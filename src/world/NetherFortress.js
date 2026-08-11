/**
 * Nether Fortress generation.
 *
 * Built on the jigsaw engine in `StructureTemplate.js`: pieces declare their
 * blocks and their connectors, and `assembleStructure` grows a layout that never
 * self-intersects. That engine existed since Phase 2 but nothing consumed it --
 * the fortress is its first real client.
 *
 * ## Why markers are not blocks
 *
 * A blaze spawn point is not a block in this codebase (there is no spawner
 * block), so pieces carry a `markers` list. Markers are rotated with the same
 * `rotatePoint` the block writer uses, keyed off the placement's recorded
 * `turns`, so a rotated blaze room still reports its cage centre correctly.
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

const BRICK = Block.NETHER_BRICKS;
const FENCE = Block.NETHER_BRICK_FENCE;
const STAIRS = Block.NETHER_BRICK_STAIRS;
const SLAB = Block.NETHER_BRICK_SLAB;
const WART = Block.NETHER_WART;
const SOUL_SAND = Block.SOUL_SAND;
const CHEST = Block.CHEST;
const AIR = Block.AIR;
const GLOWSTONE = Block.GLOWSTONE;
const MAGMA = Block.MAGMA_BLOCK;

/** Marker kinds a piece can publish. */
export const FortressMarker = Object.freeze({
  BLAZE_SPAWNER: 'blaze_spawner',
  LOOT_CHEST: 'loot_chest',
  WART_FARM: 'wart_farm',
});

/** How many chunks across one fortress siting region is. */
export const FORTRESS_REGION_CHUNKS = 24;

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

/** Small deterministic PRNG, so a seed always yields the same fortress. */
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
 * A 5-wide walled hall. Runs along Z so connectors sit on the short ends.
 */
function corridorPiece(name, length, { ceiling = true, windows = true } = {}) {
  const blocks = [];
  const w = 4;
  const h = 4;
  box(blocks, 0, 0, 0, w, 0, length - 1, BRICK); // floor
  box(blocks, 0, 1, 0, 0, h - 1, length - 1, BRICK); // west wall
  box(blocks, w, 1, 0, w, h - 1, length - 1, BRICK); // east wall
  if (ceiling) box(blocks, 0, h, 0, w, h, length - 1, BRICK);
  // Hollow the walkway.
  box(blocks, 1, 1, 0, w - 1, h - 1, length - 1, AIR);
  if (windows) {
    for (let z = 1; z < length - 1; z += 3) {
      blocks.push({ x: 0, y: 2, z, block: FENCE });
      blocks.push({ x: w, y: 2, z, block: FENCE });
    }
  }
  // Light so the hall is navigable without torches.
  blocks.push({ x: 2, y: h - 1, z: Math.floor(length / 2), block: GLOWSTONE });
  return {
    name,
    size: [w + 1, h + 1, length],
    blocks,
    connectors: [
      { name: 'south', facing: Facing.POSITIVE_Z, at: [2, 1, length - 1], target: 'fortress' },
      { name: 'north', facing: Facing.NEGATIVE_Z, at: [2, 1, 0], target: 'fortress' },
    ],
  };
}

/** Open bridge with railings -- the fortress silhouette everyone recognises. */
function bridgePiece(name, length) {
  const blocks = [];
  const w = 4;
  box(blocks, 0, 0, 0, w, 0, length - 1, BRICK);
  for (let z = 0; z < length; z++) {
    blocks.push({ x: 0, y: 1, z, block: FENCE });
    blocks.push({ x: w, y: 1, z, block: FENCE });
  }
  box(blocks, 1, 1, 0, w - 1, 3, length - 1, AIR);
  return {
    name,
    size: [w + 1, 4, length],
    blocks,
    connectors: [
      { name: 'south', facing: Facing.POSITIVE_Z, at: [2, 1, length - 1], target: 'fortress' },
      { name: 'north', facing: Facing.NEGATIVE_Z, at: [2, 1, 0], target: 'fortress' },
    ],
  };
}

