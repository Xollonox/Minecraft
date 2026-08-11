/**
 * Data-driven hooks for stateful/simulated blocks.
 *
 * World owns scheduling and persistence; behaviours own the rules for an
 * individual block. Keeping those roles separate prevents `World.setBlock`
 * becoming a switch statement that must know every crop, fluid and redstone
 * component in the game.
 */

/** @type {Map<number, Readonly<Object>>} */
const BEHAVIOURS = new Map();

/**
 * Registers one behaviour. Called at module load by behaviour packs.
 * @param {number} blockId
 * @param {Object} behaviour
 */
export function registerBlockBehavior(blockId, behaviour) {
  if (!Number.isInteger(blockId) || blockId < 0 || blockId > 0xffff) {
    throw new Error(`Invalid behaviour block id ${blockId}`);
  }
  if (BEHAVIOURS.has(blockId)) throw new Error(`Block ${blockId} already has a behaviour`);
  const frozen = Object.freeze({
    randomTick: null,
    scheduledTick: null,
    neighbourChanged: null,
    placed: null,
    removed: null,
    drops: null,
    bootstrapDelay: 0,
    ...behaviour,
  });
  BEHAVIOURS.set(blockId, frozen);
  return frozen;
}

/** Behaviour for a block id, or null. */
export function getBlockBehavior(blockId) {
  return BEHAVIOURS.get(blockId) ?? null;
}

/** True when the block participates in random ticks. */
export function hasRandomTickBehavior(blockId) {
  return typeof BEHAVIOURS.get(blockId)?.randomTick === 'function';
}

/** True when the block needs an initial scheduled tick when a chunk loads. */
export function needsScheduledBootstrap(blockId) {
  const behaviour = BEHAVIOURS.get(blockId);
  return Boolean(behaviour && behaviour.bootstrapDelay > 0 && behaviour.scheduledTick);
}

/** Registered ids, useful for diagnostics/tests. */
export function registeredBehaviorIds() {
  return Object.freeze([...BEHAVIOURS.keys()].sort((a, b) => a - b));
}

export default Object.freeze({
  registerBlockBehavior,
  getBlockBehavior,
  hasRandomTickBehavior,
  needsScheduledBootstrap,
  registeredBehaviorIds,
});
