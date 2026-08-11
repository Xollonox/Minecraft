/**
 * The Ender Dragon fight.
 *
 * Built on the same `BossController` as `WitherBoss.js`, and deliberately shaped
 * the same way: all fight state and every difficulty decision live here as plain
 * numbers, so the whole encounter is testable in Node without a renderer.
 *
 * ## The two rules that make it a fight rather than a damage race
 *
 *  1. **The crystals heal the dragon.** While any end crystal is intact the
 *     dragon regenerates faster than a bow can hurt it, so the real objective is
 *     the pillars, not the dragon. This is why `tick` heals and why `damage`
 *     still lets hits land -- the player must be able to *see* that shooting the
 *     dragon early is futile.
 *  2. **Melee only works while perched.** A flying dragon cannot be hit with a
 *     sword at all. That forces the player to wait for the perch, which is the
 *     moment the fight becomes dangerous, and it is why `damage` rejects melee
 *     while airborne instead of merely reducing it.
 *
 * Worker-safe: no DOM, no Three.js.
 */

import { BossController } from '../automation/AutomationSystems.js';
import { Block } from '../world/BlockTypes.js';
import {
  END_ISLAND_SURFACE_Y,
  endCrystalPositions,
} from '../world/EndGenerator.js';

/**
 * Fight phases, by remaining health fraction.
 *
 * `BossController` sorts these ascending and picks the first phase whose
 * threshold the current fraction is at or below, so `circling` at 1 is the
 * opening state and `desperate` at 0.25 is the endgame.
 */
export const DRAGON_PHASES = Object.freeze([
  Object.freeze({
    id: 'desperate', threshold: 0.25,
    breathCooldown: 3, perchChance: 0.65, chargeSpeed: 1.6, breathDamage: 6,
  }),
  Object.freeze({
    id: 'perching', threshold: 0.6,
    breathCooldown: 5, perchChance: 0.45, chargeSpeed: 1.3, breathDamage: 5,
  }),
  Object.freeze({
    id: 'circling', threshold: 1,
    breathCooldown: 8, perchChance: 0.2, chargeSpeed: 1, breathDamage: 4,
  }),
]);

/**
 * Health per second restored by one intact crystal.
 *
 * Ten crystals give 20 HP/s against a bow's ~9 damage per shot: comfortably
 * unwinnable, which is the intended lesson.
 */
export const CRYSTAL_HEAL_PER_SECOND = 2;

/** How long the dragon stays perched, and how long it circles between perches. */
const PERCH_SECONDS = 8;
const CIRCLE_SECONDS = 12;

/** Full visible flight state machine used by the renderer and live combat. */
export const DragonFlightState = Object.freeze({
  CIRCLING: 'circling_strafe',
  APPROACH: 'approach',
  PERCH: 'perch',
  BREATH: 'breath',
  FIREBALL: 'fireball',
  CHARGE: 'charge',
  RETREAT: 'retreat',
  DEATH: 'death',
});

/** Cubic Bezier sample used for smooth pillar-ring flight. */
export function cubicBezier(a, b, c, d, t) {
  const u = 1 - Math.max(0, Math.min(1, t));
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;
  return {
    x: uuu * a.x + 3 * uu * t * b.x + 3 * u * tt * c.x + ttt * d.x,
    y: uuu * a.y + 3 * uu * t * b.y + 3 * u * tt * c.y + ttt * d.y,
    z: uuu * a.z + 3 * uu * t * b.z + 3 * u * tt * c.z + ttt * d.z,
  };
}

/** The dragon's hitboxes and their damage multipliers. */
export const DRAGON_PARTS = Object.freeze({
  head: 1.5,
  body: 1,
  wing: 0.6,
  tail: 0.4,
});

