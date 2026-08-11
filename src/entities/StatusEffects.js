/**
 * Shared timed status-effect engine for players and living entities.
 *
 * Effects are pure simulation data: the controller owns stacking, duration,
 * periodic pulses and persistence, while callers provide tiny heal/damage
 * callbacks. That keeps it usable by the browser player, pooled mobs, servers
 * and deterministic Node tests without importing rendering or DOM code.
 */

export const StatusEffect = Object.freeze({
  SPEED: 'speed',
  SLOWNESS: 'slowness',
  STRENGTH: 'strength',
  WEAKNESS: 'weakness',
  REGENERATION: 'regeneration',
  POISON: 'poison',
  FIRE_RESISTANCE: 'fire_resistance',
  WATER_BREATHING: 'water_breathing',
  NIGHT_VISION: 'night_vision',
  RESISTANCE: 'resistance',
  ABSORPTION: 'absorption',
  INVISIBILITY: 'invisibility',
  WITHER: 'wither',
  LEVITATION: 'levitation',
  JUMP_BOOST: 'jump_boost',
  SLOW_FALLING: 'slow_falling',
});

const MAX_DURATION = 7 * 24 * 60 * 60;
const MAX_AMPLIFIER = 9;

export const STATUS_EFFECT_DEFINITIONS = Object.freeze({
  [StatusEffect.SPEED]: Object.freeze({ label: 'Speed', beneficial: true, color: 0x7cafc6 }),
  [StatusEffect.SLOWNESS]: Object.freeze({ label: 'Slowness', beneficial: false, color: 0x5a6c81 }),
  [StatusEffect.STRENGTH]: Object.freeze({ label: 'Strength', beneficial: true, color: 0x932423 }),
  [StatusEffect.WEAKNESS]: Object.freeze({ label: 'Weakness', beneficial: false, color: 0x484d48 }),
  [StatusEffect.REGENERATION]: Object.freeze({ label: 'Regeneration', beneficial: true, color: 0xcd5cab }),
  [StatusEffect.POISON]: Object.freeze({ label: 'Poison', beneficial: false, color: 0x4e9331 }),
  [StatusEffect.FIRE_RESISTANCE]: Object.freeze({ label: 'Fire Resistance', beneficial: true, color: 0xe49a3a }),
  [StatusEffect.WATER_BREATHING]: Object.freeze({ label: 'Water Breathing', beneficial: true, color: 0x2e5299 }),
  [StatusEffect.NIGHT_VISION]: Object.freeze({ label: 'Night Vision', beneficial: true, color: 0x1f1fa1 }),
  [StatusEffect.RESISTANCE]: Object.freeze({ label: 'Resistance', beneficial: true, color: 0x99453a }),
  [StatusEffect.ABSORPTION]: Object.freeze({ label: 'Absorption', beneficial: true, color: 0x2552a5 }),
  [StatusEffect.INVISIBILITY]: Object.freeze({ label: 'Invisibility', beneficial: true, color: 0x7f8392 }),
  [StatusEffect.WITHER]: Object.freeze({ label: 'Wither', beneficial: false, color: 0x352a27 }),
  [StatusEffect.LEVITATION]: Object.freeze({ label: 'Levitation', beneficial: false, color: 0xceffff }),
  [StatusEffect.JUMP_BOOST]: Object.freeze({ label: 'Jump Boost', beneficial: true, color: 0x22ff4c }),
  [StatusEffect.SLOW_FALLING]: Object.freeze({ label: 'Slow Falling', beneficial: true, color: 0xf7f8e0 }),
});

function finiteDuration(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(MAX_DURATION, duration);
}

function safeAmplifier(value) {
  const amplifier = Math.floor(Number(value) || 0);
  return Math.max(0, Math.min(MAX_AMPLIFIER, amplifier));
}

function intervalFor(id, amplifier) {
  if (id === StatusEffect.REGENERATION) return Math.max(0.25, 2.5 / (amplifier + 1));
  if (id === StatusEffect.POISON) return Math.max(0.25, 1.25 / (amplifier + 1));
  if (id === StatusEffect.WITHER) return Math.max(0.25, 2 / (amplifier + 1));
  return Infinity;
}

/** One sanitised serialisable effect instance. */
function makeInstance(id, duration, amplifier, options = {}) {
  return {
    id,
    duration: finiteDuration(duration),
    amplifier: safeAmplifier(amplifier),
    ambient: Boolean(options.ambient),
    showParticles: options.showParticles !== false,
    source: typeof options.source === 'string' ? options.source.slice(0, 64) : null,
    pulse: Math.max(0, Number(options.pulse) || 0),
  };
}

export function isStatusEffect(id) {
  return Object.prototype.hasOwnProperty.call(STATUS_EFFECT_DEFINITIONS, id);
}

export class StatusEffectController {
  constructor() {
    /** @type {Map<string, ReturnType<typeof makeInstance>>} */
    this._active = new Map();
    this.revision = 0;
  }

  get size() {
    return this._active.size;
  }

  get isEmpty() {
    return this._active.size === 0;
  }

  has(id) {
    return this._active.has(id);
  }

  get(id) {
    return this._active.get(id) ?? null;
  }

