/**
 * Deterministic voxel block-light propagation.
 *
 * Block light is kept separate from sky light: emissive voxels seed a 0..15
 * flood fill, every travelled voxel costs at least one level, and transparent
 * media may attenuate more. The worker meshes one chunk from a 3x3 chunk light
 * neighbourhood, which is wide enough for Minecraft-style light's maximum
 * radius of 15 and therefore prevents seams at chunk borders.
 *
 * Worker-safe: no DOM and no Three.js.
 */

import {
  CHUNK_SIZE_X,
  CHUNK_SIZE_Z,
  PADDED_SIZE_X,
  PADDED_SIZE_Y,
  PADDED_SIZE_Z,
  PADDED_VOLUME,
  WORLD_HEIGHT,
} from '../config/GameConfig.js';
import { LIGHT_ATTENUATION, LIGHT_LEVEL } from './BlockRegistry.js';

export const BLOCK_LIGHT_RADIUS = 15;
export const LIGHT_NEIGHBOUR_CHUNKS = 3;
export const LIGHT_VOLUME_SIZE_X = CHUNK_SIZE_X * LIGHT_NEIGHBOUR_CHUNKS;
export const LIGHT_VOLUME_SIZE_Y = WORLD_HEIGHT;
export const LIGHT_VOLUME_SIZE_Z = CHUNK_SIZE_Z * LIGHT_NEIGHBOUR_CHUNKS;
export const LIGHT_VOLUME =
  LIGHT_VOLUME_SIZE_X * LIGHT_VOLUME_SIZE_Y * LIGHT_VOLUME_SIZE_Z;
export const LIGHT_TARGET_OFFSET_X = CHUNK_SIZE_X;
export const LIGHT_TARGET_OFFSET_Z = CHUNK_SIZE_Z;

/** X-major flat index used by light volumes and chunk voxel buffers. */
export function blockLightIndex(x, y, z, sizeX, sizeZ) {
  return x + sizeX * (z + sizeZ * y);
}

/** True when a volume contains at least one registered light-emitting block. */
export function hasBlockLightSource(blocks) {
  if (!blocks || typeof blocks.length !== 'number') return false;
  for (let i = 0; i < blocks.length; i++) {
    if (LIGHT_LEVEL[blocks[i]] > 0) return true;
  }
  return false;
}

/**
 * Multi-source breadth-first block-light flood fill.
 *
 * @param {Uint16Array|Uint8Array} blocks X-major block-id volume.
 * @param {number} sizeX
 * @param {number} sizeY
 * @param {number} sizeZ
 * @param {Uint8Array|null} [output]
 * @param {Int32Array|null} [queue]
 * @param {Uint8Array|null} [queued]
 * @returns {Uint8Array}
 */
export function propagateBlockLight(
  blocks,
  sizeX,
  sizeY,
  sizeZ,
  output = null,
  queue = null,
  queued = null
) {
  if (!(blocks instanceof Uint16Array) && !(blocks instanceof Uint8Array)) {
    throw new TypeError('propagateBlockLight requires a typed block-id volume');
  }
  const sx = Math.floor(sizeX);
  const sy = Math.floor(sizeY);
  const sz = Math.floor(sizeZ);
  const volume = sx * sy * sz;
  if (sx <= 0 || sy <= 0 || sz <= 0 || blocks.length !== volume) {
    throw new RangeError(
      `Invalid block-light dimensions ${sizeX}x${sizeY}x${sizeZ} for ${blocks.length} voxels`
    );
  }

  const light = output instanceof Uint8Array && output.length === volume
    ? output
    : new Uint8Array(volume);
  light.fill(0);
  const work = queue instanceof Int32Array && queue.length === volume
    ? queue
    : new Int32Array(volume);
  const inQueue = queued instanceof Uint8Array && queued.length === volume
    ? queued
    : new Uint8Array(volume);
  inQueue.fill(0);

  let head = 0;
  let tail = 0;
  let queuedCount = 0;
  const enqueue = (index) => {
    if (inQueue[index]) return;
    work[tail] = index;
    tail = (tail + 1) % volume;
    queuedCount++;
    inQueue[index] = 1;
  };

  for (let index = 0; index < volume; index++) {
    const emitted = LIGHT_LEVEL[blocks[index]];
    if (emitted <= 0) continue;
    light[index] = emitted;
    enqueue(index);
  }

  const plane = sx * sz;
  const visit = (nextIndex, current) => {
    // Distance always costs one. Water/leaves/glass may cost more according to
    // their registry attenuation; a full opaque block's default 15 stops light.
    const attenuation = Math.max(1, LIGHT_ATTENUATION[blocks[nextIndex]]);
    const next = current - attenuation;
    if (next <= 0 || next <= light[nextIndex]) return;
    light[nextIndex] = next;
    enqueue(nextIndex);
  };

  // An index is present at most once at a time, so a volume-sized circular queue
  // remains bounded even when a stronger path re-enqueues a cell later.
  while (queuedCount > 0) {
    const index = work[head];
    head = (head + 1) % volume;
    queuedCount--;
    inQueue[index] = 0;

    const current = light[index];
    if (current <= 1) continue;
    const y = Math.floor(index / plane);
    const withinPlane = index - y * plane;
    const z = Math.floor(withinPlane / sx);
    const x = withinPlane - z * sx;

    if (x > 0) visit(index - 1, current);
    if (x + 1 < sx) visit(index + 1, current);
    if (z > 0) visit(index - sx, current);
    if (z + 1 < sz) visit(index + sx, current);
    if (y > 0) visit(index - plane, current);
    if (y + 1 < sy) visit(index + plane, current);
  }

  return light;
}


