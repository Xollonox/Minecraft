/**
 * Phase 4: Nether terrain.
 *
 * This deliberately implements the *same* public surface as `TerrainGenerator`
 * -- `generateChunk`, `getSurfaceHeight`, `sampleColumn`, `findSpawn` -- so the
 * chunk worker can hold either one behind a single variable and never branch on
 * which dimension it is generating.
 *
 * The shape is different from the Overworld in one fundamental way: the
 * Overworld is a heightmap with caves carved out of it, while the Nether is a
 * solid block of netherrack with caverns eaten out of it by 3D noise, capped
 * top and bottom by bedrock. There is no sky, so there is no single "surface"
 * height; `heightMap` instead records the best standing spot in the column,
 * which is what mob spawning and portal placement actually need.
 */

import {
  BEDROCK_HEIGHT,
  CHUNK_VOLUME,
  WORLD_HEIGHT,
} from '../config/GameConfig.js';
import { clamp01, randomFromCoords3 } from '../utils/MathUtils.js';
import { voxelIndex } from '../utils/CoordinateUtils.js';
import { Block } from './BlockTypes.js';
import { NoiseSet } from './Noise.js';
import { paintFortressChunk } from './NetherFortress.js';
import { paintBastionChunk } from './BastionRemnant.js';
import { Dimension, buildCeiling, getDimension } from './DimensionConfig.js';
import {
  NETHER_BIOME_BASE_ID,
  getNetherBiome,
  selectNetherBiome,
} from './NetherBiomes.js';

/** Above this Y the floor slab stops being forced solid. */
const FLOOR_SOLID_TOP = 9;
/** Density above which a voxel is rock. */
const SOLID_THRESHOLD = 0.16;
/** Head room required for a spot to count as standable. */
const STANDING_CLEARANCE = 2;

/**
 * A reusable Nether column sample. Mirrors `createColumnSample` from the
 * Overworld generator so callers can treat the two interchangeably.
 */
export function createNetherColumnSample() {
  return {
    height: 0,
    biome: NETHER_BIOME_BASE_ID,
    definition: null,
    temperature: 0,
    moisture: 0,
    surface: Block.NETHERRACK,
    subsurface: Block.NETHERRACK,
    subsurfaceDepth: 4,
  };
}

export class NetherGenerator {
  /**
   * @param {number} seed Already salted by `dimensionSeed`.
   */
  constructor(seed) {
    this.seed = seed >>> 0;
    this.dimension = getDimension(Dimension.NETHER);
    /** Y of the lava ocean surface. */
    this.lavaLevel = this.dimension.seaLevel;
    /** Highest Y terrain may occupy; above this is bedrock roof. */
    this.ceilingY = buildCeiling(this.dimension);

    this.noise = new NoiseSet(this.seed, [
      'terrain',
      'detail',
      'temperature',
      'moisture',
      'warp',
      'delta',
      'ore',
    ]);

    this._column = createNetherColumnSample();
    /** Scratch solidity buffer, one entry per Y. Reused across columns. */
    this._solid = new Uint8Array(WORLD_HEIGHT);
    this._indexOf = voxelIndex;
  }

  /**
   * Generates one Nether chunk.
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

    this._shapeColumns(blocks, chunkX, chunkZ, heightMap, biomeMap);
    this._fillLava(blocks);
    this._generateOres(blocks, chunkX, chunkZ);
    this._placeMagma(blocks, chunkX, chunkZ);
    this._decorate(blocks, chunkX, chunkZ, heightMap, biomeMap);
    // Fortresses are written last: they must overwrite netherrack and vines
    // rather than be buried by them.
    paintFortressChunk(blocks, chunkX, chunkZ, this.seed, { maxY: this.ceilingY - 1 });
    // Bastions are written after fortresses: on the rare occasion the two
    // overlap, the bastion wins, because a half-eaten bastion reads as broken
    // while a clipped fortress corridor just reads as ruined.
    paintBastionChunk(blocks, chunkX, chunkZ, this.seed, { maxY: this.ceilingY - 1 });

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

  /** Best standing height in a world column. */
  getSurfaceHeight(worldX, worldZ) {
    const biome = this._biomeAt(worldX, worldZ);
    this._computeSolidity(worldX, worldZ, biome);
    return this._standingHeight();
  }