  /** Stable snapshot sorted by effect id for UI and deterministic saves. */
  list() {
    return Array.from(this._active.values(), (effect) => ({ ...effect }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Applies or combines an effect.
   *
   * A stronger amplifier replaces a weaker one. Equal strength keeps the longer
   * duration. A weaker incoming effect may extend the current duration but never
   * silently reduce its strength.
   */
  apply(id, duration, amplifier = 0, options = {}) {
    if (!isStatusEffect(id)) return false;
    const incoming = makeInstance(id, duration, amplifier, options);
    if (incoming.duration <= 0) return false;

    const current = this._active.get(id);
    if (!current) {
      this._active.set(id, incoming);
      this.revision++;
      return true;
    }

    let changed = false;
    if (incoming.amplifier > current.amplifier) {
      current.amplifier = incoming.amplifier;
      current.duration = incoming.duration;
      current.pulse = incoming.pulse;
      changed = true;
    } else if (incoming.amplifier === current.amplifier && incoming.duration > current.duration) {
      current.duration = incoming.duration;
      changed = true;
    } else if (incoming.amplifier < current.amplifier && incoming.duration > current.duration) {
      current.duration = incoming.duration;
      changed = true;
    }

    if (incoming.ambient !== current.ambient) {
      current.ambient = incoming.ambient;
      changed = true;
    }
    if (incoming.showParticles !== current.showParticles) {
      current.showParticles = incoming.showParticles;
      changed = true;
    }
    if (incoming.source && incoming.source !== current.source) {
      current.source = incoming.source;
      changed = true;
    }
    if (changed) this.revision++;
    return changed;
  }

  remove(id) {
    const removed = this._active.delete(id);
    if (removed) this.revision++;
    return removed;
  }

  clear() {
    if (this._active.size === 0) return;
    this._active.clear();
    this.revision++;
  }

  /**
   * Advances durations and periodic effects.
   *
   * @param {number} dt Seconds.
   * @param {{heal?:(amount:number,id:string)=>void, damage?:(amount:number,id:string,nonLethal:boolean)=>void, health?:()=>number, dead?:()=>boolean}} [context]
   */
  tick(dt, context = {}) {
    const step = Math.max(0, Number(dt) || 0);
    if (step <= 0 || this._active.size === 0) return;
    let changed = false;

    for (const [id, effect] of this._active) {
      effect.duration = Math.max(0, effect.duration - step);
      const interval = intervalFor(id, effect.amplifier);
      if (Number.isFinite(interval) && !context.dead?.()) {
        effect.pulse += step;
        while (effect.pulse >= interval && effect.duration > 0) {
          effect.pulse -= interval;
          if (id === StatusEffect.REGENERATION) {
            context.heal?.(1, id);
          } else if (id === StatusEffect.POISON) {
            // Poison intentionally cannot deal the final half-heart.
            const health = Number(context.health?.());
            if (!Number.isFinite(health) || health > 1) context.damage?.(1, id, true);
          } else if (id === StatusEffect.WITHER) {
            context.damage?.(1, id, false);
          }
        }
      }

      if (effect.duration <= 0) {
        this._active.delete(id);
        changed = true;
      }
    }
    if (changed) this.revision++;
  }

  /** Multiplicative movement modifier from Speed and Slowness. */
  get movementSpeedMultiplier() {
    const speed = this._active.get(StatusEffect.SPEED);
    const slow = this._active.get(StatusEffect.SLOWNESS);
    let multiplier = speed ? 1 + 0.2 * (speed.amplifier + 1) : 1;
    if (slow) multiplier *= Math.max(0.1, 1 - 0.15 * (slow.amplifier + 1));
    return Math.max(0.05, multiplier);
  }

  /** Multiplicative melee modifier from Strength and Weakness. */
  get attackDamageMultiplier() {
    const strength = this._active.get(StatusEffect.STRENGTH);
    const weakness = this._active.get(StatusEffect.WEAKNESS);
    let multiplier = strength ? 1 + 0.3 * (strength.amplifier + 1) : 1;
    if (weakness) multiplier *= Math.max(0, 1 - 0.2 * (weakness.amplifier + 1));
    return Math.max(0, multiplier);
  }

  get fireImmune() {
    return this.has(StatusEffect.FIRE_RESISTANCE);
  }

  get breathesWater() {
    return this.has(StatusEffect.WATER_BREATHING);
  }

  get nightVision() {
    return this.has(StatusEffect.NIGHT_VISION);
  }

  get resistanceLevel() {
    const effect = this._active.get(StatusEffect.RESISTANCE);
    return effect ? effect.amplifier + 1 : 0;
  }

  get absorptionHearts() {
    const effect = this._active.get(StatusEffect.ABSORPTION);
    return effect ? 4 * (effect.amplifier + 1) : 0;
  }

  get invisible() { return this.has(StatusEffect.INVISIBILITY); }
  get levitationLevel() { const effect=this._active.get(StatusEffect.LEVITATION); return effect ? effect.amplifier+1 : 0; }
  get jumpBoostLevel() { const effect=this._active.get(StatusEffect.JUMP_BOOST); return effect ? effect.amplifier+1 : 0; }
  get slowFalling() { return this.has(StatusEffect.SLOW_FALLING); }

  toJSON() {
    return this.list().map(({ id, duration, amplifier, ambient, showParticles, source, pulse }) => ({
      id,
      duration,
      amplifier,
      ambient,
      showParticles,
      source,
      pulse,
    }));
  }

  fromJSON(data) {
    this.clear();
    if (!Array.isArray(data)) return this;
    for (const value of data.slice(0, 64)) {
      if (!value || !isStatusEffect(value.id)) continue;
      const effect = makeInstance(value.id, value.duration, value.amplifier, value);
      if (effect.duration <= 0) continue;
      this._active.set(effect.id, effect);
    }
    if (this._active.size > 0) this.revision++;
    return this;
  }
}

export default StatusEffectController;
