/**
 * Deterministic, seeded, biome-aware weather.
 *
 * ## Why this module exists
 *
 * FinalV2 rolled weather with `Math.random() < 0.55` on a timer inside `Game.js`.
 * That had three defects, all of them player-visible:
 *
 *  1. **Not deterministic.** Two players on the same seed saw different weather,
 *     and a replay of the same world could not be reproduced for debugging.
 *  2. **Not persisted.** Reloading a world silently reset the sky to clear, so a
 *     storm you were sheltering from vanished across a save/load boundary.
 *  3. **Not biome-aware.** It rained in deserts and fell as rain on glaciers.
 *
 * The fix is to treat weather as a pure function of `(seed, cycleIndex)`. Nothing
 * is stored except the current cycle and how far into it we are, which makes the
 * save record three numbers and makes every rule testable in Node.
 *
 * ## The cycle model
 *
 * Time is divided into consecutive **cycles**. Cycle `n`'s state and duration are
 * derived by hashing `(seed, n)` — no iteration required, so a world loaded at
 * cycle 5,000 costs the same as one at cycle 0. When the elapsed time inside a
 * cycle passes its duration we advance to the next one and re-derive.
 *
 * ## Base state versus visible state
 *
 * The hash produces a **base** state: the weather the sky "wants" to be. What the
 * player actually sees is the base state resolved against the local biome
 * temperature:
 *
 *  - cold biomes turn precipitation into snow;
 *  - arid biomes suppress precipitation entirely;
 *  - everything else sees the base state unchanged.
 *
 * Keeping these separate is what lets a single storm fall as snow on the mountain
 * and rain in the valley below at the same instant, without storing two states.
 */

/** @enum {string} */
export const WeatherState = Object.freeze({
  CLEAR: 'clear',
  RAIN: 'rain',
  THUNDER: 'thunder',
  SNOW: 'snow',
});

/** Every state the system can ever report, for validation. */
export const WEATHER_STATES = Object.freeze([
  WeatherState.CLEAR,
  WeatherState.RAIN,
  WeatherState.THUNDER,
  WeatherState.SNOW,
]);

/**
 * Temperature at or below which precipitation falls as snow.
 * Matches the `temperature` scale used by `BiomeGenerator` (-1 cold, +1 hot).
 */
export const SNOW_TEMPERATURE = -0.45;

/** Temperature at or above which precipitation is suppressed (deserts). */
export const ARID_TEMPERATURE = 0.7;

/** Cycle duration bounds, in seconds. */
export const CYCLE_SECONDS = Object.freeze({
  clearMin: 240,
  clearMax: 720,
  precipitationMin: 90,
  precipitationMax: 300,
});

/**
 * Probability weights for the base state of a cycle.
 * Clear dominates: storms should be an event, not the background.
 */
const STATE_WEIGHTS = Object.freeze([
  { state: WeatherState.CLEAR, weight: 0.66 },
  { state: WeatherState.RAIN, weight: 0.26 },
  { state: WeatherState.THUNDER, weight: 0.08 },
]);

/** Mean seconds between lightning strikes at full thunder intensity. */
const LIGHTNING_MEAN_INTERVAL = 9;

/** Salt keeping weather's random stream independent of terrain's. */
const WEATHER_SALT = 0x9e37_79b9;

/**
 * Integer hash of `(seed, cycle, channel)`.
 *
 * A hash rather than a sequential PRNG so cycle `n` is computable directly.
 * Three rounds of xor-shift/multiply is well past enough avalanche for picking
 * between three buckets.
 *
 * @returns {number} A uint32.
 */
export function weatherHash(seed, cycle, channel = 0) {
  let h = (seed >>> 0) ^ WEATHER_SALT;
  h = Math.imul(h ^ (cycle >>> 0), 0x85eb_ca6b) >>> 0;
  h = Math.imul(h ^ (channel >>> 0), 0xc2b2_ae35) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545_f491) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

/** Hash normalised to `[0, 1)`. */
export function weatherUnit(seed, cycle, channel = 0) {
  return weatherHash(seed, cycle, channel) / 4_294_967_296;
}

/**
 * The base weather state for a cycle, before biome resolution.
 *
 * @param {number} seed
 * @param {number} cycle
 * @returns {string} A `WeatherState`.
 */
