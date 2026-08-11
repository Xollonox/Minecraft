/**
 * A dropped block, waiting to be picked up.
 *
 * Behaviour worth noting:
 *
 *  - **Pickup delay.** A freshly dropped item cannot be collected for a fraction
 *    of a second. Without it, breaking a block in survival mode would instantly
 *    put the drop back in your inventory before it was ever visible, which makes
 *    the whole drop system look broken.
 *  - **Merging.** Items of the same type that come to rest near each other merge
 *    into one stack. A cave-in or a felled tree otherwise leaves dozens of
 *    entities sitting in a pile, each one costing an update and a draw instance.
 *  - **Magnetism.** Once inside the pickup radius the item accelerates towards the
 *    player rather than teleporting, so collection reads as a movement.
 */

import { ENTITIES } from '../config/GameConfig.js';
import { IS_LIQUID } from '../world/BlockRegistry.js';
import { ItemStack } from '../items/ItemStack.js';
import { Entity } from './Entity.js';

/** Vertical bob amplitude, in blocks. */
const BOB_AMPLITUDE = 0.055;
/** Bob cycles per second. */
const BOB_SPEED = 1.9;
/** Spin rate in radians per second. */
const SPIN_SPEED = 1.35;
/** Acceleration towards the player once inside the pickup radius. */
const MAGNET_ACCELERATION = 15;
/** Upward speed a fully submerged item settles towards, in blocks per second. */
const BUOYANCY_RISE = 1.4;
/** How quickly buoyancy overrides the current vertical velocity. */
const BUOYANCY_DAMPING = 6;

export class ItemEntity extends Entity {
  constructor() {
    super();
    /**
     * The stack being carried.
     *
     * A real `ItemStack` rather than a block id, so a dropped tool keeps its
     * accumulated damage and a dropped non-block item (bread, an ingot) can exist
     * at all. Null while the entity sits unused in the pool.
     * @type {ItemStack|null}
     */
    this.stack = null;
    /** Seconds before the item may be collected. */
    this.pickupDelay = 0;
    /** Vertical bob offset applied at render time only. */
    this.bobOffset = 0;

    this.halfSize = 0.14;
    this.height = 0.28;
    this.restitution = 0.28;
    this.groundDrag = 6;
    this.lifetime = ENTITIES.itemLifetime;
  }

  /**
   * Re-initialises a pooled item.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {ItemStack} stack Taken over by the entity, not copied.
   * @param {{x: number, y: number, z: number}} [impulse] Initial velocity.
   */
  spawn(x, y, z, stack, impulse = null) {
    this.reset(x, y, z);
    this.stack = stack;
    this.pickupDelay = ENTITIES.itemPickupDelay;
    this.bobOffset = 0;
    // Random spin phase so a pile of items is not perfectly synchronised.
    this.rotation = (x * 1.7 + z * 2.3) % (Math.PI * 2);

    if (impulse) {
      this.velocityX = impulse.x;
      this.velocityY = impulse.y;
      this.velocityZ = impulse.z;
    } else {
      // A gentle pop so drops scatter instead of stacking in one column.
      this.velocityX = (Math.random() - 0.5) * 1.4;
      this.velocityY = 1.6 + Math.random() * 0.7;
      this.velocityZ = (Math.random() - 0.5) * 1.4;
    }
    return this;
  }

