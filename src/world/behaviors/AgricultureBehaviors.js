/**
 * Farmland, crops and sapling growth.
 *
 * These rules run exclusively through the world's deterministic 20 Hz block
 * tick scheduler. They do not depend on rendering or wall-clock time, so a crop
 * grows identically at 30 FPS and 144 FPS and its age survives chunk unloads.
 */

import { WORLD_HEIGHT } from '../../config/GameConfig.js';
import { ItemStack } from '../../items/ItemStack.js';
import { hash3 } from '../../utils/MathUtils.js';
import { createLootRandom, rollLootTable } from '../../loot/LootTable.js';
import { registerBlockBehavior } from '../BlockBehaviorRegistry.js';
import { cropAge, cropState, farmlandMoisture, farmlandState } from '../BlockState.js';
import { Block } from '../BlockTypes.js';

export const MAX_CROP_AGE = 7;
export const MAX_FARMLAND_MOISTURE = 7;

const CROP_BY_KEY = Object.freeze({
  wheat: Block.WHEAT_CROP,
  carrot: Block.CARROT_CROP,
  potato: Block.POTATO_CROP,
});

const CROP_DATA = Object.freeze({
  [Block.WHEAT_CROP]: Object.freeze({ seed: 'wheat_seeds', produce: 'wheat' }),
  [Block.CARROT_CROP]: Object.freeze({ seed: 'carrot', produce: 'carrot' }),
  [Block.POTATO_CROP]: Object.freeze({ seed: 'potato', produce: 'potato' }),
});


const CROP_LOOT = Object.freeze({
  [Block.WHEAT_CROP]: Object.freeze({
    immature: Object.freeze({ pools: Object.freeze([{ entries: Object.freeze([{ item: 'wheat_seeds', count: 1 }]) }]) }),
    mature: Object.freeze({ pools: Object.freeze([{ entries: Object.freeze([
      { item: 'wheat', count: 1 },
      { item: 'wheat_seeds', count: Object.freeze({ min: 1, max: 3 }) },
    ]) }]) }),
  }),
  [Block.CARROT_CROP]: Object.freeze({
    immature: Object.freeze({ pools: Object.freeze([{ entries: Object.freeze([{ item: 'carrot', count: 1 }]) }]) }),
    mature: Object.freeze({ pools: Object.freeze([{ entries: Object.freeze([{ item: 'carrot', count: Object.freeze({ min: 2, max: 5 }) }]) }]) }),
  }),
  [Block.POTATO_CROP]: Object.freeze({
    immature: Object.freeze({ pools: Object.freeze([{ entries: Object.freeze([{ item: 'potato', count: 1 }]) }]) }),
    mature: Object.freeze({ pools: Object.freeze([{ entries: Object.freeze([{ item: 'potato', count: Object.freeze({ min: 2, max: 5 }) }]) }]) }),
  }),
});

const SOIL_BLOCKS = new Set([
  Block.GRASS,
  Block.SNOWY_GRASS,
  Block.DIRT,
  Block.FARMLAND,
]);

const TREE_REPLACEABLE = new Set([
  Block.AIR,
  Block.OAK_LEAVES,
  Block.SPRUCE_LEAVES,
  Block.BIRCH_LEAVES,
  Block.TALL_GRASS,
  Block.FERN,
  Block.FLOWER_RED,
  Block.FLOWER_YELLOW,
  Block.DEAD_BUSH,
  Block.OAK_SAPLING,
]);

/** Returns the crop block id planted by an item metadata key. */
export function cropBlockForKey(key) {
  return CROP_BY_KEY[key] ?? Block.AIR;
}

export function isCropBlock(blockId) {
  return Object.hasOwn(CROP_DATA, blockId);
}

/** Plants a crop in the air block immediately above farmland. */
export function plantCrop(world, x, y, z, key) {
  const blockId = cropBlockForKey(key);
  if (blockId === Block.AIR) return false;
  if (world.getBlock(x, y - 1, z) !== Block.FARMLAND) return false;
  if (world.getBlock(x, y, z) !== Block.AIR) return false;
  return world.placeBlock(x, y, z, blockId, {
    allowReplaceLiquid: false,
    state: cropState(0),
  });
}