/** Fixed scratch volume for one on-demand world-light query. */
export const BLOCK_LIGHT_SAMPLE_DIAMETER = BLOCK_LIGHT_RADIUS * 2 + 1;
export const BLOCK_LIGHT_SAMPLE_VOLUME =
  BLOCK_LIGHT_SAMPLE_DIAMETER * BLOCK_LIGHT_SAMPLE_DIAMETER * BLOCK_LIGHT_SAMPLE_DIAMETER;

/** Allocates reusable scratch storage for `sampleWorldBlockLight`. */
export function createBlockLightSampleScratch() {
  return {
    cost: new Uint8Array(BLOCK_LIGHT_SAMPLE_VOLUME),
    queue: new Int32Array(BLOCK_LIGHT_SAMPLE_VOLUME),
    queued: new Uint8Array(BLOCK_LIGHT_SAMPLE_VOLUME),
  };
}

/**
 * Samples the propagated block light at one loaded world voxel.
 *
 * The search runs backwards from the target. Moving to a neighbour charges the
 * attenuation of the current cell, exactly mirroring forward light entering
 * that cell. This finds the least-attenuated path around corners and through
 * transparent media without building a permanent main-thread light volume.
 * It is intended for infrequent simulation queries such as mob spawning; mesh
 * workers use the faster bulk propagation above.
 *
 * @param {(x:number,y:number,z:number)=>number} getBlock
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {Object} [options]
 * @param {((x:number,z:number)=>boolean)|null} [options.isLoaded]
 * @param {ReturnType<typeof createBlockLightSampleScratch>|null} [options.scratch]
 * @returns {number} Light level 0..15.
 */