  /**
   * Advances the item.
   *
   * @param {number} dt
   * @param {import('../world/World.js').World} world
   * @param {{x: number, y: number, z: number}|null} magnetTarget Player position,
   *   or null when collection is disabled.
   */
  update(dt, world, magnetTarget = null) {
    if (this.pickupDelay > 0) this.pickupDelay = Math.max(0, this.pickupDelay - dt);

    // Magnetism is applied as acceleration before the base physics step so the
    // normal collision resolution still applies and items cannot be dragged
    // through walls.
    if (magnetTarget && this.pickupDelay <= 0) {
      const dx = magnetTarget.x - this.x;
      const dy = magnetTarget.y + 0.6 - this.y;
      const dz = magnetTarget.z - this.z;
      const distanceSquared = dx * dx + dy * dy + dz * dz;
      const radius = ENTITIES.itemPickupRadius * 2.2;
      if (distanceSquared < radius * radius && distanceSquared > 1e-4) {
        const distance = Math.sqrt(distanceSquared);
        const pull = (MAGNET_ACCELERATION * dt) / distance;
        this.velocityX += dx * pull;
        this.velocityY += dy * pull * 0.6;
        this.velocityZ += dz * pull;
      }
    }

    super.update(dt, world);

    // Buoyancy. The base `Entity` sinks in liquid, which is right for a falling
    // block but wrong for a dropped item: sinking means anything dropped over
    // water settles on the seabed, out of reach, and is effectively destroyed.
    // A dropped item should float where the player can still collect it.
    //
    // Applied after the physics step so it works against the gravity that step
    // just applied, and damped towards a small upward drift rather than set
    // directly, so an item entering water decelerates instead of snapping.
    if (this.inLiquid) {
      const submerged = IS_LIQUID[
        world.getBlock(Math.floor(this.x), Math.floor(this.y + this.height), Math.floor(this.z))
      ] === 1;
      // Fully under: push up firmly. At the surface: hold position with a gentle
      // bob, which is what makes a raft of items sit visibly on the water.
      const target = submerged ? BUOYANCY_RISE : 0;
      this.velocityY += (target - this.velocityY) * Math.min(1, BUOYANCY_DAMPING * dt);
    }

    this.rotation += SPIN_SPEED * dt;
    if (this.rotation > Math.PI * 2) this.rotation -= Math.PI * 2;
    // Bob is purely visual: it never affects the collision box, so an item cannot
    // bob its way through a floor.
    this.bobOffset = Math.sin(this.age * BOB_SPEED * Math.PI) * BOB_AMPLITUDE;
  }

  /** True when the player is close enough to collect this item. */
  canBeCollectedBy(x, y, z) {
    if (this.pickupDelay > 0 || !this.alive) return false;
    const radius = ENTITIES.itemPickupRadius;
    return this.distanceSquaredTo(x, y + 0.6, z) <= radius * radius;
  }

  /**
   * Attempts to merge another item's stack into this one.
   * @param {ItemEntity} other
   * @returns {boolean} True when `other` was fully absorbed and should be killed.
   */
  tryMerge(other) {
    if (!other.alive || other === this) return false;
    if (!this.stack || !other.stack) return false;
    // `canMergeWith` is the single authority on compatibility, so two tools with
    // different wear will not silently collapse into one entity.
    if (!this.stack.canMergeWith(other.stack)) return false;

    const radius = ENTITIES.itemMergeRadius;
    if (this.distanceSquaredTo(other.x, other.y, other.z) > radius * radius) return false;

    const moved = this.stack.merge(other.stack);
    if (moved === 0) return false;

    // Merging resets the delay slightly so a merged pile does not vanish into the
    // player the instant it forms.
    this.pickupDelay = Math.max(this.pickupDelay, 0.1);
    if (other.stack.isEmpty) {
      other.kill();
      return true;
    }
    return false;
  }


  /** Serialises a live dropped stack for crash-safe world persistence. */
  toJSON() {
    if (!this.alive || !this.stack || this.stack.isEmpty) return null;
    return {
      kind: 'item',
      ...this.toBaseJSON(),
      stack: this.stack.toJSON(),
      pickupDelay: this.pickupDelay,
      lifetimeRemaining: Math.max(0, this.lifetime - this.age),
    };
  }

  /** Restores one validated dropped-item record into this pooled instance. */
  fromJSON(data) {
    if (!data || data.kind !== 'item') return false;
    const stack = ItemStack.fromJSON(data.stack);
    const x = Number(data.x);
    const y = Number(data.y);
    const z = Number(data.z);
    if (!stack || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
    this.spawn(x, y, z, stack, { x: 0, y: 0, z: 0 });
    this.restoreBaseJSON(data);
    this.pickupDelay = Math.max(0, Math.min(60, Number(data.pickupDelay) || 0));
    const remaining = Number(data.lifetimeRemaining);
    if (Number.isFinite(remaining)) {
      this.age = Math.max(0, this.lifetime - Math.max(0, Math.min(this.lifetime, remaining)));
    }
    return true;
  }

  /** Item id being carried, or null. */
  get itemId() {
    return this.stack?.itemId ?? null;
  }

  /** Quantity carried. */
  get count() {
    return this.stack?.quantity ?? 0;
  }

  /** Render Y, including the visual bob. */
  get renderY() {
    return this.y + this.bobOffset;
  }

  kill() {
    super.kill();
    // Release the stack so the pooled entity does not pin it alive.
    this.stack = null;
  }
}

export default ItemEntity;
