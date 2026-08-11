/**
 * Phase 5: The End terrain generator.
 *
 * Implements exactly the interface `DimensionGenerators.createGenerator`
 * promises -- `generateChunk`, `getSurfaceHeight`, `sampleColumn`, `findSpawn` --
 * so `World.switchDimension` needs no special case for the End.
 *
 * ## Why the End is mostly nothing
 *
 * The Overworld and the Nether are continuous: every column has ground. The End
 * is the opposite, and that inverts the generator. Instead of asking "how high is
 * the terrain here", this module asks "is there any terrain here at all", and the
 * answer is no for the overwhelming majority of columns. A chunk that generates
 * completely empty is the normal case, not a bug.
 *
 * ## The three regions
 *
 *  - The **central island**: a single disc around the origin, home of the
 *    obsidian pillars and the dragon fight. Fixed position, because the whole
 *    progression depends on the player arriving somewhere specific.
 *  - The **void ring**: deliberately empty. It exists so the outer islands can
 *    only be reached by throwing an ender pearl or bridging, which is the
 *    difficulty gate on End cities.
 *  - The **outer islands**: noise-driven floating shards carrying chorus plants.
 *
 * Worker-safe: no DOM, no Three.js.
 */

import { CHUNK_VOLUME, WORLD_HEIGHT } from '../config/GameConfig.js';
import { voxelIndex } from '../utils/CoordinateUtils.js';
import { Block } from './BlockTypes.js';
import { NoiseSet } from './Noise.js';
import { Dimension, buildCeiling, getDimension } from './DimensionConfig.js';
import { paintEndCities } from './EndCity.js';

/**
 * The End's biome id.
 *
 * The Overworld table ends at 44 and the Nether occupies 45..49, so the End
 * starts at 50. It is a single biome on purpose: End highlands/midlands/barrens
 * differ only in which structures they carry, and no structure in this build
 * needs the distinction yet.
 */
export const END_BIOME_ID = 50;

/** Y of the central island's surface. Fixed, not noise-driven. */
export const END_ISLAND_SURFACE_Y = 64;

/** Radius of the central island in blocks. */
export const END_ISLAND_RADIUS = 66;

/** Inside this radius the outer islands never generate. */
export const END_VOID_RADIUS = 320;

/** Number of obsidian pillars ringing the central island. */
export const END_PILLAR_COUNT = 10;

/** Head room `findSpawn` requires above a floor. */
const STANDING_CLEARANCE = 2;

/** Where the player materialises when arriving from the Overworld. */
export const END_ARRIVAL_PLATFORM = Object.freeze({ x: 100, y: 49, z: 0 });

/**
 * The obsidian pillars, in world coordinates.
 *
 * Deterministic and seed-independent: every world's End has the same ten pillars
 * in the same ring. That is a design choice rather than laziness -- the dragon
 * fight is the game's final exam, and it should be the same exam for everyone.
 *
 * @returns {ReadonlyArray<{index:number, x:number, z:number, height:number, radius:number, caged:boolean}>}
 */
export function endPillars() {
  const pillars = [];
  for (let i = 0; i < END_PILLAR_COUNT; i++) {
    const angle = (i / END_PILLAR_COUNT) * Math.PI * 2;
    // Alternating tall/short pillars, matching the vanilla silhouette.
    const tall = i % 2 === 0;
    pillars.push(Object.freeze({
      index: i,
      x: Math.round(Math.cos(angle) * 43),
      z: Math.round(Math.sin(angle) * 43),
      height: tall ? 30 : 22,
      radius: tall ? 3 : 2,
      // The taller pillars carry an iron cage around their crystal.
      caged: tall,
    }));
  }
  return Object.freeze(pillars);
}

const PILLARS = endPillars();

/** The end crystal positions, one per pillar. */
export function endCrystalPositions() {
  return PILLARS.map((pillar) => Object.freeze({
    pillar: pillar.index,
    x: pillar.x,
    y: END_ISLAND_SURFACE_Y + pillar.height + 1,
    z: pillar.z,
  }));
}

/** A fresh column sample object. */
export function createEndColumnSample() {
  return {
    height: 0,
    biome: END_BIOME_ID,
    definition: null,
    temperature: 0.5,
    moisture: 0.5,
    surface: Block.END_STONE,
    subsurface: Block.END_STONE,
    subsurfaceDepth: 4,
  };
}

