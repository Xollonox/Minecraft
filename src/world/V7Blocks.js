/**
 * Version 7 append-only blocks.
 *
 * These deliberately live after the v6 beacon range. Existing worlds persist
 * numeric block ids, so adding outer-End content inside EndBlocks.js would move
 * the beacon and corrupt every 6.6 save that contains one.
 */

const DEFAULTS = Object.freeze({
  shape: 'cube', layer: 'opaque', hardness: 1, tool: null, tier: 'hand',
  correctTool: false, light: 0, attenuation: 15, solid: true,
  collidable: true, breakable: true, transparent: false, cull: false,
  sway: 'none', sound: 'stone', needsSupport: false, gravity: false,
  dropsAlways: false, stackSize: 64, tags: [],
});

const descriptors = [];
const tiles = [];

function remember(name) {
  if (!tiles.includes(name)) tiles.push(name);
  return name;
}

function v7(name, texture, overrides = {}) {
  const faces = typeof texture === 'string'
    ? { top: texture, side: texture, bottom: texture }
    : {
        top: texture.top ?? texture.side,
        side: texture.side,
        bottom: texture.bottom ?? texture.top ?? texture.side,
      };
  remember(faces.top); remember(faces.side); remember(faces.bottom);
  descriptors.push(Object.freeze({
    ...DEFAULTS,
    ...overrides,
    name,
    top: faces.top,
    side: faces.side,
    bottom: faces.bottom,
    tags: Object.freeze(['v7', ...(overrides.tags ?? [])]),
  }));
}

// Stronghold content. Infested blocks are visually subtle by design; breaking
// one is what reveals the silverfish.
v7('infested_stone', 'infested_stone', {
  hardness: 0.75, tool: 'pickaxe', tier: 'wood', correctTool: true,
  tags: ['infested', 'stone_material'],
});
v7('infested_mossy_cobblestone', 'infested_mossy_cobblestone', {
  hardness: 0.75, tool: 'pickaxe', tier: 'wood', correctTool: true,
  tags: ['infested', 'stone_material'],
});
v7('silverfish_spawner', 'silverfish_spawner', {
  layer: 'cutout', hardness: 5, tool: 'pickaxe', tier: 'wood',
  correctTool: true, transparent: true, attenuation: 2, light: 3,
  sound: 'metal', tags: ['stronghold', 'spawner'],
});

// Outer-End progression. The shulker box is a normal placeable block in this
// engine; its portable inventory payload is carried by the placing ItemStack.
v7('shulker_box', { top: 'shulker_box_top', side: 'shulker_box' }, {
  hardness: 2, tool: 'pickaxe', tier: 'wood', correctTool: true,
  tags: ['end', 'container'],
});

// Generated inside an End ship. It has no block item and instead yields the
// wearable elytra through Game's block-broken event, ensuring one guaranteed
// reward without inventing a chest inventory during terrain generation.
v7('elytra_display', 'elytra_display', {
  shape: 'post', layer: 'cutout', hardness: 0.4, solid: false,
  collidable: false, transparent: true, attenuation: 0, sound: 'wood',
  stackSize: 0, tags: ['end', 'unique_loot'],
});

// The gateway appears after the first dragon kill and links the central island
// to the outer islands. It is deliberately unbreakable like an End portal.
v7('end_gateway', 'end_gateway', {
  layer: 'translucent', hardness: 36, breakable: false, stackSize: 0,
  solid: false, collidable: false, transparent: true, attenuation: 0,
  light: 15, sound: 'glass', tags: ['end', 'portal'],
});

export const V7_BLOCK_DESCRIPTORS = Object.freeze(descriptors.slice());
export const V7_TILE_NAMES = Object.freeze(tiles.slice());
export const V7_BLOCK_NAMES = Object.freeze(descriptors.map((entry) => entry.name));

export function validateV7Blocks(existingBlockNames = []) {
  const problems = [];
  const existing = new Set(existingBlockNames);
  const seen = new Set();
  for (const entry of descriptors) {
    if (seen.has(entry.name)) problems.push(`duplicate v7 block "${entry.name}"`);
    if (existing.has(entry.name)) problems.push(`v7 block "${entry.name}" already exists`);
    seen.add(entry.name);
    if (!['cube', 'cross', 'post', 'plate', 'boxes'].includes(entry.shape)) {
      problems.push(`v7 block "${entry.name}" has invalid shape`);
    }
    if (!['opaque', 'cutout', 'translucent'].includes(entry.layer)) {
      problems.push(`v7 block "${entry.name}" has invalid layer`);
    }
  }
  return problems;
}

export default V7_BLOCK_DESCRIPTORS;
