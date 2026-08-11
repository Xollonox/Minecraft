/**
 * Stronghold generation: the Overworld's buried entrance to the End.
 *
 * The third client of the jigsaw engine in `StructureTemplate.js`, written
 * against the same seams as `NetherFortress.js` and `BastionRemnant.js`.
 *
 * ## Why the portal room is the START piece
 *
 * A stronghold must contain exactly one End portal. Putting the portal room in
 * the weighted pool would give a random count -- some strongholds with three
 * portals, some with none -- so it is the start piece instead. The jigsaw then
 * grows corridors outward from it, which also matches how the structure reads in
 * play: you tunnel through corridors and arrive at the room.
 *
 * ## Why the portal itself is not generated
 *
 * Only the twelve frames are written. `END_PORTAL` blocks appear when all twelve
 * frames hold an Eye of Ender, which is what makes the eye a real progression
 * gate rather than a decoration.
 *
 * ## Palette note
 *
 * This build has no stone-brick family, so the masonry is cobblestone with mossy
 * cobblestone for the walls. That reads correctly as ancient underground
 * stonework and needs no new blocks.
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

const WALL = Block.MOSSY_COBBLESTONE;
const FLOOR = Block.COBBLESTONE;
const FRAME = Block.END_PORTAL_FRAME;
const TORCH = Block.TORCH;
const LADDER = Block.LADDER;
const CHEST = Block.CHEST;
const LAVA = Block.LAVA;
const AIR = Block.AIR;
const INFESTED = Block.INFESTED_MOSSY_COBBLESTONE;

/** Marker kinds a stronghold piece can publish. */
export const StrongholdMarker = Object.freeze({
  PORTAL_ROOM: 'portal_room',
  LIBRARY_CHEST: 'library_chest',
  CORRIDOR_CHEST: 'corridor_chest',
});

/**
 * How many chunks across one stronghold siting region is.
 *
 * Much larger than the fortress (24) or bastion (32) regions: a stronghold is
 * the rarest structure in the game because finding it is meant to be the reason
 * eyes of ender exist.
 */
export const STRONGHOLD_REGION_CHUNKS = 48;

/**
 * The twelve frame offsets around the 3x3 portal, relative to the ring centre.
 *
 * Exported because the runtime needs the same list to decide whether every frame
 * holds an eye, and two copies of this would be a bug waiting to happen.
 */
export const PORTAL_FRAME_OFFSETS = Object.freeze([
  [-1, -2], [0, -2], [1, -2],
  [-1, 2], [0, 2], [1, 2],
  [-2, -1], [-2, 0], [-2, 1],
  [2, -1], [2, 0], [2, 1],
]);

/** Deterministic 32-bit hash of two integers plus a seed. */
function hash3(x, y, seed) {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = (Math.imul(h ^ (x | 0), 0x85ebca6b) >>> 0) ^ 0x165667b1;
  h = (Math.imul(h ^ (y | 0), 0xc2b2ae35) >>> 0) ^ 0x27d4eb2f;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491) >>> 0;
  return (h ^ (h >>> 13)) >>> 0;
}

/** Small deterministic PRNG. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fills an inclusive box with one block. */
function box(blocks, x0, y0, z0, x1, y1, z1, block) {
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        blocks.push({ x, y, z, block });
      }
    }
  }
}

/** Hollow shell: walls, floor and ceiling, then an air interior. */
function shell(blocks, w, h, d, { ceiling = true } = {}) {
  box(blocks, 0, 0, 0, w - 1, 0, d - 1, FLOOR);
  if (ceiling) box(blocks, 0, h - 1, 0, w - 1, h - 1, d - 1, FLOOR);
  box(blocks, 0, 1, 0, w - 1, h - 2, 0, WALL);
  box(blocks, 0, 1, d - 1, w - 1, h - 2, d - 1, WALL);
  box(blocks, 0, 1, 0, 0, h - 2, d - 1, WALL);
  box(blocks, w - 1, 1, 0, w - 1, h - 2, d - 1, WALL);
  box(blocks, 1, 1, 1, w - 2, h - 2, d - 2, AIR);
}

