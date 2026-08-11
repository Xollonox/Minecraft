/**
 * Base class for the small number of things in the world that are not voxels.
 *
 * Entities are pooled: `reset()` re-initialises an instance in place and `alive`
 * marks it as free. Nothing here allocates during play, because a cave-in can
 * spawn a hundred falling blocks in a second and a garbage collection pause in
 * the middle of that is exactly what makes a voxel game feel bad.
 *
 * Collision is deliberately simpler than the player's: a swept AABB against the
 * voxel grid resolved axis by axis, but with no step-up, no crouching and no
 * sub-stepping beyond what the movement magnitude requires. Entities are small
 * and slow enough that this is sufficient, and keeping it separate means the
 * player's collision code does not have to grow options it does not need.
 */

import { PHYSICS, WORLD_HEIGHT } from '../config/GameConfig.js';
import { IS_LIQUID } from '../world/BlockRegistry.js';

/** Longest movement resolved in a single pass, in blocks. */
const MAX_STEP = 0.35;

export class Entity {
  constructor() {
    /** @type {boolean} */
    this.alive = false;
    /** Stable identity while the entity is persisted in a world save. */
    this.uuid = null;
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.velocityX = 0;
    this.velocityY = 0;
    this.velocityZ = 0;
    /** Half-width of the collision box. */
    this.halfSize = 0.125;
    /** Full height of the collision box. */
    this.height = 0.25;
    /** Seconds the entity has existed. */
    this.age = 0;
    /** Seconds before the entity despawns; `Infinity` never expires. */
    this.lifetime = Infinity;
    /** True when resting on the ground. */
    this.onGround = false;
    /** True when inside a liquid. */
    this.inLiquid = false;
    /** Rotation about Y, for spinning items. */
    this.rotation = 0;
    /** Bounce damping applied on impact, 0..1. */
    this.restitution = 0.2;
    /** Horizontal drag per second while grounded. */
    this.groundDrag = 8;
    /** Horizontal drag per second while airborne. */
    this.airDrag = 0.6;
  }

  /**
   * Re-initialises a pooled instance.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  reset(x, y, z, uuid = null) {
    this.alive = true;
    this.uuid = typeof uuid === 'string' && uuid ? uuid : null;
    this.x = x;
    this.y = y;
    this.z = z;
    this.velocityX = 0;
    this.velocityY = 0;
    this.velocityZ = 0;
    this.age = 0;
    this.onGround = false;
    this.inLiquid = false;
    this.rotation = 0;
    return this;
  }

  /** Marks the entity as free for reuse. */
  kill() {
    this.alive = false;
    this.uuid = null;
  }

  /** Shared serialisable physics fields used by persistent entity subclasses. */
  toBaseJSON() {
    return {
      uuid: this.uuid,
      x: this.x,
      y: this.y,
      z: this.z,
      velocityX: this.velocityX,
      velocityY: this.velocityY,
      velocityZ: this.velocityZ,
      age: this.age,
      rotation: this.rotation,
      onGround: this.onGround,
    };
  }

  /** Restores finite shared fields after a subclass has called `reset()`. */
  restoreBaseJSON(data) {
    if (!data || typeof data !== 'object') return this;
    const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    this.uuid = typeof data.uuid === 'string' && data.uuid ? data.uuid.slice(0, 96) : this.uuid;
    this.velocityX = finite(data.velocityX, 0);
    this.velocityY = finite(data.velocityY, 0);
    this.velocityZ = finite(data.velocityZ, 0);
    this.age = Math.max(0, finite(data.age, 0));
    this.rotation = finite(data.rotation, 0);
    this.onGround = Boolean(data.onGround);
    return this;
  }

  /**
   * Advances physics.
   *
   * @param {number} dt
   * @param {import('../world/World.js').World} world
   */
  update(dt, world) {
    this.age += dt;
    if (this.age >= this.lifetime) {
      this.kill();
      return;
    }

    this.inLiquid = IS_LIQUID[world.getBlock(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z))] === 1;

