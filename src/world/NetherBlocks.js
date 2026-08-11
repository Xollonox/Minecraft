/**
 * Nether block catalogue (Phase 4).
 *
 * ## Why this is a separate module
 *
 * Block ids are persisted inside save files, so they can only ever be appended.
 * `BlockTypes.js` allocates in four stable passes today - hand-written base ids
 * 0..72, generated families 73..188, colour blocks, then the Phase 3 utility
 * blocks ending at 263. Adding the Nether set as a *fifth* pass that starts at
 * 264 means every existing id keeps its meaning and no save written by V5 or
 * V6.1 is invalidated. Inserting these blocks into any earlier pass would have
 * renumbered the colour and Phase 3 ranges and silently corrupted saved chunks.
 *
 * ## Why the descriptors are neutral data
 *
 * This module deliberately imports nothing. It describes blocks in a small
 * vocabulary of strings and numbers, and `BlockTypes.js` maps that vocabulary
 * onto its own private `RenderShape`, `SoundGroup` and render-layer constants.
 * That keeps the catalogue free of circular imports, lets the self-test load it
 * directly in Node, and means the atlas can import the same palettes the blocks
 * were described with instead of keeping a second copy that can drift.
 *
 * Every tile named here is new. Nothing in this file depends on a tile that
 * already exists, so the atlas cannot accidentally repaint an Overworld block.
 */

// --------------------------------------------------------------- vocabularies

/** Render shapes this catalogue is allowed to ask for. */
export const NETHER_SHAPES = Object.freeze(['cube', 'cross', 'post', 'plate', 'boxes']);

/** Render layers, mapped to numeric layers by `BlockTypes`. */
export const NETHER_LAYERS = Object.freeze(['opaque', 'cutout', 'translucent']);

/** Sound groups, mapped to `SoundGroup` by `BlockTypes`. */
export const NETHER_SOUNDS = Object.freeze([
  'stone', 'dirt', 'grass', 'wood', 'sand', 'glass', 'plant', 'snow', 'liquid', 'metal',
]);

// ------------------------------------------------------------------- palettes

/**
 * Wood palettes for the two fungal "wood" families, in exactly the shape the
 * atlas's existing `paintFamilyPlanks` / `paintFamilyLog` / `paintStrippedLog`
 * helpers already consume: `{ planks, bark: [dark, light], stripped }`.
 */
export const NETHER_WOOD_PALETTES = Object.freeze({
  crimson: Object.freeze({
    planks: [110, 45, 58],
    bark: [[92, 26, 42], [124, 44, 60]],
    stripped: [141, 60, 74],
  }),
  warped: Object.freeze({
    planks: [44, 104, 99],
    bark: [[58, 42, 88], [45, 92, 92]],
    stripped: [60, 120, 114],
  }),
});

/**
 * Base colours for the Nether stone families. `paintFamilyStone`,
 * `paintPolishedStone` and `paintFamilyBricks` all derive their shading from a
 * single base colour, so one entry per family is enough.
 */
export const NETHER_STONE_PALETTES = Object.freeze({
  nether_bricks: [92, 46, 50],
  cracked_nether_bricks: [80, 40, 44],
  red_nether_bricks: [112, 20, 28],
  blackstone: [44, 38, 44],
  polished_blackstone: [52, 46, 54],
  polished_blackstone_bricks: [58, 51, 60],
  quartz_block: [231, 226, 219],
  quartz_bricks: [226, 221, 213],
  smooth_quartz: [236, 232, 225],
  basalt: [79, 78, 84],
  polished_basalt: [92, 91, 96],
  smooth_basalt: [72, 71, 77],
});

// -------------------------------------------------------------- descriptor DSL

const DEFAULTS = Object.freeze({
  shape: 'cube',
  layer: 'opaque',
  hardness: 1,
  tool: null,
  tier: 'hand',
  correctTool: false,
  light: 0,
  attenuation: 15,
  solid: true,
  collidable: true,
  breakable: true,
  transparent: false,
  cull: false,
  sway: 'none',
  sound: 'stone',
  needsSupport: false,
  gravity: false,
  dropsAlways: false,
  tags: [],
});

