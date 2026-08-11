/**
 * Flattens the block declarations into typed-array lookup tables.
 *
 * The mesher touches these tables millions of times per second while streaming
 * chunks. Reading `BLOCK_DEFINITIONS[id].transparent` there would mean a
 * property lookup on a megamorphic object per voxel per face; reading
 * `IS_OPAQUE[id]` is a single byte load out of a contiguous array. Everything
 * the inner loops need is therefore pre-baked here at module load.
 *
 * Worker-safe.
 */

import {
  FACE_NX,
  FACE_NY,
  FACE_NZ,
  FACE_PX,
  FACE_PY,
  FACE_PZ,
  LAYER_OPAQUE,
} from '../config/GameConfig.js';
import {
  BLOCK_DEFINITIONS,
  Block,
  RenderShape,
  TILE_INDEX,
  TILE_NAMES,
} from './BlockTypes.js';

/** Highest block id plus one. */
export const BLOCK_COUNT = BLOCK_DEFINITIONS.reduce((max, def) => Math.max(max, def.id), 0) + 1;

if (BLOCK_COUNT > 0x10000) {
  throw new Error(`BLOCK_COUNT is ${BLOCK_COUNT} — exceeds the 16-bit runtime id limit.`);
}

/** Numeric render-shape codes for the mesher's switch. */
export const Shape = Object.freeze({ CUBE: 0, CROSS: 1, POST: 2, PLATE: 3, BOXES: 4 });

/** Numeric sway codes consumed by the voxel vertex shader. */
export const Sway = Object.freeze({ NONE: 0, LEAVES: 1, GRASS: 2 });

const definitionsById = new Array(BLOCK_COUNT).fill(null);
for (const definition of BLOCK_DEFINITIONS) {
  if (definitionsById[definition.id]) {
    throw new Error(`Duplicate block id ${definition.id} ("${definition.name}")`);
  }
  definitionsById[definition.id] = definition;
}

// Any gap in the id space would silently render as air; fail loudly instead.
for (let id = 0; id < BLOCK_COUNT; id++) {
  if (!definitionsById[id]) throw new Error(`Block id ${id} is not defined`);
}

/** Whether the block participates in world geometry at all. */
export const IS_AIR = new Uint8Array(BLOCK_COUNT);
/** Fully opaque cube: hides the adjacent face of its neighbour. */
export const IS_OPAQUE = new Uint8Array(BLOCK_COUNT);
/** Blocks light and participates in "solid" queries (used by structures). */
export const IS_SOLID = new Uint8Array(BLOCK_COUNT);
/** Takes part in player/entity collision. */
export const IS_COLLIDABLE = new Uint8Array(BLOCK_COUNT);
/** Water-like. */
export const IS_LIQUID = new Uint8Array(BLOCK_COUNT);
/** Can be broken by the player. */
export const IS_BREAKABLE = new Uint8Array(BLOCK_COUNT);
/** Falls when unsupported. */
export const IS_GRAVITY = new Uint8Array(BLOCK_COUNT);
/** Pops off when its supporting block is removed. */
export const NEEDS_SUPPORT = new Uint8Array(BLOCK_COUNT);
/** Skip the shared face between two identical blocks. */
export const CULL_SAME = new Uint8Array(BLOCK_COUNT);
/** Render layer index. */
export const RENDER_LAYER = new Uint8Array(BLOCK_COUNT);
/** Mesh shape code. */
export const RENDER_SHAPE = new Uint8Array(BLOCK_COUNT);
/** Vertex-animation class. */
export const SWAY_CLASS = new Uint8Array(BLOCK_COUNT);
/** Emitted light, 0..15. */
export const LIGHT_LEVEL = new Uint8Array(BLOCK_COUNT);
/** Sky light removed from the column below this block, 0..15. */
export const LIGHT_ATTENUATION = new Uint8Array(BLOCK_COUNT);
/** Seconds to break at survival speed. `Infinity` for unbreakable blocks. */
export const HARDNESS = new Float32Array(BLOCK_COUNT);
/** Block id produced when broken. */
export const DROP_ID = new Uint16Array(BLOCK_COUNT);
/** Maximum stack size. */
export const STACK_SIZE = new Uint8Array(BLOCK_COUNT);