export class EnderDragonFight {
  constructor({ maxHealth = 200, crystals = null, perchPoint = null } = {}) {
    this.controller = new BossController({ maxHealth, phases: DRAGON_PHASES });
    for (const [part, multiplier] of Object.entries(DRAGON_PARTS)) {
      this.controller.addPart(part, multiplier);
    }

    // Each crystal carries its pillar index so a renderer can draw the healing
    // beam without a second lookup.
    this.crystals = (crystals ?? endCrystalPositions()).map((crystal) => ({
      ...crystal,
      alive: true,
    }));

    this.perchPoint = perchPoint ?? { x: 0, y: END_ISLAND_SURFACE_Y + 2, z: 0 };
    this.perched = false;
    this.breathCooldown = 4;
    this._stateTimer = CIRCLE_SECONDS;
    // `BossController` only resolves its phase inside `damage`, so a boss that
    // has not been hit yet reports a null phase. A zero-damage hit primes it,
    // which means the boss bar reads 'circling' from the first frame instead of
    // blank until the player lands a shot.
    this.controller.damage(0);
    this.healed = 0;
    this.position = { x: 0, y: END_ISLAND_SURFACE_Y + 34, z: 52 };
    this.previousPosition = { ...this.position };
    this.yaw = Math.PI;
    this.flightState = DragonFlightState.CIRCLING;
    this.flightProgress = 0;
    this.flightDuration = 7;
    this.flightCycle = 0;
    this.path = this._pathFor(DragonFlightState.CIRCLING);
    this.pendingAttack = null;
    this.deathTime = 0;
  }

  /** How many crystals are still feeding the dragon. */
  get crystalsAlive() {
    let alive = 0;
    for (const crystal of this.crystals) if (crystal.alive) alive++;
    return alive;
  }

  /**
   * Destroys one crystal.
   * @returns {boolean} True when this call was the one that broke it.
   */
  destroyCrystal(index) {
    const crystal = this.crystals[index];
    if (!crystal || !crystal.alive) return false;
    crystal.alive = false;
    return true;
  }

  /** The phase definition for the current health fraction. */
  get phaseData() {
    const id = this.controller.bar.phase;
    return DRAGON_PHASES.find((phase) => phase.id === id) ?? DRAGON_PHASES[DRAGON_PHASES.length - 1];
  }

  /**
   * Advances the fight.
   *
   * Healing is applied straight to the controller's health. That intentionally
   * does not recompute the phase -- phases are driven by damage, and a dragon
   * healing back above a threshold should not reset its aggression.
   *
   * @param {number} step Seconds.
   * @returns {{perched:boolean, healing:number, phase:string|null, crystalsAlive:number}}
   */
  tick(step) {
    const delta = Math.max(0, Number(step) || 0);
    const bar = this.controller.bar;

    let healing = 0;
    if (!bar.dead) {
      this._advanceFlight(delta);
      const alive = this.crystalsAlive;
      if (alive > 0) {
        healing = alive * CRYSTAL_HEAL_PER_SECOND * delta;
        this.controller.health = Math.min(
          this.controller.maxHealth,
          this.controller.health + healing
        );
        this.healed += healing;
      }

      this.breathCooldown = Math.max(0, this.breathCooldown - delta);
      this._stateTimer = Math.max(0, this._stateTimer - delta);
      if (this._stateTimer === 0) {
        // The dragon will not land while it still has crystals to hide behind.
        if (this.perched) {
          this.perched = false;
          this._stateTimer = CIRCLE_SECONDS;
        } else if (this.crystalsAlive === 0) {
          this.perched = true;
          this._stateTimer = PERCH_SECONDS;
        } else {
          this._stateTimer = CIRCLE_SECONDS;
        }
      }
    } else {
      this.flightState = DragonFlightState.DEATH;
      this.deathTime += delta;
      this.previousPosition = { ...this.position };
      this.position.y += delta * 2.4;
    }

    return {
      perched: this.perched,
      healing,
      phase: this.controller.bar.phase,
      crystalsAlive: this.crystalsAlive,
      state: this.flightState,
      position: { ...this.position },
    };
  }