const descriptors = [];
const tiles = [];

/** Registers a tile name once, preserving first-seen order. */
function tile(name) {
  if (!tiles.includes(name)) tiles.push(name);
  return name;
}

/**
 * Declares one block. `texture` may be a tile name (all faces) or
 * `{ top, side, bottom }`. Any face left out falls back to `side`.
 */
function nb(name, texture, overrides = {}) {
  const faces = typeof texture === 'string'
    ? { top: texture, side: texture, bottom: texture }
    : {
        top: texture.top ?? texture.side,
        side: texture.side,
        bottom: texture.bottom ?? texture.top ?? texture.side,
      };

  tile(faces.top);
  tile(faces.side);
  tile(faces.bottom);

  descriptors.push(Object.freeze({
    ...DEFAULTS,
    ...overrides,
    name,
    top: faces.top,
    side: faces.side,
    bottom: faces.bottom,
    tags: Object.freeze(['nether', ...(overrides.tags ?? [])]),
  }));
}

// Shared shapes for the derived variants, copied from the values the existing
// `oak_*` and `granite_*` blocks actually resolve to so a Nether slab behaves
// identically to an Overworld one.
const WOOD_PART = Object.freeze({
  shape: 'boxes', transparent: true, attenuation: 0, hardness: 1.5, tool: 'axe', sound: 'wood',
});
const STONE_PART = Object.freeze({
  shape: 'boxes', transparent: true, attenuation: 0, hardness: 1.5,
  tool: 'pickaxe', tier: 'wood', correctTool: true, solid: false, sound: 'stone',
});

// ------------------------------------------------------------- wood families

/** The two fungal families, which behave as wood for tools and sounds. */
export const NETHER_WOOD_FAMILIES = Object.freeze(['crimson', 'warped']);

for (const family of NETHER_WOOD_FAMILIES) {
  const stem = `${family}_stem`;
  const stemTop = `${family}_stem_top`;
  const stripped = `stripped_${family}_stem`;
  const planks = `${family}_planks`;

  // Trunk blocks.
  nb(stem, { top: stemTop, side: stem }, {
    hardness: 1.6, tool: 'axe', sound: 'wood', tags: ['logs'],
  });
  nb(stripped, stripped, {
    hardness: 2, tool: 'axe', sound: 'wood', tags: ['wooden', 'stripped_log'],
  });
  nb(`${family}_hyphae`, stem, {
    hardness: 2, tool: 'axe', sound: 'wood', tags: ['wooden', 'wood'],
  });
  nb(planks, planks, {
    hardness: 1.4, tool: 'axe', sound: 'wood', tags: ['planks'],
  });

  // Derived parts, all textured from the planks tile.
  nb(`${family}_slab`, planks, { ...WOOD_PART, tags: ['wooden', 'slab'] });
  nb(`${family}_stairs`, planks, { ...WOOD_PART, tags: ['wooden', 'stairs'] });
  nb(`${family}_fence`, planks, { ...WOOD_PART, tags: ['wooden', 'fence'] });
  nb(`${family}_fence_gate`, planks, { ...WOOD_PART, tags: ['wooden', 'fence_gate'] });
  nb(`${family}_door`, planks, { ...WOOD_PART, layer: 'cutout', tags: ['wooden', 'door'] });
  nb(`${family}_trapdoor`, planks, { ...WOOD_PART, tags: ['wooden', 'trapdoor'] });
  nb(`${family}_pressure_plate`, planks, {
    ...WOOD_PART, hardness: 0.5, tool: null, solid: false, collidable: false,
    tags: ['wooden', 'pressure_plate'],
  });
  nb(`${family}_button`, planks, {
    ...WOOD_PART, hardness: 0.5, solid: false, collidable: false, tags: ['wooden', 'button'],
  });
  nb(`${family}_sign`, planks, {
    ...WOOD_PART, hardness: 1, solid: false, collidable: false, tags: ['wooden', 'sign'],
  });
}

