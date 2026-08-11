/**
 * Bastion Remnant generation.
 *
 * The second client of the jigsaw engine in `StructureTemplate.js`, and
 * deliberately written against exactly the same seams as `NetherFortress.js`:
 * pieces publish blocks, connectors and markers, `assembleStructure` grows a
 * non-self-intersecting layout, and a region siting function decides where one
 * may exist. If you have read the fortress module, you have read this one.
 *
 * ## Why a separate module rather than more fortress pieces
 *
 * A bastion is not a fortress with different blocks. It sits in its own, larger
 * siting region so the two structures do not compete for the same ground, it is
 * rarer, and it is the only place `ancient_debris` is *guaranteed* -- which makes
 * it the intended source of the netherite tier rather than a lucky mining run.
 * Mixing the pools would let a corridor open into a treasure room and hand the
 * player netherite for free.
 *
 * ## Why markers, again
 *
 * There is no spawner block in this codebase, so piglin garrisons are published
 * as markers and rotated with the same `rotatePoint` the block writer uses.
 *
 * Worker-safe: no DOM, no Three.js.
 */

import { Block } from './BlockTypes.js';
import { voxelIndex } from '../utils/CoordinateUtils.js';
import {
  Facing,
  StructurePool,
  assembleStructure,
  flattenPlacements,
  rotatePoint,
  validatePiece,
} from './StructureTemplate.js';

const BLACK = Block.BLACKSTONE;
const POLISHED = Block.POLISHED_BLACKSTONE;
const BRICKS = Block.POLISHED_BLACKSTONE_BRICKS;
const GILDED = Block.GILDED_BLACKSTONE;
const BASALT = Block.BASALT;
const POLISHED_BASALT = Block.POLISHED_BASALT;
const DEBRIS = Block.ANCIENT_DEBRIS;
const CRYING = Block.CRYING_OBSIDIAN;
const SOUL_SAND = Block.SOUL_SAND;
const MAGMA = Block.MAGMA_BLOCK;
const CHEST = Block.CHEST;
const GLOWSTONE = Block.GLOWSTONE;
const AIR = Block.AIR;

/** Marker kinds a bastion piece can publish. */
export const BastionMarker = Object.freeze({
  PIGLIN_POST: 'piglin_post',
  TREASURE_CHEST: 'treasure_chest',
  LAVA_BASIN: 'lava_basin',
});

/**
 * How many chunks across one bastion siting region is.
 *
 * Larger than the fortress region (24) so bastions are meaningfully rarer and
 * the two structures rarely share a neighbourhood.
 */
export const BASTION_REGION_CHUNKS = 32;

/** Deterministic 32-bit hash of three integers plus a seed. */
function hash3(x, y, seed) {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = (Math.imul(h ^ (x | 0), 0x85ebca6b) >>> 0) ^ 0x165667b1;
  h = (Math.imul(h ^ (y | 0), 0xc2b2ae35) >>> 0) ^ 0x27d4eb2f;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

/** Small deterministic PRNG, so a seed always yields the same bastion. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Solid axis-aligned box, inclusive bounds. */
function box(blocks, x0, y0, z0, x1, y1, z1, block) {
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) blocks.push({ x, y, z, block });
    }
  }
}

/**
 * A walled walkway along Z, open to the sky.
 *
 * Bastion ramparts are walls you fight on top of, not corridors you hide in, so
 * unlike the fortress corridor this piece has no ceiling and carries
 * crenellations instead of windows.
 */
