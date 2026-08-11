/**
 * Universal item definitions.
 *
 * ## Why items are separate from blocks
 *
 * `BlockRegistry` describes what a *voxel* is: how it meshes, how it lights, how
 * it sounds. That is the wrong vocabulary for a pickaxe, a loaf of bread or a
 * bucket of lava, none of which can exist in the world grid. Trying to express
 * them as blocks is what forces the "block id 200 means wooden sword, don't ever
 * place it" hacks that make a codebase unmaintainable.
 *
 * So there are two registries. Every placeable block gets an item automatically
 * (see `ItemRegistry`), and items that are not blocks are declared here.
 *
 * ## Why string ids
 *
 * Block ids are numeric because a voxel is one byte and there are 32768 of them
 * per chunk; the packing is load-bearing. Items live in inventories — at most a
 * few dozen per player — so the storage argument does not apply, and string ids
 * buy three things that matter a great deal for the content ahead:
 *
 *  - No 256-value ceiling. Recipes, loot tables, trades and quest objectives all
 *    reference items, and the count grows fast.
 *  - Readable save files and readable data tables. `'stone_pickaxe'` in a recipe
 *    is self-documenting; `147` is a bug waiting to happen.
 *  - Renumbering is impossible by construction, so a reordered definition list
 *    can never silently rewrite everyone's inventory.
 *
 * Worker-safe: no DOM, no Three.js.
 */

import { Block, TILE_INDEX } from '../world/BlockTypes.js';

/**
 * Broad grouping, used for creative-menu tabs and recipe-book filtering.
 */
export const ItemCategory = Object.freeze({
  BUILDING: 'building',
  NATURAL: 'natural',
  DECORATION: 'decoration',
  TOOL: 'tool',
  COMBAT: 'combat',
  FOOD: 'food',
  MATERIAL: 'material',
  MISC: 'misc',
});

/**
 * What a tool is *for*. A block declares its `preferredTool`, and the two are
 * matched to decide mining speed and whether a drop happens at all.
 */
export const ToolType = Object.freeze({
  NONE: 'none',
  PICKAXE: 'pickaxe',
  AXE: 'axe',
  SHOVEL: 'shovel',
  HOE: 'hoe',
  SWORD: 'sword',
  SHEARS: 'shears',
  BUCKET: 'bucket',
});

/**
 * Material tiers, in ascending order.
 *
 * `level` is the comparable number: a block with `minimumHarvestTier: 2` needs a
 * tool of level 2 or better. `HAND` being level 0 means "bare hands" needs no
 * special case anywhere in the mining maths.
 */
export const ToolTier = Object.freeze({
  HAND: 'hand',
  WOOD: 'wood',
  STONE: 'stone',
  IRON: 'iron',
  DIAMOND: 'diamond',
  NETHERITE: 'netherite',
});

/** Equipment slot occupied by a wearable armour item. */
export const ArmourSlot = Object.freeze({
  HELMET: 'helmet',
  CHESTPLATE: 'chestplate',
  LEGGINGS: 'leggings',
  BOOTS: 'boots',
});

/** Armour materials currently available in survival progression. */
export const ArmourMaterial = Object.freeze({
  LEATHER: 'leather',
  GOLD: 'gold',
  IRON: 'iron',
  DIAMOND: 'diamond',
  NETHERITE: 'netherite',
});

/**
 * Per-piece protection and durability.
 *
 * Values intentionally mirror the familiar Java-style progression: leather is
 * early and weak, gold protects well but wears quickly, iron is the dependable
 * mid-game set and diamond adds toughness for large hits.
 */
