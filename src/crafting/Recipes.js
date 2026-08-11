/**
 * Every recipe in the game.
 *
 * Data only. `RecipeRegistry` validates and indexes these at load; the
 * constructors in `RecipeTypes.js` throw on a malformed entry, so a typo here is
 * a boot failure rather than a recipe that mysteriously never matches.
 *
 * ## Ordering reflects the progression
 *
 * The list runs wood -> tools -> stone -> furnace -> metal, which is the order the
 * player actually discovers them. That makes the recipe book's default ordering
 * useful without a separate sort key, and it makes a gap in the progression
 * visible while reading the file.
 *
 * ## Tags over duplication
 *
 * `#planks` and `#wooden` mean one recipe covers all four wood types. Adding a
 * fifth wood is then a block definition plus a tag, with no recipe edits.
 *
 * Worker-safe: no DOM, no Three.js.
 */

import { shaped, shapeless, smelting, CraftingStation } from './RecipeTypes.js';
import { STONE_FAMILIES, WOOD_FAMILIES, variantName } from '../world/BlockFamily.js';

/**
 * Logs that can be turned into planks.
 *
 * Written out rather than tagged because each log yields *its own* plank type in
 * most voxel games; here there is a single plank item, so one shapeless recipe
 * per log keeps the recipe book showing four distinct entries — which is what a
 * player looking for "what do I do with birch" expects to find.
 */
const LOG_ITEMS = ['oak_log', 'spruce_log', 'birch_log'];

