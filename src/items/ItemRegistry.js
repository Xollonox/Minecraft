/**
 * The single lookup for every item in the game.
 *
 * Mirrors the `BlockTypes` -> `BlockRegistry` split: declarative data in
 * `ItemTypes.js`, flattened and validated here at module load. Validation throws
 * rather than warns, for the same reason it does in `BlockRegistry`: a duplicate
 * id or a dangling block reference is a programming mistake, and discovering it
 * as "that recipe just never matches" hours later is far worse than a hard
 * failure on boot.
 *
 * ## Block items are generated, not written by hand
 *
 * Every block that a player can hold needs an item. Writing 37 of those by hand
 * would guarantee that the next block someone adds is placeable in the world but
 * impossible to pick up. Instead `BLOCK_DEFINITIONS` is walked and an item is
 * derived from each block, using the block's own `stackSize`, sound group and
 * top texture. A block opts out by declaring `stackSize: 0`, which is already how
 * `BlockPlacer` recognises an unplaceable block.
 *
 * A declared item in `ITEM_DEFINITIONS` always wins over the generated one, so a
 * block item that needs special behaviour (a sapling that plants rather than
 * places, a fuel value on planks) can simply be declared.
 *
 * Worker-safe: no DOM, no Three.js.
 */

import { BLOCK_DEFINITIONS, Block, TILE_INDEX } from '../world/BlockTypes.js';
import { FACE_PY } from '../config/GameConfig.js';
import {
  ITEM_DEFINITIONS,
  ItemCategory,
  ToolTier,
  ToolType,
  TIER_DATA,
  item,
  toDisplayName,
} from './ItemTypes.js';

/**
 * Categories chosen for generated block items, keyed by the block's sound group.
 * Purely cosmetic — it decides which creative tab the block lands in.
 */
const CATEGORY_BY_SOUND_GROUP = {
  stone: ItemCategory.BUILDING,
  dirt: ItemCategory.NATURAL,
  grass: ItemCategory.NATURAL,
  sand: ItemCategory.NATURAL,
  snow: ItemCategory.NATURAL,
  wood: ItemCategory.BUILDING,
  glass: ItemCategory.BUILDING,
  plant: ItemCategory.DECORATION,
  metal: ItemCategory.BUILDING,
  liquid: ItemCategory.MISC,
};

/**
 * Burn times for generated block items, by recipe tag.
 * Anything wooden is a fuel; declaring it per block would be noise.
 */
const WOODEN_BLOCK_FUEL = 15;

/** @type {Map<string, import('./ItemTypes.js').ItemDefinition>} */
const BY_ID = new Map();

/** @type {Map<number, string>} Block id -> the item that places it. */
const ITEM_FOR_BLOCK = new Map();

/** @type {Map<string, string[]>} Recipe tag -> item ids carrying it. */
const BY_TAG = new Map();

// ------------------------------------------------------- generated block items

/**
 * Derives an item definition from a block definition.
 * @param {Object} block
 * @returns {import('./ItemTypes.js').ItemDefinition|null}
 */
function itemForBlock(block) {
  if (block.id === Block.AIR) return null;
  // `stackSize: 0` is the existing marker for "cannot be held or placed".
  if (block.stackSize === 0) return null;

  const isWooden = block.soundGroup === 'wood';
  const tags = ['block'];
  if (isWooden) tags.push('wooden');
  // Material tags declared on the block itself, e.g. `planks` or `logs`. These
  // are what let a single recipe accept any wood type.
  for (const tag of block.recipeTags ?? []) {
    if (!tags.includes(tag)) tags.push(tag);
  }

  // Block definitions carry tile *names*; the atlas is addressed by index.
  const tileName = block.textureTop ?? block.textureSide;
  const icon = TILE_INDEX[tileName];
  if (icon === undefined) {
    throw new Error(`Block "${block.name}" references unknown tile "${tileName}"`);
  }

  return item({
    id: block.name,
    displayName: block.displayName ?? toDisplayName(block.name),
    category: CATEGORY_BY_SOUND_GROUP[block.soundGroup] ?? ItemCategory.BUILDING,
    maxStack: block.stackSize,
    // The top face reads best as an icon for almost everything; grass and logs
    // in particular look wrong rendered from their side texture.
    icon,
    placeableBlockId: block.id,
    fuelValue: isWooden ? WOODEN_BLOCK_FUEL : 0,
    recipeTags: tags,
  });
}

for (const block of BLOCK_DEFINITIONS) {
  const generated = itemForBlock(block);
  if (generated) BY_ID.set(generated.id, generated);
}

// ---------------------------------------------------------- declared overrides

for (const declared of ITEM_DEFINITIONS) {
  const generated = BY_ID.get(declared.id);
  if (generated && generated.placeableBlockId !== null && declared.placeableBlockId === null) {
    // A declared item that shadows a block item but forgot to carry the block
    // reference would become unplaceable. That is almost always a mistake, and
    // an intentional one (a sapling that plants via metadata) is expressed by
    // giving the item a `plantsCrop`/`plantsSapling` metadata key instead.
    const intentional = Object.keys(declared.metadata).some((key) => key.startsWith('plants'));
    if (!intentional) {
      throw new Error(
        `Item "${declared.id}" shadows block ${generated.placeableBlockId} but has no ` +
          'placeableBlockId; pass one explicitly or mark it as a planting item'
      );
    }
  }
  BY_ID.set(declared.id, declared);
}

