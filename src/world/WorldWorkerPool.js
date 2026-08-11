/**
 * Worker pool for chunk generation and meshing.
 *
 * The pool is a transport, not a scheduler: it owns N workers, tracks how many
 * jobs each has in flight, and forwards replies. Deciding *which* chunk matters
 * next is `ChunkManager`'s job, which keeps all prioritisation in one place.
 *
 * ## Graceful degradation
 *
 * Workers are an optimisation, not a requirement. If `Worker` is unavailable, if
 * construction throws, or if a worker dies at runtime, the pool transparently
 * switches to an **inline** mode: the same generator and mesher run on the main
 * thread, but only inside a per-frame time budget handed to `pumpInline()`, so
 * the page keeps responding instead of freezing for a second per chunk. The
 * rest of the engine cannot tell the difference beyond throughput.
 */

import WorldWorker from './workers/world-worker.js?worker';

import { STREAMING } from '../config/GameConfig.js';
import { clamp } from '../utils/MathUtils.js';
import { ChunkMesher } from './ChunkMesher.js';
import { createGenerator } from './DimensionGenerators.js';
import { Dimension } from './DimensionConfig.js';

/** Consecutive worker crashes before the pool gives up and goes inline. */
const MAX_WORKER_RESTARTS = 2;

export class WorldWorkerPool {
  /**
   * @param {Object} options
   * @param {number} options.seed
   * @param {number} options.workerCount Requested worker count; 0 forces inline.
   * @param {(result: Object) => void} options.onGenerated
   * @param {(result: Object) => void} options.onMeshed
   * @param {(error: {message: string, fatal: boolean}) => void} options.onError
   */
  constructor({ seed, workerCount, onGenerated, onMeshed, onError, dimension }) {
    this._seed = seed >>> 0;
    // Phase 4. Which dimension these workers generate. Sent to every worker at
    // init so a worker never has to guess, and used by the inline fallback.
    this._dimension = dimension || Dimension.OVERWORLD;
    this._onGenerated = onGenerated;
    this._onMeshed = onMeshed;
    this._onError = onError || (() => {});

    /** @type {Array<{worker: Worker, inFlight: number, ready: boolean, restarts: number}>} */
    this._workers = [];
    this._inlineMode = false;
    this._destroyed = false;

    /** Inline-mode generator/mesher, created lazily. */
    this._inlineGenerator = null;
    this._inlineMesher = null;
    /** @type {Array<Object>} FIFO of jobs waiting for inline processing. */
    this._inlineQueue = [];

    const requested = clamp(Math.floor(workerCount) || 0, 0, 8);
    if (requested === 0 || typeof Worker !== 'function') {
      this._enterInlineMode(
        typeof Worker !== 'function'
          ? 'Web Workers are unavailable; generating on the main thread.'
          : null
      );
      return;
    }

    for (let i = 0; i < requested; i++) {
      if (!this._spawnWorker(i)) break;
    }
    if (this._workers.length === 0) {
      this._enterInlineMode('No workers could be started; generating on the main thread.');
    }
  }

  /** Number of live workers, or 0 in inline mode. */
  get workerCount() {
    return this._inlineMode ? 0 : this._workers.length;
  }

  /** True when generation happens on the main thread. */
  get inlineMode() {
    return this._inlineMode;
  }

  /** Total jobs dispatched and not yet answered. */
  get inFlight() {
    if (this._inlineMode) return this._inlineQueue.length;
    let total = 0;
    for (const slot of this._workers) total += slot.inFlight;
    return total;
  }

  /** True when at least one worker (or the inline queue) can accept a job. */
  get hasCapacity() {
    if (this._destroyed) return false;
    if (this._inlineMode) return this._inlineQueue.length < 8;
    return this._leastLoaded() !== null;
  }

  /**
   * Requests chunk voxel data.
   *
   * @param {number} jobId
   * @param {number} chunkX
   * @param {number} chunkZ
   * @param {number} version Chunk version, echoed back for staleness checks.
   * @returns {boolean} False when the pool is saturated.
   */
  requestGenerate(jobId, chunkX, chunkZ, version) {
    if (this._destroyed) return false;
    const message = { type: 'generate', jobId, chunkX, chunkZ, version };
    if (this._inlineMode) return this._enqueueInline(message);

    const slot = this._leastLoaded();
    if (!slot) return false;
    slot.inFlight++;
    slot.worker.postMessage(message);
    return true;
  }