/** @type {import('./RecipeTypes.js').Recipe[]} */
const BASE_RECIPE_DEFINITIONS = Object.freeze([
  // ------------------------------------------------------------------ wood
  ...LOG_ITEMS.map((log) =>
    shapeless({
      id: `planks_from_${log}`,
      ingredients: [log],
      result: { id: 'oak_planks', count: 4 },
      group: 'planks',
    })
  ),

  shaped({
    id: 'stick',
    pattern: ['P', 'P'],
    key: { P: '#planks' },
    result: { id: 'stick', count: 4 },
  }),

  // ---------------------------------------------------------- workstations
  shaped({
    id: 'crafting_table',
    pattern: ['PP', 'PP'],
    key: { P: '#planks' },
    result: { id: 'crafting_table', count: 1 },
  }),
  shaped({
    id: 'furnace',
    pattern: ['CCC', 'C C', 'CCC'],
    key: { C: '#furnace_material' },
    result: { id: 'furnace', count: 1 },
  }),
  shaped({
    id: 'chest',
    pattern: ['PPP', 'P P', 'PPP'],
    key: { P: '#planks' },
    result: { id: 'chest', count: 1 },
  }),
  shaped({
    id: 'oak_slab',
    pattern: ['PPP'],
    key: { P: '#planks' },
    result: { id: 'oak_slab', count: 6 },
  }),
  shaped({
    id: 'cobblestone_slab',
    pattern: ['CCC'],
    key: { C: 'cobblestone' },
    result: { id: 'cobblestone_slab', count: 6 },
  }),
  shaped({
    id: 'oak_stairs',
    pattern: ['P  ', 'PP ', 'PPP'],
    key: { P: '#planks' },
    result: { id: 'oak_stairs', count: 4 },
    mirrored: true,
    station: CraftingStation.TABLE,
  }),
  shaped({
    id: 'cobblestone_stairs',
    pattern: ['C  ', 'CC ', 'CCC'],
    key: { C: 'cobblestone' },
    result: { id: 'cobblestone_stairs', count: 4 },
    mirrored: true,
    station: CraftingStation.TABLE,
  }),
  shaped({
    id: 'oak_trapdoor',
    pattern: ['PPP', 'PPP'],
    key: { P: '#planks' },
    result: { id: 'oak_trapdoor', count: 2 },
    station: CraftingStation.TABLE,
  }),
  shaped({
    id: 'ladder',
    pattern: ['S S', 'SSS', 'S S'],
    key: { S: 'stick' },
    result: { id: 'ladder', count: 3 },
    station: CraftingStation.TABLE,
  }),
  shaped({
    id: 'oak_fence',
    pattern: ['PSP', 'PSP'],
    key: { P: '#planks', S: 'stick' },
    result: { id: 'oak_fence', count: 3 },
    station: CraftingStation.TABLE,
  }),
  shaped({
    id: 'cobblestone_wall',
    pattern: ['CCC', 'CCC'],
    key: { C: 'cobblestone' },
    result: { id: 'cobblestone_wall', count: 6 },
    station: CraftingStation.TABLE,
  }),
  shaped({
    id: 'oak_fence_gate',
    pattern: ['SPS', 'SPS'],
    key: { P: '#planks', S: 'stick' },
    result: { id: 'oak_fence_gate', count: 1 },
    station: CraftingStation.TABLE,
  }),
  shaped({
    id: 'oak_door',
    pattern: ['PP', 'PP', 'PP'],
    key: { P: '#planks' },
    result: { id: 'oak_door', count: 3 },
    station: CraftingStation.TABLE,
  }),
  shaped({
    id: 'glass_pane',
    pattern: ['GGG', 'GGG'],
    key: { G: 'glass' },
    result: { id: 'glass_pane', count: 16 },
    station: CraftingStation.TABLE,
  }),
  shaped({
    id: 'white_bed',
    pattern: ['WWW', 'PPP'],
    key: { W: 'white_wool', P: '#planks' },
    result: { id: 'white_bed', count: 1 },
    station: CraftingStation.TABLE,
  }),
  shaped({
    id: 'stone_button',
    pattern: ['S'],
    key: { S: 'stone' },
    result: { id: 'stone_button', count: 1 },
  }),
  shaped({
    id: 'oak_pressure_plate',
    pattern: ['PP'],
    key: { P: '#planks' },
    result: { id: 'oak_pressure_plate', count: 1 },
  }),
  shaped({
    id: 'stone_pressure_plate',
    pattern: ['SS'],
    key: { S: 'stone' },
    result: { id: 'stone_pressure_plate', count: 1 },
  }),

  // ----------------------------------------------------------------- light
  shaped({
    id: 'torch',
    pattern: ['C', 'S'],
    key: { C: ['coal', 'charcoal'], S: 'stick' },
    result: { id: 'torch', count: 4 },
  }),
  shaped({
    id: 'lever',
    pattern: ['S', 'C'],
    key: { S: 'stick', C: 'cobblestone' },
    result: { id: 'lever', count: 1 },
  }),
  shaped({
    id: 'redstone_torch',
    pattern: ['R', 'S'],
    key: { R: 'redstone_dust', S: 'stick' },
    result: { id: 'redstone_torch', count: 1 },
  }),
  shaped({
    id: 'redstone_lamp',
    pattern: [' R ', 'RGR', ' R '],
    key: { R: 'redstone_dust', G: 'glowstone' },
    result: { id: 'redstone_lamp', count: 1 },
    station: CraftingStation.TABLE,
  }),
  shaped({
    id: 'repeater',
    pattern: ['TRT', 'SSS'],
    key: { T: 'redstone_torch', R: 'redstone_dust', S: 'stone' },
    result: { id: 'repeater', count: 1 },
    station: CraftingStation.TABLE,
  }),

  // ----------------------------------------------------------------- tools
  //
  // Generated per tier from one shape set. Twenty hand-written recipes would
  // otherwise be twenty chances to give the iron shovel the wooden one's pattern.
  ...['wood', 'stone', 'iron', 'diamond'].flatMap((tier) => {
    const material = { wood: '#planks', stone: '#stone_material', iron: 'iron_ingot', diamond: 'diamond' }[
      tier
    ];
    return [
      shaped({
        id: `${tier}_pickaxe`,
        pattern: ['MMM', ' S ', ' S '],
        key: { M: material, S: 'stick' },
        result: { id: `${tier}_pickaxe`, count: 1 },
        group: 'pickaxe',
      }),
      shaped({
        id: `${tier}_axe`,
        pattern: ['MM', 'MS', ' S'],
        key: { M: material, S: 'stick' },
        result: { id: `${tier}_axe`, count: 1 },
        group: 'axe',
        // An axe head is handed; mirroring is what lets a left-handed layout work.
        mirrored: true,
      }),
      shaped({
        id: `${tier}_shovel`,
        pattern: ['M', 'S', 'S'],
        key: { M: material, S: 'stick' },
        result: { id: `${tier}_shovel`, count: 1 },
        group: 'shovel',
      }),
      shaped({
        id: `${tier}_hoe`,
        pattern: ['MM', ' S', ' S'],
        key: { M: material, S: 'stick' },
        result: { id: `${tier}_hoe`, count: 1 },
        group: 'hoe',
        mirrored: true,
      }),
      shaped({
        id: `${tier}_sword`,
        pattern: ['M', 'M', 'S'],
        key: { M: material, S: 'stick' },
        result: { id: `${tier}_sword`, count: 1 },
        group: 'sword',
      }),
    ];
  }),

  // ---------------------------------------------------------------- armour
  ...[
    ['leather', 'leather'],
    ['gold', 'gold_ingot'],
    ['iron', 'iron_ingot'],
    ['diamond', 'diamond'],
  ].flatMap(([materialName, ingredient]) => [
    shaped({
      id: `${materialName}_helmet`,
      pattern: ['MMM', 'M M'],
      key: { M: ingredient },
      result: { id: `${materialName}_helmet`, count: 1 },
      group: 'helmet',
    }),
    shaped({
      id: `${materialName}_chestplate`,
      pattern: ['M M', 'MMM', 'MMM'],
      key: { M: ingredient },
      result: { id: `${materialName}_chestplate`, count: 1 },
      group: 'chestplate',
    }),
    shaped({
      id: `${materialName}_leggings`,
      pattern: ['MMM', 'M M', 'M M'],
      key: { M: ingredient },
      result: { id: `${materialName}_leggings`, count: 1 },
      group: 'leggings',
    }),
    shaped({
      id: `${materialName}_boots`,
      pattern: ['M M', 'M M'],
      key: { M: ingredient },
      result: { id: `${materialName}_boots`, count: 1 },
      group: 'boots',
    }),
  ]),

  // ------------------------------------------------------------ utilities
  shaped({
    id: 'bucket',
    pattern: ['I I', ' I '],
    key: { I: 'iron_ingot' },
    result: { id: 'bucket', count: 1 },
  }),
  shaped({
    id: 'bow',
    pattern: [' ST', 'S T', ' ST'],
    key: { S: 'stick', T: 'string' },
    result: { id: 'bow', count: 1 },
    mirrored: true,
    station: CraftingStation.TABLE,
  }),
  shaped({
    id: 'arrow',
    pattern: ['F', 'S', 'P'],
    key: { F: 'flint', S: 'stick', P: 'feather' },
    result: { id: 'arrow', count: 4 },
  }),
  shaped({
    id: 'shield',
    pattern: ['PIP', 'PPP', ' P '],
    key: { P: '#planks', I: 'iron_ingot' },
    result: { id: 'shield', count: 1 },
    station: CraftingStation.TABLE,
  }),
  shapeless({
    id: 'flint_and_steel',
    ingredients: ['iron_ingot', 'flint'],
    result: { id: 'flint_and_steel', count: 1 },
  }),

  // ----------------------------------------------------------- decoration
  shaped({
    id: 'bricks',
    pattern: ['CC', 'CC'],
    key: { C: 'clay_ball' },
    result: { id: 'bricks', count: 1 },
  }),

  // ------------------------------------------------------------------ food
  shaped({
    id: 'bread',
    pattern: ['WWW'],
    key: { W: 'wheat' },
    result: { id: 'bread', count: 1 },
    station: CraftingStation.TABLE,
  }),
  shapeless({
    id: 'bone_meal',
    ingredients: ['bone'],
    result: { id: 'bone_meal', count: 3 },
  }),

  // -------------------------------------------------------------- smelting
  smelting({
    id: 'smelt_iron',
    input: 'iron_ore',
    result: { id: 'iron_ingot', count: 1 },
  }),
  // Ancient debris smelts to scrap; scrap plus gold makes the ingot that the
  // smithing table consumes to upgrade diamond gear (see EnchantingSystem).
  shapeless({
    id: 'netherite_ingot',
    ingredients: ['netherite_scrap','netherite_scrap','netherite_scrap','netherite_scrap',
      'gold_ingot','gold_ingot','gold_ingot','gold_ingot'],
    result: { id: 'netherite_ingot', count: 1 },
    group: 'netherite',
  }),
  // Blaze rods are the only source of blaze powder, which in turn is the
  // brewing stand's fuel and the strength-potion ingredient.
  shapeless({
    id: 'blaze_powder',
    ingredients: ['blaze_rod'],
    result: { id: 'blaze_powder', count: 2 },
    group: 'nether',
  }),
  // Phase 5. The recipe that joins the Nether and the End: a pearl from the
  // Overworld's Endermen, powder from the Nether's blazes.
  shapeless({
    id: 'eye_of_ender',
    ingredients: ['ender_pearl', 'blaze_powder'],
    result: { id: 'eye_of_ender', count: 1 },
    group: 'end',
  }),
  shaped({
    id: 'end_crystal',
    pattern: ['GGG', 'GEG', 'GTG'],
    key: { G: 'glass', E: 'eye_of_ender', T: 'ghast_tear' },
    result: { id: 'end_crystal', count: 1 },
    group: 'end',
    station: CraftingStation.TABLE,
  }),
  shaped({
    id: 'shulker_box',
    pattern: [' S ', ' C ', ' S '],
    key: { S: 'shulker_shell', C: 'chest' },
    result: { id: 'shulker_box', count: 1 },
    group: 'end',
    station: CraftingStation.TABLE,
  }),
  // The nether star's only use, and the reason to fight the Wither at all.
  // Vanilla asks for gold blocks in the base; this build has no gold block, so
  // the pyramid is obsidian and netherite (see `Beacon.js`).
  shapeless({
    id: 'beacon',
    ingredients: ['glass', 'glass', 'glass', 'glass', 'glass', 'obsidian', 'obsidian', 'obsidian', 'nether_star'],
    result: { id: 'beacon', count: 1 },
    group: 'end',
  }),
  shapeless({
    id: 'glass_bottle',
    ingredients: ['glass', 'glass', 'glass'],
    result: { id: 'glass_bottle', count: 3 },
    group: 'brewing',
  }),
  shapeless({
    id: 'gold_nugget_from_ingot',
    ingredients: ['gold_ingot'],
    result: { id: 'gold_nugget', count: 9 },
    group: 'gold',
  }),
  shapeless({
    id: 'gold_ingot_from_nuggets',
    ingredients: ['gold_nugget','gold_nugget','gold_nugget','gold_nugget','gold_nugget',
      'gold_nugget','gold_nugget','gold_nugget','gold_nugget'],
    result: { id: 'gold_ingot', count: 1 },
    group: 'gold',
  }),
  smelting({
    id: 'smelt_netherite_scrap',
    input: 'ancient_debris',
    result: { id: 'netherite_scrap', count: 1 },
    cookSeconds: 18,
  }),
  smelting({
    id: 'smelt_gold',
    input: 'gold_ore',
    result: { id: 'gold_ingot', count: 1 },
    // Gold takes longer, which is what makes iron the practical early metal.
    cookSeconds: 14,
  }),
  smelting({
    id: 'smelt_glass',
    input: ['sand', 'red_sand'],
    result: { id: 'glass', count: 1 },
    cookSeconds: 8,
  }),
  smelting({
    id: 'smelt_charcoal',
    input: '#logs',
    result: { id: 'charcoal', count: 1 },
    cookSeconds: 12,
  }),
  smelting({
    id: 'smelt_stone',
    input: 'cobblestone',
    result: { id: 'stone', count: 1 },
    cookSeconds: 8,
  }),
  smelting({
    id: 'cook_beef',
    input: 'raw_beef',
    result: { id: 'cooked_beef', count: 1 },
  }),
  smelting({
    id: 'cook_porkchop',
    input: 'raw_porkchop',
    result: { id: 'cooked_porkchop', count: 1 },
  }),
  smelting({
    id: 'cook_chicken',
    input: 'raw_chicken',
    result: { id: 'cooked_chicken', count: 1 },
  }),
  smelting({
    id: 'cook_mutton',
    input: 'raw_mutton',
    result: { id: 'cooked_mutton', count: 1 },
  }),
  smelting({
    id: 'bake_potato',
    input: 'potato',
    result: { id: 'baked_potato', count: 1 },
    cookSeconds: 8,
  }),
]);