export function sampleWorldBlockLight(getBlock, x, y, z, options = {}) {
  if (typeof getBlock !== 'function') return 0;
  const centreX = Math.floor(x);
  const centreY = Math.floor(y);
  const centreZ = Math.floor(z);
  const isLoaded = typeof options.isLoaded === 'function' ? options.isLoaded : null;
  if (isLoaded && !isLoaded(centreX, centreZ)) return 0;

  const scratch = options.scratch ?? createBlockLightSampleScratch();
  const cost = scratch.cost;
  const work = scratch.queue;
  const inQueue = scratch.queued;
  if (
    !(cost instanceof Uint8Array) || cost.length !== BLOCK_LIGHT_SAMPLE_VOLUME ||
    !(work instanceof Int32Array) || work.length !== BLOCK_LIGHT_SAMPLE_VOLUME ||
    !(inQueue instanceof Uint8Array) || inQueue.length !== BLOCK_LIGHT_SAMPLE_VOLUME
  ) {
    throw new TypeError('Malformed block-light sample scratch storage');
  }
  cost.fill(255);
  inQueue.fill(0);

  const diameter = BLOCK_LIGHT_SAMPLE_DIAMETER;
  const plane = diameter * diameter;
  const radius = BLOCK_LIGHT_RADIUS;
  const localIndex = (dx, dy, dz) =>
    dx + radius + diameter * (dz + radius + diameter * (dy + radius));

  let head = 0;
  let tail = 0;
  let count = 0;
  const enqueue = (index) => {
    if (inQueue[index]) return;
    work[tail] = index;
    tail = (tail + 1) % BLOCK_LIGHT_SAMPLE_VOLUME;
    count++;
    inQueue[index] = 1;
  };

  const origin = localIndex(0, 0, 0);
  cost[origin] = 0;
  enqueue(origin);
  let best = 0;

  const relax = (dx, dy, dz, nextCost) => {
    if (Math.abs(dx) > radius || Math.abs(dy) > radius || Math.abs(dz) > radius) return;
    const worldY = centreY + dy;
    if (worldY < 0 || worldY >= WORLD_HEIGHT) return;
    const worldX = centreX + dx;
    const worldZ = centreZ + dz;
    if (isLoaded && !isLoaded(worldX, worldZ)) return;
    const index = localIndex(dx, dy, dz);
    if (nextCost >= cost[index]) return;
    cost[index] = nextCost;
    enqueue(index);
  };

  while (count > 0) {
    const index = work[head];
    head = (head + 1) % BLOCK_LIGHT_SAMPLE_VOLUME;
    count--;
    inQueue[index] = 0;

    const ly = Math.floor(index / plane);
    const withinPlane = index - ly * plane;
    const lz = Math.floor(withinPlane / diameter);
    const lx = withinPlane - lz * diameter;
    const dx = lx - radius;
    const dy = ly - radius;
    const dz = lz - radius;
    const currentCost = cost[index];
    const blockId = getBlock(centreX + dx, centreY + dy, centreZ + dz);
    const emitted = LIGHT_LEVEL[blockId] ?? 0;
    if (emitted > currentCost) best = Math.max(best, emitted - currentCost);
    if (best >= BLOCK_LIGHT_RADIUS || currentCost >= BLOCK_LIGHT_RADIUS - 1) continue;

    // In reverse, leaving the current voxel is equivalent to forward light
    // entering it, so attenuation belongs to the current voxel, not neighbour.
    const nextCost = currentCost + Math.max(1, LIGHT_ATTENUATION[blockId] ?? 15);
    if (nextCost >= BLOCK_LIGHT_RADIUS) continue;
    relax(dx - 1, dy, dz, nextCost);
    relax(dx + 1, dy, dz, nextCost);
    relax(dx, dy - 1, dz, nextCost);
    relax(dx, dy + 1, dz, nextCost);
    relax(dx, dy, dz - 1, nextCost);
    relax(dx, dy, dz + 1, nextCost);
  }

  return Math.max(0, Math.min(BLOCK_LIGHT_RADIUS, best));
}

/**
 * Extracts the target chunk's 18x130x18 padded light volume from the centre of
 * a propagated 3x3 chunk neighbourhood.
 */
export function extractPaddedBlockLight(source, destination = null) {
  if (!(source instanceof Uint8Array) || source.length !== LIGHT_VOLUME) {
    throw new TypeError(`Expected a ${LIGHT_VOLUME}-byte propagated light volume`);
  }
  const out = destination instanceof Uint8Array && destination.length === PADDED_VOLUME
    ? destination
    : new Uint8Array(PADDED_VOLUME);
  out.fill(0);

  for (let y = 0; y < WORLD_HEIGHT; y++) {
    const destinationY = y + 1;
    for (let localZ = -1; localZ <= CHUNK_SIZE_Z; localZ++) {
      const sourceZ = LIGHT_TARGET_OFFSET_Z + localZ;
      const destinationZ = localZ + 1;
      const sourceStart = blockLightIndex(
        LIGHT_TARGET_OFFSET_X - 1,
        y,
        sourceZ,
        LIGHT_VOLUME_SIZE_X,
        LIGHT_VOLUME_SIZE_Z
      );
      const destinationStart =
        PADDED_SIZE_X * (destinationZ + PADDED_SIZE_Z * destinationY);
      out.set(source.subarray(sourceStart, sourceStart + PADDED_SIZE_X), destinationStart);
    }
  }
  return out;
}

/** Propagates directly inside the regular mesher padding for standalone tests. */
export function propagatePaddedBlockLight(
  blocks,
  destination = null,
  queue = null,
  queued = null
) {
  return propagateBlockLight(
    blocks,
    PADDED_SIZE_X,
    PADDED_SIZE_Y,
    PADDED_SIZE_Z,
    destination,
    queue,
    queued
  );
}

export default propagateBlockLight;
