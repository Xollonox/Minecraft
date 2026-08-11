/**
 * Axis-aligned box against voxel grid collision.
 *
 * ## Why axis-separated resolution
 *
 * Movement is applied one axis at a time — Y, then X, then Z — and each axis is
 * resolved before the next is attempted. This is what produces correct *sliding*:
 * walking diagonally into a wall stops the blocked axis while the free axis keeps
 * moving, instead of stopping the player dead. Resolving all three together would
 * require choosing a single separation direction and gets the corner cases wrong.
 *
 * Y goes first so that landing is decided before horizontal movement, which is
 * what makes `onGround` reliable on the same frame the player touches down.
 *
 * ## Why sub-stepping
 *
 * A "move then push out of the wall" resolver is only correct while the step is
 * smaller than one block. At sprint-fly speed a single 1/60 s step is 0.48 blocks,
 * which is fine, but a hitched frame or a future speed increase would not be. Any
 * movement longer than `MAX_SUBSTEP` is therefore split, which makes tunnelling
 * impossible by construction rather than by luck.
 *
 * ## Step-up
 *
 * When a horizontal move is blocked while grounded, the mover retries it lifted by
 * `stepHeight`. If the lifted move succeeds *and* the player fits there, it is
 * kept. This is what lets you walk up a one-block ledge without jumping, and it is
 * gated on being grounded so it cannot be used to climb walls in mid-air.
 */

import { PHYSICS, WORLD_HEIGHT } from '../config/GameConfig.js';
import {
  aabbIntersectsBox,
  getCollisionShape,
  hasCustomVoxelShape,
} from '../world/BlockModels.js';

/** Longest movement applied in one resolution pass, in blocks. */
const MAX_SUBSTEP = 0.4;

/**
 * @typedef {Object} MoveResult
 * @property {boolean} collidedX
 * @property {boolean} collidedY
 * @property {boolean} collidedZ
 * @property {boolean} onGround True when the box is resting on something.
 * @property {boolean} hitCeiling
 * @property {boolean} steppedUp
 * @property {number} verticalImpact Downward speed at the moment of landing.
 */

export class PlayerCollision {
  /**
   * @param {import('../world/World.js').World} world
   */
  constructor(world) {
    this._world = world;
    /** @type {MoveResult} Reused to keep the mover allocation-free. */
    this._result = {
      collidedX: false,
      collidedY: false,
      collidedZ: false,
      onGround: false,
      hitCeiling: false,
      steppedUp: false,
      verticalImpact: 0,
    };
  }