export const ARMOUR_DATA = Object.freeze({
  [ArmourMaterial.LEATHER]: Object.freeze({
    toughness: 0,
    pieces: Object.freeze({
      [ArmourSlot.HELMET]: Object.freeze({ points: 1, durability: 55 }),
      [ArmourSlot.CHESTPLATE]: Object.freeze({ points: 3, durability: 80 }),
      [ArmourSlot.LEGGINGS]: Object.freeze({ points: 2, durability: 75 }),
      [ArmourSlot.BOOTS]: Object.freeze({ points: 1, durability: 65 }),
    }),
  }),
  [ArmourMaterial.GOLD]: Object.freeze({
    toughness: 0,
    pieces: Object.freeze({
      [ArmourSlot.HELMET]: Object.freeze({ points: 2, durability: 77 }),
      [ArmourSlot.CHESTPLATE]: Object.freeze({ points: 5, durability: 112 }),
      [ArmourSlot.LEGGINGS]: Object.freeze({ points: 3, durability: 105 }),
      [ArmourSlot.BOOTS]: Object.freeze({ points: 1, durability: 91 }),
    }),
  }),
  [ArmourMaterial.IRON]: Object.freeze({
    toughness: 0,
    pieces: Object.freeze({
      [ArmourSlot.HELMET]: Object.freeze({ points: 2, durability: 165 }),
      [ArmourSlot.CHESTPLATE]: Object.freeze({ points: 6, durability: 240 }),
      [ArmourSlot.LEGGINGS]: Object.freeze({ points: 5, durability: 225 }),
      [ArmourSlot.BOOTS]: Object.freeze({ points: 2, durability: 195 }),
    }),
  }),
  [ArmourMaterial.DIAMOND]: Object.freeze({
    toughness: 2,
    pieces: Object.freeze({
      [ArmourSlot.HELMET]: Object.freeze({ points: 3, durability: 363 }),
      [ArmourSlot.CHESTPLATE]: Object.freeze({ points: 8, durability: 528 }),
      [ArmourSlot.LEGGINGS]: Object.freeze({ points: 6, durability: 495 }),
      [ArmourSlot.BOOTS]: Object.freeze({ points: 3, durability: 429 }),
    }),
  }),
  [ArmourMaterial.NETHERITE]: Object.freeze({
    toughness: 3,
    pieces: Object.freeze({
      [ArmourSlot.HELMET]: Object.freeze({ points: 3, durability: 407 }),
      [ArmourSlot.CHESTPLATE]: Object.freeze({ points: 8, durability: 592 }),
      [ArmourSlot.LEGGINGS]: Object.freeze({ points: 6, durability: 555 }),
      [ArmourSlot.BOOTS]: Object.freeze({ points: 3, durability: 481 }),
    }),
  }),
});

/**
 * Per-tier tuning.
 *
 * `speed` multiplies mining rate when the tool matches the block's preferred
 * tool. `damage` is the base melee damage before the item's own modifier. These
 * numbers are deliberately spread widely so an upgrade is immediately felt.
 */
export const TIER_DATA = Object.freeze({
  // Speeds are Java Edition's exact tool-tier multipliers (wood 2, stone 4,
  // iron 6, diamond 8), so together with HARDNESS_TO_SECONDS the measured
  // break times line up with the vanilla progression table.
  [ToolTier.HAND]: Object.freeze({ level: 0, speed: 1, durability: 0, damage: 1, order: 0 }),
  [ToolTier.WOOD]: Object.freeze({ level: 1, speed: 2, durability: 59, damage: 2, order: 1 }),
  [ToolTier.STONE]: Object.freeze({ level: 2, speed: 4, durability: 131, damage: 3, order: 2 }),
  [ToolTier.IRON]: Object.freeze({ level: 3, speed: 6, durability: 250, damage: 4, order: 3 }),
  [ToolTier.DIAMOND]: Object.freeze({
    level: 4,
    speed: 8,
    durability: 1561,
    damage: 5,
    order: 4,
  }),
  [ToolTier.NETHERITE]: Object.freeze({
    level: 5,
    speed: 9,
    durability: 2031,
    damage: 6,
    order: 5,
  }),
});

/** Tier names ordered weakest to strongest, for progression checks. */
export const TIER_ORDER = Object.freeze([
  ToolTier.HAND,
  ToolTier.WOOD,
  ToolTier.STONE,
  ToolTier.IRON,
  ToolTier.DIAMOND,
  ToolTier.NETHERITE,
]);