    // Gravity, reduced and terminal-capped in liquid so items sink gently.
    const gravity = this.inLiquid ? PHYSICS.waterGravity * 0.7 : PHYSICS.gravity;
    this.velocityY -= gravity * dt;
    const terminal = this.inLiquid ? 2.4 : PHYSICS.terminalVelocity;
    if (this.velocityY < -terminal) this.velocityY = -terminal;

    // Drag.
    const drag = this.inLiquid ? 5 : this.onGround ? this.groundDrag : this.airDrag;
    const decay = Math.min(1, drag * dt);
    this.velocityX -= this.velocityX * decay;
    this.velocityZ -= this.velocityZ * decay;
    if (Math.abs(this.velocityX) < 0.004) this.velocityX = 0;
    if (Math.abs(this.velocityZ) < 0.004) this.velocityZ = 0;

    this._move(dt, world);

    // Entities that somehow leave the world are removed rather than falling
    // forever and being simulated for nothing.
    if (this.y < -8 || this.y > WORLD_HEIGHT + 32) this.kill();
  }

  /** Moves and resolves collisions, one axis at a time. */
  _move(dt, world) {
    let deltaX = this.velocityX * dt;
    let deltaY = this.velocityY * dt;
    let deltaZ = this.velocityZ * dt;

    const longest = Math.max(Math.abs(deltaX), Math.abs(deltaY), Math.abs(deltaZ));
    const steps = Math.max(1, Math.ceil(longest / MAX_STEP));
    deltaX /= steps;
    deltaY /= steps;
    deltaZ /= steps;

    let grounded = false;

    for (let step = 0; step < steps; step++) {
      // Y
      if (deltaY !== 0) {
        const before = this.y;
        this.y += deltaY;
        if (this._blocked(world)) {
          this.y = before;
          if (deltaY < 0) {
            grounded = true;
            // Bounce, then settle.
            this.velocityY = -this.velocityY * this.restitution;
            if (Math.abs(this.velocityY) < 0.6) this.velocityY = 0;
          } else {
            this.velocityY = 0;
          }
          deltaY = 0;
        }
      }

      // X
      if (deltaX !== 0) {
        const before = this.x;
        this.x += deltaX;
        if (this._blocked(world)) {
          this.x = before;
          this.velocityX = -this.velocityX * this.restitution * 0.5;
          deltaX = 0;
        }
      }

      // Z
      if (deltaZ !== 0) {
        const before = this.z;
        this.z += deltaZ;
        if (this._blocked(world)) {
          this.z = before;
          this.velocityZ = -this.velocityZ * this.restitution * 0.5;
          deltaZ = 0;
        }
      }
    }

    this.onGround = grounded || this._restingOnGround(world);
  }

  /** True when the entity's box intersects a collidable block. */
  _blocked(world) {
    const minX = Math.floor(this.x - this.halfSize);
    const maxX = Math.floor(this.x + this.halfSize);
    const minY = Math.floor(this.y);
    const maxY = Math.floor(this.y + this.height);
    const minZ = Math.floor(this.z - this.halfSize);
    const maxZ = Math.floor(this.z + this.halfSize);

    for (let y = minY; y <= maxY; y++) {
      if (y < 0) return true;
      if (y >= WORLD_HEIGHT) continue;
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          if (world.isCollidable(x, y, z)) return true;
        }
      }
    }
    return false;
  }

  /** True when there is a collidable block immediately beneath. */
  _restingOnGround(world) {
    const probeY = this.y - 0.02;
    const minX = Math.floor(this.x - this.halfSize);
    const maxX = Math.floor(this.x + this.halfSize);
    const minZ = Math.floor(this.z - this.halfSize);
    const maxZ = Math.floor(this.z + this.halfSize);
    const blockY = Math.floor(probeY);
    if (blockY < 0) return true;
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        if (world.isCollidable(x, blockY, z)) return true;
      }
    }
    return false;
  }

  /** Squared distance to a point, for pickup and culling tests. */
  distanceSquaredTo(x, y, z) {
    const dx = this.x - x;
    const dy = this.y - y;
    const dz = this.z - z;
    return dx * dx + dy * dy + dz * dz;
  }
}

export default Entity;