  /**
   * Moves a box, resolving collisions.
   *
   * @param {{x: number, y: number, z: number}} position Feet centre; mutated.
   * @param {number} width Full width (and depth) of the box.
   * @param {number} height Full height of the box.
   * @param {{x: number, y: number, z: number}} delta Desired movement.
   * @param {Object} [options]
   * @param {boolean} [options.allowStepUp]
   * @param {number} [options.stepHeight]
   * @returns {MoveResult}
   */
  move(position, width, height, delta, options = {}) {
    const result = this._result;
    result.collidedX = false;
    result.collidedY = false;
    result.collidedZ = false;
    result.onGround = false;
    result.hitCeiling = false;
    result.steppedUp = false;
    result.verticalImpact = 0;

    const half = width * 0.5;
    const allowStepUp = options.allowStepUp !== false;
    const stepHeight = options.stepHeight ?? PHYSICS.stepHeight;

    // Split long movements so a single pass never crosses more than one block.
    const longest = Math.max(Math.abs(delta.x), Math.abs(delta.y), Math.abs(delta.z));
    const steps = Math.max(1, Math.ceil(longest / MAX_SUBSTEP));
    const stepX = delta.x / steps;
    const stepY = delta.y / steps;
    const stepZ = delta.z / steps;

    for (let i = 0; i < steps; i++) {
      // --- vertical ---
      if (stepY !== 0) {
        const before = position.y;
        position.y += stepY;
        if (this._overlaps(position, half, height)) {
          // Resolve against the actual voxel-shape face rather than the integer
          // block boundary. This is what makes lower slabs land at y+0.5 and
          // open trapdoors stop the player at their thin vertical panel.
          const resolved = this._resolveVerticalOverlap(
            position,
            before,
            half,
            height,
            stepY
          );
          if (!resolved || this._overlaps(position, half, height)) position.y = before;

          if (stepY < 0) {
            result.onGround = true;
            result.verticalImpact = -stepY * steps;
          } else {
            result.hitCeiling = true;
          }
          result.collidedY = true;
        }
      }

      // --- horizontal, X then Z, each resolved independently so we slide ---
      if (stepX !== 0) {
        const before = position.x;
        position.x += stepX;
        if (this._overlaps(position, half, height)) {
          let resolved = false;
          if (allowStepUp && result.onGround) {
            resolved = this._tryStepUp(position, half, height, stepHeight, 'x', before, stepX);
            if (resolved) result.steppedUp = true;
          }
          if (!resolved) {
            position.x = before;
            result.collidedX = true;
          }
        }
      }

      if (stepZ !== 0) {
        const before = position.z;
        position.z += stepZ;
        if (this._overlaps(position, half, height)) {
          let resolved = false;
          if (allowStepUp && result.onGround) {
            resolved = this._tryStepUp(position, half, height, stepHeight, 'z', before, stepZ);
            if (resolved) result.steppedUp = true;
          }
          if (!resolved) {
            position.z = before;
            result.collidedZ = true;
          }
        }
      }
    }

    // Final ground probe. Done separately from the vertical pass because the
    // player may have been placed on the ground without any downward movement
    // (spawning, stepping up, or standing still).
    if (!result.onGround) {
      result.onGround = this._restingOnGround(position, half, height);
    }

    return result;
  }

