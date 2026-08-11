/**
 * Chunk generation pipeline.
 *
 * Stages, in order, and why the order matters:
 *
 *  1. **Shape** — fill the solid column from the blended biome height: bedrock,
 *     stone, a subsurface layer, then the biome's surface block.
 *  2. **Caves** — carve. Runs before water so a passage cannot swallow a lake,
 *     and the carver refuses to touch liquids anyway.
 *  3. **Water** — flood from the terrain surface up to sea level, but only in
 *     columns whose surface is genuinely below sea level. Because the fill is
 *     driven by the column height rather than by "any air below y=56", caves
 *     under the ocean stay dry instead of the sea draining into them.
 *  4. **Ice** — freeze the top water block in cold columns.
 *  5. **Ores** — replace stone only, so a vein clipped by a cave just loses
 *     blocks instead of floating.
 *  6. **Structures and cover** — trees (replayed across the 3x3 chunk
 *     neighbourhood so nothing is half-built), boulders, ruins, plants, snow.
 *
 * Every stage is a pure function of `(seed, worldX, worldZ)`, so the same seed
 * rebuilds an identical world and two workers generating adjacent chunks agree
 * exactly on their shared border.
 *
 * Worker-safe: no DOM, no Three.js.
 */

import {
  BEDROCK_HEIGHT,
  CHUNK_VOLUME,
  SEA_LEVEL,
  WORLD_HEIGHT,
} from '../config/GameConfig.js';
import { randomFromCoords3 } from '../utils/MathUtils.js';
import { voxelIndex } from '../utils/CoordinateUtils.js';
import { Block } from './BlockTypes.js';
import { BiomeGenerator, Biome, createColumnSample } from './BiomeGenerator.js';
import { CaveGenerator } from './CaveGenerator.js';
import { OreGenerator } from './OreGenerator.js';
import { StructureGenerator } from './StructureGenerator.js';
import { paintStrongholdChunk } from './Stronghold.js';

/** Temperature below which surface water freezes. */
const FREEZING_TEMPERATURE = -0.62;

/**
 * @typedef {Object} GeneratedChunk
 * @property {Uint16Array} blocks Voxel data, `CHUNK_VOLUME` entries.
 * @property {Int16Array} heightMap 16x16 surface heights.
 * @property {Int16Array} biomeMap 16x16 biome ids.
 * @property {number} nonAirCount Number of non-air voxels.
 * @property {number} maxY Highest non-air voxel, or -1 for an empty chunk.
 */

export class TerrainGenerator {
  /**
   * @param {number} seed
   */
  constructor(seed) {
    this.seed = seed >>> 0;
    this.biomes = new BiomeGenerator(this.seed);
    this.caves = new CaveGenerator(this.seed);
    this.ores = new OreGenerator(this.seed);
    this.structures = new StructureGenerator(this.seed, this.biomes);

    /** Reused column sample for the shaping loop. */
    this._column = createColumnSample();
    /** `indexOf` bound once so the sub-generators can inline it. */
    this._indexOf = (localX, y, localZ) => voxelIndex(localX, y, localZ);
  }