/**
 * Numeric tool kinds.
 *
 * The block tables are typed arrays for the same reason every other table here is:
 * they are read in the mining hot path and per-frame by the UI. A string comparison
 * per block would be a needless allocation-free-but-slow detour, and a numeric
 * enum keeps `PREFERRED_TOOL` a `Uint8Array`.
 */
export const ToolClass = Object.freeze({
  NONE: 0,
  PICKAXE: 1,
  AXE: 2,
  SHOVEL: 3,
  HOE: 4,
  SWORD: 5,
  SHEARS: 6,
});

/** Maps the string names used in block definitions onto `ToolClass`. */
const TOOL_CLASS_BY_NAME = Object.freeze({
  pickaxe: ToolClass.PICKAXE,
  axe: ToolClass.AXE,
  shovel: ToolClass.SHOVEL,
  hoe: ToolClass.HOE,
  sword: ToolClass.SWORD,
  shears: ToolClass.SHEARS,
});

/** Harvest tier levels, matching `TIER_DATA` in `items/ItemTypes.js`. */
const TIER_LEVEL_BY_NAME = Object.freeze({
  hand: 0,
  wood: 1,
  stone: 2,
  iron: 3,
  diamond: 4,
});

/** `ToolClass` each block prefers, indexed by block id. */
export const PREFERRED_TOOL = new Uint8Array(BLOCK_COUNT);
/** Minimum tool tier level that yields a drop, indexed by block id. */
export const MIN_HARVEST_TIER = new Uint8Array(BLOCK_COUNT);
/** 1 when the correct tool kind is required for a drop. */
export const REQUIRES_CORRECT_TOOL = new Uint8Array(BLOCK_COUNT);
/** 1 when the block drops regardless of what broke it. */
export const DROPS_WITHOUT_TOOL = new Uint8Array(BLOCK_COUNT);
/**
 * Atlas tile index per block per face, indexed as `id * 6 + face`.
 * @type {Uint16Array}
 */
export const FACE_TILES = new Uint16Array(BLOCK_COUNT * 6);
/** Default state byte assigned when a block item is placed. */
export const DEFAULT_STATE = new Uint8Array(BLOCK_COUNT);
/**
 * Atlas tile per block/state/face, indexed as `(id * 256 + state) * 6 + face`.
 * 256 states per block costs little compared with chunk geometry and keeps the
 * meshing hot loop branch-free.
 */
export const STATE_FACE_TILES = new Uint16Array(BLOCK_COUNT * 256 * 6);
/** Visual height per block/state, primarily for staged cross plants. */
export const STATE_RENDER_HEIGHT = new Float32Array(BLOCK_COUNT * 256).fill(1);
/** Per-block RGB tint, `id * 3`. 255 means "no tint". */
export const BLOCK_TINT = new Uint8Array(BLOCK_COUNT * 3).fill(255);