  _pathFor(state) {
    const start = { ...this.position };
    const cycle = this.flightCycle++;
    const angle = (cycle * 1.91) % (Math.PI * 2);
    const ring = 44 + (cycle % 3) * 7;
    const ringPoint = (offset, height = 30) => ({
      x: Math.cos(angle + offset) * ring,
      y: END_ISLAND_SURFACE_Y + height,
      z: Math.sin(angle + offset) * ring,
    });
    let end = ringPoint(Math.PI * 0.72);
    if (state === DragonFlightState.APPROACH || state === DragonFlightState.PERCH || state === DragonFlightState.BREATH) {
      end = { x: this.perchPoint.x, y: this.perchPoint.y + 3.2, z: this.perchPoint.z + 4 };
    } else if (state === DragonFlightState.CHARGE) {
      end = { x: -start.x * 0.72, y: END_ISLAND_SURFACE_Y + 8, z: -start.z * 0.72 };
    } else if (state === DragonFlightState.RETREAT) {
      end = ringPoint(Math.PI * 1.15, 38);
    }
    return {
      a: start,
      b: { x: start.x * 0.65, y: Math.max(start.y, end.y) + 13, z: start.z * 0.65 },
      c: { x: end.x * 0.65, y: Math.max(start.y, end.y) + 9, z: end.z * 0.65 },
      d: end,
    };
  }

  _setFlightState(state, duration) {
    this.flightState = state;
    this.flightProgress = 0;
    this.flightDuration = Math.max(0.1, duration);
    this.path = this._pathFor(state);
    this.perched = state === DragonFlightState.PERCH || state === DragonFlightState.BREATH;
    if (state === DragonFlightState.BREATH) {
      this.pendingAttack = { kind: 'breath', ...this.fireBreath(() => 0) };
    } else if (state === DragonFlightState.FIREBALL) {
      this.pendingAttack = { kind:'fireball', damage:7, speed:15, radius:.7 };
    } else if (state === DragonFlightState.CHARGE) {
      this.pendingAttack = { kind: 'charge', damage: 8 * this.phaseData.chargeSpeed, radius: 4.5 };
    } else if (state === DragonFlightState.RETREAT) {
      this.pendingAttack = { kind: 'wing_gust', damage: 3, radius: 7, knockback: 11 };
    }
  }

  _advanceFlight(delta) {
    if (delta <= 0) return;
    this.flightProgress += delta;
    const t = Math.min(1, this.flightProgress / this.flightDuration);
    this.previousPosition = { ...this.position };
    this.position = cubicBezier(this.path.a, this.path.b, this.path.c, this.path.d, t);
    const dx = this.position.x - this.previousPosition.x;
    const dz = this.position.z - this.previousPosition.z;
    if (Math.hypot(dx, dz) > 1e-5) this.yaw = Math.atan2(dx, dz);
    if (t < 1) return;

    switch (this.flightState) {
      case DragonFlightState.CIRCLING:
        this._setFlightState(this.crystalsAlive === 0 ? DragonFlightState.APPROACH : DragonFlightState.FIREBALL, 2.8);
        break;
      case DragonFlightState.FIREBALL:
        this._setFlightState(DragonFlightState.CHARGE, 3.4);
        break;
      case DragonFlightState.APPROACH:
        this._setFlightState(DragonFlightState.PERCH, 2.4);
        break;
      case DragonFlightState.PERCH:
        this._setFlightState(DragonFlightState.BREATH, 4.2);
        break;
      case DragonFlightState.BREATH:
        this._setFlightState(DragonFlightState.RETREAT, 3.2);
        break;
      case DragonFlightState.CHARGE:
        this._setFlightState(DragonFlightState.RETREAT, 2.7);
        break;
      default:
        this._setFlightState(DragonFlightState.CIRCLING, 7 / this.phaseData.chargeSpeed);
        break;
    }
  }

  /** One-shot attack request consumed by the live game. */
  consumeAttack() {
    const attack = this.pendingAttack;
    this.pendingAttack = null;
    return attack;
  }

  /**
   * Damages the dragon.
   *
   * @param {number} amount
   * @param {{part?: string, source?: string}} [options]
   * @returns {number} Damage actually dealt.
   */
  damage(amount, { part = 'body', source = 'melee' } = {}) {
    if (this.controller.bar.dead) return 0;
    // A dragon in the air is simply out of reach of a sword.
    if (source === 'melee' && !this.perched) return 0;
    return this.controller.damage(amount, part);
  }