export class EndGenerator {
  /**
   * @param {number} seed Already salted by `dimensionSeed`.
   */
  constructor(seed) {
    this.seed = seed >>> 0;
    this.dimension = getDimension(Dimension.END);
    /** The End has no sea. Kept for interface parity with the other generators. */
    this.seaLevel = null;
    this.ceilingY = buildCeiling(this.dimension);

    this.noise = new NoiseSet(this.seed, ['island', 'detail', 'outer', 'chorus']);

    this._column = createEndColumnSample();
    this._indexOf = voxelIndex;
  }

  /**
   * Generates one End chunk.
   *
   * @param {number} chunkX
   * @param {number} chunkZ
   * @param {Uint16Array|null} target Optional buffer to fill instead of allocating.
   * @returns {{blocks: Uint16Array, heightMap: Int16Array, biomeMap: Int16Array, nonAirCount: number, maxY: number}}
   */
  generateChunk(chunkX, chunkZ, target = null) {
    const blocks = target && target.length === CHUNK_VOLUME
      ? target
      : new Uint16Array(CHUNK_VOLUME);
    if (target) blocks.fill(0);

    const heightMap = new Int16Array(256);
    const biomeMap = new Int16Array(256);
    biomeMap.fill(END_BIOME_ID);

    const originX = chunkX * 16;
    const originZ = chunkZ * 16;

    for (let localZ = 0; localZ < 16; localZ++) {
      for (let localX = 0; localX < 16; localX++) {
        const worldX = originX + localX;
        const worldZ = originZ + localZ;
        const span = this._columnSpan(worldX, worldZ);
        if (!span) {
          // The void: no blocks at all, and a height of 0 so the surface probe
          // reports "nothing here" rather than "ground at y=0".
          heightMap[localX + (localZ * 16)] = 0;
          continue;
        }

        for (let y = span.bottom; y <= span.top; y++) {
          blocks[voxelIndex(localX, y, localZ)] = Block.END_STONE;
        }
        heightMap[localX + (localZ * 16)] = span.top;
      }
    }

    this._placePillars(blocks, chunkX, chunkZ);
    this._placeFountain(blocks, chunkX, chunkZ);
    this._placeArrivalPlatform(blocks, chunkX, chunkZ);
    this._placeChorus(blocks, chunkX, chunkZ, heightMap);
    paintEndCities(blocks, chunkX, chunkZ, this.seed, voxelIndex);

    let nonAirCount = 0;
    let maxY = -1;
    for (let i = CHUNK_VOLUME - 1; i >= 0; i--) {
      if (blocks[i] !== Block.AIR) {
        nonAirCount++;
        if (maxY < 0) maxY = i >> 8;
      }
    }

    return { blocks, heightMap, biomeMap, nonAirCount, maxY };
  }

  /** Best standing height in a world column, or 0 when the column is void. */
  getSurfaceHeight(worldX, worldZ) {
    const span = this._columnSpan(worldX, worldZ);
    if (!span) return 0;
    const pillar = this._pillarTopAt(worldX, worldZ);
    return Math.max(span.top, pillar);
  }

  /**
   * Fills `out` with the material sample for a column.
   * @param {number} worldX
   * @param {number} worldZ
   * @param {Object} [out]
   */
  sampleColumn(worldX, worldZ, out = this._column) {
    out.temperature = 0.5;
    out.moisture = 0.5;
    out.definition = null;
    out.biome = END_BIOME_ID;
    out.surface = Block.END_STONE;
    out.subsurface = Block.END_STONE;
    out.subsurfaceDepth = 4;
    out.height = this.getSurfaceHeight(worldX, worldZ);
    return out;
  }

