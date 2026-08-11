/**
 * Melee attacks.
 *
 * ## Why attacking is not just "breaking, but for entities"
 *
 * Breaking a block accumulates progress while the button is held. Attacking is the
 * opposite: it is a discrete, rate-limited event on the *press*. Holding the button
 * against a mob must not deal continuous damage, and spamming clicks must not
 * out-damage the weapon's stated attack speed — otherwise the fastest weapon is
 * always whichever one the player can click through quickest, and `attackSpeed`
 * becomes decorative.
 *
 * So the cooldown is derived from the held item's `attackSpeed` and enforced here,
 * once, for every attack in the game.
 *
 * ## Reach and target selection
 *
 * Entities are picked by a ray-versus-box sweep rather than by "nearest entity in
 * front", because the latter lets a player hit a mob through a wall. The block
 * raycast result bounds the search: anything further away than the block the
 * crosshair is on is behind that block and cannot be hit.
 *
 * ## Empty-hand attacks
 *
 * A bare hand deals real damage, just very little. Returning "no attack" for an
 * empty hand would mean a player who loses their sword cannot fight at all, which
 * is a much worse failure than a weak punch.
 */

import { Events } from '../core/EventBus.js';
import { getItem } from '../items/ItemRegistry.js';
import { ToolType } from '../items/ItemTypes.js';
import { EXHAUSTION } from '../player/PlayerStats.js';

/** Damage dealt with nothing in hand, in half-hearts. */
const BARE_HAND_DAMAGE = 1;
/** Attacks per second with nothing in hand. */
const BARE_HAND_SPEED = 4;

/**
 * Extra reach for entities beyond the block reach.
 *
 * Slightly longer because an entity's hitbox centre is what gets tested, and a
 * mob standing at the edge of block reach would otherwise be unhittable.
 */
const ENTITY_REACH_BONUS = 0.6;

/** Horizontal knockback impulse applied to a struck entity. */
const KNOCKBACK_STRENGTH = 5.2;
/** Vertical component, so a hit visibly lifts the target. */
const KNOCKBACK_LIFT = 3.4;

/** Durability consumed by a weapon per swing. */
const WEAPON_DURABILITY_COST = 1;

export class CombatSystem {
  /**
   * @param {Object} options
   * @param {import('../core/EventBus.js').EventBus} options.bus
   * @param {import('../core/SettingsManager.js').SettingsManager} options.settings
   */
  constructor({ bus, settings }) {
    this._bus = bus;
    this._settings = settings;

    /** Seconds until the next attack is allowed. */
    this.cooldown = 0;
    /** Seconds the current cooldown started at, for the HUD's swing indicator. */
    this.cooldownDuration = 0;
    /** Set for a moment after a swing, so the held item can animate. */
    this.swingTimer = 0;
  }

  /**
   * 0..1 readiness. 1 means a full-strength attack is available.
   *
   * Exposed for the crosshair indicator: showing the player when their weapon is
   * ready is what makes an attack-speed stat legible.
   */
  get readiness() {
    if (this.cooldownDuration <= 0) return 1;
    return Math.min(1, 1 - this.cooldown / this.cooldownDuration);
  }

  get isReady() {
    return this.cooldown <= 0;
  }