  /**
   * The dragon's breath attack, or null when it cannot use it.
   *
   * Breath is a perch-phase weapon: it is what punishes a player who stands on
   * the fountain hitting the head.
   *
   * @param {() => number} [random]
   */
  fireBreath(random = Math.random) {
    if (this.controller.bar.dead) return null;
    if (this.breathCooldown > 0) return null;
    if (!this.perched && random() > this.phaseData.perchChance) return null;

    const phase = this.phaseData;
    this.breathCooldown = phase.breathCooldown;
    return {
      type: 'dragon_breath',
      damage: phase.breathDamage,
      radius: this.perched ? 4 : 3,
      lingering: true,
      duration: 12,
      collectableInto: 'glass_bottle',
    };
  }

  get bar() { return this.controller.bar; }

  /** True once the fight is over and the way home is open. */
  get exitPortalOpen() { return this.controller.bar.dead; }

  /**
   * The blocks that appear when the dragon dies: a 3x3 exit portal on the
   * fountain with the dragon egg above it.
   *
   * Returned rather than written so the caller owns all world mutation, which is
   * what keeps this module testable and worker-safe.
   */
  exitPortalBlocks() {
    if (!this.exitPortalOpen) return [];
    const cells = [];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        cells.push({
          x: this.perchPoint.x + dx,
          y: this.perchPoint.y,
          z: this.perchPoint.z + dz,
          block: Block.END_PORTAL,
        });
      }
    }
    cells.push({
      x: this.perchPoint.x,
      y: this.perchPoint.y + 1,
      z: this.perchPoint.z,
      block: Block.DRAGON_EGG,
    });
    return cells;
  }

  /** The experience payout; the unique egg is placed on the exit fountain. */
  get rewards() {
    return this.controller.bar.dead ? [{ experience: 12000 }] : [];
  }

  toJSON() {
    return {
      health: this.controller.health,
      crystals: this.crystals.map((crystal) => ({ ...crystal })),
      perched: this.perched,
      breathCooldown: this.breathCooldown,
      stateTimer: this._stateTimer,
      healed: this.healed,
      position: { ...this.position },
      previousPosition: { ...this.previousPosition },
      yaw: this.yaw,
      flightState: this.flightState,
      flightProgress: this.flightProgress,
      flightDuration: this.flightDuration,
      flightCycle: this.flightCycle,
      deathTime: this.deathTime,
    };
  }

  fromJSON(data) {
    if (!data || typeof data !== 'object') return this;
    this.controller.health = Math.max(0, Math.min(this.controller.maxHealth, Number(data.health) || 0));
    this.controller.damage(0);
    if (Array.isArray(data.crystals) && data.crystals.length === this.crystals.length) {
      this.crystals = data.crystals.map((crystal, index) => ({
        ...this.crystals[index],
        alive: crystal?.alive !== false,
      }));
    }
    this.perched = data.perched === true;
    this.breathCooldown = Math.max(0, Number(data.breathCooldown) || 0);
    this._stateTimer = Math.max(0, Number(data.stateTimer) || 0);
    this.healed = Math.max(0, Number(data.healed) || 0);
    const finitePosition = (value, fallback) => value && ['x','y','z'].every((key) => Number.isFinite(Number(value[key])))
      ? { x:Number(value.x), y:Number(value.y), z:Number(value.z) } : fallback;
    this.position = finitePosition(data.position, this.position);
    this.previousPosition = finitePosition(data.previousPosition, { ...this.position });
    this.yaw = Number.isFinite(Number(data.yaw)) ? Number(data.yaw) : this.yaw;
    if (Object.values(DragonFlightState).includes(data.flightState)) this.flightState = data.flightState;
    this.flightProgress = Math.max(0, Number(data.flightProgress) || 0);
    this.flightDuration = Math.max(0.1, Number(data.flightDuration) || 1);
    this.flightCycle = Math.max(0, Number(data.flightCycle) || 0);
    this.deathTime = Math.max(0, Number(data.deathTime) || 0);
    this.path = this._pathFor(this.flightState);
    return this;
  }
}

export default EnderDragonFight;