function rampartPiece(name, length) {
  const blocks = [];
  const w = 4;
  box(blocks, 0, 0, 0, w, 0, length - 1, BLACK); // walkway floor
  box(blocks, 0, 1, 0, 0, 3, length - 1, POLISHED); // west parapet
  box(blocks, w, 1, 0, w, 3, length - 1, POLISHED); // east parapet
  box(blocks, 1, 1, 0, w - 1, 3, length - 1, AIR); // clear the walkway
  // Crenellations: alternating raised blocks along both parapets.
  for (let z = 0; z < length; z += 2) {
    blocks.push({ x: 0, y: 4, z, block: BRICKS });
    blocks.push({ x: w, y: 4, z, block: BRICKS });
  }
  blocks.push({ x: 2, y: 1, z: Math.floor(length / 2), block: GLOWSTONE });
  return {
    name,
    size: [w + 1, 5, length],
    blocks,
    connectors: [
      { name: 'south', facing: Facing.POSITIVE_Z, at: [2, 1, length - 1], target: 'bastion' },
      { name: 'north', facing: Facing.NEGATIVE_Z, at: [2, 1, 0], target: 'bastion' },
    ],
  };
}

/** A basalt span with low railings, crossing the lava sea. */
function bridgeSpanPiece(name, length) {
  const blocks = [];
  const w = 4;
  box(blocks, 0, 0, 0, w, 0, length - 1, BASALT);
  for (let z = 0; z < length; z++) {
    blocks.push({ x: 0, y: 1, z, block: POLISHED_BASALT });
    blocks.push({ x: w, y: 1, z, block: POLISHED_BASALT });
  }
  box(blocks, 1, 1, 0, w - 1, 2, length - 1, AIR);
  return {
    name,
    size: [w + 1, 3, length],
    blocks,
    connectors: [
      { name: 'south', facing: Facing.POSITIVE_Z, at: [2, 1, length - 1], target: 'bastion' },
      { name: 'north', facing: Facing.NEGATIVE_Z, at: [2, 1, 0], target: 'bastion' },
    ],
  };
}

/**
 * The four-way courtyard that starts every bastion.
 *
 * Doorways are carved *after* the walls go up, at exactly the connector cells,
 * which is what keeps the connector positions walkable rather than buried.
 */
function courtyardPiece(name) {
  const blocks = [];
  const s = 8;
  box(blocks, 0, 0, 0, s, 0, s, BLACK); // 9x9 plaza
  // Perimeter wall, two blocks tall.
  box(blocks, 0, 1, 0, s, 2, 0, POLISHED);
  box(blocks, 0, 1, s, s, 2, s, POLISHED);
  box(blocks, 0, 1, 0, 0, 2, s, POLISHED);
  box(blocks, s, 1, 0, s, 2, s, POLISHED);
  // Corner towers.
  for (const [cx, cz] of [[0, 0], [s, 0], [0, s], [s, s]]) {
    box(blocks, cx, 1, cz, cx, 5, cz, BRICKS);
  }
  // Hollow interior above the plaza.
  box(blocks, 1, 1, 1, s - 1, 5, s - 1, AIR);
  // A magma basin at the centre, lit by glowstone in the towers.
  box(blocks, 3, 0, 3, 5, 0, 5, MAGMA);
  blocks.push({ x: 4, y: 0, z: 4, block: CRYING });
  for (const [cx, cz] of [[1, 1], [s - 1, 1], [1, s - 1], [s - 1, s - 1]]) {
    blocks.push({ x: cx, y: 4, z: cz, block: GLOWSTONE });
  }
  // Doorways at the four connector cells.
  const mid = Math.floor(s / 2);
  for (const [dx, dz] of [[mid, 0], [mid, s], [0, mid], [s, mid]]) {
    blocks.push({ x: dx, y: 1, z: dz, block: AIR });
    blocks.push({ x: dx, y: 2, z: dz, block: AIR });
  }
  return {
    name,
    size: [s + 1, 7, s + 1],
    blocks,
    markers: [{ type: BastionMarker.LAVA_BASIN, x: 4, y: 1, z: 4 }],
    connectors: [
      { name: 'south', facing: Facing.POSITIVE_Z, at: [mid, 1, s], target: 'bastion' },
      { name: 'north', facing: Facing.NEGATIVE_Z, at: [mid, 1, 0], target: 'bastion' },
      { name: 'east', facing: Facing.POSITIVE_X, at: [s, 1, mid], target: 'bastion' },
      { name: 'west', facing: Facing.NEGATIVE_X, at: [0, 1, mid], target: 'bastion' },
    ],
  };
}