  /**
   * Fills `out` with the climate and material sample for a column.
   * @param {number} worldX
   * @param {number} worldZ
   * @param {Object} [out]
   */
  sampleColumn(worldX, worldZ, out = this._column) {
    const temperature = this._climate('temperature', worldX, worldZ);
    const moisture = this._climate('moisture', worldX, worldZ);
    const definition = selectNetherBiome(temperature, moisture);
    out.temperature = temperature;
    out.moisture = moisture;
    out.definition = definition;
    out.biome = definition.id;
    out.surface = definition.surface;
    out.subsurface = definition.subsurface;
    out.subsurfaceDepth = definition.subsurfaceDepth;
    this._computeSolidity(worldX, worldZ, definition);
    out.height = this._standingHeight();
    return out;
  }

  /**
   * Finds a safe arrival spot: solid floor, head room, and not standing in the
   * lava ocean. Spirals outwards like the Overworld version so a player never
   * arrives inside rock.
   *
   * @param {number} preferredX
   * @param {number} preferredZ
   * @param {number} [maxRadius]
   * @returns {{x: number, y: number, z: number}} Feet position.
   */
  findSpawn(preferredX = 0, preferredZ = 0, maxRadius = 128) {
    let fallbackX = preferredX;
    let fallbackZ = preferredZ;
    let fallbackY = this.lavaLevel + 12;

    for (let i = 0; i < 600; i++) {
      // Golden-angle spiral: even coverage without revisiting columns.
      const angle = i * 2.399963;
      const radius = maxRadius * Math.sqrt(i / 600);
      const worldX = Math.round(preferredX + (Math.cos(angle) * radius));
      const worldZ = Math.round(preferredZ + (Math.sin(angle) * radius));

      const biome = this._biomeAt(worldX, worldZ);
      this._computeSolidity(worldX, worldZ, biome);
      const y = this._standingHeight();
      if (y > this.lavaLevel + 1 && y < this.ceilingY - STANDING_CLEARANCE - 1) {
        return { x: worldX + 0.5, y: y + 1, z: worldZ + 0.5 };
      }
      if (y > fallbackY) {
        fallbackY = y;
        fallbackX = worldX;
        fallbackZ = worldZ;
      }
    }

    return { x: fallbackX + 0.5, y: fallbackY + 1, z: fallbackZ + 0.5 };
  }

  // ------------------------------------------------------------------ climate

  /**
   * One warped climate field, in -1..1.
   *
   * The frequency sets biome size. Nether biomes should be regions you walk
   * across in a minute or two, not continents: at 0.0052 a biome cell is on the
   * order of 200 blocks, so a single render distance usually shows two or three
   * of them meeting.
   */
  _climate(field, worldX, worldZ) {
    const warp = this.noise.get('warp');
    const offsetX = warp.noise2(worldX * 0.004, worldZ * 0.004) * 28;
    const offsetZ = warp.noise2((worldX * 0.004) + 7.3, (worldZ * 0.004) - 4.1) * 28;
    const value = this.noise.get(field).fbm2(
      (worldX + offsetX) * 0.0052,
      (worldZ + offsetZ) * 0.0052,
      3,
      1,
      2,
      0.5
    );
    return Math.max(-1, Math.min(1, value * 1.9));
  }

  /** Biome definition for a column. */
  _biomeAt(worldX, worldZ) {
    return selectNetherBiome(
      this._climate('temperature', worldX, worldZ),
      this._climate('moisture', worldX, worldZ)
    );
  }

  // ------------------------------------------------------------------- shaping

  /**
   * Fills `this._solid` for one column.
   *
   * Bedrock layers are marked solid here too so the material pass never tries
   * to overwrite them.
   */
  _computeSolidity(worldX, worldZ, biome) {
    const solid = this._solid;
    solid.fill(0);

    const terrain = this.noise.get('terrain');
    const detail = this.noise.get('detail');
    const roughness = biome.roughness;
    const floorSpan = biome.floorVariance;
    const ceilingStart = this.ceilingY - biome.ceilingVariance - 6;

    for (let y = 0; y <= BEDROCK_HEIGHT; y++) solid[y] = 1;
    for (let y = this.ceilingY; y < WORLD_HEIGHT; y++) solid[y] = 1;

    for (let y = BEDROCK_HEIGHT + 1; y < this.ceilingY; y++) {
      const base = terrain.fbm3(
        worldX * 0.0165,
        y * 0.031,
        worldZ * 0.0165,
        4,
        1,
        2.05,
        0.5
      );
      const fine = detail.fbm3(
        worldX * 0.055,
        y * 0.07,
        worldZ * 0.055,
        2,
        1,
        2,
        0.5
      ) * 0.18;

      // Slabs hugging the floor and the roof keep the cavern in the middle of
      // the column, which is what makes the Nether feel enclosed rather than
      // like an ordinary cave system.
      const floorClose = clamp01((FLOOR_SOLID_TOP - y) / floorSpan);
      const ceilingClose = clamp01((y - ceilingStart) / biome.ceilingVariance);

      const density = (base * roughness) + fine + (floorClose * 1.6) + (ceilingClose * 1.6);
      solid[y] = density > SOLID_THRESHOLD ? 1 : 0;
    }
  }