for (const definition of BLOCK_DEFINITIONS) {
  const id = definition.id;

  IS_AIR[id] = id === Block.AIR ? 1 : 0;
  IS_SOLID[id] = definition.solid ? 1 : 0;
  IS_COLLIDABLE[id] = definition.collidable ? 1 : 0;
  IS_LIQUID[id] = definition.liquid ? 1 : 0;
  IS_BREAKABLE[id] = definition.breakable ? 1 : 0;
  IS_GRAVITY[id] = definition.gravityAffected ? 1 : 0;
  NEEDS_SUPPORT[id] = definition.needsSupport ? 1 : 0;
  CULL_SAME[id] = definition.cullSameNeighbour ? 1 : 0;
  RENDER_LAYER[id] = definition.renderLayer;
  RENDER_SHAPE[id] =
    definition.renderShape === RenderShape.CROSS
      ? Shape.CROSS
      : definition.renderShape === RenderShape.POST
        ? Shape.POST
        : definition.renderShape === RenderShape.PLATE
          ? Shape.PLATE
          : definition.renderShape === RenderShape.BOXES
            ? Shape.BOXES
            : Shape.CUBE;
  SWAY_CLASS[id] =
    definition.sway === 'leaves' ? Sway.LEAVES : definition.sway === 'grass' ? Sway.GRASS : Sway.NONE;
  LIGHT_LEVEL[id] = definition.lightLevel;
  LIGHT_ATTENUATION[id] = definition.lightAttenuation;
  HARDNESS[id] = definition.hardness;
  DROP_ID[id] = definition.dropId;
  STACK_SIZE[id] = Math.min(255, definition.stackSize);

  // --- harvesting ---
  if (definition.preferredTool !== null) {
    const toolClass = TOOL_CLASS_BY_NAME[definition.preferredTool];
    if (toolClass === undefined) {
      throw new Error(
        `Block "${definition.name}" has unknown preferredTool "${definition.preferredTool}"`
      );
    }
    PREFERRED_TOOL[id] = toolClass;
  }
  {
    const level = TIER_LEVEL_BY_NAME[definition.minimumHarvestTier];
    if (level === undefined) {
      throw new Error(
        `Block "${definition.name}" has unknown minimumHarvestTier ` +
          `"${definition.minimumHarvestTier}"`
      );
    }
    MIN_HARVEST_TIER[id] = level;
  }
  REQUIRES_CORRECT_TOOL[id] = definition.requiresCorrectTool ? 1 : 0;
  DROPS_WITHOUT_TOOL[id] = definition.dropsWithoutCorrectTool ? 1 : 0;

  // A tier gate with no tool requirement is almost always a mistake: the block
  // would demand a strong tool but accept any kind, so a diamond shovel would
  // harvest diamond ore. Caught at load rather than discovered in play.
  if (MIN_HARVEST_TIER[id] > 0 && !REQUIRES_CORRECT_TOOL[id] && !DROPS_WITHOUT_TOOL[id]) {
    throw new Error(
      `Block "${definition.name}" sets minimumHarvestTier ` +
        `"${definition.minimumHarvestTier}" but not requiresCorrectTool; any tool of that ` +
        'tier would harvest it'
    );
  }

  // "Opaque" is stricter than "solid": a cactus is solid but its cutout
  // texture means the neighbour's face must still be drawn.
  IS_OPAQUE[id] =
    id !== Block.AIR &&
    !definition.transparent &&
    definition.renderLayer === LAYER_OPAQUE &&
    definition.renderShape === RenderShape.CUBE
      ? 1
      : 0;

  if (definition.tint) {
    BLOCK_TINT[id * 3] = definition.tint[0];
    BLOCK_TINT[id * 3 + 1] = definition.tint[1];
    BLOCK_TINT[id * 3 + 2] = definition.tint[2];
  }

  if (id === Block.AIR) continue;

  const top = resolveTile(definition.textureTop, definition.name);
  const bottom = resolveTile(definition.textureBottom ?? definition.textureTop, definition.name);
  const side = resolveTile(definition.textureSide ?? definition.textureTop, definition.name);
  FACE_TILES[id * 6 + FACE_PX] = side;
  FACE_TILES[id * 6 + FACE_NX] = side;
  FACE_TILES[id * 6 + FACE_PY] = top;
  FACE_TILES[id * 6 + FACE_NY] = bottom;
  FACE_TILES[id * 6 + FACE_PZ] = side;
  FACE_TILES[id * 6 + FACE_NZ] = side;
  DEFAULT_STATE[id] = definition.defaultState & 0xff;

  // Every state starts with the base textures. Sparse overrides below replace
  // only the states a block actually uses.
  for (let state = 0; state < 256; state++) {
    const destination = (id * 256 + state) * 6;
    for (let face = 0; face < 6; face++) {
      STATE_FACE_TILES[destination + face] = FACE_TILES[id * 6 + face];
    }
  }

  if (definition.stateTextures) {
    for (const [rawState, override] of Object.entries(definition.stateTextures)) {
      const state = Number(rawState);
      if (!Number.isInteger(state) || state < 0 || state > 255) {
        throw new Error(`Block "${definition.name}" has invalid texture state "${rawState}"`);
      }
      const descriptor = typeof override === 'string' ? { all: override } : override;
      if (!descriptor || typeof descriptor !== 'object') {
        throw new Error(`Block "${definition.name}" has malformed texture state ${state}`);
      }
      const topTile = resolveTile(
        descriptor.top ?? descriptor.all ?? definition.textureTop,
        definition.name
      );
      const bottomTile = resolveTile(
        descriptor.bottom ?? descriptor.all ?? definition.textureBottom ?? definition.textureTop,
        definition.name
      );
      const sideTile = resolveTile(
        descriptor.side ?? descriptor.all ?? definition.textureSide ?? definition.textureTop,
        definition.name
      );
      const destination = (id * 256 + state) * 6;
      STATE_FACE_TILES[destination + FACE_PX] = sideTile;
      STATE_FACE_TILES[destination + FACE_NX] = sideTile;
      STATE_FACE_TILES[destination + FACE_PY] = topTile;
      STATE_FACE_TILES[destination + FACE_NY] = bottomTile;
      STATE_FACE_TILES[destination + FACE_PZ] = sideTile;
      STATE_FACE_TILES[destination + FACE_NZ] = sideTile;
    }
  }

  if (definition.stateHeights) {
    for (const [rawState, rawHeight] of Object.entries(definition.stateHeights)) {
      const state = Number(rawState);
      const height = Number(rawHeight);
      if (!Number.isInteger(state) || state < 0 || state > 255 || !(height > 0 && height <= 1)) {
        throw new Error(`Block "${definition.name}" has invalid state height ${rawState}:${rawHeight}`);
      }
      STATE_RENDER_HEIGHT[id * 256 + state] = height;
    }
  }
}