  /**
   * Snaps an overlapping vertical move to the exact face it crossed.
   *
   * `beforeY` is known-free. Only faces crossed between that point and the
   * candidate are considered, which prevents a nearby stair component from
   * pulling the player onto the wrong step.
   */
  _resolveVerticalOverlap(position, beforeY, half, height, deltaY) {
    const skin = PHYSICS.skin;
    const minX = Math.floor(position.x - half + skin);
    const maxX = Math.floor(position.x + half - skin);
    const minZ = Math.floor(position.z - half + skin);
    const maxZ = Math.floor(position.z + half - skin);
    const lowY = Math.floor(Math.min(beforeY, position.y) - 1);
    const highY = Math.floor(Math.max(beforeY + height, position.y + height) + 1);
    const boxMinX = position.x - half + skin;
    const boxMaxX = position.x + half - skin;
    const boxMinZ = position.z - half + skin;
    const boxMaxZ = position.z + half - skin;
    const beforeTop = beforeY + height;
    const afterTop = position.y + height;
    const epsilon = 1e-7;
    let surface = deltaY < 0 ? -Infinity : Infinity;

    // The world floor behaves like a solid plane at y=0.
    if (deltaY < 0 && position.y < 0 && beforeY >= 0) surface = 0;

    for (let y = Math.max(0, lowY); y <= Math.min(WORLD_HEIGHT - 1, highY); y++) {
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          if (!this._world.isCollidable(x, y, z)) continue;
          const blockId = this._world.getBlock(x, y, z);
          const state = this._world.getBlockState(x, y, z);
          const boxes = getCollisionShape(blockId, state);
          for (const voxelBox of boxes) {
            const worldMinX = x + voxelBox[0];
            const worldMaxX = x + voxelBox[3];
            const worldMinZ = z + voxelBox[2];
            const worldMaxZ = z + voxelBox[5];
            if (
              boxMinX >= worldMaxX - epsilon ||
              boxMaxX <= worldMinX + epsilon ||
              boxMinZ >= worldMaxZ - epsilon ||
              boxMaxZ <= worldMinZ + epsilon
            ) continue;

            if (deltaY < 0) {
              const top = y + voxelBox[4];
              if (
                beforeY >= top - skin - epsilon &&
                position.y < top - skin + epsilon
              ) surface = Math.max(surface, top);
            } else {
              const bottom = y + voxelBox[1];
              if (
                beforeTop <= bottom + skin + epsilon &&
                afterTop > bottom + skin - epsilon
              ) surface = Math.min(surface, bottom);
            }
          }
        }
      }
    }

    if (!Number.isFinite(surface)) return false;
    position.y = deltaY < 0 ? surface + skin : surface - height - skin;
    return true;
  }

  /**
   * Attempts to lift the box over a low obstruction and complete the move.
   * @returns {boolean} True when the stepped-up position was accepted.
   */
  _tryStepUp(position, half, height, stepHeight, axis, beforeValue, step) {
    const originalY = position.y;
    const originalValue = position[axis];

    // Try progressively smaller lifts, smallest ledge first would be cheaper but
    // the largest lift is the one most likely to clear, so start there and
    // settle back down afterwards.
    for (const lift of [stepHeight, stepHeight * 0.6, stepHeight * 0.3]) {
      position.y = originalY + lift;
      position[axis] = beforeValue + step;
      if (!this._overlaps(position, half, height)) {
        // Settle back onto whatever we just stepped onto so the player does not
        // hover above a half-slab-height ledge.
        this._settleDown(position, half, height, lift);
        return true;
      }
    }

    position.y = originalY;
    position[axis] = originalValue;
    return false;
  }

  /**
   * Lowers the box in small increments until it would collide, up to `maxDrop`.
   * Leaves the box at the last free position.
   */
  _settleDown(position, half, height, maxDrop) {
    const startY = position.y;
    const stepSize = 0.05;
    for (let dropped = stepSize; dropped <= maxDrop; dropped += stepSize) {
      const candidate = startY - dropped;
      const previous = position.y;
      position.y = candidate;
      if (this._overlaps(position, half, height)) {
        position.y = previous;
        return;
      }
    }
    // Nothing within the step height: keep the lifted position. Gravity will
    // bring the player down on the next step if there really is a drop.
  }

  /**
   * True when a collidable block intersects the box.
   *
   * The bounds are inset by the skin so a box resting exactly on a surface, or
   * flush against a wall, does not report an overlap. Without that inset the
   * resolver would immediately push the player away again every frame, which is
   * the classic "stuck vibrating against a wall" bug.
   */
  _overlaps(position, half, height) {
    const skin = PHYSICS.skin;
    const minX = Math.floor(position.x - half + skin);
    const maxX = Math.floor(position.x + half - skin);
    const minY = Math.floor(position.y + skin);
    const maxY = Math.floor(position.y + height - skin);
    const minZ = Math.floor(position.z - half + skin);
    const maxZ = Math.floor(position.z + half - skin);

    const world = this._world;
    const boxMinX = position.x - half + skin;
    const boxMaxX = position.x + half - skin;
    const boxMinY = position.y + skin;
    const boxMaxY = position.y + height - skin;
    const boxMinZ = position.z - half + skin;
    const boxMaxZ = position.z + half - skin;

    for (let y = minY; y <= maxY; y++) {
      // Below the world is solid, above it is empty.
      if (y < 0) return true;
      if (y >= WORLD_HEIGHT) continue;
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          if (!world.isCollidable(x, y, z)) continue;
          const blockId = world.getBlock(x, y, z);
          if (!hasCustomVoxelShape(blockId)) return true;
          const boxes = getCollisionShape(blockId, world.getBlockState(x, y, z));
          for (const voxelBox of boxes) {
            if (
              aabbIntersectsBox(
                boxMinX,
                boxMinY,
                boxMinZ,
                boxMaxX,
                boxMaxY,
                boxMaxZ,
                x,
                y,
                z,
                voxelBox
              )
            ) return true;
          }
        }
      }
    }
    return false;
  }

  /** True when there is a collidable block immediately beneath the box. */
  _restingOnGround(position, half, height) {
    const probe = position.y;
    position.y -= PHYSICS.skin * 4;
    const grounded = this._overlaps(position, half, height);
    position.y = probe;
    return grounded;
  }

  /**
   * True when a box at this position would intersect terrain.
   * Used to validate block placement and respawn positions.
   *
   * @param {{x: number, y: number, z: number}} position
   * @param {number} width
   * @param {number} height
   */
  isBlocked(position, width, height) {
    return this._overlaps(position, width * 0.5, height);
  }

  /**
   * True when the box overlaps the block at the given coordinates.
   * Placement uses this to refuse to entomb the player.
   *
   * @param {{x: number, y: number, z: number}} position Feet centre.
   * @param {number} width
   * @param {number} height
   * @param {number} blockX
   * @param {number} blockY
   * @param {number} blockZ
   */
  intersectsBlock(position, width, height, blockX, blockY, blockZ, blockId = null, state = 0) {
    const half = width * 0.5;
    const minX = position.x - half;
    const maxX = position.x + half;
    const minY = position.y;
    const maxY = position.y + height;
    const minZ = position.z - half;
    const maxZ = position.z + half;
    const resolvedId = blockId ?? this._world.getBlock(blockX, blockY, blockZ);
    const boxes = hasCustomVoxelShape(resolvedId)
      ? getCollisionShape(resolvedId, state)
      : getCollisionShape(resolvedId, 0);
    for (const voxelBox of boxes) {
      if (
        aabbIntersectsBox(
          minX,
          minY,
          minZ,
          maxX,
          maxY,
          maxZ,
          blockX,
          blockY,
          blockZ,
          voxelBox
        )
      ) return true;
    }
    return false;
  }

  /**
   * Block id the box is standing on, for footstep sounds and particles.
   * @returns {number} Block id, or 0 (air) when airborne.
   */
  getGroundBlock(position, width) {
    const half = width * 0.5;
    const y = Math.floor(position.y - 0.08);
    const world = this._world;
    // Check the four corners and the centre; the first solid one wins.
    const samples = [
      [position.x, position.z],
      [position.x - half * 0.8, position.z - half * 0.8],
      [position.x + half * 0.8, position.z - half * 0.8],
      [position.x - half * 0.8, position.z + half * 0.8],
      [position.x + half * 0.8, position.z + half * 0.8],
    ];
    for (const [x, z] of samples) {
      const blockX = Math.floor(x);
      const blockZ = Math.floor(z);
      if (world.isCollidable(blockX, y, blockZ)) return world.getBlock(blockX, y, blockZ);
    }
    return 0;
  }

  /**
   * Finds the nearest free vertical position for a box, searching upwards then
   * downwards. Used to recover from spawning or loading inside geometry.
   *
   * @param {{x: number, y: number, z: number}} position Mutated on success.
   * @param {number} width
   * @param {number} height
   * @param {number} [searchRange] Blocks to search in each direction.
   * @returns {boolean} True when a free position was found.
   */
  resolveStuck(position, width, height, searchRange = 24) {
    if (!this.isBlocked(position, width, height)) return true;

    const originalY = position.y;
    // Upwards first: pushing a stuck player up is almost always the safe choice,
    // since down leads further into the ground.
    for (let offset = 1; offset <= searchRange; offset++) {
      position.y = originalY + offset;
      if (position.y + height < WORLD_HEIGHT && !this.isBlocked(position, width, height)) {
        return true;
      }
    }
    for (let offset = 1; offset <= searchRange; offset++) {
      position.y = originalY - offset;
      if (position.y >= 1 && !this.isBlocked(position, width, height)) return true;
    }

    position.y = originalY;
    return false;
  }
}

export default PlayerCollision;
