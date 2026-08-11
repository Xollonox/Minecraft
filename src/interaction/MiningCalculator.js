/**
 * How long a block takes to break, and whether it drops anything.
 *
 * ## Why this is a separate pure module
 *
 * The mining rule set is where a survival game's whole progression lives: a
 * pickaxe tier gate is what makes finding iron matter. That logic deserves to be
 * exercised directly rather than only through a `BlockBreaker` that needs a world,
 * an event bus and a particle system to instantiate. Everything here is a pure
 * function of a block id and an item id, so the Node self-test can assert the
 * entire progression table without a browser.
 *
 * ## The two questions
 *
 * Mining asks two independent things, and conflating them is a classic bug:
 *
 *  1. **How fast?** — hardness, the tool's speed, whether the tool is the right
 *     kind, and situational penalties.
 *  2. **Does it drop?** — whether the tool meets the block's minimum harvest tier.
 *
 * They are independent because a block can be mined slowly with the wrong tool and
 * still yield nothing. Stone with bare hands is the motivating case: it breaks, but
 * without a pickaxe there is no cobblestone. A player who does not know that will
 * mine a whole vein of iron with a wooden pickaxe and get nothing, so the UI needs
 * to be able to ask question 2 *before* the block breaks — which is why
 * `wouldDrop` exists separately from `breakSeconds`.
 *
 * Worker-safe: no DOM, no Three.js.
 */

import {
  DROPS_WITHOUT_TOOL,
  HARDNESS,
  IS_BREAKABLE,
  MIN_HARVEST_TIER,
  PREFERRED_TOOL,
  REQUIRES_CORRECT_TOOL,
  ToolClass,
} from '../world/BlockRegistry.js';
import { TIER_DATA, ToolTier, ToolType } from '../items/ItemTypes.js';
import { getItem } from '../items/ItemRegistry.js';

/**
 * Seconds per unit of hardness for a bare hand on a block it is suited to.
 *
 * Calibrated against Java Edition. Java computes `hardness * 1.5 / toolSpeed`
 * for a correct, harvest-capable tool and `hardness * 5.0` otherwise; the 3.33
 * ratio between those two branches is reproduced by WRONG_TOOL_PENALTY below.
 * This constant is 1.02 rather than 1.5 because this project's hardness table
 * runs hotter than Java's (stone is 2.2 here against Java's 1.5), so the
 * constant absorbs the difference and the resulting *times* match:
 *
 *   stone by hand           7.5s   (Java 7.5s)
 *   stone, wooden pickaxe   1.12s  (Java 1.15s)
 *   stone, stone pickaxe    0.56s  (Java 0.6s)
 *   stone, iron pickaxe     0.37s  (Java 0.4s)
 *   stone, diamond pickaxe  0.28s  (Java 0.3s)
 *
 * The previous value of 0.62 made every block in the game roughly twice as fast
 * to mine as its Java counterpart, which compressed the whole tool progression.
 */
export const HARDNESS_TO_SECONDS = 1.02;

/** Shortest possible break time, so nothing is instant outside creative. */
const MIN_BREAK_SECONDS = 0.05;

/**
 * Penalty multiplier applied when mining with the wrong tool on a block that
 * requires the right one.
 *
 * Deliberately harsh: punching through stone should feel like a mistake, not a
 * slightly slower alternative to finding a pickaxe.
 */
const WRONG_TOOL_PENALTY = 3.33;

/** Multiplier while swimming. Mining underwater is awkward. */
const UNDERWATER_PENALTY = 5;

/** Multiplier while airborne, so hovering does not become the fastest way to mine. */
const AIRBORNE_PENALTY = 5;

/**
 * Maps an item's `toolType` string onto the numeric `ToolClass` the block tables
 * use. Keeping the block tables numeric is what lets them be typed arrays.
 */
const TOOL_TYPE_TO_CLASS = Object.freeze({
  [ToolType.NONE]: ToolClass.NONE,
  [ToolType.PICKAXE]: ToolClass.PICKAXE,
  [ToolType.AXE]: ToolClass.AXE,
  [ToolType.SHOVEL]: ToolClass.SHOVEL,
  [ToolType.HOE]: ToolClass.HOE,
  [ToolType.SWORD]: ToolClass.SWORD,
  [ToolType.SHEARS]: ToolClass.SHEARS,
  [ToolType.BUCKET]: ToolClass.NONE,
});

/**
 * @typedef {Object} MiningContext
 * @property {boolean} [underwater] The player's head is in liquid.
 * @property {boolean} [airborne] The player is not standing on anything.
 * @property {boolean} [creative] Creative mode ignores all of this.
 */

/**
 * The tool class of a held item.
 * @param {string|null} itemId
 * @returns {number} A `ToolClass` value.
 */
export function toolClassOf(itemId) {
  if (!itemId) return ToolClass.NONE;
  const definition = getItem(itemId);
  if (!definition) return ToolClass.NONE;
  return TOOL_TYPE_TO_CLASS[definition.toolType] ?? ToolClass.NONE;
}

/**
 * The harvest level of a held item, 0 for bare hands.
 * @param {string|null} itemId
 * @returns {number}
 */
