/**
 * Health, hunger, saturation, exhaustion, air and death state.
 *
 * ## Deliberately decoupled from `Player`
 *
 * `Player` owns position, velocity and collision — it is the physics body.
 * Survival state is a separate concern with a completely different update rate
 * (hunger ticks over minutes, physics over 1/60 s), and keeping it here means it
 * can be unit-tested in Node without a world, a scene or a camera. `Player` holds
 * an instance and forwards a tick.
 *
 * ## The exhaustion -> saturation -> hunger chain
 *
 * Actions do not decrement hunger directly. They add *exhaustion*, and when
 * exhaustion crosses a threshold it consumes one point of saturation, or one
 * point of hunger if saturation is already gone. This indirection is what makes
 * a well-fed player able to sprint for a long time while a starving one cannot,
 * without either number needing to know about the other's units.
 *
 * Regeneration is gated on hunger being high *and* saturation being present, so
 * eating a low-saturation food tops the bar up without immediately healing.
 *
 * ## Invulnerability frames
 *
 * A hit starts a short window during which further hits are ignored, so a mob
 * cannot land three blows in a quarter of a second. Environmental damage that is
 * continuous by nature (drowning, suffocation, starvation) declares
 * `bypassesCooldown` and is unaffected — otherwise it would never land a second
 * tick. See `DamageTypes.js`.
 *
 * Worker-safe: no DOM, no Three.js.
 */

import { Events } from '../core/EventBus.js';
import { DamageType, getDamageSource } from './DamageTypes.js';
import { getDifficulty } from '../gameplay/Difficulty.js';

/** Maximum health, in half-hearts. 20 = ten hearts. */
export const MAX_HEALTH = 20;
/** Maximum hunger, in half-drumsticks. */
export const MAX_HUNGER = 20;
/** Maximum air, in ticks of submersion. */
export const MAX_AIR = 300;
/** Maximum XP level (practical cap). */
export const MAX_LEVEL = 100;

/**
 * Exhaustion needed to burn one point of saturation or hunger.
 * Chosen so a player walking continuously empties a full bar in ~15 minutes.
 */
const EXHAUSTION_PER_POINT = 4;

/** Exhaustion added per unit of activity. */
export const EXHAUSTION = Object.freeze({
  /** Per block walked. */
  walk: 0.01,
  /** Per block sprinted, on top of the walk cost. */
  sprint: 0.1,
  /** Per block swum. */
  swim: 0.013,
  /** Per jump. */
  jump: 0.05,
  /** Per sprinting jump. */
  sprintJump: 0.2,
  /** Per block broken. */
  mine: 0.005,
  /** Per melee attack. */
  attack: 0.1,
  /** Per point of damage taken. */
  damage: 0.1,
  /** Per half-heart regenerated. */
  regenerate: 6,
});

/** Hunger at or above which natural regeneration happens. */
const REGEN_HUNGER_THRESHOLD = 18;
/** Seconds between regeneration ticks while well fed. */
const REGEN_INTERVAL = 4;
/** Seconds between starvation damage ticks. */
const STARVE_INTERVAL = 4;
/** Damage per starvation tick. */
const STARVE_DAMAGE = 1;
/** Seconds of invulnerability after a hit. */
const DAMAGE_COOLDOWN = 0.5;
/** Seconds between drowning damage ticks once air is gone. */
const DROWN_INTERVAL = 1;
/** Damage per drowning tick. */
const DROWN_DAMAGE = 2;
/** Seconds between suffocation damage ticks. */
const SUFFOCATE_INTERVAL = 0.5;
/** Damage per suffocation tick. */
const SUFFOCATE_DAMAGE = 1;
/** Seconds between lava damage ticks while the body overlaps lava. */
const LAVA_INTERVAL = 0.5;
/** Damage per lava tick, in half-hearts. */
const LAVA_DAMAGE = 4;
/** Seconds between ordinary fire damage ticks. */
const FIRE_INTERVAL = 1;
/** Damage per ordinary fire tick, in half-hearts. */
const FIRE_DAMAGE = 1;
/** Fall distance in blocks that causes no damage. */
const SAFE_FALL_DISTANCE = 3;
/** Damage per block fallen beyond the safe distance. */
const FALL_DAMAGE_PER_BLOCK = 1;
/** Seconds air takes to refill completely once out of water. */
const AIR_REFILL_SECONDS = 2;