// ------------------------------------------------------------------- validation

{
  const seenIcons = new Map();
  for (const definition of BY_ID.values()) {
    if (!Number.isInteger(definition.icon) || definition.icon < 0) {
      throw new Error(`Item "${definition.id}" has a non-integer icon ${definition.icon}`);
    }
    if (definition.placeableBlockId !== null) {
      const target = BLOCK_DEFINITIONS.find((b) => b.id === definition.placeableBlockId);
      if (!target) {
        throw new Error(
          `Item "${definition.id}" places unknown block id ${definition.placeableBlockId}`
        );
      }
      const existing = ITEM_FOR_BLOCK.get(definition.placeableBlockId);
      if (existing) {
        throw new Error(
          `Blocks must have one placing item: ${existing} and ${definition.id} both place ` +
            `block ${definition.placeableBlockId}`
        );
      }
      ITEM_FOR_BLOCK.set(definition.placeableBlockId, definition.id);
    }
    // Duplicate icons are legal (many items share a tile) but a duplicate icon
    // on two *tools* is nearly always a copy-paste slip, so it is worth noting.
    if (definition.toolType !== ToolType.NONE) {
      const other = seenIcons.get(definition.icon);
      if (other) {
        throw new Error(
          `Tools "${other}" and "${definition.id}" share icon tile ${definition.icon}`
        );
      }
      seenIcons.set(definition.icon, definition.id);
    }
    for (const tag of definition.recipeTags) {
      if (!BY_TAG.has(tag)) BY_TAG.set(tag, []);
      BY_TAG.get(tag).push(definition.id);
    }
  }
}

/** Every item id, in definition order. */
export const ITEM_IDS = Object.freeze([...BY_ID.keys()]);

/** Total number of registered items. */
export const ITEM_COUNT = ITEM_IDS.length;

// --------------------------------------------------------------------- lookups

/**
 * @param {string} id
 * @returns {import('./ItemTypes.js').ItemDefinition|null}
 */
export function getItem(id) {
  return BY_ID.get(id) ?? null;
}

/**
 * Like `getItem` but throws, for call sites where a miss is a bug.
 * @param {string} id
 * @returns {import('./ItemTypes.js').ItemDefinition}
 */
export function requireItem(id) {
  const definition = BY_ID.get(id);
  if (!definition) throw new Error(`Unknown item "${id}"`);
  return definition;
}

/**
 * @param {unknown} id
 * @returns {boolean}
 */
export function isValidItemId(id) {
  return typeof id === 'string' && BY_ID.has(id);
}

/**
 * The item that places a given block, if any.
 * @param {number} blockId
 * @returns {string|null}
 */
export function itemIdForBlock(blockId) {
  return ITEM_FOR_BLOCK.get(blockId) ?? null;
}

/**
 * The block a given item places, if any.
 * @param {string} itemId
 * @returns {number|null}
 */
export function blockIdForItem(itemId) {
  return BY_ID.get(itemId)?.placeableBlockId ?? null;
}

/**
 * Every item carrying a recipe tag, e.g. `'wooden'` or `'ingot/iron'`.
 * @param {string} tag
 * @returns {string[]}
 */
export function itemsWithTag(tag) {
  return BY_TAG.get(tag) ?? [];
}

/** All known recipe tags. */
export function allTags() {
  return [...BY_TAG.keys()];
}

/**
 * @param {string} category One of `ItemCategory`.
 * @returns {import('./ItemTypes.js').ItemDefinition[]}
 */
export function itemsInCategory(category) {
  return [...BY_ID.values()].filter((definition) => definition.category === category);
}

/**
 * Items that burn in a furnace, strongest first.
 * @returns {import('./ItemTypes.js').ItemDefinition[]}
 */
export function fuelItems() {
  return [...BY_ID.values()]
    .filter((definition) => definition.fuelValue > 0)
    .sort((a, b) => b.fuelValue - a.fuelValue);
}

/**
 * Numeric harvest level of an item, 0 for anything that is not a tool.
 * @param {string|null} itemId
 * @returns {number}
 */
export function harvestLevelOf(itemId) {
  const definition = itemId ? BY_ID.get(itemId) : null;
  if (!definition) return TIER_DATA[ToolTier.HAND].level;
  return TIER_DATA[definition.toolTier]?.level ?? 0;
}

/**
 * Human-readable label, safe for unknown ids.
 * @param {string|null} itemId
 * @returns {string}
 */
export function getItemName(itemId) {
  return (itemId && BY_ID.get(itemId)?.displayName) || 'Unknown Item';
}

/**
 * Snapshot of the registry, for the debug overlay and the audit script.
 * @returns {{items: number, tools: number, armour: number, food: number, fuels: number, placeable: number}}
 */
export function describeRegistry() {
  let tools = 0;
  let armour = 0;
  let food = 0;
  let fuels = 0;
  for (const definition of BY_ID.values()) {
    if (definition.toolType !== ToolType.NONE && definition.toolType !== ToolType.BUCKET) tools++;
    if (definition.armourSlot !== null) armour++;
    if (definition.foodValue > 0) food++;
    if (definition.fuelValue > 0) fuels++;
  }
  return { items: ITEM_COUNT, tools, armour, food, fuels, placeable: ITEM_FOR_BLOCK.size };
}

export { ItemCategory, ToolType, ToolTier, TIER_DATA, FACE_PY };
export default getItem;