/** Four-way hub. Gives the layout its branching shape. */
function crossingPiece(name) {
  const blocks = [];
  const s = 6;
  box(blocks, 0, 0, 0, s, 0, s, BRICK);
  box(blocks, 0, 1, 0, s, 4, s, BRICK);
  box(blocks, 1, 1, 1, s - 1, 4, s - 1, AIR);
  blocks.push({ x: 3, y: 4, z: 3, block: GLOWSTONE });
  // Doorways on all four sides.
  box(blocks, 2, 1, 0, 4, 3, 0, AIR);
  box(blocks, 2, 1, s, 4, 3, s, AIR);
  box(blocks, 0, 1, 2, 0, 3, 4, AIR);
  box(blocks, s, 1, 2, s, 3, 4, AIR);
  return {
    name,
    size: [s + 1, 5 + 1, s + 1],
    blocks,
    connectors: [
      { name: 'south', facing: Facing.POSITIVE_Z, at: [3, 1, s], target: 'fortress' },
      { name: 'north', facing: Facing.NEGATIVE_Z, at: [3, 1, 0], target: 'fortress' },
      { name: 'east', facing: Facing.POSITIVE_X, at: [s, 1, 3], target: 'fortress' },
      { name: 'west', facing: Facing.NEGATIVE_X, at: [0, 1, 3], target: 'fortress' },
    ],
  };
}

/**
 * Blaze spawner room: a raised platform in a fence cage.
 *
 * The cage is what makes the room readable as dangerous before the first blaze
 * appears, and the marker is what the spawner logic keys on.
 */
function blazeRoomPiece(name) {
  const blocks = [];
  const s = 8;
  box(blocks, 0, 0, 0, s, 0, s, BRICK);
  box(blocks, 0, 1, 0, s, 6, s, BRICK);
  box(blocks, 1, 1, 1, s - 1, 6, s - 1, AIR);
  // Central pedestal.
  box(blocks, 3, 1, 3, 5, 1, 5, BRICK);
  blocks.push({ x: 4, y: 2, z: 4, block: MAGMA });
  // Fence cage around the pedestal.
  for (let d = 2; d <= 6; d++) {
    blocks.push({ x: d, y: 2, z: 2, block: FENCE });
    blocks.push({ x: d, y: 2, z: 6, block: FENCE });
    blocks.push({ x: 2, y: 2, z: d, block: FENCE });
    blocks.push({ x: 6, y: 2, z: d, block: FENCE });
  }
  box(blocks, 3, 2, 3, 5, 2, 5, AIR);
  blocks.push({ x: 4, y: 2, z: 4, block: MAGMA });
  blocks.push({ x: 1, y: 6, z: 1, block: GLOWSTONE });
  blocks.push({ x: s - 1, y: 6, z: s - 1, block: GLOWSTONE });
  // Entrances.
  box(blocks, 3, 1, 0, 5, 3, 0, AIR);
  box(blocks, 3, 1, s, 5, 3, s, AIR);
  return {
    name,
    size: [s + 1, 7 + 1, s + 1],
    blocks,
    markers: [
      { type: FortressMarker.BLAZE_SPAWNER, x: 4, y: 3, z: 4 },
      { type: FortressMarker.LOOT_CHEST, x: 1, y: 1, z: 7 },
    ],
    connectors: [
      { name: 'south', facing: Facing.POSITIVE_Z, at: [4, 1, s], target: 'fortress' },
      { name: 'north', facing: Facing.NEGATIVE_Z, at: [4, 1, 0], target: 'fortress' },
    ],
  };
}

/** Nether wart garden: soul sand beds, the brewing gate. */
function wartGardenPiece(name) {
  const blocks = [];
  const s = 8;
  box(blocks, 0, 0, 0, s, 0, s, BRICK);
  box(blocks, 0, 1, 0, s, 4, s, BRICK);
  box(blocks, 1, 1, 1, s - 1, 4, s - 1, AIR);
  // Two sunken beds of soul sand with wart planted on top.
  for (const bedZ of [2, 5]) {
    box(blocks, 2, 0, bedZ, 6, 0, bedZ + 1, SOUL_SAND);
    for (let x = 2; x <= 6; x++) {
      for (let z = bedZ; z <= bedZ + 1; z++) blocks.push({ x, y: 1, z, block: WART });
    }
  }
  blocks.push({ x: 4, y: 4, z: 4, block: GLOWSTONE });
  box(blocks, 3, 1, 0, 5, 3, 0, AIR);
  box(blocks, 3, 1, s, 5, 3, s, AIR);
  return {
    name,
    size: [s + 1, 5 + 1, s + 1],
    blocks,
    markers: [
      { type: FortressMarker.WART_FARM, x: 4, y: 1, z: 2 },
      { type: FortressMarker.LOOT_CHEST, x: 7, y: 1, z: 7 },
    ],
    connectors: [
      { name: 'south', facing: Facing.POSITIVE_Z, at: [4, 1, s], target: 'fortress' },
      { name: 'north', facing: Facing.NEGATIVE_Z, at: [4, 1, 0], target: 'fortress' },
    ],
  };
}