export function baseStateForCycle(seed, cycle) {
  const roll = weatherUnit(seed, cycle, 1);
  let accumulated = 0;
  for (const entry of STATE_WEIGHTS) {
    accumulated += entry.weight;
    if (roll < accumulated) return entry.state;
  }
  return WeatherState.CLEAR;
}

/**
 * How long a cycle lasts, in seconds.
 *
 * Clear spells are deliberately much longer than storms.
 */
export function durationForCycle(seed, cycle) {
  const state = baseStateForCycle(seed, cycle);
  const roll = weatherUnit(seed, cycle, 2);
  const clear = state === WeatherState.CLEAR;
  const min = clear ? CYCLE_SECONDS.clearMin : CYCLE_SECONDS.precipitationMin;
  const max = clear ? CYCLE_SECONDS.clearMax : CYCLE_SECONDS.precipitationMax;
  return min + roll * (max - min);
}

/**
 * Peak intensity for a cycle, 0..1. Clear cycles are always 0.
 */
export function intensityForCycle(seed, cycle) {
  if (baseStateForCycle(seed, cycle) === WeatherState.CLEAR) return 0;
  // 0.45..1.0 — even a light shower should be visible.
  return 0.45 + weatherUnit(seed, cycle, 3) * 0.55;
}

/**
 * Resolves a base state against a local biome temperature.
 *
 * @param {string} baseState
 * @param {number} temperature `BiomeGenerator` temperature, -1..1.
 * @returns {string} The `WeatherState` actually visible at that location.
 */
export function resolveLocalWeather(baseState, temperature) {
  if (baseState === WeatherState.CLEAR) return WeatherState.CLEAR;
  const t = Number.isFinite(temperature) ? temperature : 0;
  // Snow first: a cold biome overrides everything, including thunder. A
  // thundersnow storm is a real thing but it reads as a bug in a voxel game.
  if (t <= SNOW_TEMPERATURE) return WeatherState.SNOW;
  // Deserts stay dry. The storm still exists, it just does not precipitate here.
  if (t >= ARID_TEMPERATURE) return WeatherState.CLEAR;
  return baseState;
}

/** True when a state produces falling particles. */
export function isPrecipitation(state) {
  return state === WeatherState.RAIN || state === WeatherState.THUNDER || state === WeatherState.SNOW;
}

/**
 * The deterministic weather clock for one dimension.
 *
 * Owns no rendering. `WeatherRenderer` reads `visibleState` and `intensity` and
 * draws them; this class decides what they are.
 */
export class WeatherSystem {
  /**
   * @param {Object} [options]
   * @param {number} [options.seed] World seed.
   * @param {boolean} [options.enabled] When false the sky is permanently clear.
   */
  constructor({ seed = 0, enabled = true } = {}) {
    this.seed = seed >>> 0;
    this.enabled = enabled !== false;

    /** Index of the current cycle. */
    this.cycle = 0;
    /** Seconds elapsed inside the current cycle. */
    this.elapsed = 0;
    /** Local biome temperature the player is standing in. */
    this.temperature = 0;

    /** Seconds until the next lightning strike, when thundering. */
    this._lightningTimer = 0;
    /** Incremented per strike so the strike stream never repeats. */
    this._strikeSerial = 0;
    /** Set for one update when lightning struck. */
    this.lightningStruck = false;
  }

  /** The base state of the current cycle, ignoring biome. */
  get baseState() {
    if (!this.enabled) return WeatherState.CLEAR;
    return baseStateForCycle(this.seed, this.cycle);
  }

  /** Duration of the current cycle in seconds. */
  get cycleDuration() {
    return durationForCycle(this.seed, this.cycle);
  }

  /** What the player actually sees, after biome resolution. */
  get visibleState() {
    return resolveLocalWeather(this.baseState, this.temperature);
  }

  /**
   * Current intensity 0..1, with a ramp in and out so storms do not snap on.
   *
   * The ramp is part of the model rather than a renderer smoothing detail so the
   * value is reproducible and testable.
   */
  get intensity() {
    if (!this.enabled) return 0;
    if (!isPrecipitation(this.visibleState)) return 0;
    const peak = intensityForCycle(this.seed, this.cycle);
    const duration = this.cycleDuration;
    const ramp = Math.min(30, duration * 0.25);
    if (ramp <= 0) return peak;
    const fadeIn = Math.min(1, this.elapsed / ramp);
    const fadeOut = Math.min(1, Math.max(0, duration - this.elapsed) / ramp);
    return peak * Math.min(fadeIn, fadeOut);
  }