  /**
   * Requests a chunk mesh.
   *
   * Ownership note: `padded` is **transferred** to the worker and comes back on
   * the reply as `recycled`. The caller must not touch it after this returns.
   *
   * @param {number} jobId
   * @param {number} chunkX
   * @param {number} chunkZ
   * @param {number} version
   * @param {Uint16Array} padded 18x130x18 padded block-id volume.
   * @param {Uint8Array} paddedStates Parallel state-byte volume.
   * @param {Object} options Mesher options.
   * @param {Uint16Array|null} [lightBlocks] Optional 3x3 chunk light-source volume.
   * @returns {boolean} False when saturated (the caller keeps all volumes).
   */
  requestMesh(jobId, chunkX, chunkZ, version, padded, paddedStates, options, lightBlocks = null) {
    if (this._destroyed) return false;
    if (this._inlineMode) {
      return this._enqueueInline({
        type: 'mesh',
        jobId,
        chunkX,
        chunkZ,
        version,
        padded,
        paddedStates,
        options,
        lightBlocks,
      });
    }

    const slot = this._leastLoaded();
    if (!slot) return false;
    slot.inFlight++;
    const message = {
      type: 'mesh',
      jobId,
      chunkX,
      chunkZ,
      version,
      padded,
      paddedStates,
      options,
      lightBlocks,
    };
    const transfers = [padded.buffer, paddedStates.buffer];
    if (lightBlocks instanceof Uint16Array) transfers.push(lightBlocks.buffer);
    slot.worker.postMessage(message, transfers);
    return true;
  }

  /**
   * Runs queued inline jobs within a time budget.
   *
   * A no-op when real workers are in use. Called once per frame by
   * `ChunkManager` so the fallback path degrades throughput rather than frame
   * rate.
   *
   * @param {number} budgetMs
   */
  pumpInline(budgetMs = 6) {
    if (!this._inlineMode || this._destroyed) return;
    if (this._inlineQueue.length === 0) return;

    const start = now();
    // Always run at least one job so progress is guaranteed even on a device
    // where a single chunk exceeds the whole budget.
    do {
      const job = this._inlineQueue.shift();
      if (!job) break;
      this._runInline(job);
    } while (this._inlineQueue.length > 0 && now() - start < budgetMs);
  }

  /** Terminates every worker and clears queued work. */
  destroy() {
    this._destroyed = true;
    for (const slot of this._workers) {
      try {
        slot.worker.postMessage({ type: 'dispose' });
      } catch {
        /* the worker may already be gone */
      }
      try {
        slot.worker.terminate();
      } catch {
        /* ignore */
      }
    }
    this._workers.length = 0;
    this._inlineQueue.length = 0;
    this._inlineGenerator = null;
    this._inlineMesher = null;
  }

  /** Diagnostics for the debug overlay. */
  getStats() {
    return {
      workers: this.workerCount,
      inlineMode: this._inlineMode,
      inFlight: this.inFlight,
      queuedInline: this._inlineQueue.length,
    };
  }

  // ----------------------------------------------------------------- internals

  _spawnWorker(index) {
    try {
      const worker = new WorldWorker();
      const slot = { worker, inFlight: 0, ready: false, restarts: 0, index };
      worker.onmessage = (event) => this._onWorkerMessage(slot, event.data);
      worker.onerror = (event) => this._onWorkerFailure(slot, event);
      worker.onmessageerror = () =>
        this._onWorkerFailure(slot, { message: 'Worker could not deserialise a message' });
      worker.postMessage({
        type: 'init',
        seed: this._seed,
        workerId: index,
        dimension: this._dimension,
      });
      this._workers.push(slot);
      return true;
    } catch (error) {
      console.warn('[WorkerPool] could not start a worker:', error);
      return false;
    }
  }