// ------------------------------------------------- generated family recipes

/**
 * Crafting for the block families generated in `BlockTypes.js`.
 *
 * Generated for the same reason the blocks are: "three planks in a row makes
 * six slabs" does not change per wood type, and writing it out seven times
 * guarantees the seventh is subtly wrong.
 *
 * Oak is skipped entirely — its variants predate the family generator and
 * already have hand-written recipes above. Spruce and birch skip only the
 * direct log -> planks step, because the legacy recipes above already turn
 * those logs into oak planks and two recipes consuming the same single log
 * would be ambiguous. Their planks come from the `_wood` block instead.
 */
function woodFamilyRecipes(family) {
  const id = family.id;
  const P = variantName(id, 'planks');
  const L = variantName(id, 'log');
  const W = variantName(id, 'wood');
  const recipes = [
    shaped({
      id: `${W}_from_logs`,
      pattern: ['LL', 'LL'],
      key: { L },
      result: { id: W, count: 3 },
      group: 'wood',
    }),
    shapeless({
      id: `${P}_from_${W}`,
      ingredients: [W],
      result: { id: P, count: 4 },
      group: 'planks',
    }),
    shaped({
      id: variantName(id, 'slab'),
      pattern: ['PPP'],
      key: { P },
      result: { id: variantName(id, 'slab'), count: 6 },
      group: 'slab',
    }),
    shaped({
      id: variantName(id, 'stairs'),
      pattern: ['P  ', 'PP ', 'PPP'],
      key: { P },
      result: { id: variantName(id, 'stairs'), count: 4 },
      group: 'stairs',
    }),
    shaped({
      id: variantName(id, 'fence'),
      pattern: ['PSP', 'PSP'],
      key: { P, S: 'stick' },
      result: { id: variantName(id, 'fence'), count: 3 },
      group: 'fence',
    }),
    shaped({
      id: variantName(id, 'fence_gate'),
      pattern: ['SPS', 'SPS'],
      key: { P, S: 'stick' },
      result: { id: variantName(id, 'fence_gate'), count: 1 },
      group: 'fence_gate',
    }),
    shaped({
      id: variantName(id, 'door'),
      pattern: ['PP', 'PP', 'PP'],
      key: { P },
      result: { id: variantName(id, 'door'), count: 3 },
      group: 'door',
    }),
    shaped({
      id: variantName(id, 'trapdoor'),
      pattern: ['PPP', 'PPP'],
      key: { P },
      result: { id: variantName(id, 'trapdoor'), count: 2 },
      group: 'trapdoor',
    }),
    shapeless({
      id: variantName(id, 'button'),
      ingredients: [P],
      result: { id: variantName(id, 'button'), count: 1 },
      group: 'button',
    }),
    shaped({
      id: variantName(id, 'pressure_plate'),
      pattern: ['PP'],
      key: { P },
      result: { id: variantName(id, 'pressure_plate'), count: 1 },
      group: 'pressure_plate',
    }),
    shaped({
      id: variantName(id, 'sign'),
      pattern: ['PPP', 'PPP', ' S '],
      key: { P, S: 'stick' },
      result: { id: variantName(id, 'sign'), count: 3 },
      group: 'sign',
    }),
  ];

  // Spruce and birch logs are already spoken for by the legacy recipes.
  if (id !== 'spruce' && id !== 'birch') {
    recipes.push(
      shapeless({
        id: `${P}_from_${L}`,
        ingredients: [L],
        result: { id: P, count: 4 },
        group: 'planks',
      })
    );
  }
  return recipes;
}

