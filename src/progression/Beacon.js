/**
 * Beacons: the only thing a nether star is good for.
 *
 * ## What is modelled
 *
 * A beacon is inert on its own. It needs a pyramid of mineral blocks beneath it
 * and an unobstructed view of the sky, and the size of that pyramid decides both
 * how far the effect reaches and which effects are on offer. All of that is pure
 * geometry, which is why it lives here as functions over a world rather than
 * inside a renderer: the self-test can build a pyramid in a `Map` and assert the
 * level without a GPU.
 *
 * ## Base materials
 *
 * Vanilla accepts iron, gold, diamond, emerald and netherite blocks. This game
 * only has some of those, so `BEACON_BASE_BLOCK_NAMES` lists every candidate and
 * the resolver keeps the ones that actually exist. Obsidian is included on
 * purpose: without it there would be no craftable base material at all and the
 * beacon would be a decoration instead of a goal.
 */

import { Block } from '../world/BlockTypes.js';
import { StatusEffect } from '../entities/StatusEffects.js';
import { WORLD_HEIGHT } from '../config/GameConfig.js';

/** Every block that may form a beacon pyramid, best first. */
export const BEACON_BASE_BLOCK_NAMES = Object.freeze([
  'netherite_block',
  'diamond_block',
  'emerald_block',
  'gold_block',
  'iron_block',
  'quartz_block',
  'obsidian',
]);

/** The subset of those blocks this build actually has. */
export const BEACON_BASE_BLOCKS = Object.freeze(
  BEACON_BASE_BLOCK_NAMES
    .map((name) => Block[name.toUpperCase()])
    .filter((id) => typeof id === 'number')
);

const BASE_SET = new Set(BEACON_BASE_BLOCKS);

/** True when a block id may be used in a pyramid. */
export function isBeaconBase(blockId) {
  return BASE_SET.has(blockId);
}

/**
 * The four pyramid tiers.
 *
 * `range` is in blocks, measured horizontally from the beacon; `effects` are the
 * primary effects unlocked at that tier. Level 4 also allows a second effect,
 * which is the only reason to build the full pyramid.
 */
export const BEACON_LEVELS = Object.freeze([
  Object.freeze({ level: 1, range: 20, effects: Object.freeze([StatusEffect.SPEED]) }),
  Object.freeze({ level: 2, range: 30, effects: Object.freeze([StatusEffect.RESISTANCE, StatusEffect.JUMP_BOOST, StatusEffect.FIRE_RESISTANCE]) }),
  Object.freeze({ level: 3, range: 40, effects: Object.freeze([StatusEffect.STRENGTH]) }),
  Object.freeze({ level: 4, range: 50, effects: Object.freeze([StatusEffect.REGENERATION]) }),
]);

/** Effects reachable at a given pyramid level, cumulative. */
export function beaconEffectChoices(level) {
  const choices = [];
  for (const tier of BEACON_LEVELS) {
    if (tier.level > level) break;
    for (const effect of tier.effects) {
      if (STATUS_EXISTS.has(effect) && !choices.includes(effect)) choices.push(effect);
    }
  }
  return choices;
}

// Guards against an effect being renamed out from under the tier table.
const STATUS_EXISTS = new Set(Object.values(StatusEffect));

/** Horizontal reach of a beacon at a given level, 0 when unpowered. */
export function beaconRange(level) {
  if (level <= 0) return 0;
  return BEACON_LEVELS[Math.min(level, BEACON_LEVELS.length) - 1].range;
}

/**
 * True when nothing opaque stands between the beacon and the sky.
 *
 * Transparent blocks are allowed so a beacon can be roofed with glass, which is
 * how almost every real base uses one.
 */
export function hasSkyAccess(world, x, y, z, blockIsTransparent = null) {
  for (let cy = y + 1; cy < WORLD_HEIGHT; cy++) {
    const id = world.getBlock(x, cy, z);
    if (id === Block.AIR) continue;
    if (blockIsTransparent && blockIsTransparent(id)) continue;
    return false;
  }
  return true;
}

/**
 * Counts the complete pyramid layers under a beacon.
 *
 * Layer n is a (2n+1) square of base blocks n blocks below the beacon, centred on
 * it. Counting stops at the first incomplete layer, so a wide but hollow base
 * gives nothing -- the pyramid must be solid, exactly as in vanilla.
 *
 * @returns {number} 0..4
 */
export function beaconLevel(world, x, y, z) {
  let level = 0;
  for (let layer = 1; layer <= BEACON_LEVELS.length; layer++) {
    const cy = y - layer;
    if (cy < 0) break;
    let complete = true;
    for (let dx = -layer; dx <= layer && complete; dx++) {
      for (let dz = -layer; dz <= layer; dz++) {
        if (!isBeaconBase(world.getBlock(x + dx, cy, z + dz))) {
          complete = false;
          break;
        }
      }
    }
    if (!complete) break;
    level = layer;
  }
  return level;
}