// ------------------------------------------------------------ stone families

/**
 * Declares a stone family: a full block plus the requested derived parts.
 *
 * @param {string} base Block and tile name of the full block.
 * @param {string} prefix Name stem for the parts (`nether_brick` -> `nether_brick_slab`).
 * @param {string[]} parts Variant list.
 * @param {Object} [options]
 */
function stoneFamily(base, prefix, parts, options = {}) {
  const { hardness = 1.5, tier = 'wood', sound = 'stone' } = options;
  nb(base, base, {
    hardness, tool: 'pickaxe', tier, correctTool: true, sound,
    tags: ['stone_material', 'base'],
  });
  for (const part of parts) {
    const name = `${prefix}_${part}`;
    const extra = part === 'wall'
      ? { hardness: 2 }
      : part === 'pressure_plate' || part === 'button'
        ? { hardness: 0.5, collidable: false }
        : {};
    nb(name, base, { ...STONE_PART, hardness, tier, sound, ...extra, tags: ['stone_material', part] });
  }
}

stoneFamily('nether_bricks', 'nether_brick', ['slab', 'stairs', 'wall', 'fence'], { hardness: 2 });
stoneFamily('red_nether_bricks', 'red_nether_brick', ['slab', 'stairs', 'wall'], { hardness: 2 });
stoneFamily('blackstone', 'blackstone', ['slab', 'stairs', 'wall'], { hardness: 1.5 });
stoneFamily('polished_blackstone', 'polished_blackstone',
  ['slab', 'stairs', 'wall', 'pressure_plate', 'button'], { hardness: 2 });
stoneFamily('polished_blackstone_bricks', 'polished_blackstone_brick',
  ['slab', 'stairs', 'wall'], { hardness: 2 });
stoneFamily('quartz_block', 'quartz', ['slab', 'stairs'], { hardness: 0.8 });

// Brick and quartz decoratives that have no derived parts.
nb('cracked_nether_bricks', 'cracked_nether_bricks', {
  hardness: 2, tool: 'pickaxe', tier: 'wood', correctTool: true, tags: ['stone_material'],
});
nb('chiseled_nether_bricks', 'chiseled_nether_bricks', {
  hardness: 2, tool: 'pickaxe', tier: 'wood', correctTool: true, tags: ['stone_material'],
});
nb('quartz_bricks', 'quartz_bricks', {
  hardness: 0.8, tool: 'pickaxe', tier: 'wood', correctTool: true, tags: ['stone_material'],
});
nb('smooth_quartz', 'smooth_quartz', {
  hardness: 0.8, tool: 'pickaxe', tier: 'wood', correctTool: true, tags: ['stone_material'],
});
nb('chiseled_quartz_block', 'chiseled_quartz_block', {
  hardness: 0.8, tool: 'pickaxe', tier: 'wood', correctTool: true, tags: ['stone_material'],
});
nb('quartz_pillar', { top: 'quartz_pillar_top', side: 'quartz_pillar' }, {
  hardness: 0.8, tool: 'pickaxe', tier: 'wood', correctTool: true, tags: ['stone_material'],
});

// Basalt: columnar, so top and side differ.
nb('basalt', { top: 'basalt_top', side: 'basalt' }, {
  hardness: 1.25, tool: 'pickaxe', tier: 'wood', correctTool: true, tags: ['stone_material'],
});
nb('polished_basalt', { top: 'polished_basalt_top', side: 'polished_basalt' }, {
  hardness: 1.25, tool: 'pickaxe', tier: 'wood', correctTool: true, tags: ['stone_material'],
});
nb('smooth_basalt', 'smooth_basalt', {
  hardness: 1.25, tool: 'pickaxe', tier: 'wood', correctTool: true, tags: ['stone_material'],
});

// ------------------------------------------------------------- natural blocks

