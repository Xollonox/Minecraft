/**
 * Voxel raycasting with the Amanatides–Woo DDA algorithm.
 *
 * This walks the ray from voxel to voxel, always stepping across the *nearest*
 * upcoming grid plane. It visits every voxel the ray passes through, in order,
 * and never misses one — which a fixed-step sampling loop does whenever it steps
 * over a thin corner.
 *
 * It is also the only sane way to do this at all: `THREE.Raycaster` would have to
 * test the ray against the triangles of every chunk mesh in range. Here the cost
 * is proportional to the *reach* (about five voxel steps for a five-block reach),
 * completely independent of how much geometry is loaded, and it needs no scene
 * graph at all — just `world.getBlock`.
 *
 * The classic pitfall is the initial `tMax` computation for negative direction
 * components, where the distance to the next plane is measured to the voxel's
 * *lower* boundary rather than its upper one. That is handled explicitly below.
 */

import { WORLD_HEIGHT } from '../config/GameConfig.js';
import { Block } from '../world/BlockTypes.js';
import { IS_LIQUID } from '../world/BlockRegistry.js';
import { getVoxelShape, hasCustomVoxelShape, rayIntersectVoxelShape } from '../world/BlockModels.js';

/**
 * @typedef {Object} RaycastHit
 * @property {boolean} hit
 * @property {number} blockX Integer coordinates of the hit block.
 * @property {number} blockY
 * @property {number} blockZ
 * @property {number} blockId
 * @property {number} blockState
 * @property {number} normalX Face normal, one component is ±1.
 * @property {number} normalY
 * @property {number} normalZ
 * @property {number} placeX Coordinates of the empty voxel against the hit face.
 * @property {number} placeY
 * @property {number} placeZ
 * @property {number} distance Distance from the ray origin to the hit face.
 * @property {number} pointX Exact intersection point.
 * @property {number} pointY
 * @property {number} pointZ
 */

/** Creates an empty hit record. */
export function createRaycastHit() {
  return {
    hit: false,
    blockX: 0,
    blockY: 0,
    blockZ: 0,
    blockId: Block.AIR,
    blockState: 0,
    normalX: 0,
    normalY: 0,
    normalZ: 0,
    placeX: 0,
    placeY: 0,
    placeZ: 0,
    distance: 0,
    pointX: 0,
    pointY: 0,
    pointZ: 0,
  };
}

export class BlockRaycaster {
  /**
   * @param {import('../world/World.js').World} world
   */
  constructor(world) {
    this._world = world;
    this._hit = createRaycastHit();
  }