  /**
   * Generates one chunk.
   *
   * @param {number} chunkX
   * @param {number} chunkZ
   * @param {Uint16Array} [target] Optional recycled buffer to fill.
   * @returns {GeneratedChunk}
   */
  generateChunk(chunkX, chunkZ, target = null) {
    const blocks = target && target.length === CHUNK_VOLUME ? target : new Uint16Array(CHUNK_VOLUME);
    if (target) blocks.fill(0);

    const heightMap = new Int16Array(256);
    const biomeMap = new Int16Array(256);

    this._shapeColumns(blocks, chunkX, chunkZ, heightMap, biomeMap);
    this.caves.carve(blocks, chunkX, chunkZ, heightMap, this._indexOf);
    this._fillWater(blocks, chunkX, chunkZ, heightMap);
    this.ores.generate(blocks, chunkX, chunkZ, this._indexOf);
    this.structures.decorate(blocks, chunkX, chunkZ, heightMap, biomeMap, this._indexOf);
    // Strongholds are written after decoration and after cave carving on
    // purpose: a ravine that clipped the End portal room would make the game
    // unfinishable, so the masonry always wins.
    paintStrongholdChunk(blocks, chunkX, chunkZ, this.seed);

    // Single reverse pass: the voxel layout is `x | (z << 4) | (y << 8)`, so the
    // first non-air index encountered from the end also gives the highest Y.
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

  /** Surface height of a world column. */
  getSurfaceHeight(worldX, worldZ) {
    return this.biomes.getSurfaceHeight(worldX, worldZ);
  }

  /** Full climate sample of a world column. */
  sampleColumn(worldX, worldZ, out) {
    return this.biomes.sampleColumn(worldX, worldZ, out);
  }

  /**
   * Finds a spawn position on dry land near the requested coordinates.
   *
   * Spirals outwards testing columns until it finds one above sea level whose
   * surface is not water, so a player never spawns inside an ocean or inside a
   * mountain. Falls back to the highest column it saw.
   *
   * @param {number} preferredX
   * @param {number} preferredZ
   * @param {number} [maxRadius] Search radius in blocks.
   * @returns {{x: number, y: number, z: number}} Feet position.
   */
  findSpawn(preferredX = 0, preferredZ = 0, maxRadius = 512) {
    const sample = createColumnSample();
    let bestX = preferredX;
    let bestZ = preferredZ;
    let bestHeight = -1;

    // Golden-angle (sunflower) spiral: samples the disc evenly outwards from
    // the preferred point without revisiting the same ring.
    const samples = 900;
    for (let i = 0; i < samples; i++) {
      const radius = Math.sqrt(i / samples) * maxRadius;
      const angle = i * 2.399963; // 2π / φ²
      const x = Math.round(preferredX + Math.cos(angle) * radius);
      const z = Math.round(preferredZ + Math.sin(angle) * radius);
      this.biomes.sampleColumn(x, z, sample);

      if (sample.height > bestHeight) {
        bestHeight = sample.height;
        bestX = x;
        bestZ = z;
      }

      const dryLand =
        sample.height > SEA_LEVEL + 1 &&
        sample.biome !== Biome.OCEAN &&
        sample.height < WORLD_HEIGHT - 24;
      if (dryLand) {
        return { x: x + 0.5, y: sample.height + 1, z: z + 0.5 };
      }
    }

    // Nothing dry nearby: stand on top of the best column we found, at least
    // one block above sea level so the player is not submerged.
    return {
      x: bestX + 0.5,
      y: Math.max(bestHeight + 1, SEA_LEVEL + 1),
      z: bestZ + 0.5,
    };
  }

  // ---------------------------------------------------------------- internals

  /** Stage 1: bedrock, stone, subsurface and surface for all 256 columns. */
  _shapeColumns(blocks, chunkX, chunkZ, heightMap, biomeMap) {
    const originX = chunkX * 16;
    const originZ = chunkZ * 16;
    const sample = this._column;

    for (let localZ = 0; localZ < 16; localZ++) {
      const worldZ = originZ + localZ;
      for (let localX = 0; localX < 16; localX++) {
        const worldX = originX + localX;
        this.biomes.sampleColumn(worldX, worldZ, sample);

        const surfaceY = sample.height;
        const mapIndex = localX + localZ * 16;
        heightMap[mapIndex] = surfaceY;
        biomeMap[mapIndex] = sample.biome;

        // Bedrock: a solid floor with a ragged top edge.
        blocks[voxelIndex(localX, 0, localZ)] = Block.BEDROCK;
        for (let y = 1; y <= BEDROCK_HEIGHT; y++) {
          const roughness = randomFromCoords3(worldX, y, worldZ, this.seed ^ 0xbed_0c);
          if (roughness < (BEDROCK_HEIGHT + 1 - y) / (BEDROCK_HEIGHT + 1)) {
            blocks[voxelIndex(localX, y, localZ)] = Block.BEDROCK;
          }
        }

        const subsurfaceTop = surfaceY - 1;
        const subsurfaceBottom = Math.max(
          BEDROCK_HEIGHT + 1,
          surfaceY - sample.subsurfaceDepth
        );

        // Stone core.
        for (let y = BEDROCK_HEIGHT + 1; y < subsurfaceBottom; y++) {
          const index = voxelIndex(localX, y, localZ);
          if (blocks[index] === Block.AIR) blocks[index] = Block.STONE;
        }

        // Subsurface band.
        for (let y = subsurfaceBottom; y <= subsurfaceTop; y++) {
          if (y < 1 || y >= WORLD_HEIGHT) continue;
          const index = voxelIndex(localX, y, localZ);
          if (blocks[index] === Block.AIR) blocks[index] = sample.subsurface;
        }

        // Surface block.
        if (surfaceY >= 1 && surfaceY < WORLD_HEIGHT) {
          const index = voxelIndex(localX, surfaceY, localZ);
          if (blocks[index] === Block.AIR) blocks[index] = sample.surface;
        }
      }
    }
  }

  /** Stage 3 and 4: flood open water columns, then freeze cold surfaces. */
  _fillWater(blocks, chunkX, chunkZ, heightMap) {
    const originX = chunkX * 16;
    const originZ = chunkZ * 16;
    const sample = this._column;

    for (let localZ = 0; localZ < 16; localZ++) {
      for (let localX = 0; localX < 16; localX++) {
        const mapIndex = localX + localZ * 16;
        const surfaceY = heightMap[mapIndex];
        if (surfaceY >= SEA_LEVEL) continue;

        for (let y = surfaceY + 1; y <= SEA_LEVEL; y++) {
          const index = voxelIndex(localX, y, localZ);
          if (blocks[index] === Block.AIR) blocks[index] = Block.WATER;
        }

        // Freeze the surface in cold climates.
        this.biomes.sampleColumn(originX + localX, originZ + localZ, sample);
        if (sample.temperature < FREEZING_TEMPERATURE) {
          const topIndex = voxelIndex(localX, SEA_LEVEL, localZ);
          if (blocks[topIndex] === Block.WATER) blocks[topIndex] = Block.ICE;
        }

        // Grass does not survive submersion; a dirt bed reads better.
        if (surfaceY >= 1) {
          const bedIndex = voxelIndex(localX, surfaceY, localZ);
          if (blocks[bedIndex] === Block.GRASS || blocks[bedIndex] === Block.SNOWY_GRASS) {
            blocks[bedIndex] = Block.DIRT;
          }
        }
      }
    }
  }
}

export default TerrainGenerator;
