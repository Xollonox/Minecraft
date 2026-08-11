/**
 * Deterministic fire placement, spread and extinguishing.
 *
 * Fire uses the low four state bits as an age counter. It is scheduled rather
 * than random-ticked so unloaded/static regions cost nothing and the same world
 * seed plus edit sequence produces the same result at every frame rate.
 */

import { hash3 } from '../../utils/MathUtils.js';
import { registerBlockBehavior } from '../BlockBehaviorRegistry.js';
import { Block } from '../BlockTypes.js';

/** Normal fire update cadence at the canonical 20 Hz block clock. */
export const FIRE_TICK_DELAY = 10;
/** Maximum age encoded in the low nibble. */
export const MAX_FIRE_AGE = 15;

const NEIGHBOURS = Object.freeze([
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
]);

/** Blocks that can be consumed by ordinary fire. */
const FLAMMABLE = new Set([
  Block.OAK_LOG,
  Block.SPRUCE_LOG,
  Block.BIRCH_LOG,
  Block.OAK_LEAVES,
  Block.SPRUCE_LEAVES,
  Block.BIRCH_LEAVES,
  Block.PLANKS,
  Block.OAK_SAPLING,
  Block.TALL_GRASS,
  Block.FERN,
  Block.DEAD_BUSH,
  Block.FLOWER_RED,
  Block.FLOWER_YELLOW,
  Block.WHEAT_CROP,
  Block.CARROT_CROP,
  Block.POTATO_CROP,
  Block.WHITE_WOOL,
  Block.CRAFTING_TABLE,
  Block.CHEST,
  Block.OAK_SLAB,
  Block.OAK_STAIRS,
  Block.OAK_TRAPDOOR,
  Block.LADDER,
  Block.OAK_FENCE,
  Block.OAK_FENCE_GATE,
  Block.OAK_DOOR,
  Block.WHITE_BED,
  Block.OAK_PRESSURE_PLATE,
]);

export function fireAge(state) {
  return Math.max(0, Math.min(MAX_FIRE_AGE, state & 0x0f));
}

export function fireState(age = 0) {
  return Math.max(0, Math.min(MAX_FIRE_AGE, Math.floor(age))) & 0x0f;
}

export function isFlammable(blockId) {
  return FLAMMABLE.has(blockId);
}

/** True when a water cell directly touches this fire. */
export function isFireWet(world, x, y, z) {
  for (const [dx, dy, dz] of NEIGHBOURS) {
    if (world.getBlock(x + dx, y + dy, z + dz) === Block.WATER) return true;
  }
  return false;
}

/** Returns flammable neighbours in a stable order for deterministic spreading. */
export function flammableNeighbours(world, x, y, z) {
  const found = [];
  for (const [dx, dy, dz] of NEIGHBOURS) {
    const nx = x + dx;
    const ny = y + dy;
    const nz = z + dz;
    if (isFlammable(world.getBlock(nx, ny, nz))) found.push({ x: nx, y: ny, z: nz });
  }
  return found;
}

/**
 * Places fire into an empty cell when it has a floor or combustible neighbour.
 * Used by flint and steel and deliberately exported for tests/data-driven tools.
 */
export function igniteBlock(world, x, y, z) {
  if (!world?.isLoaded?.(x, z)) return false;
  if (world.getBlock(x, y, z) !== Block.AIR) return false;
  const supported = world.isSupportive?.(x, y - 1, z) ?? false;
  if (!supported && flammableNeighbours(world, x, y, z).length === 0) return false;
  const changed = world.setBlock(x, y, z, Block.FIRE, {
    cause: 'ignite',
    state: fireState(0),
    cascade: false,
  });
  if (changed) world.scheduleBlockTick(x, y, z, 1, 'fire');
  return changed;
}

/** One scheduled fire simulation step. */
export function tickFire({ world, x, y, z, state = 0 }) {
  if (world.getBlock(x, y, z) !== Block.FIRE) return false;

  if (isFireWet(world, x, y, z)) {
    return world.setBlock(x, y, z, Block.AIR, { cause: 'fire-extinguished', cascade: false });
  }

  const age = fireAge(state);
  const fuel = flammableNeighbours(world, x, y, z);
  const seed = hash3(x, y, z, (world.seed ^ world.gameTick ^ age) >>> 0);

  // Consume at most one neighbouring block per step. Stable neighbour ordering
  // plus the coordinate hash makes spreading replayable and testable.
  if (fuel.length > 0 && (seed & 3) === 0) {
    const target = fuel[(seed >>> 2) % fuel.length];
    if (world.setBlock(target.x, target.y, target.z, Block.FIRE, {
      cause: 'fire-spread',
      state: fireState(0),
      cascade: false,
    })) {
      world.scheduleBlockTick(target.x, target.y, target.z, FIRE_TICK_DELAY, 'fire');
    }
  }

  const nextAge = Math.min(MAX_FIRE_AGE, age + 1);
  const stillFuelled = flammableNeighbours(world, x, y, z).length > 0;
  // Unsupported decorative fire is temporary. A fire that has consumed its fuel
  // also clears, leaving air rather than an immortal flame voxel.
  const shouldExtinguish = (!stillFuelled && nextAge >= 3) || (nextAge >= 12 && ((seed >>> 8) & 1) === 0);
  if (shouldExtinguish) {
    return world.setBlock(x, y, z, Block.AIR, { cause: 'fire-burnout', cascade: false });
  }

  world.setBlockState(x, y, z, fireState(nextAge), {
    cause: 'fire-age',
    cascade: false,
  });
  world.scheduleBlockTick(x, y, z, FIRE_TICK_DELAY, 'fire');
  return true;
}

registerBlockBehavior(Block.FIRE, {
  bootstrapDelay: FIRE_TICK_DELAY,
  placed({ world, x, y, z }) {
    world.scheduleBlockTick(x, y, z, 1, 'fire');
  },
  neighbourChanged({ world, x, y, z }) {
    world.scheduleBlockTick(x, y, z, 1, 'fire-neighbour');
  },
  scheduledTick: tickFire,
  drops() {
    return [];
  },
});

export default Object.freeze({
  FIRE_TICK_DELAY,
  MAX_FIRE_AGE,
  fireAge,
  fireState,
  flammableNeighbours,
  igniteBlock,
  isFireWet,
  isFlammable,
  tickFire,
});