/**
 * Full state of one beacon: what it can do and how far.
 *
 * @returns {{active: boolean, level: number, range: number, choices: string[], secondaryAllowed: boolean}}
 */
export function beaconState(world, x, y, z, blockIsTransparent = null) {
  const level = beaconLevel(world, x, y, z);
  const sky = level > 0 ? hasSkyAccess(world, x, y, z, blockIsTransparent) : false;
  const active = level > 0 && sky;
  return {
    active,
    level: active ? level : 0,
    range: active ? beaconRange(level) : 0,
    choices: active ? beaconEffectChoices(level) : [],
    secondaryAllowed: active && level >= BEACON_LEVELS.length,
  };
}

/** How long a beacon pulse lasts, in seconds, at a given level. */
export function beaconEffectDuration(level) {
  return 9 + level * 2;
}

/**
 * Tracks the beacons a world knows about.
 *
 * Beacons are registered when placed and dropped when broken, so the expensive
 * pyramid scan only ever runs for blocks the player actually built -- never as a
 * search through loaded chunks.
 */
export class BeaconRegistry {
  constructor({ world = null } = {}) {
    this.world = world;
    /** @type {Map<string, {x: number, y: number, z: number, primary: string|null, secondary: string|null}>} */
    this.beacons = new Map();
    this._elapsed = 0;
  }

  static key(x, y, z) {
    return `${x | 0},${y | 0},${z | 0}`;
  }

  /** Registers a placed beacon. Returns its state. */
  add(x, y, z, { primary = null, secondary = null } = {}) {
    const key = BeaconRegistry.key(x, y, z);
    this.beacons.set(key, { x: x | 0, y: y | 0, z: z | 0, primary, secondary });
    return this.stateAt(x, y, z);
  }

  /** Forgets a broken beacon. */
  remove(x, y, z) {
    return this.beacons.delete(BeaconRegistry.key(x, y, z));
  }

  has(x, y, z) {
    return this.beacons.has(BeaconRegistry.key(x, y, z));
  }

  get count() {
    return this.beacons.size;
  }

  /** Chooses which effects a registered beacon broadcasts. */
  configure(x, y, z, primary, secondary = null) {
    const entry = this.beacons.get(BeaconRegistry.key(x, y, z));
    if (!entry) return false;
    const state = this.stateAt(x, y, z);
    if (!state.active || !state.choices.includes(primary)) return false;
    entry.primary = primary;
    entry.secondary = state.secondaryAllowed && state.choices.includes(secondary) ? secondary : null;
    return true;
  }

  stateAt(x, y, z) {
    if (!this.world) return { active: false, level: 0, range: 0, choices: [], secondaryAllowed: false };
    return beaconState(this.world, x, y, z);
  }

  /**
   * Effects that should be applied to something standing at a position.
   *
   * @returns {Array<{effect: string, amplifier: number, duration: number}>}
   */
  effectsAt(position) {
    const applied = [];
    for (const entry of this.beacons.values()) {
      const state = this.stateAt(entry.x, entry.y, entry.z);
      if (!state.active || !entry.primary) continue;
      const dx = position.x - entry.x;
      const dz = position.z - entry.z;
      const dy = position.y - entry.y;
      if (Math.abs(dx) > state.range || Math.abs(dz) > state.range || Math.abs(dy) > state.range) continue;
      const duration = beaconEffectDuration(state.level);
      // A level 4 beacon may push its primary effect to amplifier 1, which is what
      // makes the top tier worth the netherite.
      const boosted = state.level >= BEACON_LEVELS.length && entry.secondary === entry.primary;
      applied.push({ effect: entry.primary, amplifier: boosted ? 1 : 0, duration });
      if (entry.secondary && entry.secondary !== entry.primary) {
        applied.push({ effect: entry.secondary, amplifier: 0, duration });
      }
    }
    return applied;
  }

  /**
   * Pulses every beacon once every four seconds, applying effects to a target.
   *
   * @returns {number} Effects applied this pulse.
   */
  fixedUpdate(step, target = null, apply = null) {
    this._elapsed += step;
    if (this._elapsed < 4) return 0;
    this._elapsed = 0;
    if (!target || !apply) return 0;
    const effects = this.effectsAt(target);
    for (const effect of effects) apply(effect);
    return effects.length;
  }

  toJSON() {
    return [...this.beacons.values()].map((entry) => [entry.x, entry.y, entry.z, entry.primary, entry.secondary]);
  }

  fromJSON(data) {
    this.beacons.clear();
    for (const entry of Array.isArray(data) ? data.slice(0, 512) : []) {
      if (!Array.isArray(entry) || entry.length < 3) continue;
      this.add(Number(entry[0]) | 0, Number(entry[1]) | 0, Number(entry[2]) | 0, {
        primary: typeof entry[3] === 'string' ? entry[3] : null,
        secondary: typeof entry[4] === 'string' ? entry[4] : null,
      });
    }
    return this;
  }

  destroy() {
    this.beacons.clear();
    this.world = null;
  }
}

export default BeaconRegistry;
