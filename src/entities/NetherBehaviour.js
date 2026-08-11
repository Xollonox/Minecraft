/**
 * Phase 4: Nether-specific creature behaviour.
 *
 * Three separate rules live here because they all key off the same idea -- that
 * the Nether's mobs react to what the player is carrying or wearing:
 *
 *  - Piglins barter gold ingots for a weighted table of junk and treasure.
 *  - Piglins tolerate a player in gold armour, and turn hostile otherwise.
 *  - Striders are steered with a warped fungus on a stick, like a pig.
 */

import { mulberry32 } from '../utils/MathUtils.js';

/**
 * What a piglin hands back for one gold ingot.
 *
 * Weights are relative, not percentages, so entries can be added without
 * rebalancing the rest. Every id here is asserted against the item registry by
 * the Phase 4 self-test, because a typo would silently make a barter produce
 * nothing.
 */
export const BARTER_TABLE = Object.freeze([
  Object.freeze({ item: 'gravel', min: 8, max: 16, weight: 40 }),
  Object.freeze({ item: 'blackstone', min: 8, max: 16, weight: 40 }),
  Object.freeze({ item: 'leather', min: 4, max: 10, weight: 40 }),
  Object.freeze({ item: 'arrow', min: 6, max: 12, weight: 40 }),
  Object.freeze({ item: 'string', min: 3, max: 9, weight: 20 }),
  Object.freeze({ item: 'glowstone_dust', min: 5, max: 12, weight: 20 }),
  Object.freeze({ item: 'soul_sand', min: 4, max: 16, weight: 20 }),
  Object.freeze({ item: 'magma_cream', min: 2, max: 6, weight: 20 }),
  Object.freeze({ item: 'gunpowder', min: 2, max: 8, weight: 20 }),
  Object.freeze({ item: 'obsidian', min: 1, max: 1, weight: 10 }),
  Object.freeze({ item: 'crying_obsidian', min: 1, max: 3, weight: 10 }),
  Object.freeze({ item: 'iron_ingot', min: 1, max: 1, weight: 10 }),
  Object.freeze({ item: 'warped_fungus_on_a_stick', min: 1, max: 1, weight: 4 }),
  Object.freeze({ item: 'ancient_debris', min: 1, max: 1, weight: 1 }),
]);

const TOTAL_BARTER_WEIGHT = BARTER_TABLE.reduce((sum, entry) => sum + entry.weight, 0);

/** The currency piglins accept. */
export const BARTER_CURRENCY = 'gold_ingot';

/**
 * Rolls one barter result.
 *
 * @param {() => number} random A function returning a float in [0, 1).
 * @returns {{item: string, count: number}}
 */
export function rollBarter(random) {
  const roll = (typeof random === 'function' ? random() : Math.random()) * TOTAL_BARTER_WEIGHT;
  let cursor = 0;
  for (const entry of BARTER_TABLE) {
    cursor += entry.weight;
    if (roll < cursor) {
      const span = entry.max - entry.min + 1;
      const extra = Math.floor((typeof random === 'function' ? random() : Math.random()) * span);
      return { item: entry.item, count: entry.min + Math.min(span - 1, extra) };
    }
  }
  const last = BARTER_TABLE[BARTER_TABLE.length - 1];
  return { item: last.item, count: last.min };
}

/**
 * Trades one gold ingot to a piglin.
 *
 * Returns `null` when the player has no gold to offer, so the caller can play a
 * refusal sound rather than silently doing nothing.
 *
 * @param {{seed?: number, trades?: number}} piglin Mutable barter state.
 * @param {{count: number}} payment How much gold is being offered.
 */
export function barterWithPiglin(piglin, payment = { count: 1 }) {
  if (!piglin || !payment || (payment.count ?? 0) < 1) return null;
  const trades = Number(piglin.trades) || 0;
  // Seeding per trade keeps a given piglin's sequence reproducible across a
  // save/load cycle instead of depending on call order.
  const random = mulberry32(((Number(piglin.seed) || 0) ^ (trades * 0x9e3779b1)) >>> 0);
  const reward = rollBarter(random);
  piglin.trades = trades + 1;
  return reward;
}

/** Item ids that count as gold armour for the purposes of piglin tolerance. */
export function isGoldArmour(itemId) {
  return typeof itemId === 'string' && /^gold(en)?_(helmet|chestplate|leggings|boots)$/.test(itemId);
}

/**
 * Whether piglins leave this player alone.
 *
 * Wearing any single piece of gold is enough, matching vanilla, but looting a
 * chest or hitting one of them overrides the disguise.
 */
export function piglinIsPacified({ worn = [], openedNetherChest = false, attackedPiglin = false } = {}) {
  if (attackedPiglin || openedNetherChest) return false;
  return worn.some((itemId) => isGoldArmour(itemId));
}

/**
 * Steering state for a ridden strider.
 *
 * The fungus wears out as it is used, which is what stops it from being a
 * permanent free mount.
 */
export class StriderControl {
  constructor({ durability = 100 } = {}) {
    this.durability = Math.max(0, Number(durability) || 0);
    this.boosting = false;
    this.boostSeconds = 0;
  }

  /** True when the held item can still steer. */
  get usable() { return this.durability > 0; }

  /**
   * Waves the fungus, which starts a short speed boost.
   *
   * @returns {boolean} Whether the boost actually started.
   */
  boost() {
    if (!this.usable || this.boosting) return false;
    this.boosting = true;
    this.boostSeconds = 3;
    this.durability = Math.max(0, this.durability - 1);
    return true;
  }

  tick(step) {
    if (!this.boosting) return 1;
    this.boostSeconds = Math.max(0, this.boostSeconds - Math.max(0, Number(step) || 0));
    if (this.boostSeconds === 0) this.boosting = false;
    return this.boosting ? 2.4 : 1;
  }

  /** Speed multiplier applied to the strider's walk speed. */
  get speedMultiplier() { return this.boosting ? 2.4 : 1; }
}

/** Striders shiver and slow down out of lava, which is the point of the mount. */
export function striderSpeedOn(blockIsLava, control = null) {
  const base = blockIsLava ? 1 : 0.35;
  return base * (control ? control.speedMultiplier : 1);
}

export default { barterWithPiglin, rollBarter, piglinIsPacified, StriderControl };