  /**
   * Highest Y with a solid block underfoot and clearance above, preferring
   * spots out of the lava. Returns the lava surface when the column is drowned.
   */
  _standingHeight() {
    const solid = this._solid;
    const top = this.ceilingY - STANDING_CLEARANCE - 1;
    let highestSolid = BEDROCK_HEIGHT;

    for (let y = top; y > BEDROCK_HEIGHT; y--) {
      if (!solid[y]) continue;
      if (highestSolid === BEDROCK_HEIGHT) highestSolid = y;
      let clear = true;
      for (let offset = 1; offset <= STANDING_CLEARANCE; offset++) {
        if (solid[y + offset]) { clear = false; break; }
      }
      if (clear && y > this.lavaLevel) return y;
    }

    return Math.max(highestSolid, this.lavaLevel);
  }

  /** Stage 1: rock, bedrock shell, and surface materials. */
  _shapeColumns(blocks, chunkX, chunkZ, heightMap, biomeMap) {
    const originX = chunkX * 16;
    const originZ = chunkZ * 16;
    const solid = this._solid;

    for (let localZ = 0; localZ < 16; localZ++) {
      const worldZ = originZ + localZ;
      for (let localX = 0; localX < 16; localX++) {
        const worldX = originX + localX;
        const biome = this._biomeAt(worldX, worldZ);
        this._computeSolidity(worldX, worldZ, biome);

        const mapIndex = localX + (localZ * 16);
        biomeMap[mapIndex] = biome.id;
        heightMap[mapIndex] = this._standingHeight();

        // Bedrock floor, ragged on its upper edge.
        blocks[voxelIndex(localX, 0, localZ)] = Block.BEDROCK;
        for (let y = 1; y <= BEDROCK_HEIGHT; y++) {
          const roughness = randomFromCoords3(worldX, y, worldZ, this.seed ^ 0xbed_0c);
          if (roughness < (BEDROCK_HEIGHT + 1 - y) / (BEDROCK_HEIGHT + 1)) {
            blocks[voxelIndex(localX, y, localZ)] = Block.BEDROCK;
          }
        }

        // Bedrock roof, ragged on its underside. This is the ceiling that makes
        // the Nether inescapable from above.
        blocks[voxelIndex(localX, WORLD_HEIGHT - 1, localZ)] = Block.BEDROCK;
        for (let y = this.ceilingY; y < WORLD_HEIGHT - 1; y++) {
          const roughness = randomFromCoords3(worldX, y, worldZ, this.seed ^ 0xce11_16);
          const depth = y - this.ceilingY + 1;
          if (roughness < depth / (WORLD_HEIGHT - this.ceilingY)) {
            blocks[voxelIndex(localX, y, localZ)] = Block.BEDROCK;
          }
        }

        // Material pass, top down, tracking how deep we are below open air.
        let sinceAir = 99;
        for (let y = this.ceilingY - 1; y > BEDROCK_HEIGHT; y--) {
          if (!solid[y]) { sinceAir = 0; continue; }
          sinceAir++;

          const index = voxelIndex(localX, y, localZ);
          if (blocks[index] !== Block.AIR) continue;

          if (sinceAir === 1 && y > this.lavaLevel) {
            // Nylium and soul sand only form on dry top-facing surfaces.
            blocks[index] = biome.surface;
          } else if (sinceAir <= biome.subsurfaceDepth) {
            blocks[index] = biome.subsurface;
          } else {
            blocks[index] = biome.filler;
          }
        }
      }
    }
  }