export class PlayerStats {
  /**
   * @param {import('../core/EventBus.js').EventBus|null} bus
   */
  constructor(bus = null) {
    this._bus = bus;

    this.health = MAX_HEALTH;
    this.maxHealth = MAX_HEALTH;
    this.hunger = MAX_HUNGER;
    this.saturation = 5;
    this.exhaustion = 0;
    this.air = MAX_AIR;

    /** Seconds of remaining invulnerability. */
    this.damageCooldown = 0;
    /** True between dying and respawning. */
    this.dead = false;
    /** Damage type that killed the player. */
    this.deathCause = null;
    /** Message for the death screen. */
    this.deathMessage = '';
    /** Distance fallen since last touching ground, in blocks. */
    this.fallDistance = 0;

    /** Set to true for a frame after damage, so the HUD can flash. */
    this.damageFlash = 0;

    /** XP system */
    this.level = 0;
    this.xp = 0;
    this.xpToNext = 10;

    // Tick accumulators, kept separate so one does not starve another.
    this._regenTimer = 0;
    this._starveTimer = 0;
    this._drownTimer = 0;
    this._suffocateTimer = 0;
    this._lavaTimer = 0;
    this._fireTimer = 0;

    /** Survival rules are skipped entirely in creative. */
    this.enabled = true;

    /**
     * Optional equipment-aware resolver supplied by Player. Kept out of the
     * constructor signature so PlayerStats stays trivial to instantiate in
     * headless tests and other entities can still use it without an inventory.
     * @type {((amount:number, source:Object) => number)|null}
     */
    this._damageResolver = null;
    this._difficulty = getDifficulty('normal');
  }

  // ----------------------------------------------------------------- accessors

  get isDead() {
    return this.dead;
  }

  get healthFraction() {
    return this.maxHealth === 0 ? 0 : this.health / this.maxHealth;
  }

  get hungerFraction() {
    return this.hunger / MAX_HUNGER;
  }

  get airFraction() {
    return this.air / MAX_AIR;
  }

  /** True when the air meter should be drawn. */
  get showAir() {
    return this.air < MAX_AIR;
  }

  get isStarving() {
    return this.hunger <= 0;
  }

  get canSprint() {
    return !this.enabled || this.hunger > 6;
  }

  get canRegenerate() {
    return this.hunger >= REGEN_HUNGER_THRESHOLD && this.saturation > 0;
  }

  /** True when the player is invulnerable from a recent hit. */
  get isInvulnerable() {
    return this.damageCooldown > 0;
  }

  // ---------------------------------------------------------------- simulation

  /**
   * Advances every survival timer.
   *
   * @param {number} step Seconds; called from the fixed-step tick.
   * @param {Object} context
   * @param {boolean} context.headInWater Air drains while true.
   * @param {boolean} context.suffocating Head inside a solid block.
   * @param {boolean} context.inLava Body overlaps lava.
   * @param {boolean} context.inFire Body overlaps a fire block.
   * @param {boolean} context.inVoid Below the world floor.
   */
  tick(step, { headInWater = false, suffocating = false, inLava = false, inFire = false, inVoid = false } = {}) {
    if (this.damageCooldown > 0) this.damageCooldown = Math.max(0, this.damageCooldown - step);
    if (this.damageFlash > 0) this.damageFlash = Math.max(0, this.damageFlash - step);

    if (!this.enabled || this.dead) return;

    this._tickAir(step, headInWater);
    this._tickRegeneration(step);
    this._tickStarvation(step);
    // Exhaustion is settled *last* so everything charged during this tick —
    // movement added by `Player`, and the cost of any regeneration that just
    // happened — is converted together. Running it first delayed the price of
    // healing by a tick, which decoupled the cost from its cause and let a
    // player regenerate one free heart on entering the regeneration threshold.
    this._tickExhaustion();

    if (suffocating) {
      this._suffocateTimer += step;
      if (this._suffocateTimer >= SUFFOCATE_INTERVAL) {
        this._suffocateTimer = 0;
        this.applyDamage(SUFFOCATE_DAMAGE, DamageType.SUFFOCATION);
      }
    } else {
      this._suffocateTimer = 0;
    }

    if (inLava) {
      this._lavaTimer += step;
      while (this._lavaTimer >= LAVA_INTERVAL && !this.dead) {
        this._lavaTimer -= LAVA_INTERVAL;
        this.applyDamage(LAVA_DAMAGE, DamageType.LAVA);
      }
    } else {
      this._lavaTimer = 0;
    }

    if (inFire) {
      this._fireTimer += step;
      while (this._fireTimer >= FIRE_INTERVAL && !this.dead) {
        this._fireTimer -= FIRE_INTERVAL;
        this.applyDamage(FIRE_DAMAGE, DamageType.FIRE);
      }
    } else {
      this._fireTimer = 0;
    }

    if (inVoid) {
      // Instant and unconditional: there is no recovery from below the world.
      this.applyDamage(this.maxHealth, DamageType.VOID);
    }
  }

