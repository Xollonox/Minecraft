/**
 * World generation and meshing worker.
 *
 * The worker is intentionally dumb: it owns a `TerrainGenerator` and a
 * `ChunkMesher`, and answers requests. It holds no map of the world, tracks no
 * chunk state and never decides what to do next. All scheduling lives on the
 * main thread in `ChunkManager`, which is what makes cancelling obsolete work
 * trivial — the main thread simply ignores a reply whose job id or chunk version
 * is stale, and no worker-side bookkeeping can drift out of sync.
 *
 * ## Buffer ownership
 *
 * Typed arrays are *transferred*, not copied, in both directions. Ownership
 * rules, which the main thread mirrors:
 *
 *  - `generate` replies transfer `blocks`, `heightMap` and `biomeMap` out. The
 *    worker keeps no reference to them afterwards.
 *  - `mesh` requests transfer the padded volume *in*. The worker uses it and
 *    transfers the same buffer *back* under `recycled` so the main thread can
 *    reuse the 42 KB allocation for the next chunk instead of churning the GC.
 *  - `mesh` replies transfer every attribute array out.
 *
 * Touching a transferred array after posting it throws, so each handler drops
 * its references before returning.
 */

import { createGenerator } from '../DimensionGenerators.js';
import { Dimension } from '../DimensionConfig.js';
import { ChunkMesher } from '../ChunkMesher.js';
import { PADDED_VOLUME } from '../../config/GameConfig.js';
import { LIGHT_VOLUME } from '../BlockLight.js';

/** @type {TerrainGenerator|null} */
let generator = null;
/** @type {ChunkMesher|null} */
let mesher = null;
let workerId = -1;
let dimension = Dimension.OVERWORLD;

/** Reusable chunk buffer, so a busy worker allocates once rather than per job. */
let scratchBlocks = null;

self.onmessage = (event) => {
  const message = event.data;
  if (!message || typeof message.type !== 'string') return;

  try {
    switch (message.type) {
      case 'init':
        handleInit(message);
        break;
      case 'generate':
        handleGenerate(message);
        break;
      case 'mesh':
        handleMesh(message);
        break;
      case 'dispose':
        generator = null;
        mesher = null;
        scratchBlocks = null;
        self.close();
        break;
      default:
        postError(message.jobId, `Unknown message type "${message.type}"`);
        break;
    }
  } catch (error) {
    postError(message.jobId, error instanceof Error ? error.message : String(error), error);
  }
};

self.onerror = (event) => {
  postError(-1, `Uncaught worker error: ${event?.message || 'unknown'}`);
};

function handleInit(message) {
  workerId = message.workerId ?? -1;
  // Phase 4: a worker is bound to one dimension for its lifetime. Switching
  // dimensions tears the pool down and starts a new one, which is simpler to
  // reason about than draining in-flight jobs that belong to the world the
  // player just left.
  dimension = message.dimension ?? Dimension.OVERWORLD;
  generator = createGenerator(dimension, message.seed);
  mesher = new ChunkMesher();
  scratchBlocks = null;
  self.postMessage({ type: 'ready', workerId, dimension });
}

function handleGenerate(message) {
  if (!generator) {
    postError(message.jobId, 'Worker received a generate request before init');
    return;
  }
  const { jobId, chunkX, chunkZ, version } = message;

  // Reuse the scratch buffer, then release ownership of it: the result is
  // transferred out, so the next job allocates a fresh one.
  const result = generator.generateChunk(chunkX, chunkZ, scratchBlocks);
  scratchBlocks = null;

  self.postMessage(
    {
      type: 'generated',
      jobId,
      workerId,
      chunkX,
      chunkZ,
      version,
      blocks: result.blocks,
      heightMap: result.heightMap,
      biomeMap: result.biomeMap,
      nonAirCount: result.nonAirCount,
      maxY: result.maxY,
    },
    [result.blocks.buffer, result.heightMap.buffer, result.biomeMap.buffer]
  );
}

function handleMesh(message) {
  if (!mesher) {
    postError(message.jobId, 'Worker received a mesh request before init');
    return;
  }
  const {
    jobId,
    chunkX,
    chunkZ,
    version,
    padded,
    paddedStates,
    options,
    lightBlocks = null,
  } = message;

  if (!(padded instanceof Uint16Array) || padded.length !== PADDED_VOLUME) {
    postError(jobId, `Mesh request carried a malformed padded volume (${padded?.length})`);
    return;
  }
  if (!(paddedStates instanceof Uint8Array) || paddedStates.length !== PADDED_VOLUME) {
    postError(
      jobId,
      `Mesh request carried malformed padded states (${paddedStates?.length})`
    );
    return;
  }

  if (
    lightBlocks !== null &&
    (!(lightBlocks instanceof Uint16Array) || lightBlocks.length !== LIGHT_VOLUME)
  ) {
    postError(jobId, `Mesh request carried malformed light blocks (${lightBlocks?.length})`);
    return;
  }

  const result = mesher.mesh(padded, paddedStates, options || {}, lightBlocks);

  // Collect every buffer to transfer: the geometry, plus the padded volume
  // going home for reuse.
  const transfers = [padded.buffer, paddedStates.buffer];
  if (lightBlocks instanceof Uint16Array) transfers.push(lightBlocks.buffer);
  for (const layer of Object.values(result.layers)) {
    transfers.push(
      layer.positions.buffer,
      layer.normals.buffer,
      layer.uvs.buffer,
      layer.light.buffer,
      layer.indices.buffer
    );
  }

  self.postMessage(
    {
      type: 'meshed',
      jobId,
      workerId,
      chunkX,
      chunkZ,
      version,
      layers: result.layers,
      stats: result.stats,
      recycled: padded,
      recycledStates: paddedStates,
      recycledLightBlocks: lightBlocks,
    },
    transfers
  );
}

function postError(jobId, message, error = null) {
  self.postMessage({
    type: 'jobError',
    jobId: jobId ?? -1,
    workerId,
    message,
    stack: error?.stack || null,
  });
}