  /**
   * Finds a safe arrival spot.
   *
   * Unlike the other dimensions this cannot fall back to "the highest column
   * found", because most columns are void and a fallback would drop the player
   * into the abyss. The obsidian arrival platform is the guaranteed answer.
   *
   * @returns {{x: number, y: number, z: number}} Feet position.
   */
  findSpawn(preferredX = END_ARRIVAL_PLATFORM.x, preferredZ = END_ARRIVAL_PLATFORM.z, maxRadius = 96) {
    for (let i = 0; i < 600; i++) {
      const angle = i * 2.399963;
      const radius = maxRadius * Math.sqrt(i / 600);
      const worldX = Math.round(preferredX + (Math.cos(angle) * radius));
      const worldZ = Math.round(preferredZ + (Math.sin(angle) * radius));
      const y = this.getSurfaceHeight(worldX, worldZ);
      if (y > 0 && y < this.ceilingY - STANDING_CLEARANCE - 1) {
        return { x: worldX + 0.5, y: y + 1, z: worldZ + 0.5 };
      }
    }

    // The platform is generated unconditionally, so this is always solid ground.
    return {
      x: END_ARRIVAL_PLATFORM.x + 0.5,
      y: END_ARRIVAL_PLATFORM.y + 1,
      z: END_ARRIVAL_PLATFORM.z + 0.5,
    };
  }

  // ------------------------------------------------------------------- shaping

  /**
   * The solid span of a column, or null when the column is void.
   *
   * @returns {{top:number, bottom:number}|null}
   */
  _columnSpan(worldX, worldZ) {
    const distance = Math.sqrt((worldX * worldX) + (worldZ * worldZ));

    if (distance < END_ISLAND_RADIUS) {
      // Central island: a disc that thins towards a ragged edge.
      const falloff = 1 - (distance / END_ISLAND_RADIUS);
      const wobble = this.noise.get('island').fbm2(worldX * 0.021, worldZ * 0.021, 3, 1, 2, 0.5);
      // The edge is eroded by noise, so the island is not a perfect circle.
      const edge = falloff + (wobble * 0.14);
      if (edge <= 0.02) return null;
      const top = END_ISLAND_SURFACE_Y + Math.round(wobble * 2.5 * Math.min(1, falloff * 3));
      const thickness = 6 + Math.round(26 * Math.min(1, edge * 1.6));
      return { top, bottom: Math.max(1, top - thickness) };
    }

    if (distance < END_VOID_RADIUS) return null;

    // Outer islands: sparse floating shards.
    const field = this.noise.get('outer').fbm2(worldX * 0.0075, worldZ * 0.0075, 4, 1, 2, 0.5);
    // Thresholds here are tuned against the measured range of this field
    // (-0.51..0.60, p97 = 0.30). A gate of 0.24 keeps roughly the top 8% of
    // columns solid, which reads as an archipelago rather than a continent.
    if (field < 0.24) return null;
    const strength = Math.min(1, (field - 0.24) / 0.3);
    const detail = this.noise.get('detail').noise2(worldX * 0.045, worldZ * 0.045);
    const top = 70 + Math.round((strength * 16) + (detail * 2));
    const thickness = 4 + Math.round(strength * 14);
    return { top, bottom: Math.max(1, top - thickness) };
  }

  /** The top Y of any pillar covering this column, or 0. */
  _pillarTopAt(worldX, worldZ) {
    for (const pillar of PILLARS) {
      const dx = worldX - pillar.x;
      const dz = worldZ - pillar.z;
      if (Math.abs(dx) > pillar.radius || Math.abs(dz) > pillar.radius) continue;
      if ((dx * dx) + (dz * dz) > (pillar.radius + 0.5) * (pillar.radius + 0.5)) continue;
      return END_ISLAND_SURFACE_Y + pillar.height;
    }
    return 0;
  }