  /**
   * Casts a ray through the voxel grid.
   *
   * @param {{x: number, y: number, z: number}} origin
   * @param {{x: number, y: number, z: number}} direction Need not be normalised.
   * @param {number} maxDistance In blocks.
   * @param {Object} [options]
   * @param {boolean} [options.includeLiquids] Stop on water as well as solids.
   * @param {RaycastHit} [options.out] Target record; defaults to an internal one.
   * @returns {RaycastHit} `hit` is false when nothing was found in range.
   */
  cast(origin, direction, maxDistance, options = {}) {
    const out = options.out || this._hit;
    const includeLiquids = options.includeLiquids === true;
    out.hit = false;

    // Normalise so `distance` is measured in blocks.
    const length = Math.hypot(direction.x, direction.y, direction.z);
    if (length < 1e-8 || maxDistance <= 0) return out;
    const dirX = direction.x / length;
    const dirY = direction.y / length;
    const dirZ = direction.z / length;

    let voxelX = Math.floor(origin.x);
    let voxelY = Math.floor(origin.y);
    let voxelZ = Math.floor(origin.z);

    const stepX = dirX > 0 ? 1 : dirX < 0 ? -1 : 0;
    const stepY = dirY > 0 ? 1 : dirY < 0 ? -1 : 0;
    const stepZ = dirZ > 0 ? 1 : dirZ < 0 ? -1 : 0;

    // Distance along the ray needed to cross one whole voxel per axis.
    const deltaX = stepX === 0 ? Infinity : Math.abs(1 / dirX);
    const deltaY = stepY === 0 ? Infinity : Math.abs(1 / dirY);
    const deltaZ = stepZ === 0 ? Infinity : Math.abs(1 / dirZ);

    // Distance to the first grid plane on each axis. For a negative direction the
    // next plane is the voxel's lower boundary, hence the asymmetry.
    let tMaxX = stepX === 0
      ? Infinity
      : stepX > 0
        ? (voxelX + 1 - origin.x) * deltaX
        : (origin.x - voxelX) * deltaX;
    let tMaxY = stepY === 0
      ? Infinity
      : stepY > 0
        ? (voxelY + 1 - origin.y) * deltaY
        : (origin.y - voxelY) * deltaY;
    let tMaxZ = stepZ === 0
      ? Infinity
      : stepZ > 0
        ? (voxelZ + 1 - origin.z) * deltaZ
        : (origin.z - voxelZ) * deltaZ;

    let normalX = 0;
    let normalY = 0;
    let normalZ = 0;
    let travelled = 0;

    const world = this._world;

    // The origin voxel is tested first. Partial models need an exact AABB hit;
    // otherwise standing in the empty half of a slab would target invisible air.
    const directionUnit = { x: dirX, y: dirY, z: dirZ };
    const originBlockId = world.getBlock(voxelX, voxelY, voxelZ);
    if (this._isTargetable(originBlockId, includeLiquids)) {
      const exact = hasCustomVoxelShape(originBlockId)
        ? this._shapeHit(origin, directionUnit, voxelX, voxelY, voxelZ, originBlockId, maxDistance)
        : { distance: 0, normalX: 0, normalY: 0, normalZ: 0 };
      if (exact) {
        return this._fill(
          out,
          voxelX,
          voxelY,
          voxelZ,
          exact.normalX,
          exact.normalY,
          exact.normalZ,
          exact.distance,
          origin,
          dirX,
          dirY,
          dirZ
        );
      }
    }

    // A generous iteration cap: the true bound is about `3 * maxDistance` steps,
    // and the cap exists purely so a NaN direction can never spin forever.
    const maxSteps = Math.ceil(maxDistance * 3) + 6;

    for (let step = 0; step < maxSteps; step++) {
      // Cross the nearest plane.
      if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
        voxelX += stepX;
        travelled = tMaxX;
        tMaxX += deltaX;
        normalX = -stepX;
        normalY = 0;
        normalZ = 0;
      } else if (tMaxY <= tMaxZ) {
        voxelY += stepY;
        travelled = tMaxY;
        tMaxY += deltaY;
        normalX = 0;
        normalY = -stepY;
        normalZ = 0;
      } else {
        voxelZ += stepZ;
        travelled = tMaxZ;
        tMaxZ += deltaZ;
        normalX = 0;
        normalY = 0;
        normalZ = -stepZ;
      }

      if (travelled > maxDistance) break;

      // Above the world there is nothing to hit, but the ray may come back down,
      // so keep stepping. Below it, nothing can be hit at all.
      if (voxelY >= WORLD_HEIGHT) {
        if (stepY >= 0) break;
        continue;
      }
      if (voxelY < 0) {
        if (stepY <= 0) break;
        continue;
      }

      const blockId = world.getBlock(voxelX, voxelY, voxelZ);
      if (this._isTargetable(blockId, includeLiquids)) {
        const exact = hasCustomVoxelShape(blockId)
          ? this._shapeHit(origin, directionUnit, voxelX, voxelY, voxelZ, blockId, maxDistance)
          : { distance: travelled, normalX, normalY, normalZ };
        if (exact) {
          return this._fill(
            out,
            voxelX,
            voxelY,
            voxelZ,
            exact.normalX,
            exact.normalY,
            exact.normalZ,
            exact.distance,
            origin,
            dirX,
            dirY,
            dirZ
          );
        }
      }
    }

    return out;
  }

  /** Exact hit for partial models; full cubes already intersect at DDA entry. */
  _shapeHit(origin, direction, x, y, z, blockId, maxDistance) {
    if (!hasCustomVoxelShape(blockId)) return null;
    const state = this._world.getBlockState(x, y, z);
    return rayIntersectVoxelShape(
      origin,
      direction,
      x,
      y,
      z,
      getVoxelShape(blockId, state),
      maxDistance
    );
  }

  /** True when the ray should stop at this block. */
  _isTargetable(blockId, includeLiquids) {
    if (blockId === Block.AIR) return false;
    if (!includeLiquids && IS_LIQUID[blockId]) return false;
    return true;
  }

  _fill(out, x, y, z, normalX, normalY, normalZ, distance, origin, dirX, dirY, dirZ) {
    out.hit = true;
    out.blockX = x;
    out.blockY = y;
    out.blockZ = z;
    out.blockId = this._world.getBlock(x, y, z);
    out.blockState = this._world.getBlockState(x, y, z);
    out.normalX = normalX;
    out.normalY = normalY;
    out.normalZ = normalZ;
    // The placement voxel is the empty one on the near side of the hit face.
    out.placeX = x + normalX;
    out.placeY = y + normalY;
    out.placeZ = z + normalZ;
    out.distance = distance;
    out.pointX = origin.x + dirX * distance;
    out.pointY = origin.y + dirY * distance;
    out.pointZ = origin.z + dirZ * distance;
    return out;
  }

  /**
   * Convenience wrapper that casts from a camera.
   *
   * @param {{x: number, y: number, z: number}} eye
   * @param {{x: number, y: number, z: number}} forward
   * @param {number} reach
   * @param {RaycastHit} [out]
   */
  castFromCamera(eye, forward, reach, out) {
    return this.cast(eye, forward, reach, { out });
  }
}

export default BlockRaycaster;