  _leastLoaded() {
    let best = null;
    for (const slot of this._workers) {
      // `postMessage(init)` and the next main-thread frame can race. A worker is
      // not schedulable until it has constructed its dimension generator and
      // acknowledged the ready handshake; otherwise the first chunk requests
      // are rejected and remain permanently blank.
      if (!slot.ready) continue;
      if (slot.inFlight >= STREAMING.maxJobsPerWorker) continue;
      if (!best || slot.inFlight < best.inFlight) best = slot;
    }
    return best;
  }

  _onWorkerMessage(slot, message) {
    if (this._destroyed || !message) return;

    switch (message.type) {
      case 'ready':
        slot.ready = true;
        return;

      case 'generated':
        slot.inFlight = Math.max(0, slot.inFlight - 1);
        this._onGenerated(message);
        return;

      case 'meshed':
        slot.inFlight = Math.max(0, slot.inFlight - 1);
        this._onMeshed(message);
        return;

      case 'jobError':
        slot.inFlight = Math.max(0, slot.inFlight - 1);
        this._onError({ message: message.message, fatal: false, jobId: message.jobId });
        return;

      default:
        return;
    }
  }

  /**
   * Handles a worker that crashed.
   *
   * A worker is restarted a couple of times — a transient out-of-memory kill is
   * recoverable — but repeated failures mean something systemic, so the pool
   * falls back to inline generation rather than looping forever.
   */
  _onWorkerFailure(slot, event) {
    if (this._destroyed) return;
    const message = event?.message || 'A generation worker crashed';
    console.warn('[WorkerPool]', message);

    // Any job that worker was holding is lost. ChunkManager re-queues chunks
    // that stay in a pending state, so no explicit replay is needed here.
    slot.inFlight = 0;

    try {
      slot.worker.terminate();
    } catch {
      /* ignore */
    }
    const position = this._workers.indexOf(slot);
    if (position >= 0) this._workers.splice(position, 1);

    if (slot.restarts < MAX_WORKER_RESTARTS) {
      const replacement = this._spawnWorker(slot.index);
      if (replacement) {
        this._workers[this._workers.length - 1].restarts = slot.restarts + 1;
        this._onError({ message: `${message}. Restarted the worker.`, fatal: false });
        return;
      }
    }

    if (this._workers.length === 0) {
      this._enterInlineMode(`${message}. Falling back to main-thread generation.`);
    } else {
      this._onError({ message: `${message}. Continuing with fewer workers.`, fatal: false });
    }
  }

  _enterInlineMode(reason) {
    if (this._inlineMode) return;
    this._inlineMode = true;
    this._inlineGenerator = createGenerator(this._dimension, this._seed);
    this._inlineMesher = new ChunkMesher();
    if (reason) this._onError({ message: reason, fatal: false });
  }

  _enqueueInline(job) {
    if (this._inlineQueue.length >= 32) return false;
    this._inlineQueue.push(job);
    return true;
  }

  /**
   * Executes one job synchronously.
   *
   * The reply shape is identical to the worker's, including the `recycled`
   * padded volume, so `ChunkManager` has exactly one code path for results.
   */
  _runInline(job) {
    try {
      if (job.type === 'generate') {
        const result = this._inlineGenerator.generateChunk(job.chunkX, job.chunkZ);
        this._onGenerated({
          type: 'generated',
          jobId: job.jobId,
          workerId: -1,
          chunkX: job.chunkX,
          chunkZ: job.chunkZ,
          version: job.version,
          blocks: result.blocks,
          heightMap: result.heightMap,
          biomeMap: result.biomeMap,
          nonAirCount: result.nonAirCount,
          maxY: result.maxY,
        });
      } else if (job.type === 'mesh') {
        const result = this._inlineMesher.mesh(
          job.padded,
          job.paddedStates,
          job.options || {},
          job.lightBlocks ?? null
        );
        this._onMeshed({
          type: 'meshed',
          jobId: job.jobId,
          workerId: -1,
          chunkX: job.chunkX,
          chunkZ: job.chunkZ,
          version: job.version,
          layers: result.layers,
          stats: result.stats,
          recycled: job.padded,
          recycledStates: job.paddedStates,
          recycledLightBlocks: job.lightBlocks ?? null,
        });
      }
    } catch (error) {
      this._onError({
        message: error instanceof Error ? error.message : String(error),
        fatal: false,
        jobId: job.jobId,
      });
    }
  }
}

function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

export default WorldWorkerPool;
