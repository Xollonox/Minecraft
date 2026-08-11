/**
 * Deterministic water and lava propagation.
 *
 * State byte layout is shared by both liquids:
 *   level 0 = source, 1..7 = progressively shallower horizontal flow
 *   bit 3   = falling column fed from above
 *
 * The implementation is deliberately event/schedule driven. Static oceans cost
 * nothing; only a liquid next to an edited block or a newly placed bucket source
 * enters the tick queue.
 */

import { registerBlockBehavior } from '../BlockBehaviorRegistry.js';
import { fluidIsFalling, fluidLevel, fluidState } from '../BlockState.js';
import { Block } from '../BlockTypes.js';

const HORIZONTAL = Object.freeze([
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]);

const CONFIG = Object.freeze({
  [Block.WATER]: Object.freeze({ delay: 5, levelStep: 1 }),
  [Block.LAVA]: Object.freeze({ delay: 30, levelStep: 2 }),
});

export function isFluidBlock(blockId) {
  return blockId === Block.WATER || blockId === Block.LAVA;
}

function oppositeFluid(blockId) {
  return blockId === Block.WATER ? Block.LAVA : Block.WATER;
}

function schedule(world, x, y, z, blockId, delay = null) {
  const config = CONFIG[blockId];
  if (!config) return;
  world.scheduleBlockTick(x, y, z, delay ?? config.delay, `fluid-${blockId}`);
}

function solidifyLava(world, x, y, z) {
  if (world.getBlock(x, y, z) !== Block.LAVA) return false;
  const state = world.getBlockState(x, y, z);
  const result = fluidLevel(state) === 0 && !fluidIsFalling(state)
    ? Block.OBSIDIAN
    : Block.COBBLESTONE;
  return world.setBlock(x, y, z, result, { cause: 'fluid-solidify' });
}

/** Resolves every water/lava contact touching one fluid cell. */
export function reactFluidContacts(world, x, y, z, blockId) {
  if (!isFluidBlock(blockId)) return false;
  const opposite = oppositeFluid(blockId);
  const neighbours = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  for (const [dx, dy, dz] of neighbours) {
    if (world.getBlock(x + dx, y + dy, z + dz) !== opposite) continue;
    if (blockId === Block.LAVA) return solidifyLava(world, x, y, z);
    return solidifyLava(world, x + dx, y + dy, z + dz);
  }
  return false;
}

function canWashAway(world, x, y, z, targetId) {
  return targetId !== Block.AIR && !isFluidBlock(targetId) && !world.isCollidable(x, y, z);
}

/**
 * Writes a fluid into one destination when it is weaker/replaceable.
 * Returns true when the destination changed or a contact reaction happened.
 */
export function flowFluidInto(world, x, y, z, blockId, desiredState) {
  if (!world.isLoaded(x, z)) return false;
  const targetId = world.getBlock(x, y, z);
  if (targetId === oppositeFluid(blockId)) {
    return blockId === Block.LAVA
      ? false // caller will solidify the current lava cell
      : solidifyLava(world, x, y, z);
  }

  if (targetId === blockId) {
    const currentState = world.getBlockState(x, y, z);
    if (fluidLevel(currentState) === 0 && !fluidIsFalling(currentState)) return false;
    const currentLevel = fluidLevel(currentState);
    const desiredLevel = fluidLevel(desiredState);
    const stronger = desiredLevel < currentLevel;
    const makesFalling = fluidIsFalling(desiredState) && !fluidIsFalling(currentState);
    if (!stronger && !makesFalling) return false;
    const changed = world.setBlockState(x, y, z, desiredState, {
      cause: 'fluid-flow',
      cascade: false,
    });
    if (changed) schedule(world, x, y, z, blockId, 1);
    return changed;
  }

  if (targetId !== Block.AIR) {
    if (!canWashAway(world, x, y, z, targetId)) return false;
    world.breakBlock(x, y, z, {
      drop: world.itemDropsEnabled,
      context: { cause: 'fluid-wash' },
    });
  }

  const changed = world.setBlock(x, y, z, blockId, {
    state: desiredState,
    cause: 'fluid-flow',
    cascade: false,
  });
  if (changed) schedule(world, x, y, z, blockId, 1);
  return changed;
}

/** Calculates the state a non-source fluid cell should have from its feeders. */
export function desiredFluidState(world, x, y, z, blockId) {
  const config = CONFIG[blockId];
  const aboveId = world.getBlock(x, y + 1, z);
  if (aboveId === blockId) {
    const aboveState = world.getBlockState(x, y + 1, z);
    return fluidState(fluidLevel(aboveState), true);
  }

  let best = Infinity;
  let adjacentSources = 0;
  for (const [dx, dz] of HORIZONTAL) {
    if (world.getBlock(x + dx, y, z + dz) !== blockId) continue;
    const state = world.getBlockState(x + dx, y, z + dz);
    if (fluidIsFalling(state)) continue;
    const level = fluidLevel(state);
    if (level === 0) adjacentSources++;
    if (level < best) best = level;
  }

  if (
    blockId === Block.WATER &&
    adjacentSources >= 2 &&
    world.isSupportive(x, y - 1, z)
  ) {
    return fluidState(0, false);
  }
  if (!Number.isFinite(best)) return null;
  const next = best + config.levelStep;
  return next <= 7 ? fluidState(next, false) : null;
}

function fluidTick({ world, x, y, z, blockId }) {
  if (world.getBlock(x, y, z) !== blockId) return;
  if (reactFluidContacts(world, x, y, z, blockId)) return;

  const config = CONFIG[blockId];
  let state = world.getBlockState(x, y, z);
  const source = fluidLevel(state) === 0 && !fluidIsFalling(state);

  if (!source) {
    const desired = desiredFluidState(world, x, y, z, blockId);
    if (desired === null) {
      world.setBlock(x, y, z, Block.AIR, { cause: 'fluid-decay', cascade: false });
      return;
    }
    if (desired !== state) {
      world.setBlockState(x, y, z, desired, { cause: 'fluid-balance', cascade: false });
      state = desired;
    }
  }

  // Gravity wins. A falling column keeps the horizontal level of its feeder;
  // only when it lands does it spend another level to spread sideways.
  const downState = fluidState(fluidLevel(state), true);
  const belowId = world.getBlock(x, y - 1, z);
  if (belowId === oppositeFluid(blockId)) {
    if (blockId === Block.LAVA) solidifyLava(world, x, y, z);
    else solidifyLava(world, x, y - 1, z);
    return;
  }
  if (flowFluidInto(world, x, y - 1, z, blockId, downState)) return;

  const nextLevel = Math.max(1, fluidLevel(state) + config.levelStep);
  if (nextLevel > 7) return;
  const horizontalState = fluidState(nextLevel, false);
  let changed = false;
  for (const [dx, dz] of HORIZONTAL) {
    const targetId = world.getBlock(x + dx, y, z + dz);
    if (targetId === oppositeFluid(blockId) && blockId === Block.LAVA) {
      solidifyLava(world, x, y, z);
      return;
    }
    if (flowFluidInto(world, x + dx, y, z + dz, blockId, horizontalState)) changed = true;
  }
  if (changed && !source) schedule(world, x, y, z, blockId, config.delay);
}

function registerFluid(blockId) {
  registerBlockBehavior(blockId, {
    placed({ world, x, y, z }) {
      schedule(world, x, y, z, blockId, 1);
    },
    neighbourChanged({ world, x, y, z }) {
      schedule(world, x, y, z, blockId, 1);
    },
    scheduledTick: fluidTick,
  });
}

registerFluid(Block.WATER);
registerFluid(Block.LAVA);