  /** True when the current cycle can produce lightning. */
  get isThundering() {
    return this.visibleState === WeatherState.THUNDER;
  }

  /** Fraction through the current cycle, 0..1. */
  get cycleProgress() {
    const duration = this.cycleDuration;
    return duration > 0 ? Math.min(1, this.elapsed / duration) : 1;
  }

  /**
   * Sets the local biome temperature. Called as the player moves.
   * @param {number} temperature -1..1
   */
  setTemperature(temperature) {
    this.temperature = Number.isFinite(temperature) ? temperature : 0;
  }

  /**
   * Advances the clock.
   *
   * @param {number} dt Seconds.
   * @returns {{changed:boolean, struck:boolean}} `changed` when the visible state
   *   differs from before the call, so callers can fire a notification.
   */
  update(dt) {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 1) : 0;
    const before = this.visibleState;
    this.lightningStruck = false;

    if (!this.enabled) return { changed: false, struck: false };

    this.elapsed += step;
    // A `while` rather than an `if`: a long pause (hidden tab, slow load) can
    // skip a whole short cycle, and silently staying in it would desynchronise
    // the weather from the world clock.
    let guard = 0;
    while (this.elapsed >= this.cycleDuration && guard++ < 1024) {
      this.elapsed -= this.cycleDuration;
      this.cycle++;
      this._lightningTimer = 0;
    }

    if (this.isThundering) this._updateLightning(step);
    else this._lightningTimer = 0;

    return { changed: this.visibleState !== before, struck: this.lightningStruck };
  }

  /**
   * Schedules lightning during a thunderstorm.
   *
   * Strikes are drawn from the same seeded hash stream as everything else, keyed
   * on a monotonic serial, so a given storm always produces the same strike
   * timings.
   */
  _updateLightning(step) {
    this._lightningTimer -= step;
    if (this._lightningTimer > 0) return;
    if (this._strikeSerial > 0) this.lightningStruck = true;
    const roll = weatherUnit(this.seed, this.cycle, 100 + (this._strikeSerial % 8192));
    this._strikeSerial++;
    // Exponential-ish spacing scaled by intensity: heavier storms strike more.
    const scale = 0.5 + (1 - Math.min(1, this.intensity)) * 1.5;
    this._lightningTimer = LIGHTNING_MEAN_INTERVAL * scale * (0.35 + roll * 1.3);
  }

  /**
   * Jumps straight to the next cycle whose base state differs from the current
   * one. Used by the debug overlay and by sleeping through a storm in a bed.
   */
  advanceToNextChange() {
    const current = this.baseState;
    for (let step = 1; step <= 64; step++) {
      if (baseStateForCycle(this.seed, this.cycle + step) !== current) {
        this.cycle += step;
        this.elapsed = 0;
        this._lightningTimer = 0;
        return true;
      }
    }
    return false;
  }

  /** Serialises to the save record. Three numbers. */
  serialize() {
    return {
      version: 1,
      seed: this.seed,
      cycle: this.cycle,
      elapsed: Math.max(0, Math.round(this.elapsed * 100) / 100),
    };
  }

  /**
   * Restores from a save record. Unknown/corrupt records reset to cycle 0 rather
   * than throwing — weather is never worth failing a world load over.
   *
   * @param {Object|null} record
   * @returns {boolean} True when a valid record was applied.
   */
  deserialize(record) {
    if (!record || typeof record !== 'object') return false;
    const cycle = Number(record.cycle);
    const elapsed = Number(record.elapsed);
    if (!Number.isFinite(cycle) || cycle < 0) return false;
    if (!Number.isFinite(elapsed) || elapsed < 0) return false;
    this.cycle = Math.floor(cycle);
    this.elapsed = Math.min(elapsed, durationForCycle(this.seed, this.cycle));
    this._lightningTimer = 0;
    this._strikeSerial = 0;
    return true;
  }

  /** Debug-overlay snapshot. */
  getStats() {
    return {
      base: this.baseState,
      visible: this.visibleState,
      intensity: Number(this.intensity.toFixed(3)),
      cycle: this.cycle,
      progress: Number(this.cycleProgress.toFixed(3)),
      duration: Math.round(this.cycleDuration),
      temperature: Number(this.temperature.toFixed(2)),
    };
  }
}

export default WeatherSystem;