export function harvestLevel(itemId) {
  if (!itemId) return TIER_DATA[ToolTier.HAND].level;
  const definition = getItem(itemId);
  if (!definition) return TIER_DATA[ToolTier.HAND].level;
  return TIER_DATA[definition.toolTier]?.level ?? 0;
}

/**
 * Whether the held item is the kind of tool this block wants.
 *
 * A block with no preferred tool is satisfied by anything, which is what makes
 * dirt equally diggable by hand and by shovel — just at different speeds.
 *
 * @param {number} blockId
 * @param {string|null} itemId
 * @returns {boolean}
 */
export function isCorrectTool(blockId, itemId) {
  const preferred = PREFERRED_TOOL[blockId];
  if (preferred === ToolClass.NONE) return true;
  return toolClassOf(itemId) === preferred;
}

/**
 * Whether breaking this block with this item yields a drop.
 *
 * Two conditions: the block must not require a correct tool that is absent, and
 * the tool's tier must meet the block's minimum. Both are needed — a wooden
 * pickaxe *is* the correct tool for iron ore but is too weak to harvest it.
 *
 * @param {number} blockId
 * @param {string|null} itemId
 * @returns {boolean}
 */
export function wouldDrop(blockId, itemId) {
  if (!IS_BREAKABLE[blockId]) return false;
  // Some blocks drop regardless — dirt does not care what dug it.
  if (DROPS_WITHOUT_TOOL[blockId]) return true;
  if (REQUIRES_CORRECT_TOOL[blockId] && !isCorrectTool(blockId, itemId)) return false;
  return harvestLevel(itemId) >= MIN_HARVEST_TIER[blockId];
}

/**
 * Effective mining speed multiplier for an item against a block.
 *
 * The right tool contributes its full `miningSpeed`; the wrong tool contributes
 * nothing beyond a bare hand. A sword deliberately has `miningSpeed: 1` so it
 * never becomes a mining shortcut.
 *
 * @param {number} blockId
 * @param {string|null} itemId
 * @returns {number}
 */
export function speedMultiplier(blockId, itemId) {
  if (!itemId) return 1;
  const definition = getItem(itemId);
  if (!definition) return 1;
  return isCorrectTool(blockId, itemId) ? Math.max(1, definition.miningSpeed) : 1;
}

/**
 * Seconds to break a block.
 *
 * @param {number} blockId
 * @param {string|null} itemId Held item, or null for a bare hand.
 * @param {MiningContext} [context]
 * @returns {number} Seconds, or `Infinity` for an unbreakable block.
 */
export function breakSeconds(blockId, itemId, context = {}) {
  if (!IS_BREAKABLE[blockId]) return Infinity;
  if (context.creative) return 0;

  const hardness = HARDNESS[blockId];
  if (!Number.isFinite(hardness)) return Infinity;

  let seconds = (hardness * HARDNESS_TO_SECONDS) / speedMultiplier(blockId, itemId);

  // Using the wrong tool on a block that demands the right one is punishing on
  // top of gaining no speed bonus, so the mistake is unmistakable.
  if (REQUIRES_CORRECT_TOOL[blockId] && !isCorrectTool(blockId, itemId)) {
    seconds *= WRONG_TOOL_PENALTY;
  }

  if (context.underwater) seconds *= UNDERWATER_PENALTY;
  if (context.airborne) seconds *= AIRBORNE_PENALTY;

  return Math.max(MIN_BREAK_SECONDS, seconds);
}

/**
 * Everything the UI and the breaker need, in one call.
 *
 * Bundled because `BlockBreaker` needs all of it every frame and three separate
 * calls would each redo the same registry lookups.
 *
 * @param {number} blockId
 * @param {string|null} itemId
 * @param {MiningContext} [context]
 * @returns {{seconds: number, drops: boolean, correctTool: boolean, speed: number, unbreakable: boolean}}
 */
export function describeMining(blockId, itemId, context = {}) {
  const unbreakable = !IS_BREAKABLE[blockId];
  return {
    seconds: breakSeconds(blockId, itemId, context),
    drops: wouldDrop(blockId, itemId),
    correctTool: isCorrectTool(blockId, itemId),
    speed: speedMultiplier(blockId, itemId),
    unbreakable,
  };
}

/**
 * Whether using an item on a block should cost durability.
 *
 * Only actual tools wear, and only when they were doing tool work. Punching dirt
 * with a sword should not consume the sword, because the sword contributed
 * nothing — charging for it would make weapons feel like a liability.
 *
 * @param {number} blockId
 * @param {string|null} itemId
 * @returns {boolean}
 */
export function shouldConsumeDurability(blockId, itemId) {
  if (!itemId) return false;
  const definition = getItem(itemId);
  if (!definition || definition.durability <= 0) return false;
  if (definition.toolType === ToolType.SWORD) return false;
  // A tool used as the correct tool wears. A pickaxe used on dirt does not,
  // because it gained nothing from being a pickaxe.
  return isCorrectTool(blockId, itemId) && PREFERRED_TOOL[blockId] !== ToolClass.NONE;
}

export default describeMining;