/**
 * The treasure room: the guaranteed netherite source.
 *
 * Ancient debris is embedded *inside* the floor rather than sitting on it, so it
 * still has to be mined with a diamond pickaxe -- the room removes the search,
 * not the cost.
 */
function treasureRoomPiece(name) {
  const blocks = [];
  const s = 6;
  box(blocks, 0, 0, 0, s, 0, s, GILDED);
  box(blocks, 0, 1, 0, s, 4, 0, BRICKS);
  box(blocks, 0, 1, s, s, 4, s, BRICKS);
  box(blocks, 0, 1, 0, 0, 4, s, BRICKS);
  box(blocks, s, 1, 0, s, 4, s, BRICKS);
  box(blocks, 0, 5, 0, s, 5, s, BLACK); // roof
  box(blocks, 1, 1, 1, s - 1, 4, s - 1, AIR);
  // Debris seam under the floor.
  for (const [dx, dz] of [[2, 2], [4, 2], [3, 4], [2, 4]]) {
    blocks.push({ x: dx, y: 0, z: dz, block: DEBRIS });
  }
  blocks.push({ x: 3, y: 1, z: 3, block: CHEST });
  blocks.push({ x: 1, y: 1, z: 1, block: CHEST });
  blocks.push({ x: 3, y: 4, z: 3, block: GLOWSTONE });
  // Doorway on the north face.
  blocks.push({ x: 3, y: 1, z: 0, block: AIR });
  blocks.push({ x: 3, y: 2, z: 0, block: AIR });
  return {
    name,
    size: [s + 1, 6, s + 1],
    blocks,
    markers: [
      { type: BastionMarker.TREASURE_CHEST, x: 3, y: 1, z: 3 },
      { type: BastionMarker.TREASURE_CHEST, x: 1, y: 1, z: 1 },
    ],
    connectors: [
      { name: 'north', facing: Facing.NEGATIVE_Z, at: [3, 1, 0], target: 'bastion' },
    ],
  };
}

/** A piglin garrison: soul sand floor patches and three spawn posts. */
function piglinCampPiece(name) {
  const blocks = [];
  const s = 6;
  box(blocks, 0, 0, 0, s, 0, s, BLACK);
  box(blocks, 0, 1, 0, s, 3, 0, POLISHED);
  box(blocks, 0, 1, s, s, 3, s, POLISHED);
  box(blocks, 0, 1, 0, 0, 3, s, POLISHED);
  box(blocks, s, 1, 0, s, 3, s, POLISHED);
  box(blocks, 1, 1, 1, s - 1, 3, s - 1, AIR);
  for (const [dx, dz] of [[2, 2], [4, 3], [2, 4]]) {
    blocks.push({ x: dx, y: 0, z: dz, block: SOUL_SAND });
  }
  blocks.push({ x: 3, y: 0, z: 3, block: MAGMA });
  blocks.push({ x: 3, y: 3, z: 3, block: GLOWSTONE });
  blocks.push({ x: 3, y: 1, z: 0, block: AIR });
  blocks.push({ x: 3, y: 2, z: 0, block: AIR });
  return {
    name,
    size: [s + 1, 4, s + 1],
    blocks,
    markers: [
      { type: BastionMarker.PIGLIN_POST, x: 2, y: 1, z: 2 },
      { type: BastionMarker.PIGLIN_POST, x: 4, y: 1, z: 3 },
      { type: BastionMarker.PIGLIN_POST, x: 2, y: 1, z: 4 },
    ],
    connectors: [
      { name: 'north', facing: Facing.NEGATIVE_Z, at: [3, 1, 0], target: 'bastion' },
    ],
  };
}