  /** Stage 2: flood everything below the lava level. */
  _fillLava(blocks) {
    for (let localZ = 0; localZ < 16; localZ++) {
      for (let localX = 0; localX < 16; localX++) {
        for (let y = BEDROCK_HEIGHT + 1; y <= this.lavaLevel; y++) {
          const index = voxelIndex(localX, y, localZ);
          if (blocks[index] === Block.AIR) blocks[index] = Block.LAVA;
        }
      }
    }
  }

  /**
   * Magma crusts the shoreline of the lava ocean.
   *
   * Keyed off adjacency to lava rather than off an absolute Y, because the
   * shore is wherever rock happens to meet the ocean, and that varies by tens
   * of blocks between biomes.
   */
  _placeMagma(blocks, chunkX, chunkZ) {
    const originX = chunkX * 16;
    const originZ = chunkZ * 16;
    const lowest = Math.max(BEDROCK_HEIGHT + 1, this.lavaLevel - 4);
    const highest = Math.min(this.ceilingY - 1, this.lavaLevel + 4);

    for (let localZ = 0; localZ < 16; localZ++) {
      const worldZ = originZ + localZ;
      for (let localX = 0; localX < 16; localX++) {
        const worldX = originX + localX;
        const biome = this._biomeAt(worldX, worldZ);
        if (biome.magmaChance <= 0) continue;

        for (let y = lowest; y <= highest; y++) {
          const index = voxelIndex(localX, y, localZ);
          const current = blocks[index];
          if (current !== Block.NETHERRACK
            && current !== Block.BASALT
            && current !== Block.BLACKSTONE) {
            continue;
          }

          const above = blocks[voxelIndex(localX, y + 1, localZ)];
          const below = y > 0 ? blocks[voxelIndex(localX, y - 1, localZ)] : Block.AIR;
          if (above !== Block.LAVA && below !== Block.LAVA) continue;

          if (randomFromCoords3(worldX, y, worldZ, this.seed ^ 0xa9_a5) < biome.magmaChance * 6) {
            blocks[index] = Block.MAGMA_BLOCK;
          }
        }
      }
    }
  }

  /** Stage 3: ores, glowstone, and magma. */
  _generateOres(blocks, chunkX, chunkZ) {
    const originX = chunkX * 16;
    const originZ = chunkZ * 16;

    for (let localZ = 0; localZ < 16; localZ++) {
      const worldZ = originZ + localZ;
      for (let localX = 0; localX < 16; localX++) {
        const worldX = originX + localX;

        for (let y = BEDROCK_HEIGHT + 1; y < this.ceilingY; y++) {
          const index = voxelIndex(localX, y, localZ);
          const current = blocks[index];
          if (current !== Block.NETHERRACK
            && current !== Block.BLACKSTONE
            && current !== Block.BASALT) {
            continue;
          }

          const roll = randomFromCoords3(worldX, y, worldZ, this.seed ^ 0x0_0e5);

          if (current === Block.NETHERRACK) {
            if (roll < 0.014) { blocks[index] = Block.NETHER_QUARTZ_ORE; continue; }
            if (roll < 0.021) { blocks[index] = Block.NETHER_GOLD_ORE; continue; }
          }
          if (current === Block.BLACKSTONE && roll > 0.988) {
            blocks[index] = Block.GILDED_BLACKSTONE;
            continue;
          }
          // Ancient debris hides in a narrow band, deep and rare, so netherite
          // stays an expedition rather than a stroll.
          if (y >= 8 && y <= 22 && roll > 0.9994) {
            blocks[index] = Block.ANCIENT_DEBRIS;
          }
        }
      }
    }

    this._decorateCeiling(blocks, chunkX, chunkZ);
  }

  /** Glowstone clusters hanging from cavern roofs. */
  _decorateCeiling(blocks, chunkX, chunkZ) {
    const originX = chunkX * 16;
    const originZ = chunkZ * 16;

    for (let localZ = 0; localZ < 16; localZ++) {
      const worldZ = originZ + localZ;
      for (let localX = 0; localX < 16; localX++) {
        const worldX = originX + localX;
        const biome = this._biomeAt(worldX, worldZ);

        for (let y = this.ceilingY - 2; y > this.lavaLevel; y--) {
          const index = voxelIndex(localX, y, localZ);
          if (blocks[index] === Block.AIR) continue;
          if (blocks[index] === Block.BEDROCK) continue;
          if (blocks[voxelIndex(localX, y - 1, localZ)] !== Block.AIR) continue;

          const roll = randomFromCoords3(worldX, y, worldZ, this.seed ^ 0x610_05);
          if (roll < biome.glowstoneChance) {
            this._glowstoneCluster(blocks, localX, y, localZ, worldX, worldZ);
          }
          break;
        }
      }
    }
  }