/** Applies bone meal to a crop or oak sapling. */
export function fertilisePlant(world, x, y, z, salt = 0) {
  const blockId = world.getBlock(x, y, z);
  if (isCropBlock(blockId)) {
    const age = cropAge(world.getBlockState(x, y, z));
    if (age >= MAX_CROP_AGE) return false;
    const roll = hash3(x, y, z, (world.seed ^ world.gameTick ^ salt) >>> 0);
    const growth = 2 + (roll % 4);
    return world.setBlockState(x, y, z, cropState(Math.min(MAX_CROP_AGE, age + growth)), {
      cause: 'bone-meal',
      cascade: false,
    });
  }
  if (blockId === Block.OAK_SAPLING) {
    return growOakTree(world, x, y, z, salt);
  }
  return false;
}

/**
 * Grows one deterministic oak tree. The full plan is validated before the
 * sapling is removed, so failed growth never eats the player's sapling or clips
 * a tree through an existing build.
 */
export function growOakTree(world, x, y, z, salt = 0) {
  if (world.getBlock(x, y, z) !== Block.OAK_SAPLING) return false;
  const ground = world.getBlock(x, y - 1, z);
  if (!SOIL_BLOCKS.has(ground)) return false;

  const seed = hash3(x, y, z, (world.seed ^ salt) >>> 0);
  const trunkHeight = 4 + (seed % 3);
  const topY = y + trunkHeight - 1;
  if (topY + 2 >= WORLD_HEIGHT) return false;

  /** @type {Map<string, {x:number,y:number,z:number,blockId:number}>} */
  const plan = new Map();
  const put = (px, py, pz, blockId) => {
    const key = `${px},${py},${pz}`;
    const existing = plan.get(key);
    // Trunk wins over leaves at the canopy centre.
    if (!existing || blockId === Block.OAK_LOG) plan.set(key, { x: px, y: py, z: pz, blockId });
  };

  for (let dy = 0; dy < trunkHeight; dy++) put(x, y + dy, z, Block.OAK_LOG);

  for (let dy = -2; dy <= 1; dy++) {
    const py = topY + dy;
    const radius = dy === 1 ? 1 : 2;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx === 0 && dz === 0 && py <= topY) continue;
        if (Math.abs(dx) === radius && Math.abs(dz) === radius) {
          const trim = hash3(x + dx, py, z + dz, seed) & 1;
          if (trim === 0) continue;
        }
        put(x + dx, py, z + dz, Block.OAK_LEAVES);
      }
    }
  }

  for (const entry of plan.values()) {
    if (!world.isLoaded(entry.x, entry.z)) return false;
    const existing = world.getBlock(entry.x, entry.y, entry.z);
    if (!TREE_REPLACEABLE.has(existing)) return false;
  }

  // Leaves first, trunk second: if a renderer observes the edits between frames,
  // it sees a canopy gain its support rather than a naked trunk lose it.
  for (const entry of plan.values()) {
    if (entry.blockId !== Block.OAK_LEAVES) continue;
    world.setBlock(entry.x, entry.y, entry.z, entry.blockId, {
      cause: 'tree-growth',
      cascade: false,
    });
  }
  for (const entry of plan.values()) {
    if (entry.blockId !== Block.OAK_LOG) continue;
    world.setBlock(entry.x, entry.y, entry.z, entry.blockId, {
      cause: 'tree-growth',
      cascade: false,
    });
  }
  return true;
}

function hasNearbyWater(world, x, y, z) {
  for (let dz = -4; dz <= 4; dz++) {
    for (let dx = -4; dx <= 4; dx++) {
      if (world.getBlock(x + dx, y, z + dz) === Block.WATER) return true;
      if (world.getBlock(x + dx, y + 1, z + dz) === Block.WATER) return true;
    }
  }
  return false;
}

function cropGrowthSpeed(world, x, y, z, cropId) {
  let speed = 1;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (world.getBlock(x + dx, y - 1, z + dz) !== Block.FARMLAND) continue;
      const hydrated = farmlandMoisture(world.getBlockState(x + dx, y - 1, z + dz)) > 0;
      let contribution = hydrated ? 3 : 1;
      if (dx !== 0 || dz !== 0) contribution /= 4;
      speed += contribution;
    }
  }

  // Dense rows are intentionally less efficient, matching the classic rule
  // that encourages alternating crop rows rather than a solid monoculture.
  const sameX =
    world.getBlock(x - 1, y, z) === cropId || world.getBlock(x + 1, y, z) === cropId;
  const sameZ =
    world.getBlock(x, y, z - 1) === cropId || world.getBlock(x, y, z + 1) === cropId;
  const diagonal =
    world.getBlock(x - 1, y, z - 1) === cropId ||
    world.getBlock(x + 1, y, z - 1) === cropId ||
    world.getBlock(x - 1, y, z + 1) === cropId ||
    world.getBlock(x + 1, y, z + 1) === cropId;
  if (diagonal || (sameX && sameZ)) speed /= 2;
  return speed;
}