  /**
   * Advances timers.
   * @param {number} dt
   */
  update(dt) {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.swingTimer > 0) this.swingTimer = Math.max(0, this.swingTimer - dt);
  }

  /**
   * Damage and speed for a held item.
   *
   * @param {string|null} itemId
   * @returns {{damage: number, speed: number, isWeapon: boolean}}
   */
  static describeWeapon(itemId) {
    if (!itemId) {
      return { damage: BARE_HAND_DAMAGE, speed: BARE_HAND_SPEED, isWeapon: false };
    }
    const definition = getItem(itemId);
    if (!definition) {
      return { damage: BARE_HAND_DAMAGE, speed: BARE_HAND_SPEED, isWeapon: false };
    }
    // Every item has an `attackDamage`; tools fall back to their tier value, and
    // non-tools to 1. So a shovel hits harder than a fist but far less than a
    // sword, with no special-casing here.
    return {
      damage: Math.max(BARE_HAND_DAMAGE, definition.attackDamage),
      speed: Math.max(0.4, definition.attackSpeed),
      isWeapon: definition.toolType === ToolType.SWORD || definition.toolType === ToolType.AXE,
    };
  }

  /**
   * Attempts an attack against the nearest entity along the view ray.
   *
   * @param {Object} options
   * @param {{x: number, y: number, z: number}} options.origin Eye position.
   * @param {{x: number, y: number, z: number}} options.direction Unit view vector.
   * @param {number} options.reach Block reach, extended slightly for entities.
   * @param {string|null} options.itemId Held item.
   * @param {number} options.blockDistance Distance to the targeted block, or Infinity.
   * @param {Iterable<Object>} options.candidates Living entities to consider.
   * @param {boolean} [options.creative]
   * @param {number} [options.damageMultiplier] Strength/Weakness modifier.
   * @returns {{entity: Object, damage: number, wears: boolean}|null}
   */
  tryAttack({ origin, direction, reach, itemId, blockDistance, candidates, creative = false, damageMultiplier = 1 }) {
    if (this.cooldown > 0) return null;

    const weapon = CombatSystem.describeWeapon(itemId);
    // The cooldown is charged even on a miss. Swinging at nothing still takes as
    // long as swinging at something, which is what stops a player spamming clicks
    // to guarantee a hit the instant a mob enters range.
    this.cooldownDuration = 1 / weapon.speed;
    this.cooldown = this.cooldownDuration;
    this.swingTimer = 0.22;

    const maxDistance = Math.min(reach + ENTITY_REACH_BONUS, blockDistance + ENTITY_REACH_BONUS);
    const hit = this._pickEntity(origin, direction, maxDistance, candidates);
    if (!hit) return null;

    const multiplier = Number.isFinite(Number(damageMultiplier)) ? Math.max(0, Number(damageMultiplier)) : 1;
    const damage = creative ? 1000 : weapon.damage * multiplier;
    const applied = hit.entity.hurt?.(damage, {
      x: origin.x,
      y: origin.y,
      z: origin.z,
      attacker: 'player',
      kind: 'melee',
    });
    // `hurt` returning false means the target was in its own invulnerability
    // window; the swing is spent either way.
    if (applied === false) return null;

    this._applyKnockback(hit.entity, direction);

    this._bus.emit(Events.ENTITY_ATTACKED, {
      entity: hit.entity,
      damage,
      itemId,
      distance: hit.distance,
    });
    this._bus.emit(Events.PLAY_SOUND, {
      name: weapon.isWeapon ? 'attack.sharp' : 'attack.blunt',
      volume: 0.8,
    });

    const wears = !creative && weapon.damage > BARE_HAND_DAMAGE && Boolean(getItem(itemId)?.durability);
    return { entity: hit.entity, damage, wears, cost: WEAPON_DURABILITY_COST };
  }

  /**
   * Exhaustion cost of a swing, so attacking makes a survival player hungry.
   * @returns {number}
   */
  static get swingExhaustion() {
    return EXHAUSTION.attack;
  }

  /**
   * Ray-versus-axis-aligned-box sweep over the candidates.
   *
   * A slab test per axis (the standard "ray vs AABB" method) rather than a
   * distance-to-centre check, because the latter would let a shot pass beside a
   * wide mob and still register, and would miss a tall one the player is clearly
   * looking at.
   *
   * @returns {{entity: Object, distance: number}|null}
   */
  _pickEntity(origin, direction, maxDistance, candidates) {
    let best = null;
    let bestDistance = maxDistance;

    for (const entity of candidates) {
      if (!entity || entity.alive === false) continue;
      if (entity.isDead) continue;

      const half = entity.halfSize ?? 0.3;
      const height = entity.height ?? 1.8;
      // Entity origin is at its feet, matching the player convention.
      const minX = entity.x - half;
      const maxX = entity.x + half;
      const minY = entity.y;
      const maxY = entity.y + height;
      const minZ = entity.z - half;
      const maxZ = entity.z + half;

      const distance = raycastBox(
        origin,
        direction,
        minX,
        minY,
        minZ,
        maxX,
        maxY,
        maxZ,
        bestDistance
      );
      if (distance === null) continue;
      best = entity;
      bestDistance = distance;
    }

    return best ? { entity: best, distance: bestDistance } : null;
  }

  /**
   * Pushes a struck entity away from the attacker.
   * @param {Object} entity
   * @param {{x: number, y: number, z: number}} direction
   */
  _applyKnockback(entity, direction) {
    if (typeof entity.velocityX !== 'number') return;
    const length = Math.hypot(direction.x, direction.z) || 1;
    entity.velocityX += (direction.x / length) * KNOCKBACK_STRENGTH;
    entity.velocityZ += (direction.z / length) * KNOCKBACK_STRENGTH;
    entity.velocityY = Math.max(entity.velocityY ?? 0, KNOCKBACK_LIFT);
    entity.onGround = false;
  }

  /** Clears cooldowns, for a respawn or a mode change. */
  reset() {
    this.cooldown = 0;
    this.cooldownDuration = 0;
    this.swingTimer = 0;
  }
}

/**
 * Distance along a ray at which it first enters an axis-aligned box.
 *
 * Standard slab method. Returns `null` when the ray misses, starts past `maxDistance`,
 * or the box is behind the origin.
 *
 * Exported because the mob AI needs the same test for line of sight.
 *
 * @returns {number|null}
 */
export function raycastBox(origin, direction, minX, minY, minZ, maxX, maxY, maxZ, maxDistance) {
  let near = 0;
  let far = maxDistance;

  for (const axis of ['x', 'y', 'z']) {
    const start = origin[axis];
    const delta = direction[axis];
    const low = axis === 'x' ? minX : axis === 'y' ? minY : minZ;
    const high = axis === 'x' ? maxX : axis === 'y' ? maxY : maxZ;

    if (Math.abs(delta) < 1e-8) {
      // Ray is parallel to this slab: a miss unless it already lies between the
      // planes.
      if (start < low || start > high) return null;
      continue;
    }

    let t1 = (low - start) / delta;
    let t2 = (high - start) / delta;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > near) near = t1;
    if (t2 < far) far = t2;
    if (near > far) return null;
  }

  return near >= 0 && near <= maxDistance ? near : null;
}

export default CombatSystem;
