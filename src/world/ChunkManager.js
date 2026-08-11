/**
 * Chunk streaming: what to load, in what order, and when to throw it away.
 *
 * ## Scheduling
 *
 * Two priority queues drive everything. Chunks needing voxel data sit in the
 * generation queue; chunks with data but no mesh sit in the meshing queue. Both
 * are ordered by a cost that combines distance from the player with how far the
 * chunk is from the camera's forward direction, so the world fills in ahead of
 * you first and the ring behind you last.
 *
 * The generation radius is deliberately one chunk larger than the mesh radius.
 * Correct face culling and ambient occlusion at a chunk border require the
 * neighbouring voxels, so a chunk is only meshed once all eight of its
 * neighbours have data. Without that extra ring the frontier chunk would be
 * meshed against emptiness and show a wall of spurious faces that had to be
 * rebuilt a moment later.
 *
 * ## Bounded work
 *
 * Every stage has a ceiling. Generation dispatch is limited by worker capacity,
 * mesh dispatch by how many padded volumes we are willing to build per frame,
 * and GPU upload by the `uploadBudget` setting. Flying quickly therefore never
 * grows an unbounded backlog: the queues are re-scanned from the player's new
 * position and stale entries are pruned rather than drained.
 *
 * ## Stale-result rejection
 *
 * Each request carries a job id and the chunk's version counter. A reply is
 * applied only when the chunk still exists, still wants that result, and the
 * version still matches. Anything else is dropped — including its transferred
 * buffers, which are returned to the pool rather than leaked.
 */

import * as THREE from 'three';

import {
  LAYER_NAMES,
  PADDED_SIZE_X,
  PADDED_SIZE_Z,
  PADDED_VOLUME,
  STREAMING,
  WORLD_HEIGHT,
} from '../config/GameConfig.js';
import { Events } from '../core/EventBus.js';
import { chunkKey, chunkRingDistance, voxelIndex } from '../utils/CoordinateUtils.js';
import { PriorityQueue } from '../utils/PriorityQueue.js';
import { ObjectPool } from '../utils/ObjectPool.js';
import { clamp } from '../utils/MathUtils.js';
import { Chunk, ChunkState } from './Chunk.js';
import {
  blockLightIndex,
  hasBlockLightSource,
  LIGHT_VOLUME,
  LIGHT_VOLUME_SIZE_X,
  LIGHT_VOLUME_SIZE_Z,
} from './BlockLight.js';
import { WorldWorkerPool } from './WorldWorkerPool.js';
import { Dimension } from './DimensionConfig.js';

/** Maximum mesh dispatch attempts per frame (padded volumes we may build). */
const MAX_MESH_DISPATCH_PER_FRAME = 4;
/** Maximum queue entries examined per frame when dispatching meshes. */
const MAX_MESH_QUEUE_PROBES = 24;
/** Seconds between eviction sweeps. */
const EVICTION_INTERVAL = 0.5;
/** Seconds between queue re-prioritisation while the player stays in a chunk. */
const REPRIORITISE_INTERVAL = 0.45;
/**
 * How long a chunk may sit in `GENERATING`/`MESHING` before the watchdog
 * re-queues it. Generous, so a merely slow device is never disturbed.
 */
const STALLED_JOB_TIMEOUT_MS = 12000;

/** Neighbour offsets required before a chunk can be meshed. */
const NEIGHBOUR_OFFSETS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

export class ChunkManager {
  /**
   * @param {Object} options
   * @param {THREE.Scene} options.scene
   * @param {import('../core/EventBus.js').EventBus} options.bus
   * @param {import('../core/SettingsManager.js').SettingsManager} options.settings
   * @param {import('../core/ResourceManager.js').ResourceManager} options.resources
   * @param {import('../rendering/Materials.js').Materials} options.materials
   * @param {number} options.seed
   */
  constructor({ scene, bus, settings, resources, materials, seed, dimension }) {
    this._scene = scene;
    // Phase 4. The dimension whose chunks this manager streams. Passed down to
    // the worker pool so terrain generation matches what the player sees.
    this._dimension = dimension || Dimension.OVERWORLD;
    this._bus = bus;
    this._settings = settings;
    this._resources = resources;
    this._materials = materials;
    this._seed = seed >>> 0;

    /** @type {Map<string, Chunk>} */
    this.chunks = new Map();

    /** Group holding every chunk mesh, so the whole world can be hidden at once. */
    this.group = new THREE.Group();
    this.group.name = 'chunks';
    this.group.matrixAutoUpdate = false;
    scene.add(this.group);

    this._generationQueue = new PriorityQueue((entry) => entry.key);
    this._meshQueue = new PriorityQueue((entry) => entry.key);
    /** @type {Array<Object>} Completed mesh results awaiting GPU upload. */
    this._uploadQueue = [];

    /**
     * Pools of padded id/state meshing volumes. The id volume is 84 KB and the
     * state volume is 42 KB; both are
     * transferred to the worker and back, so pooling avoids a steady allocation churn
     * that would otherwise dominate the GC profile while flying.
     */
    this._paddedPool = new ObjectPool(
      () => new Uint16Array(PADDED_VOLUME),
      (buffer) => buffer.fill(0),
      12
    );
    this._paddedStatePool = new ObjectPool(
      () => new Uint8Array(PADDED_VOLUME),
      (buffer) => buffer.fill(0),
      12
    );
    /** 3x3 chunk source volumes used for seam-free propagated block light. */
    this._lightVolumePool = new ObjectPool(
      () => new Uint16Array(LIGHT_VOLUME),
      (buffer) => buffer.fill(0),
      8
    );

    this._jobCounter = 1;
    this._playerChunkX = Number.NaN;
    this._playerChunkZ = Number.NaN;
    this._forwardX = 0;
    this._forwardZ = -1;
    this._evictionTimer = 0;
    this._reprioritiseTimer = 0;
    this._needsRescan = true;
    this._paused = false;
    this._destroyed = false;
    this._cameraY = 0;

    /** @type {(key: string, chunk: Chunk) => void|null} */
    this.onChunkDataReady = null;
    /** @type {(chunkX: number, chunkZ: number) => Map<number, number>|null} */
    this.editProvider = null;

    this._stats = {
      loaded: 0,
      visible: 0,
      visibleLayers: 0,
      generating: 0,
      meshing: 0,
      queuedGeneration: 0,
      queuedMeshing: 0,
      queuedUpload: 0,
      triangles: 0,
      generatedTotal: 0,
      meshedTotal: 0,
      discardedTotal: 0,
      evictedTotal: 0,
      recoveredTotal: 0,
    };

    this._pool = new WorldWorkerPool({
      seed: this._seed,
      dimension: this._dimension,
      workerCount: settings.get('graphics.workerCount'),
      onGenerated: (message) => this._onGenerated(message),
      onMeshed: (message) => this._onMeshed(message),
      onError: (error) => this._onPoolError(error),
    });
  }