nb('netherrack', 'netherrack', {
  hardness: 0.4, tool: 'pickaxe', correctTool: true, tags: ['nether_natural'],
});
nb('soul_sand', 'soul_sand', {
  hardness: 0.5, tool: 'shovel', sound: 'sand', dropsAlways: true, tags: ['nether_natural'],
});
nb('soul_soil', 'soul_soil', {
  hardness: 0.5, tool: 'shovel', sound: 'sand', dropsAlways: true, tags: ['nether_natural'],
});
// Magma glows faintly and burns anything standing on it.
nb('magma_block', 'magma_block', {
  hardness: 0.5, tool: 'pickaxe', correctTool: true, light: 3, tags: ['nether_natural'],
});
nb('crimson_nylium', { top: 'crimson_nylium', side: 'netherrack' }, {
  hardness: 0.4, tool: 'pickaxe', correctTool: true, tags: ['nether_natural'],
});
nb('warped_nylium', { top: 'warped_nylium', side: 'netherrack' }, {
  hardness: 0.4, tool: 'pickaxe', correctTool: true, tags: ['nether_natural'],
});
nb('nether_wart_block', 'nether_wart_block', {
  hardness: 1, sound: 'plant', dropsAlways: true, tags: ['nether_natural'],
});
nb('warped_wart_block', 'warped_wart_block', {
  hardness: 1, sound: 'plant', dropsAlways: true, tags: ['nether_natural'],
});
// The Nether's only renewable light source that is not glowstone.
nb('shroomlight', 'shroomlight', {
  hardness: 1, sound: 'plant', light: 15, dropsAlways: true, tags: ['nether_natural'],
});
nb('gilded_blackstone', 'gilded_blackstone', {
  hardness: 1.5, tool: 'pickaxe', tier: 'wood', correctTool: true, tags: ['ore'],
});
nb('nether_quartz_ore', 'nether_quartz_ore', {
  hardness: 3, tool: 'pickaxe', tier: 'wood', correctTool: true, tags: ['ore'],
});
nb('nether_gold_ore', 'nether_gold_ore', {
  hardness: 3, tool: 'pickaxe', tier: 'wood', correctTool: true, tags: ['ore'],
});
// Ancient debris is the netherite gate: diamond pickaxe or nothing.
nb('ancient_debris', 'ancient_debris', {
  hardness: 30, tool: 'pickaxe', tier: 'diamond', correctTool: true, sound: 'metal', tags: ['ore'],
});
nb('netherite_block', 'netherite_block', {
  hardness: 50, tool: 'pickaxe', tier: 'diamond', correctTool: true, sound: 'metal',
  tags: ['storage_block'],
});
nb('crying_obsidian', 'crying_obsidian', {
  hardness: 50, tool: 'pickaxe', tier: 'diamond', correctTool: true, light: 10,
  tags: ['nether_natural'],
});

// ------------------------------------------------------------- special blocks

/**
 * The portal interior.
 *
 * Not breakable and not collidable: it is removed by breaking the frame, and
 * the player must be able to walk into it for travel to trigger at all.
 */
nb('nether_portal', 'nether_portal', {
  hardness: 0, breakable: false, solid: false, collidable: false,
  transparent: true, layer: 'translucent', cull: true, attenuation: 0,
  light: 11, sound: 'glass', tags: ['portal'],
});
nb('soul_fire', 'soul_fire', {
  shape: 'cross', hardness: 0, solid: false, collidable: false, transparent: true,
  layer: 'cutout', attenuation: 0, light: 10, sound: 'plant', dropsAlways: true,
  tags: ['fire'],
});
nb('chain', 'chain', {
  shape: 'post', hardness: 3, tool: 'pickaxe', tier: 'wood', correctTool: true,
  solid: false, transparent: true, layer: 'cutout', attenuation: 0, sound: 'metal',
  tags: ['decoration'],
});
nb('lantern', 'lantern', {
  shape: 'post', hardness: 3, tool: 'pickaxe', tier: 'wood', correctTool: true,
  solid: false, transparent: true, layer: 'cutout', attenuation: 0, light: 15,
  sound: 'metal', tags: ['light_source'],
});
nb('soul_lantern', 'soul_lantern', {
  shape: 'post', hardness: 3, tool: 'pickaxe', tier: 'wood', correctTool: true,
  solid: false, transparent: true, layer: 'cutout', attenuation: 0, light: 10,
  sound: 'metal', tags: ['light_source'],
});