  /**
   * Drains air while submerged, refills it otherwise, and drowns at zero.
   */
  _tickAir(step, headInWater) {
    if (headInWater) {
      this.air = Math.max(0, this.air - step * 60);
      if (this.air <= 0) {
        this._drownTimer += step;
        if (this._drownTimer >= DROWN_INTERVAL) {
          this._drownTimer = 0;
          this.applyDamage(DROWN_DAMAGE, DamageType.DROWNING);
        }
      }
      this._emitStats();
      return;
    }

    this._drownTimer = 0;
    if (this.air < MAX_AIR) {
      this.air = Math.min(MAX_AIR, this.air + step * (MAX_AIR / AIR_REFILL_SECONDS));
      this._emitStats();
    }
  }

  /**
   * Converts accumulated exhaustion into saturation, then hunger.
   *
   * A `while` rather than an `if` so a large one-off cost (regenerating a heart
   * adds 6) is fully applied in the same tick instead of dribbling out over
   * several, which would decouple the cost from its cause.
   */
  _tickExhaustion() {
    let changed = false;
    while (this.exhaustion >= EXHAUSTION_PER_POINT) {
      this.exhaustion -= EXHAUSTION_PER_POINT;
      if (this.saturation > 0) {
        this.saturation = Math.max(0, this.saturation - 1);
      } else if (this.hunger > 0) {
        this.hunger -= 1;
      }
      changed = true;
    }
    if (changed) this._emitStats();
  }

  _tickRegeneration(step) {
    if (this.health >= this.maxHealth || !this.canRegenerate || this._difficulty.naturalRegeneration <= 0) {
      this._regenTimer = 0;
      return;
    }
    this._regenTimer += step;
    if (this._regenTimer < REGEN_INTERVAL / this._difficulty.naturalRegeneration) return;
    this._regenTimer = 0;
    this.heal(1);
    // Healing is expensive, which is what stops a full hunger bar from being a
    // permanent regeneration engine.
    this.addExhaustion(EXHAUSTION.regenerate);
  }

  _tickStarvation(step) {
    if (!this.isStarving) {
      this._starveTimer = 0;
      return;
    }
    this._starveTimer += step;
    if (this._starveTimer < STARVE_INTERVAL) return;
    this._starveTimer = 0;
    const floor = this._difficulty.starvationFloor;
    if (this.health > floor) this.applyDamage(
      Math.min(STARVE_DAMAGE, this.health - floor), DamageType.STARVATION
    );
  }

  // -------------------------------------------------------------------- damage

  /** Installs the final damage resolver (armour, effects, enchantments later). */
  setDamageResolver(resolver) {
    this._damageResolver = typeof resolver === 'function' ? resolver : null;
  }

