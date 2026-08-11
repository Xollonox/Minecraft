/**
 * A block in mid-air: sand or gravel that lost its support.
 *
 * The block is removed from the voxel grid when the entity spawns and written
 * back when it lands, so at no point does it exist in both places. That is what
 * keeps the world consistent — a player who saves mid-collapse gets a world where
 * the block is genuinely gone, not one where it exists twice or not at all.
 *
 * ## Landing
 *
 * The entity does not settle where its box happens to stop; it snaps to the voxel
 * grid. It lands in the block position it currently occupies, or one above if that
 * is taken (which happens when two falling blocks land on the same column in the
 * same frame). If neither is free the block is dropped as an item rather than
 * silently deleted.
 */

import { WORLD_HEIGHT } from '../config/GameConfig.js';
import { Entity } from './Entity.js';

/** Grace period before a freshly spawned falling block may land, in seconds. */
const SETTLE_DELAY = 0.02;

export class FallingBlockEntity extends Entity {
  constructor() {
    super();
    /** Block id being carried. */
    this.blockId = 0;
    /** True once the entity has landed and is waiting to be removed. */
    this.settled = false;
    /** Position the block should be written back to, set on landing. */
    this.settleX = 0;
    this.settleY = 0;
    this.settleZ = 0;

    // A full block: the box matches the voxel it represents.
    this.halfSize = 0.49;
    this.height = 0.98;
    // Sand does not bounce.
    this.restitution = 0;
    this.groundDrag = 30;
    this.airDrag = 0;
    this.lifetime = 30;
  }

  /**
   * Re-initialises a pooled falling block.
   * @param {number} blockX Integer block coordinates it came from.
   * @param {number} blockY
   * @param {number} blockZ
   * @param {number} blockId
   */
  spawn(blockX, blockY, blockZ, blockId) {
    // Centre of the voxel horizontally, bottom of the voxel vertically, so the
    // entity's box exactly covers the block it replaced.
    this.reset(blockX + 0.5, blockY, blockZ + 0.5);
    this.blockId = blockId;
    this.settled = false;
    this.settleX = blockX;
    this.settleY = blockY;
    this.settleZ = blockZ;
    // A tiny initial velocity avoids a one-frame pause before the fall starts.
    this.velocityY = -0.2;
    return this;
  }

  /**
   * Advances the fall and detects landing.
   *
   * @param {number} dt
   * @param {import('../world/World.js').World} world
   */
  update(dt, world) {
    if (this.settled) return;

    const previousY = this.y;
    super.update(dt, world);
    if (!this.alive) return;

    // Landing: grounded, or vertical motion stopped after having started.
    const stopped = this.onGround || (this.age > SETTLE_DELAY && this.y >= previousY - 1e-6 && this.velocityY === 0);
    if (!stopped) return;

    this.settled = true;
    // Snap to the grid. Rounding the horizontal centre rather than flooring the
    // edge keeps the block in the column it fell down.
    this.settleX = Math.floor(this.x);
    this.settleZ = Math.floor(this.z);
    this.settleY = Math.max(0, Math.min(WORLD_HEIGHT - 1, Math.round(this.y)));
  }

  /** Sideways drift is not wanted: sand falls straight down. */
  _move(dt, world) {
    this.velocityX = 0;
    this.velocityZ = 0;
    super._move(dt, world);
  }
}

export default FallingBlockEntity;