  /** A small blob of glowstone growing downwards from a roof block. */
  _glowstoneCluster(blocks, localX, topY, localZ, worldX, worldZ) {
    const size = 2 + Math.floor(randomFromCoords3(worldX, topY, worldZ, this.seed ^ 0x9_10) * 3);
    for (let dy = 0; dy < size; dy++) {
      const y = topY - dy;
      if (y <= this.lavaLevel) break;
      const spread = dy === 0 ? 1 : 0;
      for (let dz = -spread; dz <= spread; dz++) {
        for (let dx = -spread; dx <= spread; dx++) {
          const x = localX + dx;
          const z = localZ + dz;
          if (x < 0 || x > 15 || z < 0 || z > 15) continue;
          const index = voxelIndex(x, y, z);
          if (blocks[index] !== Block.AIR && dy > 0) continue;
          blocks[index] = Block.GLOWSTONE;
        }
      }
    }
  }

  /** Stage 4: vegetation, columns, fire. */
  _decorate(blocks, chunkX, chunkZ, heightMap, biomeMap) {
    const originX = chunkX * 16;
    const originZ = chunkZ * 16;

    for (let localZ = 0; localZ < 16; localZ++) {
      const worldZ = originZ + localZ;
      for (let localX = 0; localX < 16; localX++) {
        const worldX = originX + localX;
        const mapIndex = localX + (localZ * 16);
        const biome = getNetherBiome(biomeMap[mapIndex]);
        if (!biome) continue;

        const floorY = heightMap[mapIndex];
        if (floorY <= this.lavaLevel || floorY >= this.ceilingY - 2) continue;

        const ground = blocks[voxelIndex(localX, floorY, localZ)];
        const aboveIndex = voxelIndex(localX, floorY + 1, localZ);
        if (blocks[aboveIndex] !== Block.AIR) continue;
        if (ground === Block.LAVA || ground === Block.AIR) continue;

        const roll = randomFromCoords3(worldX, floorY, worldZ, this.seed ^ 0xdec_0);
        const vegetation = biome.vegetation;

        // Basalt pillars, the signature of the deltas.
        if (roll < biome.basaltColumnChance) {
          this._basaltColumn(blocks, localX, floorY, localZ, worldX, worldZ);
          continue;
        }
        // Huge fungi first: they need the most room.
        if (roll < biome.basaltColumnChance + vegetation.hugeFungusChance) {
          this._hugeFungus(blocks, localX, floorY, localZ, worldX, worldZ, vegetation);
          continue;
        }

        const second = randomFromCoords3(worldX, floorY + 1, worldZ, this.seed ^ 0xdec_1);
        if (vegetation.fungus && second < vegetation.fungusChance) {
          blocks[aboveIndex] = vegetation.fungus;
          continue;
        }
        if (vegetation.roots && second < vegetation.fungusChance + vegetation.rootsChance) {
          blocks[aboveIndex] = vegetation.roots;
          continue;
        }
        if (vegetation.fire && second > 1 - vegetation.fireChance) {
          blocks[aboveIndex] = vegetation.fire;
          continue;
        }
        if (second > 1 - biome.magmaChance && floorY <= this.lavaLevel + 6) {
          blocks[voxelIndex(localX, floorY, localZ)] = Block.MAGMA_BLOCK;
        }
      }
    }

    this._hangVines(blocks, chunkX, chunkZ, biomeMap);
  }