  /**
   * Applies damage, respecting invulnerability.
   *
   * @param {number} amount Half-hearts.
   * @param {string} [cause] A `DamageType`.
   * @returns {boolean} True when damage was actually applied.
   */
  applyDamage(amount, cause = DamageType.GENERIC) {
    if (!this.enabled || this.dead) return false;
    const rawPoints = Math.max(0, amount);
    if (rawPoints === 0) return false;

    const source = getDamageSource(cause);
    if (this.isInvulnerable && !source.bypassesCooldown) return false;

    let points = rawPoints;
    if (this._damageResolver) {
      const resolved = Number(this._damageResolver(rawPoints, source));
      if (Number.isFinite(resolved)) points = Math.max(0, resolved);
    }
    if (points === 0) return false;

    const previous = this.health;
    this.health = Math.max(0, this.health - points);
    if (!source.bypassesCooldown) this.damageCooldown = DAMAGE_COOLDOWN;
    if (source.flashScreen) this.damageFlash = 0.35;

    // Being hurt is itself tiring.
    this.addExhaustion(EXHAUSTION.damage * points);

    this._bus?.emit(Events.PLAYER_DAMAGED, {
      amount: points,
      rawAmount: rawPoints,
      cause,
      health: this.health,
      fatal: this.health <= 0,
    });
    this._emitHealth(previous, cause);

    if (this.health <= 0) this._die(cause);
    return true;
  }

  /**
   * Restores health.
   * @param {number} amount
   */
  heal(amount) {
    if (this.dead) return;
    const previous = this.health;
    this.health = Math.min(this.maxHealth, this.health + Math.max(0, amount));
    if (this.health !== previous) this._emitHealth(previous, 'heal');
  }

  /**
   * Converts a fall into damage.
   *
   * Called on landing. Returns the damage dealt so the caller can pick a sound.
   *
   * @param {number} distance Blocks fallen.
   * @returns {number} Damage applied.
   */
  applyFallDamage(distance) {
    this.fallDistance = 0;
    if (!this.enabled || this.dead) return 0;
    const excess = distance - SAFE_FALL_DISTANCE;
    if (excess <= 0) return 0;
    const damage = Math.floor(excess * FALL_DAMAGE_PER_BLOCK);
    if (damage <= 0) return 0;
    this.applyDamage(damage, DamageType.FALL);
    return damage;
  }

  // --------------------------------------------------------------- consumption

  /**
   * Adds exhaustion from an activity.
   * @param {number} amount
   */
  addExhaustion(amount) {
    if (!this.enabled || this.dead) return;
    this.exhaustion += Math.max(0, amount) * this._difficulty.exhaustionMultiplier;
  }

  /** Applies a validated world difficulty without resetting current survival state. */
  setDifficulty(value) {
    this._difficulty = typeof value === 'object' && value?.id ? getDifficulty(value.id) : getDifficulty(value);
    return this._difficulty;
  }

  get difficulty() { return this._difficulty; }

  /**
   * Applies a food item's nutrition.
   *
   * @param {number} foodValue Hunger points restored.
   * @param {number} saturationValue Saturation restored.
   * @returns {boolean} False when already completely full.
   */
  eat(foodValue, saturationValue) {
    if (this.dead) return false;
    if (this.hunger >= MAX_HUNGER && this.saturation >= this.hunger) return false;

    this.hunger = Math.min(MAX_HUNGER, this.hunger + Math.max(0, foodValue));
    // Saturation is capped by hunger, so a big meal on an almost-full bar is
    // partly wasted rather than banking indefinite regeneration.
    this.saturation = Math.min(this.hunger, this.saturation + Math.max(0, saturationValue));
    this._emitStats();
    return true;
  }

  // ---------------------------------------------------------- death and respawn

  _die(cause) {
    if (this.dead) return;
    this.dead = true;
    this.deathCause = cause;
    this.deathMessage = getDamageSource(cause).deathMessage;
    this.health = 0;
    this._bus?.emit(Events.PLAYER_DIED, { cause, message: this.deathMessage });
  }

  /**
   * Kills the player outright, for commands and the void.
   * @param {string} [cause]
   */
  kill(cause = DamageType.GENERIC) {
    this.health = 0;
    this._die(cause);
  }

  /** Restores full survival state after a death. */
  respawn() {
    this.health = this.maxHealth;
    this.hunger = MAX_HUNGER;
    this.saturation = 5;
    this.exhaustion = 0;
    this.air = MAX_AIR;
    this.damageCooldown = 0;
    this.damageFlash = 0;
    this.fallDistance = 0;
    this.dead = false;
    this.deathCause = null;
    this.deathMessage = '';
    this._regenTimer = 0;
    this._starveTimer = 0;
    this._drownTimer = 0;
    this._suffocateTimer = 0;
    this._lavaTimer = 0;
    this._fireTimer = 0;
    this.level = 0;
    this.xp = 0;
    this.xpToNext = 10;
    this._emitHealth(0, 'respawn');
    this._emitStats();
    this._emitXp();
  }