  /** Live streaming statistics for the debug overlay. */
  get stats() {
    return this._stats;
  }

  /** The worker pool, exposed for diagnostics. */
  get workerPool() {
    return this._pool;
  }

  /** Horizontal render distance in chunks. */
  get renderDistance() {
    return clamp(this._settings.get('graphics.renderDistance'), 2, 24);
  }

  /** Radius that must have voxel data, one ring beyond the mesh radius. */
  get generationDistance() {
    return this.renderDistance + 1;
  }

  /** Pauses streaming without tearing anything down (used while paused/hidden). */
  setPaused(paused) {
    this._paused = paused;
  }

  /** Forces the desired-chunk set to be recomputed on the next update. */
  requestRescan() {
    this._needsRescan = true;
  }

  // -------------------------------------------------------------------- update

  /**
   * Advances streaming by one frame.
   *
   * @param {number} dt Seconds since the previous frame.
   * @param {THREE.Vector3} playerPosition
   * @param {THREE.Vector3} cameraForward Normalised look direction.
   */
  update(dt, playerPosition, cameraForward) {
    if (this._destroyed) return;

    const chunkX = Math.floor(playerPosition.x / 16);
    const chunkZ = Math.floor(playerPosition.z / 16);
    this._forwardX = cameraForward.x;
    this._forwardZ = cameraForward.z;

    if (chunkX !== this._playerChunkX || chunkZ !== this._playerChunkZ) {
      const previousX = this._playerChunkX;
      this._playerChunkX = chunkX;
      this._playerChunkZ = chunkZ;
      this._needsRescan = true;
      if (Number.isFinite(previousX)) {
        this._bus.emit(Events.PLAYER_MOVED_CHUNK, chunkX, chunkZ);
      }
    }

    if (this._paused) {
      this._updateStats();
      return;
    }

    this._reprioritiseTimer += dt;
    if (this._needsRescan || this._reprioritiseTimer >= REPRIORITISE_INTERVAL) {
      this._reprioritiseTimer = 0;
      this._needsRescan = false;
      this._scanDesiredChunks();
    }

    this._dispatchGeneration();
    this._dispatchMeshing();

    // In inline mode the pool needs main-thread time to make progress.
    this._pool.pumpInline(this._inlineBudgetMs());

    this._processUploads();

    this._evictionTimer += dt;
    if (this._evictionTimer >= EVICTION_INTERVAL) {
      this._evictionTimer = 0;
      this._evictDistantChunks();
      this._recoverStalledChunks();
    }

    this._updateVisibility();
    this._updateStats();
  }

  /** Time budget for main-thread generation when workers are unavailable. */
  _inlineBudgetMs() {
    // Leave most of the frame for rendering: 5 ms on a 60 Hz budget.
    return this._settings.get('display.maxFps') === 30 ? 9 : 5;
  }

  // ------------------------------------------------------------------ queueing