/** The End portal room. Exactly one per stronghold, because it is the start. */
function portalRoomPiece(name) {
  const blocks = [];
  const w = 11;
  const h = 9;
  const d = 11;
  shell(blocks, w, h, d);

  // A lava trough under the portal platform: the room's only light source, and
  // the reason falling off the platform matters.
  box(blocks, 3, 0, 3, 7, 0, 7, LAVA);
  // The platform itself sits one block above the lava.
  box(blocks, 3, 1, 3, 7, 1, 7, FLOOR);

  // Twelve frames in a ring, centred on the platform.
  for (const [dx, dz] of PORTAL_FRAME_OFFSETS) {
    blocks.push({ x: 5 + dx, y: 2, z: 5 + dz, block: FRAME });
  }

  // The staircase landing contains the silverfish spawner required by the End
  // progression. A few infested stones around it make the encounter discoverable.
  blocks.push({ x: 5, y: 2, z: 1, block: Block.SILVERFISH_SPAWNER });
  blocks.push({ x: 4, y: 1, z: 1, block: INFESTED });
  blocks.push({ x: 6, y: 1, z: 1, block: INFESTED });

  // Corner torches, so the room is readable before the portal is lit.
  for (const [x, z] of [[1, 1], [w - 2, 1], [1, d - 2], [w - 2, d - 2]]) {
    blocks.push({ x, y: 3, z, block: TORCH });
  }

  // Doorway out, carved after the walls so nothing overwrites it.
  blocks.push({ x: 5, y: 1, z: 0, block: AIR });
  blocks.push({ x: 5, y: 2, z: 0, block: AIR });

  return {
    name,
    size: [w, h, d],
    blocks,
    markers: [{ type: StrongholdMarker.PORTAL_ROOM, x: 5, y: 2, z: 5 }],
    connectors: [
      { name: 'exit', facing: Facing.NEGATIVE_Z, at: [5, 1, 0], target: 'stronghold' },
    ],
  };
}

/** A straight corridor. */
function corridorPiece(name, length) {
  const blocks = [];
  shell(blocks, 5, 5, length);
  // Torches every four blocks along one wall.
  for (let z = 2; z < length - 1; z += 4) {
    blocks.push({ x: 1, y: 3, z, block: TORCH });
  }
  blocks.push({ x: 2, y: 1, z: 0, block: AIR });
  blocks.push({ x: 2, y: 2, z: 0, block: AIR });
  blocks.push({ x: 2, y: 1, z: length - 1, block: AIR });
  blocks.push({ x: 2, y: 2, z: length - 1, block: AIR });
  return {
    name,
    size: [5, 5, length],
    blocks,
    markers: [],
    connectors: [
      { name: 'in', facing: Facing.NEGATIVE_Z, at: [2, 1, 0], target: 'stronghold' },
      { name: 'out', facing: Facing.POSITIVE_Z, at: [2, 1, length - 1], target: 'stronghold' },
    ],
  };
}

/** A storeroom corridor with a chest. */
function storeroomPiece(name) {
  const blocks = [];
  shell(blocks, 5, 5, 7);
  blocks.push({ x: 1, y: 1, z: 5, block: CHEST });
  blocks.push({ x: 3, y: 1, z: 5, block: CHEST });
  blocks.push({ x: 2, y: 3, z: 3, block: TORCH });
  blocks.push({ x: 2, y: 1, z: 0, block: AIR });
  blocks.push({ x: 2, y: 2, z: 0, block: AIR });
  return {
    name,
    size: [5, 5, 7],
    blocks,
    markers: [
      { type: StrongholdMarker.CORRIDOR_CHEST, x: 1, y: 1, z: 5 },
      { type: StrongholdMarker.CORRIDOR_CHEST, x: 3, y: 1, z: 5 },
    ],
    connectors: [
      { name: 'in', facing: Facing.NEGATIVE_Z, at: [2, 1, 0], target: 'stronghold' },
    ],
  };
}

/** A four-way crossing: how the maze branches. */
function crossingPiece(name) {
  const blocks = [];
  shell(blocks, 7, 6, 7);
  blocks.push({ x: 3, y: 4, z: 3, block: TORCH });
  for (const [x, z] of [[3, 0], [3, 6]]) {
    blocks.push({ x, y: 1, z, block: AIR });
    blocks.push({ x, y: 2, z, block: AIR });
  }
  for (const [x, z] of [[0, 3], [6, 3]]) {
    blocks.push({ x, y: 1, z, block: AIR });
    blocks.push({ x, y: 2, z, block: AIR });
  }
  return {
    name,
    size: [7, 6, 7],
    blocks,
    markers: [],
    connectors: [
      { name: 'north', facing: Facing.NEGATIVE_Z, at: [3, 1, 0], target: 'stronghold' },
      { name: 'south', facing: Facing.POSITIVE_Z, at: [3, 1, 6], target: 'stronghold' },
      { name: 'west', facing: Facing.NEGATIVE_X, at: [0, 1, 3], target: 'stronghold' },
      { name: 'east', facing: Facing.POSITIVE_X, at: [6, 1, 3], target: 'stronghold' },
    ],
  };
}