function stoneFamilyRecipes(family) {
  const id = family.id;
  const B = variantName(id, 'base');
  const Q = variantName(id, 'polished');
  return [
    shaped({
      id: Q,
      pattern: ['BB', 'BB'],
      key: { B },
      result: { id: Q, count: 4 },
      group: 'polished',
    }),
    shaped({
      id: variantName(id, 'bricks'),
      pattern: ['QQ', 'QQ'],
      key: { Q },
      result: { id: variantName(id, 'bricks'), count: 4 },
      group: 'bricks',
    }),
    shaped({
      id: variantName(id, 'slab'),
      pattern: ['BBB'],
      key: { B },
      result: { id: variantName(id, 'slab'), count: 6 },
      group: 'slab',
    }),
    shaped({
      id: variantName(id, 'stairs'),
      pattern: ['B  ', 'BB ', 'BBB'],
      key: { B },
      result: { id: variantName(id, 'stairs'), count: 4 },
      group: 'stairs',
    }),
    shaped({
      id: variantName(id, 'wall'),
      pattern: ['BBB', 'BBB'],
      key: { B },
      result: { id: variantName(id, 'wall'), count: 6 },
      group: 'wall',
    }),
  ];
}

const FAMILY_RECIPE_DEFINITIONS = Object.freeze([
  ...WOOD_FAMILIES.filter((family) => family.id !== 'oak').flatMap(woodFamilyRecipes),
  ...STONE_FAMILIES.flatMap(stoneFamilyRecipes),
]);