/** A stepped tower, so a layout can change height instead of sprawling flat. */
function stairTowerPiece(name) {
  const blocks = [];
  const w = 4;
  const length = 6;
  box(blocks, 0, 0, 0, w, 0, length - 1, BLACK);
  // A staircase climbing along +Z.
  for (let z = 0; z < length; z++) {
    const step = Math.min(4, z);
    box(blocks, 1, 1, z, w - 1, step, z, BLACK);
    blocks.push({ x: 0, y: step + 1, z, block: POLISHED });
    blocks.push({ x: w, y: step + 1, z, block: POLISHED });
  }
  blocks.push({ x: 2, y: 6, z: length - 1, block: GLOWSTONE });
  return {
    name,
    size: [w + 1, 8, length],
    blocks,
    connectors: [
      { name: 'north', facing: Facing.NEGATIVE_Z, at: [2, 1, 0], target: 'bastion' },
      { name: 'south', facing: Facing.POSITIVE_Z, at: [2, 5, length - 1], target: 'bastion' },
    ],
  };
}

/** Every bastion piece, keyed by name. */
export const BASTION_PIECES = Object.freeze({
  courtyard: courtyardPiece('courtyard'),
  rampart: rampartPiece('rampart', 9),
  long_rampart: rampartPiece('long_rampart', 12),
  bridge_span: bridgeSpanPiece('bridge_span', 11),
  treasure_room: treasureRoomPiece('treasure_room'),
  piglin_camp: piglinCampPiece('piglin_camp'),
  stair_tower: stairTowerPiece('stair_tower'),
});

/**
 * Weighted pool. Ramparts carry the layout; the treasure room is rare so a
 * bastion usually holds exactly one.
 */
export function bastionPools() {
  return new Map([
    ['bastion', new StructurePool('bastion', [
      { piece: BASTION_PIECES.rampart, weight: 6 },
      { piece: BASTION_PIECES.long_rampart, weight: 3 },
      { piece: BASTION_PIECES.bridge_span, weight: 3 },
      { piece: BASTION_PIECES.piglin_camp, weight: 4 },
      { piece: BASTION_PIECES.stair_tower, weight: 2 },
      { piece: BASTION_PIECES.treasure_room, weight: 1 },
    ])],
  ]);
}

/** Validates every piece. Returns a list of problems, empty when healthy. */
export function validateBastionPieces() {
  const problems = [];
  for (const piece of Object.values(BASTION_PIECES)) {
    problems.push(...validatePiece(piece));
  }
  return problems;
}

/**
 * Assembles one bastion.
 *
 * @param {Object} [options]
 * @param {number} [options.seed]
 * @param {number[]} [options.origin] World position of the courtyard.
 * @param {number} [options.maxPieces]
 * @param {Object} [options.bounds] Optional hard bounds.
 * @returns {{placements:Array, cells:Array, markers:Array, rejected:number}}
 */
export function buildBastion({ seed = 1, origin = [0, 44, 0], maxPieces = 16, bounds = null } = {}) {
  const random = mulberry32(hash3(origin[0], origin[2], (seed ^ 0x1b0a_57e9) >>> 0));
  const result = assembleStructure({
    start: BASTION_PIECES.courtyard,
    origin,
    pools: bastionPools(),
    random,
    maxPieces,
    bounds,
  });

  const cells = flattenPlacements(result.placements);
  const markers = [];
  for (const placement of result.placements) {
    const sourceName = placement.source ?? placement.piece.name;
    const base = BASTION_PIECES[sourceName];
    for (const marker of base?.markers ?? []) {
      const [rx, ry, rz] = rotatePoint([marker.x, marker.y, marker.z], base.size, placement.turns);
      markers.push({
        type: marker.type,
        x: placement.origin[0] + rx,
        y: placement.origin[1] + ry,
        z: placement.origin[2] + rz,
      });
    }
  }

  return { placements: result.placements, cells, markers, rejected: result.rejected };
}

