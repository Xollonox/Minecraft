/** Deterministic special drops for ordinary terrain blocks. */

import { ItemStack } from '../../items/ItemStack.js';
import { hash3 } from '../../utils/MathUtils.js';
import { createLootRandom, rollLootTable } from '../../loot/LootTable.js';
import { registerBlockBehavior } from '../BlockBehaviorRegistry.js';
import { Block } from '../BlockTypes.js';

const GRAVEL_LOOT = Object.freeze({
  pools: Object.freeze([{
    mode: 'weighted',
    rolls: 1,
    entries: Object.freeze([
      Object.freeze({ item: 'flint', count: 1, weight: 1 }),
      Object.freeze({ item: 'gravel', count: 1, weight: 9 }),
    ]),
  }]),
});

/** Familiar ten-percent flint chance, deterministic for a world/tick/position. */
export function gravelDrops({ world, x, y, z, tick }) {
  const seed = hash3(x, y, z, (world.seed ^ tick ^ 0x6a09e667) >>> 0);
  return rollLootTable(GRAVEL_LOOT, { random: createLootRandom(seed) })
    .map((drop) => new ItemStack(drop.item, drop.count));
}


registerBlockBehavior(Block.GRAVEL, {
  drops: gravelDrops,
});

export default Object.freeze({ gravelDrops });