/** The library: the stronghold's reward room. */
function libraryPiece(name) {
  const blocks = [];
  const w = 9;
  const d = 9;
  shell(blocks, w, 8, d);
  // Freestanding pillars, which is what makes a library read as a library at
  // voxel scale without a bookshelf block.
  for (const [x, z] of [[2, 2], [6, 2], [2, 6], [6, 6]]) {
    box(blocks, x, 1, z, x, 5, z, WALL);
  }
  // A ladder up to the balcony level.
  box(blocks, 1, 1, 4, 1, 5, 4, LADDER);
  blocks.push({ x: 4, y: 1, z: 4, block: CHEST });
  blocks.push({ x: 4, y: 5, z: 6, block: CHEST });
  blocks.push({ x: 4, y: 6, z: 4, block: TORCH });
  blocks.push({ x: 4, y: 1, z: 0, block: AIR });
  blocks.push({ x: 4, y: 2, z: 0, block: AIR });
  return {
    name,
    size: [w, 8, d],
    blocks,
    markers: [
      { type: StrongholdMarker.LIBRARY_CHEST, x: 4, y: 1, z: 4 },
      { type: StrongholdMarker.LIBRARY_CHEST, x: 4, y: 5, z: 6 },
    ],
    connectors: [
      { name: 'in', facing: Facing.NEGATIVE_Z, at: [4, 1, 0], target: 'stronghold' },
    ],
  };
}

/** A staircase, so a stronghold occupies more than one Y band. */
function stairPiece(name) {
  const blocks = [];
  const length = 6;
  shell(blocks, 5, 8, length);
  for (let i = 0; i < 5; i++) {
    box(blocks, 1, 1 + i, 1 + i, 3, 1 + i, 1 + i, FLOOR);
  }
  blocks.push({ x: 2, y: 1, z: 0, block: AIR });
  blocks.push({ x: 2, y: 2, z: 0, block: AIR });
  blocks.push({ x: 2, y: 6, z: length - 1, block: AIR });
  blocks.push({ x: 2, y: 7, z: length - 1, block: AIR });
  return {
    name,
    size: [5, 8, length],
    blocks,
    markers: [],
    connectors: [
      { name: 'bottom', facing: Facing.NEGATIVE_Z, at: [2, 1, 0], target: 'stronghold' },
      { name: 'top', facing: Facing.POSITIVE_Z, at: [2, 6, length - 1], target: 'stronghold' },
    ],
  };
}

/** Every stronghold piece, by name. */
export const STRONGHOLD_PIECES = Object.freeze({
  portal_room: portalRoomPiece('portal_room'),
  corridor: corridorPiece('corridor', 7),
  long_corridor: corridorPiece('long_corridor', 11),
  storeroom: storeroomPiece('storeroom'),
  crossing: crossingPiece('crossing'),
  library: libraryPiece('library'),
  stairs: stairPiece('stairs'),
});

/** The weighted pool the jigsaw draws from. */
export function strongholdPools() {
  return new Map([
    ['stronghold', new StructurePool('stronghold', [
      { piece: STRONGHOLD_PIECES.corridor, weight: 6 },
      { piece: STRONGHOLD_PIECES.long_corridor, weight: 4 },
      { piece: STRONGHOLD_PIECES.crossing, weight: 4 },
      { piece: STRONGHOLD_PIECES.stairs, weight: 3 },
      { piece: STRONGHOLD_PIECES.storeroom, weight: 2 },
      { piece: STRONGHOLD_PIECES.library, weight: 2 },
    ])],
  ]);
}

/** Validates every piece. Returns a list of problems, empty when healthy. */
export function validateStrongholdPieces() {
  const problems = [];
  for (const [name, piece] of Object.entries(STRONGHOLD_PIECES)) {
    try {
      validatePiece(piece);
    } catch (error) {
      problems.push(`${name}: ${error.message}`);
    }
  }
  return problems;
}