  /** Weeping vines hang from roofs; twisting vines climb from floors. */
  _hangVines(blocks, chunkX, chunkZ, biomeMap) {
    const originX = chunkX * 16;
    const originZ = chunkZ * 16;

    for (let localZ = 0; localZ < 16; localZ++) {
      const worldZ = originZ + localZ;
      for (let localX = 0; localX < 16; localX++) {
        const worldX = originX + localX;
        const biome = getNetherBiome(biomeMap[localX + (localZ * 16)]);
        if (!biome) continue;
        const vegetation = biome.vegetation;
        if (!vegetation.vine || vegetation.vineChance <= 0) continue;

        const roll = randomFromCoords3(worldX, 7, worldZ, this.seed ^ 0x1e_af);
        if (roll > vegetation.vineChance) continue;

        const length = 1 + Math.floor(
          randomFromCoords3(worldX, 11, worldZ, this.seed ^ 0x1e_b0) * 5
        );

        if (vegetation.vinesHangFromCeiling) {
          // Hunt for a cavern *underside*: solid rock with open air beneath it.
          // Simply taking the topmost solid block finds the roof slab, whose
          // neighbour below is also rock, so nothing would ever hang.
          for (let y = this.ceilingY - 2; y > this.lavaLevel + 2; y--) {
            const index = voxelIndex(localX, y, localZ);
            if (blocks[index] === Block.AIR) continue;
            if (blocks[index] === Block.BEDROCK) continue;
            if (blocks[voxelIndex(localX, y - 1, localZ)] !== Block.AIR) continue;
            for (let i = 1; i <= length; i++) {
              const below = voxelIndex(localX, y - i, localZ);
              if (y - i <= this.lavaLevel + 1) break;
              if (blocks[below] !== Block.AIR) break;
              blocks[below] = vegetation.vine;
            }
            break;
          }
        } else {
          for (let y = this.lavaLevel + 1; y < this.ceilingY - 2; y++) {
            const index = voxelIndex(localX, y, localZ);
            if (blocks[index] === Block.AIR) continue;
            const start = y + 1;
            for (let i = 0; i < length; i++) {
              const above = voxelIndex(localX, start + i, localZ);
              if (start + i >= this.ceilingY - 1) break;
              if (blocks[above] !== Block.AIR) break;
              blocks[above] = vegetation.vine;
            }
            break;
          }
        }
      }
    }
  }

  /** A basalt pillar rising from the deltas floor. */
  _basaltColumn(blocks, localX, floorY, localZ, worldX, worldZ) {
    const height = 2 + Math.floor(
      randomFromCoords3(worldX, floorY, worldZ, this.seed ^ 0xba_51) * 7
    );
    for (let i = 1; i <= height; i++) {
      const y = floorY + i;
      if (y >= this.ceilingY - 1) break;
      const index = voxelIndex(localX, y, localZ);
      if (blocks[index] !== Block.AIR) break;
      blocks[index] = Block.BASALT;
    }
  }

  /**
   * A huge crimson or warped fungus: a stem topped with a wart-block cap and a
   * couple of shroomlights buried in it.
   *
   * Placement is clamped to the chunk. Growing across a chunk border would mean
   * writing into a neighbour that may already be meshed, so the trade is a
   * clipped cap at the seam rather than a corrupted neighbour.
   */
  _hugeFungus(blocks, localX, floorY, localZ, worldX, worldZ, vegetation) {
    if (!vegetation.stem || !vegetation.wart) return;

    const wanted = 4 + Math.floor(
      randomFromCoords3(worldX, floorY, worldZ, this.seed ^ 0xf0_09) * 6
    );

    // Measure the headroom before writing anything.
    //
    // The first version placed stem blocks as it climbed and returned the
    // moment it hit rock. Nether caverns are low, so that bailed out most of
    // the time -- leaving capless stumps behind and meaning wart blocks never
    // generated anywhere in the world. The terrain probe caught it.
    let height = 0;
    while (height < wanted) {
      const y = floorY + 1 + height;
      if (y >= this.ceilingY - 3) break;
      if (blocks[voxelIndex(localX, y, localZ)] !== Block.AIR) break;
      height++;
    }

    // Too short to read as a fungus; leave the floor clear instead.
    if (height < 3) return;

    const topY = floorY + height;

    for (let i = 1; i <= height; i++) {
      blocks[voxelIndex(localX, floorY + i, localZ)] = vegetation.stem;
    }

    for (let dy = 0; dy <= 1; dy++) {
      const y = topY + dy;
      if (y >= this.ceilingY - 1) break;
      const radius = dy === 0 ? 2 : 1;
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.abs(dx) === radius && Math.abs(dz) === radius) continue;
          const x = localX + dx;
          const z = localZ + dz;
          if (x < 0 || x > 15 || z < 0 || z > 15) continue;
          const index = voxelIndex(x, y, z);
          if (blocks[index] !== Block.AIR) continue;
          const glow = randomFromCoords3(worldX + dx, y, worldZ + dz, this.seed ^ 0x51_09);
          blocks[index] = (vegetation.shroomlight && glow > 0.88)
            ? vegetation.shroomlight
            : vegetation.wart;
        }
      }
    }
  }
}

export default NetherGenerator;