/** Dead end with a treasure chest, so exploration pays out. */
function treasureCapPiece(name) {
  const blocks = [];
  const w = 4;
  box(blocks, 0, 0, 0, w, 0, 3, BRICK);
  box(blocks, 0, 1, 0, w, 4, 3, BRICK);
  box(blocks, 1, 1, 1, w - 1, 3, 2, AIR);
  box(blocks, 2, 1, 0, 2, 3, 0, AIR);
  blocks.push({ x: 2, y: 1, z: 2, block: CHEST });
  blocks.push({ x: 1, y: 3, z: 1, block: GLOWSTONE });
  return {
    name,
    size: [w + 1, 5, 4],
    blocks,
    markers: [{ type: FortressMarker.LOOT_CHEST, x: 2, y: 1, z: 2 }],
    connectors: [
      { name: 'north', facing: Facing.NEGATIVE_Z, at: [2, 1, 0], target: 'fortress' },
    ],
  };
}

/** Stair flight, so a fortress is not confined to one Y level. */
function stairPiece(name) {
  const blocks = [];
  const w = 4;
  const length = 6;
  for (let z = 0; z < length; z++) {
    const y = z;
    box(blocks, 0, y, z, w, y, z, BRICK);
    box(blocks, 0, y + 1, z, 0, y + 4, z, BRICK);
    box(blocks, w, y + 1, z, w, y + 4, z, BRICK);
    box(blocks, 1, y + 1, z, w - 1, y + 4, z, AIR);
    blocks.push({ x: 2, y: y + 1, z, block: STAIRS });
  }
  return {
    name,
    size: [w + 1, length + 5, length],
    blocks,
    connectors: [
      { name: 'north', facing: Facing.NEGATIVE_Z, at: [2, 1, 0], target: 'fortress' },
      { name: 'south', facing: Facing.POSITIVE_Z, at: [2, length, length - 1], target: 'fortress' },
    ],
  };
}

/** Every fortress piece, keyed by name. */
export const FORTRESS_PIECES = Object.freeze({
  crossing: crossingPiece('crossing'),
  corridor: corridorPiece('corridor', 9),
  long_corridor: corridorPiece('long_corridor', 12),
  bridge: bridgePiece('bridge', 11),
  blaze_room: blazeRoomPiece('blaze_room'),
  wart_garden: wartGardenPiece('wart_garden'),
  treasure_cap: treasureCapPiece('treasure_cap'),
  stairs: stairPiece('stairs'),
});

/** Weighted pool. Corridors are common; special rooms are the payoff. */
export function fortressPools() {
  return new Map([
    ['fortress', new StructurePool('fortress', [
      { piece: FORTRESS_PIECES.corridor, weight: 6 },
      { piece: FORTRESS_PIECES.long_corridor, weight: 3 },
      { piece: FORTRESS_PIECES.bridge, weight: 4 },
      { piece: FORTRESS_PIECES.crossing, weight: 3 },
      { piece: FORTRESS_PIECES.blaze_room, weight: 3 },
      { piece: FORTRESS_PIECES.wart_garden, weight: 2 },
      { piece: FORTRESS_PIECES.stairs, weight: 2 },
      { piece: FORTRESS_PIECES.treasure_cap, weight: 2 },
    ])],
  ]);
}

/** Validates every piece. Returns a list of problems, empty when healthy. */
export function validateFortressPieces() {
  const problems = [];
  for (const piece of Object.values(FORTRESS_PIECES)) {
    problems.push(...validatePiece(piece));
  }
  return problems;
}