function cropDrops({ world, x, y, z, blockId, state, tick }) {
  const tables = CROP_LOOT[blockId];
  if (!tables) return [];
  const table = cropAge(state) >= MAX_CROP_AGE ? tables.mature : tables.immature;
  const seed = hash3(x, y, z, (world.seed ^ tick ^ blockId) >>> 0);
  return rollLootTable(table, { random: createLootRandom(seed) })
    .map((drop) => new ItemStack(drop.item, drop.count));
}

function cropSupportTick({ world, x, y, z }) {
  const blockId = world.getBlock(x, y, z);
  if (!isCropBlock(blockId)) return;
  if (world.getBlock(x, y - 1, z) === Block.FARMLAND) return;
  world.breakBlock(x, y, z, {
    drop: world.itemDropsEnabled,
    context: { cause: 'lost-support' },
  });
}

function registerCrop(blockId) {
  registerBlockBehavior(blockId, {
    bootstrapDelay: 1,
    placed({ world, x, y, z }) {
      world.scheduleBlockTick(x, y, z, 1, 'crop-support');
    },
    neighbourChanged({ world, x, y, z, changedNeighbour }) {
      if (changedNeighbour.x === x && changedNeighbour.y === y - 1 && changedNeighbour.z === z) {
        world.scheduleBlockTick(x, y, z, 1, 'crop-support');
      }
    },
    scheduledTick: cropSupportTick,
    randomTick({ world, x, y, z, state, random }) {
      if (world.getBlock(x, y - 1, z) !== Block.FARMLAND) {
        world.scheduleBlockTick(x, y, z, 1, 'crop-support');
        return;
      }
      const age = cropAge(state);
      if (age >= MAX_CROP_AGE) return;
      if (world.isOpaque(x, y + 1, z)) return;
      const speed = cropGrowthSpeed(world, x, y, z, blockId);
      const denominator = Math.floor(25 / speed) + 1;
      if (random >= 1 / denominator) return;
      world.setBlockState(x, y, z, cropState(age + 1), {
        cause: 'crop-growth',
        cascade: false,
      });
    },
    drops: cropDrops,
  });
}

registerBlockBehavior(Block.FARMLAND, {
  bootstrapDelay: 1,
  placed({ world, x, y, z }) {
    world.scheduleBlockTick(x, y, z, 1, 'farmland-check');
  },
  neighbourChanged({ world, x, y, z }) {
    world.scheduleBlockTick(x, y, z, 1, 'farmland-check');
  },
  scheduledTick({ world, x, y, z }) {
    if (world.getBlock(x, y, z) !== Block.FARMLAND) return;
    if (world.isCollidable(x, y + 1, z)) {
      world.setBlock(x, y, z, Block.DIRT, { cause: 'farmland-covered' });
    }
  },
  randomTick({ world, x, y, z, state }) {
    const moisture = farmlandMoisture(state);
    if (hasNearbyWater(world, x, y, z)) {
      if (moisture !== MAX_FARMLAND_MOISTURE) {
        world.setBlockState(x, y, z, farmlandState(MAX_FARMLAND_MOISTURE), {
          cause: 'farmland-hydrate',
          cascade: false,
        });
      }
      return;
    }

    if (moisture > 0) {
      world.setBlockState(x, y, z, farmlandState(moisture - 1), {
        cause: 'farmland-dry',
        cascade: false,
      });
      return;
    }
    if (!isCropBlock(world.getBlock(x, y + 1, z))) {
      world.setBlock(x, y, z, Block.DIRT, { cause: 'farmland-dry' });
    }
  },
});

registerCrop(Block.WHEAT_CROP);
registerCrop(Block.CARROT_CROP);
registerCrop(Block.POTATO_CROP);

registerBlockBehavior(Block.OAK_SAPLING, {
  randomTick({ world, x, y, z, state, random }) {
    if (world.isOpaque(x, y + 1, z)) return;
    if ((state & 1) === 0) {
      if (random < 0.25) {
        world.setBlockState(x, y, z, 1, { cause: 'sapling-stage', cascade: false });
      }
      return;
    }
    if (random < 0.2) growOakTree(world, x, y, z, world.gameTick);
  },
});
