/**
 * Neutral utility blocks: blocks that belong to no dimension.
 *
 * `NetherBlocks.js` and `EndBlocks.js` both force a dimension tag onto every
 * descriptor they declare, which is correct for them and wrong for a beacon --
 * a beacon is built by the player and works anywhere. Rather than loosen those
 * modules and risk mistagging thirty-eight Nether blocks, this file is the third
 * seam: same descriptor vocabulary, no forced dimension.
 *
 * ## Why the beacon lives here and arrives last
 *
 * Block ids are assigned by declaration order, so inserting the beacon into the
 * Phase 3 list would have shifted every Nether and End id by one and silently
 * rewritten the contents of existing saved worlds. Appending a new family after
 * the End keeps all 364 existing ids exactly where they are.
 *
 * The beacon also closes a real gap: before it, a nether star -- the reward for
 * the hardest fight in the Nether -- had nothing to be crafted into.
 */

/** Render shapes a utility block may use. */
export const UTILITY_SHAPES = Object.freeze(['cube', 'cross', 'post', 'plate', 'boxes']);

/** Render layers a utility block may use. */
export const UTILITY_LAYERS = Object.freeze(['opaque', 'cutout', 'translucent']);

/** Sound groups a utility block may use. */
export const UTILITY_SOUNDS = Object.freeze(['stone', 'glass', 'grass', 'metal']);

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

function tile(name) {
  if (!tiles.includes(name)) tiles.push(name);
  return name;
}

/** Declares one block. `texture` is a tile name or `{ top, side, bottom }`. */
function ub(name, texture, overrides = {}) {
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
    tags: Object.freeze(['utility', ...(overrides.tags ?? [])]),
  }));
}

// ------------------------------------------------------------------- the blocks

// Glass-cased, always lit, and never lost to a bad pickaxe: `dropsAlways` matters
// here because the recipe costs a nether star.
ub('beacon', { top: 'beacon_top', side: 'beacon' }, {
  layer: 'translucent',
  hardness: 3,
  light: 15,
  transparent: true,
  attenuation: 0,
  sound: 'glass',
  dropsAlways: true,
  tags: ['light_source'],
});

// ----------------------------------------------------------------- the exports

/** Atlas tile names this module needs, in first-seen order. */
export const UTILITY_TILE_NAMES = Object.freeze(tiles.slice());

/** Every utility block descriptor, in declaration order. */
export const UTILITY_BLOCK_DESCRIPTORS = Object.freeze(descriptors.slice());

/** Just the names, for quick membership checks. */
export const UTILITY_BLOCK_NAMES = Object.freeze(descriptors.map((entry) => entry.name));

/**
 * Validates every descriptor against the known vocabulary.
 *
 * @param {ReadonlyArray<string>} existingTileNames Tiles the atlas can paint.
 * @param {ReadonlyArray<string>} existingBlockNames Block names already taken.
 * @returns {string[]} Problems found; empty means valid.
 */
export function validateUtilityBlocks(existingTileNames = [], existingBlockNames = []) {
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
    if (!UTILITY_SHAPES.includes(entry.shape)) {
      problems.push(`"${entry.name}" has unknown shape "${entry.shape}"`);
    }
    if (!UTILITY_LAYERS.includes(entry.layer)) {
      problems.push(`"${entry.name}" has unknown layer "${entry.layer}"`);
    }
    if (!UTILITY_SOUNDS.includes(entry.sound)) {
      problems.push(`"${entry.name}" has unknown sound group "${entry.sound}"`);
    }
    if (!Number.isInteger(entry.light) || entry.light < 0 || entry.light > 15) {
      problems.push(`"${entry.name}" has light level ${entry.light} outside 0..15`);
    }
  }
  return problems;
}

export default UTILITY_BLOCK_DESCRIPTORS;