/** Assembles one stronghold layout. */
export function buildStronghold({ seed = 1, origin = [0, 20, 0], maxPieces = 18, bounds = null } = {}) {
  const random = mulberry32(hash3(origin[0], origin[2], (seed ^ 0x57a0_9b1d) >>> 0));
  const result = assembleStructure({
    start: STRONGHOLD_PIECES.portal_room,
    origin,
    pools: strongholdPools(),
    random,
    maxPieces,
    bounds,
  });

  const cells = flattenPlacements(result.placements);
  const markers = [];
  for (const placement of result.placements) {
    const sourceName = placement.source ?? placement.piece.name;
    const base = STRONGHOLD_PIECES[sourceName];
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
 * Where the stronghold in one region sits, or null when that region has none.
 *
 * Buried deep: y 14..30 keeps the structure under the surface everywhere except
 * the deepest ravines, so it has to be tunnelled to.
 */
export function strongholdOriginForRegion(regionX, regionZ, seed) {
  const h = hash3(regionX, regionZ, ((seed >>> 0) ^ 0x2b19_0f5c) >>> 0);
  if ((h & 0xff) / 255 > 0.6) return null;
  const span = STRONGHOLD_REGION_CHUNKS * 16;
  const jitterX = ((h >>> 8) & 0x1ff) % (span - 160);
  const jitterZ = ((h >>> 17) & 0x1ff) % (span - 160);
  const y = 14 + (((h >>> 26) & 0x0f) % 17);
  return {
    x: regionX * span + jitterX + 64,
    y,
    z: regionZ * span + jitterZ + 64,
  };
}

const STRONGHOLD_CACHE = new Map();

/** The assembled stronghold for a region, memoised. */
export function strongholdForRegion(regionX, regionZ, seed) {
  const key = `${regionX}|${regionZ}|${seed >>> 0}`;
  if (STRONGHOLD_CACHE.has(key)) return STRONGHOLD_CACHE.get(key);
  const origin = strongholdOriginForRegion(regionX, regionZ, seed);
  const built = origin
    ? buildStronghold({ seed, origin: [origin.x, origin.y, origin.z] })
    : null;
  STRONGHOLD_CACHE.set(key, built);
  return built;
}

/** Clears the memo. Called when a world is unloaded. */
export function clearStrongholdCache() {
  STRONGHOLD_CACHE.clear();
}

/** Writes any stronghold cells that fall inside one chunk. */
export function paintStrongholdChunk(blocks, chunkX, chunkZ, seed, { maxY = 127 } = {}) {
  const originX = chunkX * 16;
  const originZ = chunkZ * 16;
  const span = STRONGHOLD_REGION_CHUNKS * 16;
  const baseRegionX = Math.floor(originX / span);
  const baseRegionZ = Math.floor(originZ / span);
  let written = 0;

  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const hold = strongholdForRegion(baseRegionX + dx, baseRegionZ + dz, seed);
      if (!hold) continue;
      for (const cell of hold.cells) {
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

/** Stronghold markers near a world position. */
export function strongholdMarkersNear(x, z, seed, { radius = 160, type = null } = {}) {
  const span = STRONGHOLD_REGION_CHUNKS * 16;
  const baseRegionX = Math.floor(x / span);
  const baseRegionZ = Math.floor(z / span);
  const found = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const hold = strongholdForRegion(baseRegionX + dx, baseRegionZ + dz, seed);
      if (!hold) continue;
      for (const marker of hold.markers) {
        if (type && marker.type !== type) continue;
        const distX = marker.x - x;
        const distZ = marker.z - z;
        if ((distX * distX) + (distZ * distZ) <= radius * radius) found.push(marker);
      }
    }
  }
  return found;
}

/**
 * The nearest portal room to a world position, or null.
 *
 * This is what an Eye of Ender throw resolves against, so it searches a wide
 * radius: one region span, which is guaranteed to cover at least one candidate
 * region in every direction.
 */
export function nearestPortalRoom(x, z, seed) {
  const rooms = strongholdMarkersNear(x, z, seed, {
    radius: STRONGHOLD_REGION_CHUNKS * 16,
    type: StrongholdMarker.PORTAL_ROOM,
  });
  let best = null;
  let bestDistance = Infinity;
  for (const room of rooms) {
    const distX = room.x - x;
    const distZ = room.z - z;
    const distance = (distX * distX) + (distZ * distZ);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = room;
    }
  }
  return best;
}

export default buildStronghold;