const PHASE3_RECIPE_DEFINITIONS = Object.freeze([
  shaped({ id:'enchanting_table', pattern:[' D ','DOD','OOO'], key:{D:'diamond',O:'obsidian'}, result:{id:'enchanting_table',count:1}, station:CraftingStation.TABLE }),
  shaped({ id:'anvil', pattern:['III',' I ','III'], key:{I:'iron_ingot'}, result:{id:'anvil',count:1}, station:CraftingStation.TABLE }),
  shaped({ id:'grindstone', pattern:['S S','PIP',' P '], key:{S:'stick',P:'#planks',I:'iron_ingot'}, result:{id:'grindstone',count:1}, station:CraftingStation.TABLE }),
  shaped({ id:'smithing_table', pattern:['II','PP','PP'], key:{I:'iron_ingot',P:'#planks'}, result:{id:'smithing_table',count:1}, station:CraftingStation.TABLE }),
  shaped({ id:'brewing_stand', pattern:[' S ','CCC'], key:{S:'stick',C:'cobblestone'}, result:{id:'brewing_stand',count:1}, station:CraftingStation.TABLE }),
  shaped({ id:'piston', pattern:['PPP','CIC','CRC'], key:{P:'#planks',C:'cobblestone',I:'iron_ingot',R:'redstone_dust'}, result:{id:'piston',count:1}, station:CraftingStation.TABLE }),
  shaped({ id:'sticky_piston', pattern:[' C ',' P '], key:{C:'clay_ball',P:'piston'}, result:{id:'sticky_piston',count:1}, station:CraftingStation.TABLE }),
  shaped({ id:'hopper', pattern:['I I','ICI',' I '], key:{I:'iron_ingot',C:'chest'}, result:{id:'hopper',count:1}, station:CraftingStation.TABLE }),
  shaped({ id:'dispenser', pattern:['CCC','CBC','CRC'], key:{C:'cobblestone',B:'bow',R:'redstone_dust'}, result:{id:'dispenser',count:1}, station:CraftingStation.TABLE }),
  shaped({ id:'dropper', pattern:['CCC','C C','CRC'], key:{C:'cobblestone',R:'redstone_dust'}, result:{id:'dropper',count:1}, station:CraftingStation.TABLE }),
  shaped({ id:'rail', pattern:['I I','ISI','I I'], key:{I:'iron_ingot',S:'stick'}, result:{id:'rail',count:16}, station:CraftingStation.TABLE }),
  shaped({ id:'powered_rail', pattern:['G G','GSG','GRG'], key:{G:'gold_ingot',S:'stick',R:'redstone_dust'}, result:{id:'powered_rail',count:6}, station:CraftingStation.TABLE }),
]);

/** Every recipe in the game: hand-written progression plus generated families. */
export const RECIPE_DEFINITIONS = Object.freeze([
  ...BASE_RECIPE_DEFINITIONS,
  ...FAMILY_RECIPE_DEFINITIONS,
  ...PHASE3_RECIPE_DEFINITIONS,
]);

export default RECIPE_DEFINITIONS;