/**
 * Assembles one fortress.
 *
 * @param {Object} [options]
 * @param {number} [options.seed]
 * @param {number[]} [options.origin] World position of the start piece.
 * @param {number} [options.maxPieces]
 * @param {Object} [options.bounds] Optional hard bounds.
 * @returns {{placements:Array, cells:Array, markers:Array, rejected:number}}
 */
export function buildFortress({ seed = 1, origin = [0, 40, 0], maxPieces = 20, bounds = null } = {}) {
  const random = mulberry32(hash3(origin[0], origin[2], seed));
  const result = assembleStructure({
    start: FORTRESS_PIECES.crossing,
    origin,
    pools: fortressPools(),
    random,
    maxPieces,
    bounds,
  });

  const cells = flattenPlacements(result.placements);
  const markers = [];
  for (const placement of result.placements) {
    const sourceName = placement.source ?? placement.piece.name;
    const base = FORTRESS_PIECES[sourceName];
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
 * Deterministic fortress siting.
 *
 * One candidate per region, jittered inside it, and only ~55% of regions carry a
 * fortress -- so finding one is an event rather than a certainty.
 *
 * @returns {{x:number, y:number, z:number}|null}
 */
export function fortressOriginForRegion(regionX, regionZ, seed) {
  const h = hash3(regionX, regionZ, (seed ^ 0x0f07_2e55) >>> 0);
  if ((h & 0xff) / 255 > 0.55) return null;
  const span = FORTRESS_REGION_CHUNKS * 16;
  const jitterX = ((h >>> 8) & 0x7f) % (span - 80);
  const jitterZ = ((h >>> 16) & 0x7f) % (span - 80);
  const y = 40 + (((h >>> 24) & 0x0f) - 8);
  return {
    x: regionX * span + jitterX + 16,
    y,
    z: regionZ * span + jitterZ + 16,
  };
}

const FORTRESS_CACHE = new Map();

/** Builds (and memoises) the fortress owning a region, or null. */
export function fortressForRegion(regionX, regionZ, seed) {
  const key = `${regionX},${regionZ},${seed >>> 0}`;
  if (FORTRESS_CACHE.has(key)) return FORTRESS_CACHE.get(key);
  const origin = fortressOriginForRegion(regionX, regionZ, seed);
  const built = origin
    ? buildFortress({ seed, origin: [origin.x, origin.y, origin.z], maxPieces: 20 })
    : null;
  if (FORTRESS_CACHE.size > 64) FORTRESS_CACHE.clear();
  FORTRESS_CACHE.set(key, built);
  return built;
}

/** Clears the memo cache. Tests use this to prove determinism. */
export function clearFortressCache() {
  FORTRESS_CACHE.clear();
}

/**
 * Writes any fortress cells that land inside one chunk.
 *
 * Scans the 3x3 region neighbourhood so a fortress straddling a region edge is
 * never half-built, which is the same trick `StructureGenerator` uses.
 *
 * @returns {number} Cells written.
 */
export function paintFortressChunk(blocks, chunkX, chunkZ, seed, { maxY = 127 } = {}) {
  const originX = chunkX * 16;
  const originZ = chunkZ * 16;
  const span = FORTRESS_REGION_CHUNKS * 16;
  const baseRegionX = Math.floor(originX / span);
  const baseRegionZ = Math.floor(originZ / span);
  let written = 0;

  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const fortress = fortressForRegion(baseRegionX + dx, baseRegionZ + dz, seed);
      if (!fortress) continue;
      for (const cell of fortress.cells) {
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

/** Fortress markers near a world position, for spawner and loot wiring. */
export function fortressMarkersNear(x, z, seed, { radius = 96, type = null } = {}) {
  const span = FORTRESS_REGION_CHUNKS * 16;
  const baseRegionX = Math.floor(x / span);
  const baseRegionZ = Math.floor(z / span);
  const found = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const fortress = fortressForRegion(baseRegionX + dx, baseRegionZ + dz, seed);
      if (!fortress) continue;
      for (const marker of fortress.markers) {
        if (type && marker.type !== type) continue;
        const dxx = marker.x - x;
        const dzz = marker.z - z;
        if ((dxx * dxx) + (dzz * dzz) <= radius * radius) found.push(marker);
      }
    }
  }
  return found;
}

export default buildFortress;