  /** Writes the obsidian pillars, their bedrock caps and their iron cages. */
  _placePillars(blocks, chunkX, chunkZ) {
    const originX = chunkX * 16;
    const originZ = chunkZ * 16;

    for (const pillar of PILLARS) {
      // Cheap reject: the pillar cannot touch this chunk.
      if (pillar.x + pillar.radius < originX || pillar.x - pillar.radius > originX + 15) continue;
      if (pillar.z + pillar.radius < originZ || pillar.z - pillar.radius > originZ + 15) continue;

      const topY = END_ISLAND_SURFACE_Y + pillar.height;
      for (let dz = -pillar.radius; dz <= pillar.radius; dz++) {
        for (let dx = -pillar.radius; dx <= pillar.radius; dx++) {
          if ((dx * dx) + (dz * dz) > (pillar.radius + 0.5) * (pillar.radius + 0.5)) continue;
          const localX = pillar.x + dx - originX;
          const localZ = pillar.z + dz - originZ;
          if (localX < 0 || localX > 15 || localZ < 0 || localZ > 15) continue;

          // Start below the surface so a pillar never floats over eroded ground.
          for (let y = END_ISLAND_SURFACE_Y - 4; y <= topY; y++) {
            if (y < 1 || y >= WORLD_HEIGHT) continue;
            blocks[voxelIndex(localX, y, localZ)] = Block.OBSIDIAN;
          }
          // Bedrock cap: the crystal's plinth, and unmineable so the player
          // cannot dismantle the pillar instead of fighting.
          if (dx === 0 && dz === 0 && topY + 1 < WORLD_HEIGHT) {
            blocks[voxelIndex(localX, topY + 1, localZ)] = Block.BEDROCK;
          }
        }
      }

      if (pillar.caged) {
        const cageY = topY + 2;
        for (let dy = 0; dy <= 3; dy++) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
          const boundary = Math.abs(dx) === 2 || Math.abs(dz) === 2 || dy === 3;
          if (!boundary) continue;
          const localX = pillar.x + dx - originX;
          const localZ = pillar.z + dz - originZ;
          const y = cageY + dy;
          if (localX < 0 || localX > 15 || localZ < 0 || localZ > 15 || y >= WORLD_HEIGHT) continue;
          blocks[voxelIndex(localX, y, localZ)] = Block.IRON_BARS;
        }
      }
    }
  }

  /**
   * The bedrock fountain at the origin.
   *
   * The exit portal blocks are deliberately *not* written here: the portal opens
   * when the dragon dies, and generating it at world-gen time would let a player
   * walk straight past the fight and finish the game.
   */
  _placeFountain(blocks, chunkX, chunkZ) {
    const originX = chunkX * 16;
    const originZ = chunkZ * 16;
    if (originX > 4 || originX + 15 < -4) return;
    if (originZ > 4 || originZ + 15 < -4) return;

    for (let dz = -4; dz <= 4; dz++) {
      for (let dx = -4; dx <= 4; dx++) {
        if (Math.abs(dx) + Math.abs(dz) > 5) continue;
        const localX = dx - originX;
        const localZ = dz - originZ;
        if (localX < 0 || localX > 15 || localZ < 0 || localZ > 15) continue;
        blocks[voxelIndex(localX, END_ISLAND_SURFACE_Y + 1, localZ)] = Block.BEDROCK;
      }
    }
  }

  /** The 5x5 obsidian platform every arrival lands on. */
  _placeArrivalPlatform(blocks, chunkX, chunkZ) {
    const originX = chunkX * 16;
    const originZ = chunkZ * 16;
    const { x: px, y: py, z: pz } = END_ARRIVAL_PLATFORM;
    if (px + 2 < originX || px - 2 > originX + 15) return;
    if (pz + 2 < originZ || pz - 2 > originZ + 15) return;

    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const localX = px + dx - originX;
        const localZ = pz + dz - originZ;
        if (localX < 0 || localX > 15 || localZ < 0 || localZ > 15) continue;
        blocks[voxelIndex(localX, py, localZ)] = Block.OBSIDIAN;
        // Clear the head room above, in case an outer island overlaps.
        for (let y = py + 1; y <= py + 3 && y < WORLD_HEIGHT; y++) {
          blocks[voxelIndex(localX, y, localZ)] = Block.AIR;
        }
      }
    }
  }

  /** Chorus growth on the outer islands. */
  _placeChorus(blocks, chunkX, chunkZ, heightMap) {
    const originX = chunkX * 16;
    const originZ = chunkZ * 16;
    // Chorus only grows out past the void ring.
    if (Math.sqrt((originX * originX) + (originZ * originZ)) < END_VOID_RADIUS) return;

    const field = this.noise.get('chorus');
    for (let localZ = 0; localZ < 16; localZ++) {
      for (let localX = 0; localX < 16; localX++) {
        const top = heightMap[localX + (localZ * 16)];
        if (top <= 0) continue;
        const worldX = originX + localX;
        const worldZ = originZ + localZ;
        const roll = field.noise2(worldX * 0.63, worldZ * 0.63);
        if (roll < 0.42) continue;

        const height = 2 + Math.round((roll - 0.42) * 12);
        for (let i = 1; i <= height; i++) {
          const y = top + i;
          if (y >= WORLD_HEIGHT) break;
          blocks[voxelIndex(localX, y, localZ)] = i === height
            ? Block.CHORUS_FLOWER
            : Block.CHORUS_PLANT;
        }
      }
    }
  }
}

export default EndGenerator;