  /**
   * Enables or disables survival rules.
   *
   * Switching to creative restores full health rather than freezing the current
   * value, so a player who flips to creative to escape a bad situation is
   * actually rescued.
   *
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (next === this.enabled) return;
    this.enabled = next;
    if (!next) {
      this.dead = false;
      this.health = this.maxHealth;
      this.hunger = MAX_HUNGER;
      this.saturation = 5;
      this.exhaustion = 0;
      this.air = MAX_AIR;
      this._lavaTimer = 0;
      this._fireTimer = 0;
      this._emitHealth(0, 'mode');
      this._emitStats();
    }
  }

  // ------------------------------------------------------------- serialisation

  toJSON() {
    return {
      health: this.health,
      hunger: this.hunger,
      saturation: this.saturation,
      exhaustion: this.exhaustion,
      air: this.air,
      dead: this.dead,
      deathCause: this.deathCause,
      level: this.level,
      xp: this.xp,
      xpToNext: this.xpToNext,
    };
  }

  /**
   * Restores from a save, clamping every field.
   *
   * Clamping matters because a save could predate a change to `MAX_HEALTH`, and
   * a health value above the maximum would render as overflowing hearts.
   *
   * @param {Object|null} data
   */
  fromJSON(data) {
    if (!data || typeof data !== 'object') {
      this.respawn();
      return;
    }
    const clamp = (value, min, max, fallback) => {
      const number = Number(value);
      return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
    };

    this.health = clamp(data.health, 0, this.maxHealth, this.maxHealth);
    this.hunger = clamp(data.hunger, 0, MAX_HUNGER, MAX_HUNGER);
    this.saturation = clamp(data.saturation, 0, MAX_HUNGER, 5);
    this.exhaustion = clamp(data.exhaustion, 0, EXHAUSTION_PER_POINT * 4, 0);
    this.air = clamp(data.air, 0, MAX_AIR, MAX_AIR);
    this.level = clamp(data.level, 0, MAX_LEVEL, 0);
    this.xp = clamp(data.xp, 0, 1000, 0);
    this.xpToNext = clamp(data.xpToNext, 1, 1000, 10);

    // A save taken at the moment of death would otherwise load into a corpse
    // with no death screen showing. Loading always yields a live player; the
    // death screen is a session concern, not a persisted one.
    this.dead = false;
    this.deathCause = null;
    this.deathMessage = '';
    if (this.health <= 0) this.health = this.maxHealth;
    this._regenTimer = 0;
    this._starveTimer = 0;
    this._drownTimer = 0;
    this._suffocateTimer = 0;
    this._lavaTimer = 0;
    this._fireTimer = 0;

    this._emitHealth(0, 'load');
    this._emitStats();
  }

  // ------------------------------------------------------------------- events

  _emitHealth(previous, cause) {
    this._bus?.emit(Events.PLAYER_HEALTH_CHANGED, {
      health: this.health,
      maxHealth: this.maxHealth,
      previous,
      cause,
    });
  }

  _emitStats() {
    this._bus?.emit(Events.PLAYER_STATS_CHANGED, {
      hunger: this.hunger,
      saturation: this.saturation,
      air: this.air,
    });
  }

  // ------------------------------------------------------------------- XP

  get xpFraction() {
    return this.xpToNext === 0 ? 0 : this.xp / this.xpToNext;
  }

  addExperience(amount) {
    if (!this.enabled || this.dead) return;
    const pts = Math.max(0, Math.floor(amount));
    if (pts === 0) return;
    this.xp += pts;
    while (this.xp >= this.xpToNext && this.level < MAX_LEVEL) {
      this.xp -= this.xpToNext;
      this.level++;
      this.xpToNext = 10 + this.level * 5;
      this._bus?.emit(Events.PLAY_SOUND, { name: 'player.levelup', volume: 0.9 });
    }
    this._emitXp();
  }

  _emitXp() {
    this._bus?.emit(Events.PLAYER_XP_CHANGED, {
      level: this.level,
      xp: this.xp,
      xpToNext: this.xpToNext,
      fraction: this.xpFraction,
    });
  }
}

export default PlayerStats;
