import { Block } from '../world/BlockTypes.js';
import { trySummonWither } from './WitherBoss.js';
import { StriderControl, barterWithPiglin, piglinIsPacified } from '../entities/NetherBehaviour.js';
import { BeaconRegistry } from './Beacon.js';

/**
 * Live, world-scoped owner for every Phase 4 Nether system.
 *
 * Mirrors `Phase3Runtime`: the systems themselves are pure and independently
 * testable, and this class is the single place that holds their live state, ties
 * them to a world, and decides what survives a save.
 *
 * Wither fights are deliberately *not* persisted. A boss frozen mid-fight and
 * restored on load would resurrect at partial health with no body in the world,
 * so a reload ends the fight rather than corrupting it; the ritual can simply be
 * rebuilt.
 */

/** Cheap FNV-1a so each piglin gets a stable, seed-derived trade stream. */
function hashKey(key) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class Phase4Runtime {
  constructor({ world = null, player = null, seed = 0 } = {}) {
    this.world = world;
    this.player = player;
    this.seed = Number(seed) >>> 0;
    /** @type {Set<import('./WitherBoss.js').WitherFight>} */
    this.fights = new Set();
    /** Per-piglin barter state, keyed by entity id. */
    this.piglins = new Map();
    /** Per-strider steering state, keyed by entity id. */
    this.striders = new Map();
    this.defeatedWithers = 0;
    this.pendingRewards = [];
    // Beacons are the nether star's payout, so they belong to the phase that
    // introduced the Wither rather than to Phase 5.
    this.beacons = new BeaconRegistry({ world });
  }

  fixedUpdate(step) {
    // Copy first: a dead boss is removed from the set inside the loop.
    for (const fight of [...this.fights]) {
      fight.tick(step);
      if (fight.bar.dead) {
        this.defeatedWithers += 1;
        for (const reward of fight.rewards) this.pendingRewards.push({ ...reward });
        this.fights.delete(fight);
      }
    }
    for (const control of this.striders.values()) control.tick(step);
    // The registry keeps its own four-second cadence, so this is one addition
    // per tick until a pulse is actually due.
    this.beacons.fixedUpdate(step, this.player?.position ?? null, (pulse) => {
      this.player?.effects?.apply(pulse.effect, pulse.duration, pulse.amplifier);
    });
  }

  /**
   * Called for every block the player places. Only a wither skull can complete
   * the ritual, so everything else costs one integer comparison.
   *
   * @returns {import('./WitherBoss.js').WitherFight|null} The started fight.
   */
  onBlockPlaced(x, y, z, blockId) {
    if (blockId === Block.BEACON) {
      // A new beacon adopts the best effect its pyramid already allows, so it
      // does something the moment it is placed instead of waiting on a menu.
      const state = this.beacons.add(x, y, z);
      if (state.choices.length > 0) this.beacons.configure(x, y, z, state.choices[0]);
      return null;
    }
    if (blockId !== Block.WITHER_SKELETON_SKULL || !this.world) return null;
    const fight = trySummonWither(this.world, x, y, z);
    if (fight) this.fights.add(fight);
    return fight;
  }

  /** Forgets a beacon that has been mined, so it stops pulsing. */
  onBlockBroken(x, y, z, blockId) {
    if (blockId !== Block.BEACON) return false;
    return this.beacons.remove(x, y, z);
  }

  /** Every beacon this world knows about. */
  get beaconCount() {
    return this.beacons.count;
  }

  /** The fight the boss bar should be showing, if any. */
  get activeFight() {
    for (const fight of this.fights) return fight;
    return null;
  }

  /** Takes the loot from every Wither killed since the last call. */
  claimRewards() {
    const rewards = this.pendingRewards;
    this.pendingRewards = [];
    return rewards;
  }

  piglinState(id) {
    const key = String(id);
    let state = this.piglins.get(key);
    if (!state) {
      state = { seed: (this.seed ^ hashKey(key)) >>> 0, trades: 0 };
      this.piglins.set(key, state);
    }
    return state;
  }

  /** Trades one gold ingot with a piglin, reproducibly across a reload. */
  barter(id, payment = { count: 1 }) {
    return barterWithPiglin(this.piglinState(id), payment);
  }

  /** Whether piglins tolerate the player, given what they are wearing. */
  pacifies(worn, flags = {}) {
    return piglinIsPacified({ worn, ...flags });
  }

  striderControl(id, durability = 100) {
    const key = String(id);
    let control = this.striders.get(key);
    if (!control) {
      control = new StriderControl({ durability });
      this.striders.set(key, control);
    }
    return control;
  }

  toJSON() {
    return {
      defeatedWithers: this.defeatedWithers,
      piglins: [...this.piglins].map(([id, state]) => [id, state.seed, state.trades]),
      striders: [...this.striders].map(([id, control]) => [id, control.durability]),
      beacons: this.beacons.toJSON(),
    };
  }

  fromJSON(data) {
    if (!data || typeof data !== 'object') return this;
    this.defeatedWithers = Math.max(0, Number(data.defeatedWithers) || 0);
    this.piglins.clear();
    for (const entry of Array.isArray(data.piglins) ? data.piglins.slice(0, 2048) : []) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
      this.piglins.set(entry[0], {
        seed: Number(entry[1]) >>> 0,
        trades: Math.max(0, Number(entry[2]) || 0),
      });
    }
    this.striders.clear();
    for (const entry of Array.isArray(data.striders) ? data.striders.slice(0, 1024) : []) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
      this.striders.set(entry[0], new StriderControl({ durability: Number(entry[1]) || 0 }));
    }
    this.beacons.fromJSON(data.beacons);
    return this;
  }

  destroy() {
    this.beacons.destroy();
    this.fights.clear();
    this.piglins.clear();
    this.striders.clear();
    this.pendingRewards = [];
    this.world = null;
    this.player = null;
  }
}

export default Phase4Runtime;
