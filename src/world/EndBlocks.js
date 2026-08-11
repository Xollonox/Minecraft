/**
 * Phase 5: The End block family.
 *
 * Written against exactly the same seam as `NetherBlocks.js`: this module
 * describes blocks in a vocabulary of plain strings and knows nothing about the
 * atlas, the config or the renderer. `BlockTypes.js` translates the strings into
 * real constants. That is what lets the terrain generator import the End's block
 * list inside a worker without dragging Three.js in with it.
 *
 * ## Why the End is small
 *
 * The Nether needed 38 blocks because it is a place you build in. The End is a
 * place you *fight* in: ten blocks is the whole dimension, and six of those exist
 * to serve the Ender Dragon fight rather than the player's inventory.
 *
 * ## Unbreakable by design
 *
 * `end_portal_frame` and `end_portal` are deliberately `breakable: false`. The
 * return journey is the entire tension of the End, and a player with a diamond
 * pickaxe should not be able to mine the exit and strand themselves -- nor carry
 * a portal frame home and trivialise the next world.
 */

/** Render shapes an End block may use. Mirrors the Nether vocabulary. */
export const END_SHAPES = Object.freeze(['cube', 'cross', 'post', 'plate', 'boxes']);

/** Render layers an End block may use. */
export const END_LAYERS = Object.freeze(['opaque', 'cutout', 'translucent']);

/** Sound groups an End block may use. */
export const END_SOUNDS = Object.freeze(['stone', 'glass', 'grass']);

/** Base colours the atlas painters derive their shading from. */
export const END_STONE_PALETTES = Object.freeze({
  end_stone: [221, 223, 165],
  end_stone_bricks: [216, 219, 158],
  purpur_block: [169, 125, 169],
  purpur_pillar: [172, 128, 172],
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
function eb(name, texture, overrides = {}) {
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
    tags: Object.freeze(['end', ...(overrides.tags ?? [])]),
  }));
}

// ------------------------------------------------------------------- the blocks

eb('end_stone', 'end_stone', {
  hardness: 3, tool: 'pickaxe', tier: 'wood', correctTool: true,
  tags: ['stone_material'],
});
eb('end_stone_bricks', 'end_stone_bricks', {
  hardness: 3, tool: 'pickaxe', tier: 'wood', correctTool: true,
  tags: ['stone_material'],
});
eb('purpur_block', 'purpur_block', {
  hardness: 1.5, tool: 'pickaxe', tier: 'wood', correctTool: true,
  tags: ['stone_material'],
});
eb('purpur_pillar', { top: 'purpur_pillar_top', side: 'purpur_pillar' }, {
  hardness: 1.5, tool: 'pickaxe', tier: 'wood', correctTool: true,
  tags: ['stone_material'],
});

// The portal room furniture. Neither of these may ever be mined.
// No `tier` here on purpose. The registry rejects a harvest tier without a tool
// requirement, and rightly so -- but for an unbreakable block the tier is
// meaningless anyway, because the break never happens.
eb('end_portal_frame', { top: 'end_portal_frame_top', side: 'end_portal_frame' }, {
  hardness: 36, breakable: false, light: 1,
});
eb('end_portal', 'end_portal', {
  layer: 'translucent', hardness: 36, breakable: false,
  solid: false, collidable: false, transparent: true,
  light: 11, attenuation: 0, sound: 'glass',
});

// The dragon's trophy, and the only block in the game that is a reward.
eb('dragon_egg', 'dragon_egg', {
  hardness: 3, tool: 'pickaxe', tier: 'wood', light: 1, dropsAlways: true,
});

// Chorus growth: the End's only vegetation.
eb('chorus_plant', 'chorus_plant', {
  hardness: 0.4, layer: 'cutout', transparent: true, attenuation: 0,
  cull: false, sound: 'grass', tags: ['plant'],
});
eb('chorus_flower', 'chorus_flower', {
  hardness: 0.4, layer: 'cutout', transparent: true, attenuation: 0,
  sound: 'grass', tags: ['plant'],
});

// Light source, and the reason the End's cities are visible at all.
eb('end_rod', 'end_rod', {
  shape: 'post', layer: 'cutout', hardness: 0.2, light: 14,
  solid: false, transparent: true, attenuation: 0, sound: 'glass',
});

// ----------------------------------------------------------------- the exports

/** Atlas tile names this module needs, in first-seen order. */
export const END_TILE_NAMES = Object.freeze(tiles.slice());

/** Every End block descriptor, in declaration order. */
export const END_BLOCK_DESCRIPTORS = Object.freeze(descriptors.slice());

/** Just the names, for quick membership checks. */
export const END_BLOCK_NAMES = Object.freeze(descriptors.map((entry) => entry.name));

/**
 * Validates every descriptor against the known vocabulary.
 *
 * Exercised by the self-test so an End block cannot be added with an unpainted
 * tile, an unknown shape, or a light level outside 0..15.
 *
 * @param {ReadonlyArray<string>} existingTileNames Tiles the atlas can paint.
 * @param {ReadonlyArray<string>} existingBlockNames Block names already taken.
 * @returns {string[]} Problems found; empty means valid.
 */
export function validateEndBlocks(existingTileNames = [], existingBlockNames = []) {
  const problems = [];
  const known = new Set([...existingTileNames, ...tiles]);
  const existing = new Set(existingBlockNames);
  const seen = new Set();

  for (const entry of descriptors) {
    if (seen.has(entry.name)) problems.push(`"${entry.name}" is declared twice`);
    seen.add(entry.name);
    if (existing.has(entry.name)) problems.push(`"${entry.name}" collides with an existing block`);

    for (const face of ['top', 'side', 'bottom']) {
      if (!known.has(entry[face])) {
        problems.push(`"${entry.name}" uses unpainted tile "${entry[face]}"`);
      }
    }
    if (!END_SHAPES.includes(entry.shape)) {
      problems.push(`"${entry.name}" has unknown shape "${entry.shape}"`);
    }
    if (!END_LAYERS.includes(entry.layer)) {
      problems.push(`"${entry.name}" has unknown layer "${entry.layer}"`);
    }
    if (!END_SOUNDS.includes(entry.sound)) {
      problems.push(`"${entry.name}" has unknown sound group "${entry.sound}"`);
    }
    if (!Number.isInteger(entry.light) || entry.light < 0 || entry.light > 15) {
      problems.push(`"${entry.name}" has light level ${entry.light} outside 0..15`);
    }
  }
  return problems;
}

export default END_BLOCK_DESCRIPTORS;