// Plants. All cross-shaped, all need something underneath, all drop by hand.
const PLANT = Object.freeze({
  shape: 'cross', hardness: 0.1, solid: false, collidable: false, transparent: true,
  layer: 'cutout', attenuation: 0, sound: 'plant', needsSupport: true, dropsAlways: true,
});
nb('crimson_fungus', 'crimson_fungus', { ...PLANT, tags: ['plant'] });
nb('warped_fungus', 'warped_fungus', { ...PLANT, tags: ['plant'] });
nb('crimson_roots', 'crimson_roots', { ...PLANT, tags: ['plant'] });
nb('warped_roots', 'warped_roots', { ...PLANT, tags: ['plant'] });
nb('nether_sprouts', 'nether_sprouts', { ...PLANT, tags: ['plant'] });
nb('weeping_vines', 'weeping_vines', { ...PLANT, sway: 'leaves', tags: ['plant'] });
nb('twisting_vines', 'twisting_vines', { ...PLANT, sway: 'leaves', tags: ['plant'] });
nb('nether_wart', 'nether_wart', { ...PLANT, tags: ['crop'] });

// Placing three of these on soul sand is the Wither summon ritual, so the skull
// has to be a real placeable block rather than an inventory-only trophy.
nb('wither_skeleton_skull', 'wither_skeleton_skull',
  { hardness: 1, solid: false, transparent: true, cull: false, tags: ['skull'] });

// --------------------------------------------------------------------- exports

/** Every new atlas tile this catalogue introduces, in declaration order. */
export const NETHER_TILE_NAMES = Object.freeze(tiles.slice());

/** Every Nether block descriptor, in stable declaration order. */
export const NETHER_BLOCK_DESCRIPTORS = Object.freeze(descriptors.slice());

/** Just the names, for tests and tooling. */
export const NETHER_BLOCK_NAMES = Object.freeze(descriptors.map((entry) => entry.name));

/**
 * Validates the catalogue.
 *
 * Exercised by the Phase 4 self-test so a future edit cannot introduce a block
 * that names a tile nobody paints, or reuse a name that already exists.
 *
 * @param {string[]} [existingTileNames] Tiles already in the atlas.
 * @param {string[]} [existingBlockNames] Block names already registered.
 * @returns {string[]} Problems found; empty means valid.
 */
export function validateNetherBlocks(existingTileNames = [], existingBlockNames = []) {
  const problems = [];
  const known = new Set([...existingTileNames, ...NETHER_TILE_NAMES]);
  const seen = new Set();
  const existing = new Set(existingBlockNames);

  for (const entry of NETHER_BLOCK_DESCRIPTORS) {
    if (seen.has(entry.name)) problems.push(`duplicate block name "${entry.name}"`);
    seen.add(entry.name);
    if (existing.has(entry.name)) problems.push(`"${entry.name}" collides with an existing block`);

    for (const face of ['top', 'side', 'bottom']) {
      if (!known.has(entry[face])) {
        problems.push(`"${entry.name}" uses unpainted tile "${entry[face]}"`);
      }
    }
    if (!NETHER_SHAPES.includes(entry.shape)) {
      problems.push(`"${entry.name}" has unknown shape "${entry.shape}"`);
    }
    if (!NETHER_LAYERS.includes(entry.layer)) {
      problems.push(`"${entry.name}" has unknown layer "${entry.layer}"`);
    }
    if (!NETHER_SOUNDS.includes(entry.sound)) {
      problems.push(`"${entry.name}" has unknown sound group "${entry.sound}"`);
    }
    if (!Number.isInteger(entry.light) || entry.light < 0 || entry.light > 15) {
      problems.push(`"${entry.name}" has light level ${entry.light} outside 0..15`);
    }
  }
  return problems;
}

export default NETHER_BLOCK_DESCRIPTORS;
