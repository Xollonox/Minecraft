/**
 * Voxel coordinate maths.
 *
 * Everything here is written to behave correctly for negative world
 * coordinates. JavaScript's `%` is a *remainder*, not a mathematical modulo:
 * `-1 % 16` is `-1`, not `15`. Using it directly to derive local chunk
 * coordinates is the single most common source of "invisible wall at x = -1"
 * bugs in voxel engines, so this module is the only place allowed to do the
 * conversion and the rest of the engine calls into it.
 */

import {
  CHUNK_SIZE_X,
  CHUNK_SIZE_Z,
  WORLD_HEIGHT,
  IDX_SHIFT_Y,
  IDX_SHIFT_Z,
  PAD,
  PADDED_SIZE_X,
  PADDED_SIZE_Z,
} from '../config/GameConfig.js';

/** Floor division that is correct for negative numerators. */
export function floorDiv(value, divisor) {
  return Math.floor(value / divisor);
}

/** Mathematical modulo: the result always has the sign of `divisor`. */
export function mod(value, divisor) {
  const r = value % divisor;
  return r < 0 ? r + divisor : r;
}

/** Converts a continuous world coordinate to an integer block coordinate. */
export function worldToBlock(value) {
  return Math.floor(value);
}

/** Chunk X index containing the given block X. */
export function blockToChunkX(blockX) {
  return blockX >= 0 ? (blockX / CHUNK_SIZE_X) | 0 : ~(~blockX / CHUNK_SIZE_X);
}

/** Chunk Z index containing the given block Z. */
export function blockToChunkZ(blockZ) {
  return blockZ >= 0 ? (blockZ / CHUNK_SIZE_Z) | 0 : ~(~blockZ / CHUNK_SIZE_Z);
}

/**
 * Local X coordinate (`0 .. CHUNK_SIZE_X - 1`) of a block X.
 *
 * The bitwise AND is a fast, negative-safe positive modulo *because chunk
 * dimensions are powers of two* — `-1 & 15 === 15`. If `CHUNK_SIZE_X` ever
 * stops being a power of two, switch to `mod(blockX, CHUNK_SIZE_X)`.
 */
export function blockToLocalX(blockX) {
  return blockX & (CHUNK_SIZE_X - 1);
}

/** Local Z coordinate (`0 .. CHUNK_SIZE_Z - 1`) of a block Z. See `blockToLocalX`. */
export function blockToLocalZ(blockZ) {
  return blockZ & (CHUNK_SIZE_Z - 1);
}

/**
 * Flat voxel index inside a chunk's typed array.
 * Layout is `x | (z << 4) | (y << 8)`, i.e. X-major within a Z row within a
 * Y slice, which keeps the mesher's inner loop cache friendly.
 */
export function voxelIndex(localX, y, localZ) {
  return localX | (localZ << IDX_SHIFT_Z) | (y << IDX_SHIFT_Y);
}

/** True when a block Y is inside the world's vertical bounds. */
export function isValidY(y) {
  return y >= 0 && y < WORLD_HEIGHT;
}

/** Flat index into a padded meshing volume. Accepts local coords in `-1 .. size`. */
export function paddedIndex(localX, y, localZ) {
  return (
    localX + PAD + PADDED_SIZE_X * (localZ + PAD + PADDED_SIZE_Z * (y + PAD))
  );
}

/**
 * Serialises a chunk coordinate pair to a Map key.
 *
 * A string key is used rather than bit packing because chunk coordinates are
 * unbounded: packing them into a single 32-bit number would silently wrap
 * around after ~32k chunks and corrupt distant worlds.
 *
 * @param {number} chunkX
 * @param {number} chunkZ
 * @returns {string}
 */
export function chunkKey(chunkX, chunkZ) {
  return `${chunkX},${chunkZ}`;
}

/**
 * Parses a chunk key back into coordinates.
 * @param {string} key
 * @param {{x:number,z:number}} [out]
 */
export function parseChunkKey(key, out = { x: 0, z: 0 }) {
  const comma = key.indexOf(',');
  out.x = Number(key.slice(0, comma));
  out.z = Number(key.slice(comma + 1));
  return out;
}

/** Key for a block position, used by sparse edit maps. */
export function blockKey(x, y, z) {
  return `${x},${y},${z}`;
}

/** True when the local coordinates sit on a chunk border. */
export function isBorderBlock(localX, localZ) {
  return localX === 0 || localZ === 0 || localX === CHUNK_SIZE_X - 1 || localZ === CHUNK_SIZE_Z - 1;
}

/**
 * Collects the chunk coordinates that must be re-meshed after a block at the
 * given local position changed. This is always the owning chunk plus, when the
 * block touches a border, the up to three neighbours that can see the new face.
 *
 * @param {number} chunkX
 * @param {number} chunkZ
 * @param {number} localX
 * @param {number} localZ
 * @param {Array<[number, number]>} out Reused array, cleared then filled.
 * @returns {Array<[number, number]>}
 */
export function collectAffectedChunks(chunkX, chunkZ, localX, localZ, out = []) {
  out.length = 0;
  out.push([chunkX, chunkZ]);
  const west = localX === 0;
  const east = localX === CHUNK_SIZE_X - 1;
  const north = localZ === 0;
  const south = localZ === CHUNK_SIZE_Z - 1;
  if (west) out.push([chunkX - 1, chunkZ]);
  if (east) out.push([chunkX + 1, chunkZ]);
  if (north) out.push([chunkX, chunkZ - 1]);
  if (south) out.push([chunkX, chunkZ + 1]);
  // Diagonals matter because ambient occlusion samples corner neighbours.
  if (west && north) out.push([chunkX - 1, chunkZ - 1]);
  if (east && north) out.push([chunkX + 1, chunkZ - 1]);
  if (west && south) out.push([chunkX - 1, chunkZ + 1]);
  if (east && south) out.push([chunkX + 1, chunkZ + 1]);
  return out;
}

/** Squared horizontal distance between two chunk coordinates. */
export function chunkDistanceSq(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

/** Chebyshev (square ring) distance between two chunk coordinates. */
export function chunkRingDistance(ax, az, bx, bz) {
  return Math.max(Math.abs(ax - bx), Math.abs(az - bz));
}