/**
 * @typedef {Object} ItemDefinition
 * @property {string} id Stable identifier, also the save key.
 * @property {string} name Internal snake_case name; equals `id` for declared items.
 * @property {string} displayName Human-facing label.
 * @property {string} category One of `ItemCategory`.
 * @property {number} maxStack 1 for tools, 16 for some foods, 64 for most things.
 * @property {number} icon Atlas tile index used to draw the item.
 * @property {number|null} placeableBlockId Block placed on use, or null.
 * @property {string} toolType One of `ToolType`.
 * @property {string} toolTier One of `ToolTier`.
 * @property {number} attackDamage Melee damage in half-hearts.
 * @property {number} attackSpeed Attacks per second.
 * @property {number} miningSpeed Multiplier against block hardness.
 * @property {number} durability Uses before breaking; 0 means indestructible.
 * @property {string|null} armourSlot Wearable slot, or null for ordinary items.
 * @property {string|null} armourMaterial Material family, or null.
 * @property {number} armourPoints Protection points supplied while equipped.
 * @property {number} armourToughness Toughness supplied while equipped.
 * @property {number} foodValue Hunger points restored.
 * @property {number} saturation Saturation restored.
 * @property {number} fuelValue Seconds of furnace burn time; 0 means not a fuel.
 * @property {string[]} recipeTags Tags for "any plank"-style recipe matching.
 * @property {Object} metadata Free-form extras (eat time, bucket contents, ...).
 */

/**
 * Normalises a partial definition into a complete, frozen `ItemDefinition`.
 *
 * Every field gets an explicit default so no consumer has to write
 * `item.fuelValue ?? 0`. Validation throws rather than warns: a malformed item
 * would otherwise surface much later as a recipe that silently never matches.
 *
 * @param {Partial<ItemDefinition> & {id: string}} definition
 * @returns {ItemDefinition}
 */
export function item(definition) {
  const id = definition.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Item definition needs a non-empty string id');
  }
  if (!/^[a-z0-9_]+$/.test(id)) {
    throw new Error(`Item id "${id}" must be lower_snake_case`);
  }

  const toolType = definition.toolType ?? ToolType.NONE;
  if (!Object.values(ToolType).includes(toolType)) {
    throw new Error(`Item "${id}" has unknown toolType "${toolType}"`);
  }
  const toolTier = definition.toolTier ?? ToolTier.HAND;
  if (!Object.values(ToolTier).includes(toolTier)) {
    throw new Error(`Item "${id}" has unknown toolTier "${toolTier}"`);
  }
  const category = definition.category ?? ItemCategory.MISC;
  if (!Object.values(ItemCategory).includes(category)) {
    throw new Error(`Item "${id}" has unknown category "${category}"`);
  }

  const armourSlot = definition.armourSlot ?? null;
  if (armourSlot !== null && !Object.values(ArmourSlot).includes(armourSlot)) {
    throw new Error(`Item "${id}" has unknown armourSlot "${armourSlot}"`);
  }
  const armourMaterial = definition.armourMaterial ?? null;
  if (armourMaterial !== null && !Object.values(ArmourMaterial).includes(armourMaterial)) {
    throw new Error(`Item "${id}" has unknown armourMaterial "${armourMaterial}"`);
  }
  if ((armourSlot === null) !== (armourMaterial === null)) {
    throw new Error(`Item "${id}" must declare armourSlot and armourMaterial together`);
  }

  const isTool = toolType !== ToolType.NONE && toolType !== ToolType.BUCKET;
  const tier = TIER_DATA[toolTier];

  // A tool defaults to its tier's numbers so declaring one is a single line.
  const durability = definition.durability ?? (isTool ? tier.durability : 0);
  const maxStack = definition.maxStack ?? (durability > 0 ? 1 : 64);

  if (durability > 0 && maxStack !== 1) {
    // Two damaged tools cannot occupy one slot without losing one of the two
    // damage values, so the registry refuses to describe that situation at all.
    throw new Error(`Item "${id}" has durability but a stack size of ${maxStack}`);
  }
  if (maxStack < 1 || maxStack > 64 || !Number.isInteger(maxStack)) {
    throw new Error(`Item "${id}" has an invalid maxStack ${maxStack}`);
  }

  const icon = definition.icon ?? TILE_INDEX[id];
  if (icon === undefined || icon === null) {
    throw new Error(`Item "${id}" has no icon tile; add "${id}" to TILE_NAMES or pass an icon`);
  }

  const foodValue = definition.foodValue ?? 0;
  if (foodValue > 0 && category !== ItemCategory.FOOD) {
    throw new Error(`Item "${id}" restores hunger but is not in the food category`);
  }

  return Object.freeze({
    id,
    name: definition.name ?? id,
    displayName: definition.displayName ?? toDisplayName(id),
    category,
    maxStack,
    icon,
    placeableBlockId: definition.placeableBlockId ?? null,
    toolType,
    toolTier,
    attackDamage: definition.attackDamage ?? (isTool ? tier.damage : 1),
    attackSpeed: definition.attackSpeed ?? (toolType === ToolType.SWORD ? 1.6 : 4),
    miningSpeed: definition.miningSpeed ?? (isTool ? tier.speed : 1),
    durability,
    armourSlot,
    armourMaterial,
    armourPoints: definition.armourPoints ?? 0,
    armourToughness: definition.armourToughness ?? 0,
    foodValue,
    saturation: definition.saturation ?? 0,
    fuelValue: definition.fuelValue ?? 0,
    recipeTags: Object.freeze(definition.recipeTags ? [...definition.recipeTags] : []),
    metadata: Object.freeze({ ...(definition.metadata ?? {}) }),
  });
}