function resolveTile(tileName, blockName) {
  const index = TILE_INDEX[tileName];
  if (index === undefined) {
    throw new Error(`Block "${blockName}" references unknown tile "${tileName}"`);
  }
  return index;
}

/**
 * Returns the full definition object for a block id.
 * Use this for UI and gameplay logic; use the typed arrays in hot loops.
 *
 * @param {number} id
 * @returns {Object}
 */
export function getBlock(id) {
  return definitionsById[id] || definitionsById[Block.AIR];
}

/** Display name for a block id, safe for unknown ids. */
export function getBlockName(id) {
  return definitionsById[id]?.displayName ?? 'Unknown';
}

/** True when the id names a real, registered block. */
export function isValidBlockId(id) {
  return Number.isInteger(id) && id >= 0 && id < BLOCK_COUNT;
}

/**
 * True when a face between `blockId` and `neighbourId` should be emitted.
 *
 * This single predicate is the whole face-culling policy:
 *  - a face against air is always drawn;
 *  - a face against a fully opaque cube is never drawn;
 *  - identical see-through blocks (glass/glass, water/water, leaves/leaves)
 *    hide their shared face so a lake is not a stack of interior quads;
 *  - anything else — stone behind glass, sand behind leaves — is drawn,
 *    because you can see through the neighbour.
 *
 * @param {number} blockId The block owning the face.
 * @param {number} neighbourId The block on the other side.
 * @returns {boolean}
 */
export function shouldEmitFace(blockId, neighbourId) {
  if (neighbourId === Block.AIR) return true;
  if (IS_OPAQUE[neighbourId]) return false;
  if (blockId === neighbourId && CULL_SAME[blockId]) return false;
  // Liquids never draw their inner faces against a solid they are flush with.
  if (IS_LIQUID[blockId] && IS_SOLID[neighbourId] && RENDER_SHAPE[neighbourId] === Shape.CUBE) {
    return false;
  }
  return true;
}

/**
 * Tile index for one face of a block.
 * @param {number} blockId
 * @param {number} face One of the `FACE_*` constants.
 */
export function getFaceTile(blockId, face, state = 0) {
  return STATE_FACE_TILES[(blockId * 256 + (state & 0xff)) * 6 + face];
}

/** Number of tiles in the atlas. */
export const TILE_COUNT = TILE_NAMES.length;

/**
 * Snapshot of the registry tables, structured-clone friendly, for handing to a
 * worker that was built without importing this module. Currently the worker
 * imports the registry directly (it is pure JS), so this exists for
 * diagnostics and for future off-thread tooling.
 */
export function exportRegistryTables() {
  return {
    blockCount: BLOCK_COUNT,
    isOpaque: IS_OPAQUE,
    isSolid: IS_SOLID,
    isLiquid: IS_LIQUID,
    renderLayer: RENDER_LAYER,
    renderShape: RENDER_SHAPE,
    swayClass: SWAY_CLASS,
    lightLevel: LIGHT_LEVEL,
    lightAttenuation: LIGHT_ATTENUATION,
    faceTiles: FACE_TILES,
    stateFaceTiles: STATE_FACE_TILES,
    defaultState: DEFAULT_STATE,
    stateRenderHeight: STATE_RENDER_HEIGHT,
  };
}