/**
 * Deterministic bastion siting.
 *
 * One candidate per region and only ~35% of regions carry one, which makes a
 * bastion rarer than a fortress (~55%) as well as spaced further apart.
 *
 * @returns {{x:number, y:number, z:number}|null}
 */
export function bastionOriginForRegion(regionX, regionZ, seed) {
  const h = hash3(regionX, regionZ, ((seed >>> 0) ^ 0x5a57_10a1) >>> 0);
  if ((h & 0xff) / 255 > 0.35) return null;
  const span = BASTION_REGION_CHUNKS * 16;
  const jitterX = ((h >>> 8) & 0x7f) % (span - 96);
  const jitterZ = ((h >>> 16) & 0x7f) % (span - 96);
  // Bastions sit a little above the fortress band so the two rarely interleave.
  const y = 46 + (((h >>> 24) & 0x0f) - 8);
  return {
    x: regionX * span + jitterX + 24,
    y,
    z: regionZ * span + jitterZ + 24,
  };
}

const BASTION_CACHE = new Map();

/** Builds (and memoises) the bastion owning a region, or null. */
export function bastionForRegion(regionX, regionZ, seed) {
  const key = `${regionX},${regionZ},${seed >>> 0}`;
  if (BASTION_CACHE.has(key)) return BASTION_CACHE.get(key);
  const origin = bastionOriginForRegion(regionX, regionZ, seed);
  const built = origin
    ? buildBastion({ seed, origin: [origin.x, origin.y, origin.z], maxPieces: 16 })
    : null;
  if (BASTION_CACHE.size > 64) BASTION_CACHE.clear();
  BASTION_CACHE.set(key, built);
  return built;
}

/** Clears the memo cache. Tests use this to prove determinism. */
export function clearBastionCache() {
  BASTION_CACHE.clear();
}

/**
 * Writes any bastion cells that land inside one chunk.
 *
 * Scans the 3x3 region neighbourhood so a bastion straddling a region edge is
 * never half-built.
 *
 * @returns {number} Cells written.
 */
export function paintBastionChunk(blocks, chunkX, chunkZ, seed, { maxY = 127 } = {}) {
  const originX = chunkX * 16;
  const originZ = chunkZ * 16;
  const span = BASTION_REGION_CHUNKS * 16;
  const baseRegionX = Math.floor(originX / span);
  const baseRegionZ = Math.floor(originZ / span);
  let written = 0;

  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const bastion = bastionForRegion(baseRegionX + dx, baseRegionZ + dz, seed);
      if (!bastion) continue;
      for (const cell of bastion.cells) {
        const localX = cell.x - originX;
        const localZ = cell.z - originZ;
        if (localX < 0 || localX > 15 || localZ < 0 || localZ > 15) continue;
        if (cell.y < 1 || cell.y > maxY) continue;
        blocks[voxelIndex(localX, cell.y, localZ)] = cell.block;
        written++;
      }
    }
  }
  return written;
}

/** Bastion markers near a world position, for garrison and loot wiring. */
export function bastionMarkersNear(x, z, seed, { radius = 96, type = null } = {}) {
  const span = BASTION_REGION_CHUNKS * 16;
  const baseRegionX = Math.floor(x / span);
  const baseRegionZ = Math.floor(z / span);
  const found = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const bastion = bastionForRegion(baseRegionX + dx, baseRegionZ + dz, seed);
      if (!bastion) continue;
      for (const marker of bastion.markers) {
        if (type && marker.type !== type) continue;
        const dxx = marker.x - x;
        const dzz = marker.z - z;
        if ((dxx * dxx) + (dzz * dzz) <= radius * radius) found.push(marker);
      }
    }
  }
  return found;
}

export default buildBastion;