/** Builds helmet, chestplate, leggings and boots for one material. */
function armourSet(materialName) {
  const material = ARMOUR_DATA[materialName];
  return Object.values(ArmourSlot).map((slot) => {
    const piece = material.pieces[slot];
    return item({
      id: `${materialName}_${slot}`,
      category: ItemCategory.COMBAT,
      maxStack: 1,
      durability: piece.durability,
      armourSlot: slot,
      armourMaterial: materialName,
      armourPoints: piece.points,
      armourToughness: material.toughness,
      recipeTags: [`armour/${slot}`, `armour/${materialName}`],
    });
  });
}

/** `oak_log` -> `Oak Log`. */
export function toDisplayName(id) {
  return id
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Builds the five tools of one material in one call.
 *
 * Writing these out by hand is twenty near-identical definitions and an
 * invitation to a typo that only shows up when a recipe stops matching.
 *
 * @param {string} tierName One of `ToolTier`.
 * @param {string[]} tags Recipe tags shared by the whole set.
 * @returns {ItemDefinition[]}
 */
function toolSet(tierName, tags = []) {
  const tier = TIER_DATA[tierName];
  const make = (toolType, extra = {}) =>
    item({
      id: `${tierName}_${toolType}`,
      category: toolType === ToolType.SWORD ? ItemCategory.COMBAT : ItemCategory.TOOL,
      toolType,
      toolTier: tierName,
      recipeTags: [`tool/${toolType}`, `tier/${tierName}`, ...tags],
      ...extra,
    });

  return [
    make(ToolType.PICKAXE),
    make(ToolType.AXE, { attackDamage: tier.damage + 1, attackSpeed: 3.2 }),
    make(ToolType.SHOVEL),
    make(ToolType.HOE, { attackSpeed: 3 }),
    // A sword mines nothing well but hits hardest and swings fast.
    make(ToolType.SWORD, {
      attackDamage: tier.damage + 2,
      miningSpeed: 1,
      attackSpeed: 1.6,
    }),
  ];
}

/**
 * Items that are not blocks.
 *
 * Block items are generated from `BLOCK_DEFINITIONS` by `ItemRegistry`, so this
 * list stays focused on things the world grid cannot represent.
 */
export const ITEM_DEFINITIONS = Object.freeze([
  // ------------------------------------------------------------- raw materials
  item({
    id: 'stick',
    category: ItemCategory.MATERIAL,
    // Sticks burn: a cheap, weak fuel that makes an early furnace usable before
    // coal is found.
    fuelValue: 5,
    recipeTags: ['stick'],
  }),
  item({
    id: 'coal',
    category: ItemCategory.MATERIAL,
    fuelValue: 80,
    recipeTags: ['coal', 'fuel'],
  }),
  item({
    id: 'charcoal',
    category: ItemCategory.MATERIAL,
    fuelValue: 80,
    recipeTags: ['coal', 'fuel'],
  }),
  item({ id: 'iron_ingot', category: ItemCategory.MATERIAL, recipeTags: ['ingot/iron'] }),
  item({ id: 'gold_ingot', category: ItemCategory.MATERIAL, recipeTags: ['ingot/gold'] }),
  item({ id: 'diamond', category: ItemCategory.MATERIAL, recipeTags: ['gem/diamond'] }),
  item({ id: 'netherite_scrap', category: ItemCategory.MATERIAL, recipeTags: ['scrap/netherite'] }),
  item({ id: 'netherite_ingot', category: ItemCategory.MATERIAL, recipeTags: ['ingot/netherite'] }),
  // Phase 4 Nether materials. `nether_wart` is both a crop block and an item,
  // so the item borrows a distinct icon tile name to avoid colliding with it.
  item({ id: 'blaze_rod', category: ItemCategory.MATERIAL, recipeTags: ['rod/blaze', 'fuel'] }),
  item({ id: 'blaze_powder', category: ItemCategory.MATERIAL, recipeTags: ['powder/blaze'] }),
  // Nether wart is both a crop block and a held item. Like carrots, the item
  // plants the crop through metadata rather than placing a block directly, and
  // the `plantsCrop` key is what marks the block shadowing as intentional.
  item({ id: 'nether_wart', category: ItemCategory.MATERIAL, icon: TILE_INDEX.nether_wart_item,
    placeableBlockId: Block.NETHER_WART, recipeTags: ['crop/nether_wart'],
    metadata: { plantsCrop: 'nether_wart' } }),
  item({ id: 'ghast_tear', category: ItemCategory.MATERIAL, recipeTags: ['ghast_tear'] }),
  item({ id: 'gunpowder', category: ItemCategory.MATERIAL, recipeTags: ['gunpowder'] }),
  item({ id: 'magma_cream', category: ItemCategory.MATERIAL, recipeTags: ['magma_cream'] }),
  item({ id: 'gold_nugget', category: ItemCategory.MATERIAL, recipeTags: ['nugget/gold'] }),
  item({ id: 'glowstone_dust', category: ItemCategory.MATERIAL, recipeTags: ['glowstone_dust'] }),
  item({ id: 'nether_star', category: ItemCategory.MATERIAL, maxStack: 1, recipeTags: ['nether_star'] }),
  item({ id: 'wither_skeleton_skull', category: ItemCategory.MATERIAL, maxStack: 1,
    placeableBlockId: Block.WITHER_SKELETON_SKULL, recipeTags: ['skull/wither'] }),
  item({ id: 'warped_fungus_on_a_stick', category: ItemCategory.TOOL, maxStack: 1, durability: 100,
    metadata: { steers: 'strider' } }),
  // Phase 5. The pearl is the Enderman's only drop and the Eye of Ender's only
  // ingredient, which makes it the hard gate on reaching the End: no pearls,
  // no eyes, no stronghold portal.
  item({ id: 'ender_pearl', category: ItemCategory.MATERIAL, maxStack: 16,
    recipeTags: ['ender_pearl'], metadata: { throwable: 'teleport' } }),
  item({ id: 'eye_of_ender', category: ItemCategory.MATERIAL, maxStack: 16,
    recipeTags: ['eye_of_ender'], metadata: { activatesPortalFrame: 'end_portal_frame' } }),
  // The bottle the brewing stand has always assumed existed. Without it the
  // whole potion chain had no container item.
  item({ id: 'glass_bottle', category: ItemCategory.MATERIAL, recipeTags: ['glass_bottle'] }),
  // `BrewingSystem.brewPotion` turns a potion lingering when brewed with dragon
  // breath. That branch existed before the item did; this makes it reachable.
  item({ id: 'dragon_breath', category: ItemCategory.MATERIAL, maxStack: 16,
    recipeTags: ['dragon_breath'] }),
  // Chorus fruit is the End's only food, and it teleports the eater a short
  // distance -- which is also its danger, since it can drop you off an island.
  item({ id: 'chorus_fruit', category: ItemCategory.FOOD, foodValue: 4, saturation: 2.4,
    metadata: { teleportsOnEat: 8 } }),
  // Version 7 outer-End rewards and dragon-respawn ingredients.
  item({ id: 'shulker_shell', category: ItemCategory.MATERIAL,
    recipeTags: ['shulker_shell'] }),
  item({ id: 'end_crystal', category: ItemCategory.MATERIAL, maxStack: 64,
    recipeTags: ['end_crystal'], metadata: { respawnsDragon: true } }),
  item({ id: 'elytra', category: ItemCategory.COMBAT, maxStack: 1, durability: 432,
    metadata: { glider: true, equipmentSlot: ArmourSlot.CHESTPLATE } }),
  item({ id: 'leather', category: ItemCategory.MATERIAL, recipeTags: ['leather'] }),
  item({ id: 'feather', category: ItemCategory.MATERIAL, recipeTags: ['feather'] }),
  item({ id: 'bone', category: ItemCategory.MATERIAL, recipeTags: ['bone'] }),
  item({ id: 'bone_meal', category: ItemCategory.MATERIAL, recipeTags: ['fertiliser'] }),
  item({ id: 'string', category: ItemCategory.MATERIAL, recipeTags: ['string'] }),
  item({ id: 'flint', category: ItemCategory.MATERIAL, recipeTags: ['flint'] }),
  item({ id: 'clay_ball', category: ItemCategory.MATERIAL, recipeTags: ['clay'] }),
  item({ id: 'wheat', category: ItemCategory.MATERIAL, recipeTags: ['crop/wheat'] }),
  item({
    id: 'wheat_seeds',
    displayName: 'Wheat Seeds',
    category: ItemCategory.MATERIAL,
    recipeTags: ['seed'],
    // Planting is a "use on farmland" action rather than a block placement, so
    // the target block lives in metadata instead of `placeableBlockId`.
    metadata: { plantsCrop: 'wheat' },
  }),

  // ---------------------------------------------------------------------- tools
  ...toolSet(ToolTier.WOOD),
  ...toolSet(ToolTier.STONE),
  ...toolSet(ToolTier.IRON),
  ...toolSet(ToolTier.DIAMOND),
  ...toolSet(ToolTier.NETHERITE, ['fireproof']),

  // --------------------------------------------------------------------- armour
  ...armourSet(ArmourMaterial.LEATHER),
  ...armourSet(ArmourMaterial.GOLD),
  ...armourSet(ArmourMaterial.IRON),
  ...armourSet(ArmourMaterial.DIAMOND),
  ...armourSet(ArmourMaterial.NETHERITE),

  // ---------------------------------------------------------- ranged/defence
  item({
    id: 'arrow',
    category: ItemCategory.COMBAT,
    maxStack: 64,
    recipeTags: ['ammunition/arrow'],
  }),
  item({
    id: 'bow',
    category: ItemCategory.COMBAT,
    maxStack: 1,
    durability: 384,
    attackDamage: 1,
    attackSpeed: 1.2,
    metadata: { rangedWeapon: 'bow', ammo: 'arrow', maxChargeSeconds: 1 },
  }),
  item({
    id: 'shield',
    category: ItemCategory.COMBAT,
    maxStack: 1,
    durability: 336,
    metadata: { shield: true },
  }),
  item({
    id: 'flint_and_steel',
    displayName: 'Flint and Steel',
    category: ItemCategory.TOOL,
    maxStack: 1,
    durability: 64,
    metadata: { ignites: true },
  }),

  // ----------------------------------------------------------------------- food
  item({
    id: 'bread',
    category: ItemCategory.FOOD,
    foodValue: 5,
    saturation: 6,
    recipeTags: ['food'],
  }),
  item({
    id: 'apple',
    category: ItemCategory.FOOD,
    foodValue: 4,
    saturation: 2.4,
    recipeTags: ['food'],
  }),
  item({
    id: 'carrot',
    category: ItemCategory.FOOD,
    foodValue: 3,
    saturation: 3.6,
    recipeTags: ['food', 'crop/carrot', 'seed'],
    metadata: { plantsCrop: 'carrot' },
  }),
  item({
    id: 'potato',
    category: ItemCategory.FOOD,
    foodValue: 1,
    saturation: 0.6,
    recipeTags: ['food', 'crop/potato', 'seed'],
    metadata: { plantsCrop: 'potato' },
  }),
  item({
    id: 'baked_potato',
    category: ItemCategory.FOOD,
    foodValue: 5,
    saturation: 6,
    recipeTags: ['food'],
  }),
  item({
    id: 'raw_beef',
    category: ItemCategory.FOOD,
    foodValue: 3,
    saturation: 1.8,
    recipeTags: ['food', 'raw_meat'],
  }),
  item({
    id: 'cooked_beef',
    category: ItemCategory.FOOD,
    foodValue: 8,
    saturation: 12.8,
    recipeTags: ['food'],
  }),
  item({
    id: 'raw_porkchop',
    category: ItemCategory.FOOD,
    foodValue: 3,
    saturation: 1.8,
    recipeTags: ['food', 'raw_meat'],
  }),
  item({
    id: 'cooked_porkchop',
    category: ItemCategory.FOOD,
    foodValue: 8,
    saturation: 12.8,
    recipeTags: ['food'],
  }),
  item({
    id: 'raw_chicken',
    category: ItemCategory.FOOD,
    foodValue: 2,
    saturation: 1.2,
    recipeTags: ['food', 'raw_meat'],
  }),
  item({
    id: 'cooked_chicken',
    category: ItemCategory.FOOD,
    foodValue: 6,
    saturation: 7.2,
    recipeTags: ['food'],
  }),
  item({
    id: 'raw_mutton',
    category: ItemCategory.FOOD,
    foodValue: 2,
    saturation: 1.2,
    recipeTags: ['food', 'raw_meat'],
  }),
  item({
    id: 'cooked_mutton',
    category: ItemCategory.FOOD,
    foodValue: 6,
    saturation: 9.6,
    recipeTags: ['food'],
  }),

  // ------------------------------------------------------------------- utility
  item({
    id: 'bucket',
    category: ItemCategory.MISC,
    toolType: ToolType.BUCKET,
    maxStack: 16,
    metadata: { fluid: null },
  }),
  item({
    id: 'water_bucket',
    category: ItemCategory.MISC,
    toolType: ToolType.BUCKET,
    maxStack: 1,
    metadata: { fluid: 'water', emptiesTo: 'bucket' },
  }),
  item({
    id: 'lava_bucket',
    category: ItemCategory.MISC,
    toolType: ToolType.BUCKET,
    maxStack: 1,
    // By far the strongest fuel in the game, which is what makes hauling lava
    // back from a cave worth the trip. The bucket survives the burn — see
    // `emptiesTo`, which `FurnaceBlockEntity` honours so the container is
    // returned rather than consumed.
    fuelValue: 1000,
    metadata: { fluid: 'lava', emptiesTo: 'bucket' },
  }),
  item({
    id: 'oak_sapling',
    category: ItemCategory.DECORATION,
    placeableBlockId: Block.OAK_SAPLING,
    fuelValue: 5,
    recipeTags: ['sapling'],
  }),
]);

/**
 * Items granted to a fresh survival player.
 *
 * Deliberately empty: starting with nothing is what makes the first tree matter,
 * and the progression chain in `Advancements` assumes a bare-handed start.
 * Kept as an explicit export so the intent is visible rather than implied by an
 * absent call.
 */
export const SURVIVAL_STARTING_ITEMS = Object.freeze([]);

export default ITEM_DEFINITIONS;