  /**
   * Walks the square around the player and queues anything missing.
   *
   * Runs on chunk change and a few times a second, not every frame: the scan is
   * cheap but re-heaping a thousand entries is not.
   */
  _scanDesiredChunks() {
    const radius = this.generationDistance;
    const centreX = this._playerChunkX;
    const centreZ = this._playerChunkZ;
    if (!Number.isFinite(centreX)) return;

    // Drop queued work that has fallen outside the keep radius entirely. This is
    // the cancellation path that keeps a long flight from accumulating a backlog
    // of chunks nobody will ever see.
    const keepRadius = radius + STREAMING.unloadMargin;
    this._generationQueue.prune(
      (entry) => chunkRingDistance(entry.chunkX, entry.chunkZ, centreX, centreZ) > keepRadius
    );
    this._meshQueue.prune(
      (entry) => chunkRingDistance(entry.chunkX, entry.chunkZ, centreX, centreZ) > keepRadius
    );

    const now = performance.now();
    let queued = 0;

    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const cx = centreX + dx;
        const cz = centreZ + dz;
        const key = chunkKey(cx, cz);
        let chunk = this.chunks.get(key);

        if (!chunk) {
          if (queued >= STREAMING.maxQueuedGenerations) continue;
          chunk = new Chunk(cx, cz);
          chunk.lastSeen = now;
          // Attach any edits the world already knows about so they are replayed
          // the instant generated terrain arrives.
          const edits = this.editProvider ? this.editProvider(cx, cz) : null;
          if (edits) chunk.edits = edits;
          this.chunks.set(key, chunk);
          chunk.state = ChunkState.QUEUED;
          this._generationQueue.pushOrUpdate(
            { key, chunkX: cx, chunkZ: cz },
            this._priority(dx, dz)
          );
          queued++;
          continue;
        }

        chunk.lastSeen = now;

        if (chunk.state === ChunkState.QUEUED) {
          this._generationQueue.pushOrUpdate(
            { key, chunkX: cx, chunkZ: cz },
            this._priority(dx, dz)
          );
        } else if (
          (chunk.state === ChunkState.GENERATED ||
            chunk.state === ChunkState.DIRTY ||
            (chunk.needsRemesh && chunk.state !== ChunkState.MESHING)) &&
          Math.abs(dx) <= this.renderDistance &&
          Math.abs(dz) <= this.renderDistance
        ) {
          this._meshQueue.pushOrUpdate({ key, chunkX: cx, chunkZ: cz }, this._priority(dx, dz));
        }
      }
    }
  }

  /**
   * Streaming cost for a chunk offset from the player.
   *
   * Distance dominates; the dot product against the camera forward vector
   * subtracts up to 6 "chunks" of cost, which reliably brings the chunks you
   * are looking at in before the ones behind your head without ever starving
   * the periphery.
   */
  _priority(dx, dz) {
    const distance = Math.sqrt(dx * dx + dz * dz);
    if (distance < 0.5) return -8; // the player's own chunk always wins
    const facing = (dx * this._forwardX + dz * this._forwardZ) / distance;
    return distance - facing * 6;
  }

  // ----------------------------------------------------------------- dispatch

  _dispatchGeneration() {
    while (this._pool.hasCapacity && !this._generationQueue.isEmpty) {
      const entry = this._generationQueue.pop();
      const chunk = this.chunks.get(entry.key);
      if (!chunk || chunk.state !== ChunkState.QUEUED) continue;

      const jobId = this._jobCounter++;
      chunk.generateJobId = jobId;
      chunk.state = ChunkState.GENERATING;
      chunk.jobStartedAt = performance.now();
      if (!this._pool.requestGenerate(jobId, chunk.chunkX, chunk.chunkZ, chunk.version)) {
        // The pool filled up between the capacity check and the request.
        chunk.state = ChunkState.QUEUED;
        chunk.generateJobId = -1;
        this._generationQueue.push(entry, this._priorityFor(chunk));
        break;
      }
    }
  }

  _dispatchMeshing() {
    let dispatched = 0;
    let probes = 0;
    /** @type {Array<{entry: Object, priority: number}>} */
    const retry = [];

    while (
      dispatched < MAX_MESH_DISPATCH_PER_FRAME &&
      probes < MAX_MESH_QUEUE_PROBES &&
      !this._meshQueue.isEmpty &&
      this._pool.hasCapacity
    ) {
      probes++;
      const priority = this._meshQueue.peekPriority();
      const entry = this._meshQueue.pop();
      const chunk = this.chunks.get(entry.key);
      if (!chunk || !chunk.hasData) continue;
      if (chunk.state === ChunkState.MESHING) continue;
      if (chunk.state === ChunkState.DISPOSING || chunk.state === ChunkState.DISPOSED) continue;

      if (!this._neighboursReady(chunk)) {
        // Not an error: the surrounding ring is still generating. Try again on a
        // later frame rather than meshing against emptiness.
        retry.push({ entry, priority: priority + 0.5 });
        continue;
      }

      // An empty chunk with empty neighbours can never produce geometry.
      if (chunk.isEmpty && this._neighbourhoodEmpty(chunk)) {
        chunk.needsRemesh = false;
        chunk.state = ChunkState.READY;
        continue;
      }

      const padded = this._paddedPool.acquire();
      const paddedStates = this._paddedStatePool.acquire();
      this._fillPaddedVolumes(chunk, padded, paddedStates);
      let lightBlocks = this._lightVolumePool.acquire();
      this._fillLightVolume(chunk, lightBlocks);
      if (!hasBlockLightSource(lightBlocks)) {
        this._lightVolumePool.release(lightBlocks);
        lightBlocks = null;
      }

      const jobId = this._jobCounter++;
      chunk.meshJobId = jobId;
      chunk.state = ChunkState.MESHING;
      chunk.needsRemesh = false;
      chunk.jobStartedAt = performance.now();

      const accepted = this._pool.requestMesh(
        jobId,
        chunk.chunkX,
        chunk.chunkZ,
        chunk.version,
        padded,
        paddedStates,
        this._mesherOptions(),
        lightBlocks
      );

      if (!accepted) {
        // The volumes were not transferred, so we still own them.
        this._paddedPool.release(padded);
        this._paddedStatePool.release(paddedStates);
        if (lightBlocks) this._lightVolumePool.release(lightBlocks);
        chunk.state = ChunkState.GENERATED;
        chunk.meshJobId = -1;
        chunk.needsRemesh = true;
        retry.push({ entry, priority });
        break;
      }
      dispatched++;
    }

    for (const item of retry) this._meshQueue.pushOrUpdate(item.entry, item.priority);
  }

  _mesherOptions() {
    const graphics = this._settings.values.graphics;
    return {
      ambientOcclusion: graphics.ambientOcclusion,
      smoothLighting: graphics.smoothLighting,
      liquidSurface: graphics.waterQuality !== 'simple',
    };
  }

  _priorityFor(chunk) {
    return this._priority(chunk.chunkX - this._playerChunkX, chunk.chunkZ - this._playerChunkZ);
  }

  /** True when all eight neighbours have voxel data. */
  _neighboursReady(chunk) {
    for (let i = 0; i < NEIGHBOUR_OFFSETS.length; i++) {
      const neighbour = this.chunks.get(
        chunkKey(chunk.chunkX + NEIGHBOUR_OFFSETS[i][0], chunk.chunkZ + NEIGHBOUR_OFFSETS[i][1])
      );
      if (!neighbour || !neighbour.hasData) return false;
    }
    return true;
  }

  /** True when the chunk and all its neighbours contain no blocks. */
  _neighbourhoodEmpty(chunk) {
    for (let i = 0; i < NEIGHBOUR_OFFSETS.length; i++) {
      const neighbour = this.chunks.get(
        chunkKey(chunk.chunkX + NEIGHBOUR_OFFSETS[i][0], chunk.chunkZ + NEIGHBOUR_OFFSETS[i][1])
      );
      if (neighbour && !neighbour.isEmpty) return false;
    }
    return true;
  }

  /**
   * Copies a chunk and one block of every neighbour into a padded volume.
   *
   * The copy is done in contiguous 16-byte runs wherever possible (`TypedArray
   * .set` on a subarray), because the voxel layout is X-major: a whole row of X
   * is adjacent in memory in both the source chunk and the destination volume.
   */
  _fillPaddedVolumes(chunk, padded, paddedStates) {
    padded.fill(0);
    paddedStates.fill(0);
    const blocks = chunk.blocks;
    const states = chunk.states;

    // Interior: one contiguous run of 16 voxels per (y, z).
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      for (let localZ = 0; localZ < 16; localZ++) {
        const source = voxelIndex(0, y, localZ);
        const destination = paddedIdx(0, y, localZ);
        padded.set(blocks.subarray(source, source + 16), destination);
        if (states) paddedStates.set(states.subarray(source, source + 16), destination);
      }
    }

    const cx = chunk.chunkX;
    const cz = chunk.chunkZ;

    // West / east faces: single voxels, so a per-voxel loop is unavoidable.
    const west = this.chunks.get(chunkKey(cx - 1, cz));
    if (west?.blocks) {
      const source = west.blocks;
      for (let y = 0; y < WORLD_HEIGHT; y++) {
        for (let localZ = 0; localZ < 16; localZ++) {
          const sourceIndex = voxelIndex(15, y, localZ);
          const destination = paddedIdx(-1, y, localZ);
          padded[destination] = source[sourceIndex];
          paddedStates[destination] = west.states?.[sourceIndex] ?? 0;
        }
      }
    }
    const east = this.chunks.get(chunkKey(cx + 1, cz));
    if (east?.blocks) {
      const source = east.blocks;
      for (let y = 0; y < WORLD_HEIGHT; y++) {
        for (let localZ = 0; localZ < 16; localZ++) {
          const sourceIndex = voxelIndex(0, y, localZ);
          const destination = paddedIdx(16, y, localZ);
          padded[destination] = source[sourceIndex];
          paddedStates[destination] = east.states?.[sourceIndex] ?? 0;
        }
      }
    }

    // North / south faces: a full row of X, so `set` works here too.
    const north = this.chunks.get(chunkKey(cx, cz - 1));
    if (north?.blocks) {
      const source = north.blocks;
      for (let y = 0; y < WORLD_HEIGHT; y++) {
        const start = voxelIndex(0, y, 15);
        const destination = paddedIdx(0, y, -1);
        padded.set(source.subarray(start, start + 16), destination);
        if (north.states) paddedStates.set(north.states.subarray(start, start + 16), destination);
      }
    }
    const south = this.chunks.get(chunkKey(cx, cz + 1));
    if (south?.blocks) {
      const source = south.blocks;
      for (let y = 0; y < WORLD_HEIGHT; y++) {
        const start = voxelIndex(0, y, 0);
        const destination = paddedIdx(0, y, 16);
        padded.set(source.subarray(start, start + 16), destination);
        if (south.states) paddedStates.set(south.states.subarray(start, start + 16), destination);
      }
    }

    // Four vertical corner columns.
    const corners = [
      [-1, -1, 15, 15],
      [1, -1, 0, 15],
      [-1, 1, 15, 0],
      [1, 1, 0, 0],
    ];
    for (let i = 0; i < corners.length; i++) {
      const [offsetX, offsetZ, sourceX, sourceZ] = corners[i];
      const neighbour = this.chunks.get(chunkKey(cx + offsetX, cz + offsetZ));
      if (!neighbour?.blocks) continue;
      const source = neighbour.blocks;
      const destinationX = offsetX < 0 ? -1 : 16;
      const destinationZ = offsetZ < 0 ? -1 : 16;
      for (let y = 0; y < WORLD_HEIGHT; y++) {
        const sourceIndex = voxelIndex(sourceX, y, sourceZ);
        const destination = paddedIdx(destinationX, y, destinationZ);
        padded[destination] = source[sourceIndex];
        paddedStates[destination] = neighbour.states?.[sourceIndex] ?? 0;
      }
    }
  }

  /**
   * Copies the complete 3x3 loaded chunk neighbourhood into one block-light
   * source volume. A radius-15 flood from any source can therefore reach every
   * voxel of the centre chunk without clipping at a border.
   */
  _fillLightVolume(chunk, destination) {
    destination.fill(0);
    for (let offsetZ = -1; offsetZ <= 1; offsetZ++) {
      for (let offsetX = -1; offsetX <= 1; offsetX++) {
        const sourceChunk = this.chunks.get(
          chunkKey(chunk.chunkX + offsetX, chunk.chunkZ + offsetZ)
        );
        if (!sourceChunk?.blocks) continue;
        const baseX = (offsetX + 1) * 16;
        const baseZ = (offsetZ + 1) * 16;
        for (let y = 0; y < WORLD_HEIGHT; y++) {
          for (let localZ = 0; localZ < 16; localZ++) {
            const sourceStart = voxelIndex(0, y, localZ);
            const destinationStart = blockLightIndex(
              baseX,
              y,
              baseZ + localZ,
              LIGHT_VOLUME_SIZE_X,
              LIGHT_VOLUME_SIZE_Z
            );
            destination.set(
              sourceChunk.blocks.subarray(sourceStart, sourceStart + 16),
              destinationStart
            );
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------ replies

  _onGenerated(message) {
    const key = chunkKey(message.chunkX, message.chunkZ);
    const chunk = this.chunks.get(key);

    // Stale-result rejection: the chunk may have been evicted while the job ran,
    // or superseded by a newer request.
    if (!chunk || chunk.generateJobId !== message.jobId || chunk.state === ChunkState.DISPOSED) {
      this._stats.discardedTotal++;
      return;
    }

    chunk.generateJobId = -1;
    try {
      chunk.setGeneratedData(
        message.blocks,
        message.heightMap,
        message.biomeMap,
        message.nonAirCount,
        message.maxY
      );
    } catch (error) {
      console.error(`[ChunkManager] malformed generation result for ${key}:`, error);
      chunk.state = ChunkState.QUEUED;
      return;
    }

    this._stats.generatedTotal++;
    if (this.onChunkDataReady) this.onChunkDataReady(key, chunk);

    // The new data unblocks this chunk and can unblock its neighbours, all of
    // which needed it to build a correct padded volume.
    this._enqueueMeshIfInRange(chunk);
    for (let i = 0; i < NEIGHBOUR_OFFSETS.length; i++) {
      const neighbour = this.chunks.get(
        chunkKey(chunk.chunkX + NEIGHBOUR_OFFSETS[i][0], chunk.chunkZ + NEIGHBOUR_OFFSETS[i][1])
      );
      if (neighbour && neighbour.hasData && !neighbour.hasMesh) {
        this._enqueueMeshIfInRange(neighbour);
      }
    }
  }

  _enqueueMeshIfInRange(chunk) {
    const distance = chunkRingDistance(
      chunk.chunkX,
      chunk.chunkZ,
      this._playerChunkX,
      this._playerChunkZ
    );
    if (distance > this.renderDistance) return;
    if (chunk.state === ChunkState.MESHING) return;
    this._meshQueue.pushOrUpdate(
      { key: chunk.key, chunkX: chunk.chunkX, chunkZ: chunk.chunkZ },
      this._priorityFor(chunk)
    );
  }

  _onMeshed(message) {
    // The padded volume comes home first, whatever happens to the result.
    if (message.recycled instanceof Uint16Array && message.recycled.length === PADDED_VOLUME) {
      this._paddedPool.release(message.recycled);
    }
    if (
      message.recycledStates instanceof Uint8Array &&
      message.recycledStates.length === PADDED_VOLUME
    ) {
      this._paddedStatePool.release(message.recycledStates);
    }
    if (
      message.recycledLightBlocks instanceof Uint16Array &&
      message.recycledLightBlocks.length === LIGHT_VOLUME
    ) {
      this._lightVolumePool.release(message.recycledLightBlocks);
    }

    const key = chunkKey(message.chunkX, message.chunkZ);
    const chunk = this.chunks.get(key);

    if (
      !chunk ||
      chunk.meshJobId !== message.jobId ||
      chunk.version !== message.version ||
      chunk.state === ChunkState.DISPOSED
    ) {
      // Superseded (the player edited the chunk while it was meshing) or the
      // chunk is gone. Drop the geometry; nothing was uploaded to the GPU yet.
      this._stats.discardedTotal++;
      if (chunk && chunk.meshJobId === message.jobId) {
        // Leave MESHING or the chunk would never be picked up again: the
        // dispatcher deliberately skips chunks it believes are already meshing.
        chunk.meshJobId = -1;
        chunk.needsRemesh = true;
        chunk.state = ChunkState.DIRTY;
        this._enqueueMeshIfInRange(chunk);
      }
      return;
    }

    chunk.meshJobId = -1;
    chunk.state = ChunkState.READY;
    this._stats.meshedTotal++;
    this._uploadQueue.push({ key, layers: message.layers, stats: message.stats });
  }

  _onPoolError(error) {
    console.warn('[ChunkManager] worker pool:', error.message);
    this._bus.emit(Events.NOTIFY, {
      level: error.fatal ? 'error' : 'warning',
      message: error.message,
      id: 'worker-pool',
    });
  }

  // ------------------------------------------------------------------- uploads

  /**
   * Turns finished mesh data into GPU geometry, a few chunks per frame.
   *
   * Uploading is the one part of streaming that must happen on the main thread
   * and cannot be interrupted, so it is strictly budgeted. A high budget loads
   * the world faster; a low budget keeps frame times flat.
   */
  _processUploads() {
    const budget = clamp(this._settings.get('graphics.uploadBudget'), 1, 8);
    let uploaded = 0;

    while (uploaded < budget && this._uploadQueue.length > 0) {
      const item = this._uploadQueue.shift();
      const chunk = this.chunks.get(item.key);
      if (!chunk || chunk.state === ChunkState.DISPOSED) continue;

      try {
        this._buildChunkMeshes(chunk, item.layers);
        chunk.state = ChunkState.VISIBLE;
        this._bus.emit(Events.CHUNK_READY, chunk.chunkX, chunk.chunkZ);
      } catch (error) {
        console.error(`[ChunkManager] failed to upload ${item.key}:`, error);
      }
      uploaded++;
    }
  }

  /** Replaces a chunk's meshes with freshly built geometry. */
  _buildChunkMeshes(chunk, layers) {
    for (const layerName of LAYER_NAMES) {
      const data = layers[layerName];
      const existing = chunk.meshes[layerName];

      if (!data || data.vertexCount === 0) {
        if (existing) this._destroyMesh(chunk, layerName);
        continue;
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
      // `alight` packs [ambient occlusion, sky light, block light, sway class].
      // Normalised so the shader reads 0..1 for the first three channels; the
      // sway class is recovered by multiplying the fourth by 255.
      geometry.setAttribute('alight', new THREE.BufferAttribute(data.light, 4, true));
      geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
      geometry.computeBoundingSphere();

      if (existing) {
        // Reusing the mesh object avoids re-adding to the scene graph, which
        // would force Three to re-sort the render list.
        const previousGeometry = existing.geometry;
        existing.geometry = geometry;
        existing.material = this._materials.forLayer(layerName);
        this._resources.releaseTransient(previousGeometry);
        existing.visible = true;
      } else {
        const mesh = new THREE.Mesh(geometry, this._materials.forLayer(layerName));
        mesh.name = `chunk:${chunk.key}:${layerName}`;
        mesh.position.set(chunk.originX, 0, chunk.originZ);
        mesh.updateMatrix();
        mesh.matrixAutoUpdate = false;
        mesh.castShadow = layerName === 'opaque' || layerName === 'cutout';
        mesh.receiveShadow = true;
        // Liquid and translucent layers must draw after opaque geometry.
        mesh.renderOrder = layerName === 'opaque' ? 0 : layerName === 'cutout' ? 1 : 2;
        mesh.frustumCulled = true;
        chunk.meshes[layerName] = mesh;
        this.group.add(mesh);
      }

      this._resources.trackTransient(geometry);
    }
  }

  _destroyMesh(chunk, layerName) {
    const mesh = chunk.meshes[layerName];
    if (!mesh) return;
    this.group.remove(mesh);
    this._resources.releaseTransient(mesh.geometry);
    // The material is shared across every chunk and must survive.
    mesh.material = null;
    chunk.meshes[layerName] = null;
  }

  // ------------------------------------------------------------------ eviction

  /**
   * Unloads chunks that have drifted outside the keep radius.
   *
   * `unloadMargin` provides hysteresis so walking back and forth over a chunk
   * boundary does not thrash the same chunk in and out.
   */
  _evictDistantChunks() {
    const keepRadius = this.generationDistance + STREAMING.unloadMargin;
    /** @type {string[]} */
    const doomed = [];

    for (const [key, chunk] of this.chunks) {
      const distance = chunkRingDistance(
        chunk.chunkX,
        chunk.chunkZ,
        this._playerChunkX,
        this._playerChunkZ
      );
      if (distance > keepRadius) doomed.push(key);
    }

    for (const key of doomed) this._disposeChunk(key);

    // A hard ceiling protects memory if the render distance is raised while a
    // lot of chunks are still resident.
    const span = keepRadius * 2 + 1;
    const maxChunks = Math.ceil(span * span * 1.25);
    if (this.chunks.size > maxChunks) {
      const sorted = Array.from(this.chunks.values()).sort(
        (a, b) =>
          chunkRingDistance(b.chunkX, b.chunkZ, this._playerChunkX, this._playerChunkZ) -
          chunkRingDistance(a.chunkX, a.chunkZ, this._playerChunkX, this._playerChunkZ)
      );
      const excess = this.chunks.size - maxChunks;
      for (let i = 0; i < excess; i++) this._disposeChunk(sorted[i].key);
    }
  }

  /**
   * Re-queues chunks whose job never came back.
   *
   * A worker that is killed by the OS (out of memory on a phone, or a crashed
   * tab process) silently swallows whatever it was holding. Without this
   * watchdog those chunks would sit in `GENERATING` or `MESHING` forever and
   * leave a permanent hole in the world.
   */
  _recoverStalledChunks() {
    const now = performance.now();
    for (const chunk of this.chunks.values()) {
      if (chunk.state !== ChunkState.GENERATING && chunk.state !== ChunkState.MESHING) continue;
      if (!chunk.jobStartedAt || now - chunk.jobStartedAt < STALLED_JOB_TIMEOUT_MS) continue;

      if (chunk.state === ChunkState.GENERATING) {
        chunk.generateJobId = -1;
        chunk.state = ChunkState.QUEUED;
      } else {
        chunk.meshJobId = -1;
        chunk.needsRemesh = true;
        chunk.state = chunk.hasData ? ChunkState.DIRTY : ChunkState.QUEUED;
      }
      chunk.jobStartedAt = 0;
      this._needsRescan = true;
      this._stats.recoveredTotal++;
    }
  }

  /** Fully disposes one chunk: meshes, geometry, voxel data and queue entries. */
  _disposeChunk(key) {
    const chunk = this.chunks.get(key);
    if (!chunk) return;

    chunk.state = ChunkState.DISPOSING;
    for (const layerName of LAYER_NAMES) this._destroyMesh(chunk, layerName);

    // Any in-flight job for this chunk becomes stale by construction: the reply
    // handler looks the chunk up by key and finds nothing.
    this.chunks.delete(key);
    chunk.release();

    this._generationQueue.prune((entry) => entry.key === key);
    this._meshQueue.prune((entry) => entry.key === key);
    for (let i = this._uploadQueue.length - 1; i >= 0; i--) {
      if (this._uploadQueue[i].key === key) this._uploadQueue.splice(i, 1);
    }

    this._stats.evictedTotal++;
    this._bus.emit(Events.CHUNK_UNLOADED, chunk.chunkX, chunk.chunkZ);
  }

  // ---------------------------------------------------------------- visibility

  /**
   * Applies the vertical distance setting.
   *
   * Horizontal culling is Three's frustum test. This adds a vertical rule:
   * because a chunk is a full 128-block column, "vertical distance" is measured
   * from the camera to the span of blocks the chunk *actually contains*
   * (`0 .. maxY`). A chunk is hidden only when that whole span is further than
   * the configured distance from the camera, which in practice matters when
   * flying high above low terrain or when far below the surface. At the default
   * of 4 chunks (64 blocks) it almost never triggers; lowering it is a real
   * performance lever on weak devices at the cost of popping.
   */
  _updateVisibility() {
    const verticalChunks = clamp(this._settings.get('graphics.verticalDistance'), 1, 8);
    const verticalRange = verticalChunks * 16;
    const cameraY = this._cameraY;
    let visibleChunks = 0;
    let visibleLayers = 0;

    for (const chunk of this.chunks.values()) {
      if (!chunk.hasMesh) continue;

      const spanTop = chunk.maxY >= 0 ? chunk.maxY : 0;
      // Distance from the camera to the chunk's occupied vertical span.
      const verticalGap = cameraY > spanTop ? cameraY - spanTop : cameraY < 0 ? -cameraY : 0;
      const withinVertical = verticalGap <= verticalRange;

      for (const layerName of LAYER_NAMES) {
        const mesh = chunk.meshes[layerName];
        if (!mesh) continue;
        mesh.visible = withinVertical;
        if (withinVertical) visibleLayers++;
      }
      if (withinVertical) visibleChunks++;
    }

    // Chunks, not meshes: a chunk contributes up to four layer meshes, and
    // reporting those as "visible" made the count exceed the number loaded.
    this._stats.visible = visibleChunks;
    this._stats.visibleLayers = visibleLayers;
  }

  /**
   * Reports the camera height for the vertical visibility test.
   * @param {number} y
   */
  setCameraHeight(y) {
    this._cameraY = y;
  }

  // ---------------------------------------------------------------- public API

  /**
   * Looks up a loaded chunk.
   * @param {number} chunkX
   * @param {number} chunkZ
   * @returns {Chunk|undefined}
   */
  getChunk(chunkX, chunkZ) {
    return this.chunks.get(chunkKey(chunkX, chunkZ));
  }

  /**
   * Flags a chunk for re-meshing.
   * @param {number} chunkX
   * @param {number} chunkZ
   */
  markDirty(chunkX, chunkZ) {
    const chunk = this.chunks.get(chunkKey(chunkX, chunkZ));
    if (!chunk || !chunk.hasData) return;
    chunk.needsRemesh = true;
    if (chunk.state === ChunkState.VISIBLE || chunk.state === ChunkState.READY) {
      chunk.state = ChunkState.DIRTY;
    }
    this._enqueueMeshIfInRange(chunk);
  }

  /**
   * Rebuilds every loaded chunk's geometry.
   * Used when a setting that is baked into the mesh changes (ambient occlusion,
   * smooth lighting, water quality).
   */
  rebuildAllMeshes() {
    for (const chunk of this.chunks.values()) {
      if (!chunk.hasData) continue;
      chunk.needsRemesh = true;
      if (chunk.state === ChunkState.VISIBLE || chunk.state === ChunkState.READY) {
        chunk.state = ChunkState.DIRTY;
      }
    }
    this._needsRescan = true;
  }

  /** Re-applies the shared materials to every existing mesh. */
  refreshMaterials() {
    for (const chunk of this.chunks.values()) {
      for (const layerName of LAYER_NAMES) {
        const mesh = chunk.meshes[layerName];
        if (mesh) mesh.material = this._materials.forLayer(layerName);
      }
    }
  }

  /**
   * Fraction of the chunks within the render distance that are drawable.
   * Drives the loading screen's progress bar.
   * @returns {number} 0..1
   */
  getLoadProgress() {
    const radius = Math.min(this.renderDistance, 4);
    if (!Number.isFinite(this._playerChunkX)) return 0;
    let total = 0;
    let ready = 0;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        total++;
        const chunk = this.chunks.get(chunkKey(this._playerChunkX + dx, this._playerChunkZ + dz));
        if (chunk && (chunk.state === ChunkState.VISIBLE || chunk.state === ChunkState.READY)) {
          ready++;
        }
      }
    }
    return total === 0 ? 0 : ready / total;
  }

  _updateStats() {
    let generating = 0;
    let meshing = 0;
    let triangles = 0;

    for (const chunk of this.chunks.values()) {
      if (chunk.state === ChunkState.GENERATING) generating++;
      else if (chunk.state === ChunkState.MESHING) meshing++;
      for (const layerName of LAYER_NAMES) {
        const mesh = chunk.meshes[layerName];
        if (mesh && mesh.visible && mesh.geometry.index) {
          triangles += mesh.geometry.index.count / 3;
        }
      }
    }

    this._stats.loaded = this.chunks.size;
    this._stats.generating = generating;
    this._stats.meshing = meshing;
    this._stats.queuedGeneration = this._generationQueue.size;
    this._stats.queuedMeshing = this._meshQueue.size;
    this._stats.queuedUpload = this._uploadQueue.length;
    this._stats.triangles = triangles;
  }

  /** Tears everything down: workers, meshes, geometry and queues. */
  /** The dimension this manager is currently streaming. */
  get dimension() {
    return this._dimension;
  }

  /**
   * Rebuilds the manager for a different dimension.
   *
   * Every loaded chunk belongs to the dimension it was generated in, so none of
   * it is worth keeping: meshes are disposed, queues dropped, and the worker
   * pool restarted. Re-initialising the existing pool would be cheaper but lets
   * in-flight results from the old dimension land in the new one, which shows
   * up as Overworld grass in the Nether.
   *
   * @param {string} dimension
   */
  switchDimension(dimension) {
    if (this._destroyed || dimension === this._dimension) return;
    this._dimension = dimension;

    for (const key of Array.from(this.chunks.keys())) this._disposeChunk(key);
    this.chunks.clear();
    this._generationQueue.clear();
    this._meshQueue.clear();
    this._uploadQueue.length = 0;

    this._pool.destroy();
    this._pool = new WorldWorkerPool({
      seed: this._seed,
      dimension: this._dimension,
      workerCount: this._settings.get('graphics.workerCount'),
      onGenerated: (message) => this._onGenerated(message),
      onMeshed: (message) => this._onMeshed(message),
      onError: (error) => this._onPoolError(error),
    });

    this.requestRescan();
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    this._pool.destroy();

    for (const key of Array.from(this.chunks.keys())) this._disposeChunk(key);
    this.chunks.clear();
    this._generationQueue.clear();
    this._meshQueue.clear();
    this._uploadQueue.length = 0;
    this._paddedPool.drain();
    this._paddedStatePool.drain();
    this._lightVolumePool.drain();

    if (this.group.parent) this.group.parent.remove(this.group);
  }
}

/** Flat index into a padded meshing volume; local coordinates may be -1..16. */
function paddedIdx(localX, y, localZ) {
  return localX + 1 + PADDED_SIZE_X * (localZ + 1 + PADDED_SIZE_Z * (y + 1));
}

export default ChunkManager;
