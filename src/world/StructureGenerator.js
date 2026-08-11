/**
 * Trees, boulders, ruins and ground cover.
 *
 * ## How cross-chunk features stay whole
 *
 * A tree is up to 11 blocks tall and 5 wide, so it routinely straddles a chunk
 * border. The naive approach — roll trees for the chunk you are generating and
 * clip anything that falls outside — produces the classic half-tree: the
 * neighbour chunk never knew a trunk was nearby, so the canopy simply stops at
 * the seam.
 *
 * This generator instead walks the **3x3 neighbourhood of source chunks** when
 * decorating a chunk. For each of the nine source chunks it replays exactly the
 * same deterministic roll that chunk will make (or already made) for itself, and
 * writes only the blocks that land inside the chunk being generated. Because the
 * PRNG is seeded from the *source* chunk coordinates and always consumes the
 * same number of values in the same order — candidates are fully evaluated even
 * when their blocks are entirely outside the target chunk — both chunks agree
 * bit-for-bit on where every tree is and what shape it has. Features are
 * therefore always complete, with no queue of pending cross-chunk writes to
 * persist or replay.
 *
 * Ground cover (grass, flowers, dead bushes, snow) is single-block and never
 * crosses a border, so it is rolled only for the chunk itself.
 *
 * Worker-safe.
 */

import { SEA_LEVEL, WORLD_HEIGHT } from '../config/GameConfig.js';
import { hash3, mulberry32 } from '../utils/MathUtils.js';
import { Block } from './BlockTypes.js';
import { IS_LIQUID, IS_OPAQUE } from './BlockRegistry.js';
import { Biome, TreeType, getBiome } from './BiomeGenerator.js';

/** Fixed number of tree rolls per source chunk; density scales acceptance. */
const TREE_ATTEMPTS = 14;
/** Fixed number of boulder rolls per source chunk. */
const BOULDER_ATTEMPTS = 2;
/** Fixed number of ruin rolls per source chunk. */
const RUIN_ATTEMPTS = 1;

/** Distinct PRNG salts so feature types do not correlate with each other. */
const SALT_TREES = 0x7ee5;
const SALT_BOULDERS = 0xb01d;
const SALT_RUINS = 0x4e11;
const SALT_VILLAGES = 0x71a6e;
const SALT_COVER = 0xc0be;

export class StructureGenerator {
  /**
   * @param {number} seed
   * @param {import('./BiomeGenerator.js').BiomeGenerator} biomeGenerator
   */
  constructor(seed, biomeGenerator) {
    this.seed = seed >>> 0;
    this._biomes = biomeGenerator;
    /** Scratch column sample, reused across candidate evaluations. */
    this._column = null;
  }

  /**
   * Decorates a chunk with structures and ground cover.
   *
   * @param {Uint16Array} blocks Chunk voxel data, mutated in place.
   * @param {number} chunkX
   * @param {number} chunkZ
   * @param {Int16Array} heightMap 16x16 surface heights (`x + z * 16`).
   * @param {Int16Array} biomeMap 16x16 biome ids (`x + z * 16`).
   * @param {(localX:number, y:number, localZ:number) => number} indexOf
   */
  decorate(blocks, chunkX, chunkZ, heightMap, biomeMap, indexOf) {
    const context = {
      blocks,
      indexOf,
      originX: chunkX * 16,
      originZ: chunkZ * 16,
    };

    // Structures: replay the 3x3 neighbourhood so nothing is ever half-built.
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const sourceX = chunkX + dx;
        const sourceZ = chunkZ + dz;
        this._placeTrees(context, sourceX, sourceZ);
        this._placeBoulders(context, sourceX, sourceZ);
        this._placeRuins(context, sourceX, sourceZ);
        this._placeVillage(context, sourceX, sourceZ);
      }
    }

    // Ground cover is local to this chunk only.
    this._placeGroundCover(context, chunkX, chunkZ, heightMap, biomeMap);
  }

  // ------------------------------------------------------------------- trees

  _placeTrees(context, sourceX, sourceZ) {
    const random = mulberry32(hash3(sourceX, sourceZ, SALT_TREES, this.seed));

    for (let attempt = 0; attempt < TREE_ATTEMPTS; attempt++) {
      // Always draw the same values, whether or not the tree is written, so the
      // stream stays aligned between the source chunk and its neighbours.
      const localX = Math.floor(random() * 16);
      const localZ = Math.floor(random() * 16);
      const acceptance = random();
      const heightRoll = random();
      const shapeRoll = random();
      const variantRoll = random();

      const worldX = sourceX * 16 + localX;
      const worldZ = sourceZ * 16 + localZ;

      const column = this._biomes.sampleColumn(worldX, worldZ);
      const definition = getBiome(column.biome);
      if (definition.tree === TreeType.NONE) continue;
      if (definition.treeDensity <= 0) continue;
      if (acceptance > definition.treeDensity / TREE_ATTEMPTS) continue;

      const surfaceY = column.height;
      if (surfaceY <= SEA_LEVEL) continue; // no trees in or under water
      if (surfaceY >= WORLD_HEIGHT - 16) continue;

      // Trees only grow on their biome's own surface material.
      const surface = column.surface;
      const growsOnSand = definition.tree === TreeType.CACTUS;
      if (growsOnSand) {
        if (surface !== Block.SAND && surface !== Block.RED_SAND) continue;
      } else if (
        surface !== Block.GRASS &&
        surface !== Block.SNOWY_GRASS &&
        surface !== Block.DIRT
      ) {
        continue;
      }

      const base = surfaceY + 1;
      switch (definition.tree) {
        case TreeType.OAK:
          this._buildRoundTree(context, worldX, base, worldZ, {
            trunk: Block.OAK_LOG,
            leaves: Block.OAK_LEAVES,
            trunkHeight: 4 + Math.floor(heightRoll * 3),
            canopyRadius: shapeRoll > 0.6 ? 3 : 2,
            canopyHeight: 3,
            trimCorners: true,
          });
          break;
        case TreeType.BIRCH:
          this._buildRoundTree(context, worldX, base, worldZ, {
            trunk: Block.BIRCH_LOG,
            leaves: Block.BIRCH_LEAVES,
            trunkHeight: 5 + Math.floor(heightRoll * 3),
            canopyRadius: 2,
            canopyHeight: 3,
            trimCorners: true,
          });
          break;
        case TreeType.SPRUCE:
          this._buildConiferTree(context, worldX, base, worldZ, {
            trunk: Block.SPRUCE_LOG,
            leaves: Block.SPRUCE_LEAVES,
            trunkHeight: 6 + Math.floor(heightRoll * 5),
            wide: variantRoll > 0.5,
          });
          break;
        case TreeType.ACACIA:
          this._buildAcaciaTree(context, worldX, base, worldZ, {
            trunk: Block.OAK_LOG,
            leaves: Block.OAK_LEAVES,
            trunkHeight: 4 + Math.floor(heightRoll * 2),
            leanX: shapeRoll > 0.5 ? 1 : -1,
            leanZ: variantRoll > 0.5 ? 1 : -1,
          });
          break;
        case TreeType.CACTUS:
          this._buildCactus(context, worldX, base, worldZ, 2 + Math.floor(heightRoll * 3));
          break;
        default:
          break;
      }
    }
  }

  /** Oak/birch: a straight trunk with a roughly spherical canopy. */
  _buildRoundTree(context, worldX, baseY, worldZ, options) {
    const { trunk, leaves, trunkHeight, canopyRadius, canopyHeight, trimCorners } = options;
    const topY = baseY + trunkHeight - 1;

    for (let i = 0; i < trunkHeight; i++) {
      this._put(context, worldX, baseY + i, worldZ, trunk, true);
    }

    // Canopy spans the top of the trunk and two layers above it.
    for (let dy = -canopyHeight + 1; dy <= 1; dy++) {
      const y = topY + dy;
      // Radius tapers at the very top and bottom of the canopy.
      const radius = dy === 1 ? canopyRadius - 1 : dy === -canopyHeight + 1 ? canopyRadius - 1 : canopyRadius;
      if (radius <= 0) continue;
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx === 0 && dz === 0 && y <= topY) continue; // keep the trunk
          const distance = dx * dx + dz * dz;
          if (distance > radius * radius + 1) continue;
          if (trimCorners && Math.abs(dx) === radius && Math.abs(dz) === radius) continue;
          this._put(context, worldX + dx, y, worldZ + dz, leaves, false);
        }
      }
    }
  }

  /** Spruce: layered conical canopy that alternates wide and narrow rings. */
  _buildConiferTree(context, worldX, baseY, worldZ, options) {
    const { trunk, leaves, trunkHeight, wide } = options;
    for (let i = 0; i < trunkHeight; i++) {
      this._put(context, worldX, baseY + i, worldZ, trunk, true);
    }

    const canopyBase = baseY + Math.max(2, Math.floor(trunkHeight * 0.3));
    const topY = baseY + trunkHeight;
    let radius = wide ? 3 : 2;
    let ring = 0;

    for (let y = canopyBase; y <= topY; y++) {
      // Ring radius cycles down towards the tip.
      const remaining = topY - y;
      let currentRadius;
      if (remaining <= 0) currentRadius = 0;
      else if (remaining === 1) currentRadius = 1;
      else currentRadius = ring % 2 === 0 ? radius : Math.max(1, radius - 1);

      for (let dz = -currentRadius; dz <= currentRadius; dz++) {
        for (let dx = -currentRadius; dx <= currentRadius; dx++) {
          if (dx === 0 && dz === 0 && y < topY) continue;
          if (dx * dx + dz * dz > currentRadius * currentRadius + 1) continue;
          this._put(context, worldX + dx, y, worldZ + dz, leaves, false);
        }
      }

      ring++;
      // Shrink every other ring so the cone narrows smoothly.
      if (ring % 2 === 0 && radius > 1 && y > canopyBase + 1) radius--;
    }
    this._put(context, worldX, topY + 1, worldZ, leaves, false);
  }

  /** Acacia: leaning trunk with a flat, offset canopy. */
  _buildAcaciaTree(context, worldX, baseY, worldZ, options) {
    const { trunk, leaves, trunkHeight, leanX, leanZ } = options;
    let x = worldX;
    let z = worldZ;

    for (let i = 0; i < trunkHeight; i++) {
      this._put(context, x, baseY + i, z, trunk, true);
    }
    // Two-block lean, then a flat canopy above the offset top.
    const leanBase = baseY + trunkHeight;
    for (let i = 0; i < 2; i++) {
      x += leanX;
      z += i === 1 ? leanZ : 0;
      this._put(context, x, leanBase + i, z, trunk, true);
    }

    const canopyY = leanBase + 2;
    for (let dy = 0; dy <= 1; dy++) {
      const radius = dy === 0 ? 3 : 2;
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dz * dz > radius * radius) continue;
          this._put(context, x + dx, canopyY + dy, z + dz, leaves, false);
        }
      }
    }
  }

  /** Cactus: a short column with occasional arms. */
  _buildCactus(context, worldX, baseY, worldZ, height) {
    for (let i = 0; i < height; i++) {
      this._put(context, worldX, baseY + i, worldZ, Block.CACTUS, true);
    }
  }

  // ---------------------------------------------------------------- boulders

  _placeBoulders(context, sourceX, sourceZ) {
    const random = mulberry32(hash3(sourceX, sourceZ, SALT_BOULDERS, this.seed));

    for (let attempt = 0; attempt < BOULDER_ATTEMPTS; attempt++) {
      const localX = Math.floor(random() * 16);
      const localZ = Math.floor(random() * 16);
      const acceptance = random();
      const sizeRoll = random();
      const mossRoll = random();

      const worldX = sourceX * 16 + localX;
      const worldZ = sourceZ * 16 + localZ;
      const column = this._biomes.sampleColumn(worldX, worldZ);

      // Boulders belong on rocky, cold or mountainous ground.
      const rocky =
        column.biome === Biome.ROCKY_HILLS ||
        column.biome === Biome.MOUNTAINS ||
        column.biome === Biome.TAIGA;
      if (!rocky || acceptance > 0.28) continue;
      if (column.height <= SEA_LEVEL) continue;

      const radius = sizeRoll > 0.65 ? 2 : 1;
      const material = mossRoll > 0.55 ? Block.MOSSY_COBBLESTONE : Block.COBBLESTONE;
      const centreY = column.height + radius - 1;

      for (let dy = -radius; dy <= radius; dy++) {
        for (let dz = -radius; dz <= radius; dz++) {
          for (let dx = -radius; dx <= radius; dx++) {
            if (dx * dx + dy * dy + dz * dz > radius * radius + 1) continue;
            this._put(context, worldX + dx, centreY + dy, worldZ + dz, material, false);
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------- ruins

  /**
   * A rare, small ruin: a cobble platform with broken brick pillars and a
   * glowstone block inside. Deliberately tiny so it never fights the terrain.
   */
  _placeRuins(context, sourceX, sourceZ) {
    const random = mulberry32(hash3(sourceX, sourceZ, SALT_RUINS, this.seed));

    for (let attempt = 0; attempt < RUIN_ATTEMPTS; attempt++) {
      const localX = 3 + Math.floor(random() * 10);
      const localZ = 3 + Math.floor(random() * 10);
      const acceptance = random();
      const pillarRoll = random();
      const lightRoll = random();

      if (acceptance > 0.022) continue;

      const worldX = sourceX * 16 + localX;
      const worldZ = sourceZ * 16 + localZ;
      const column = this._biomes.sampleColumn(worldX, worldZ);
      if (column.height <= SEA_LEVEL + 2) continue;
      if (column.biome === Biome.SNOWY_PEAKS || column.biome === Biome.MOUNTAINS) continue;

      const floorY = column.height;

      // 5x5 floor, partially eroded.
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const erode = ((dx * 7 + dz * 13 + localX) & 7) === 0;
          if (erode) continue;
          this._put(context, worldX + dx, floorY, worldZ + dz, Block.BRICKS, true);
        }
      }

      // Four corner pillars of varying, broken heights.
      const corners = [
        [-2, -2],
        [2, -2],
        [-2, 2],
        [2, 2],
      ];
      for (let i = 0; i < corners.length; i++) {
        const [dx, dz] = corners[i];
        const height = 1 + Math.floor(((pillarRoll * 977 + i * 131) % 100) / 25);
        for (let dy = 1; dy <= height; dy++) {
          this._put(context, worldX + dx, floorY + dy, worldZ + dz, Block.COBBLESTONE, true);
        }
      }

      if (lightRoll > 0.45) {
        this._put(context, worldX, floorY + 1, worldZ, Block.GLOWSTONE, true);
      }
    }
  }

  // --------------------------------------------------------------- villages

  /** A compact two-house settlement with a road, farm, well and lit interiors. */
  _placeVillage(context, sourceX, sourceZ) {
    const random = mulberry32(hash3(sourceX, sourceZ, SALT_VILLAGES, this.seed));
    const localX = 4 + Math.floor(random() * 8);
    const localZ = 4 + Math.floor(random() * 8);
    if (random() > 0.014) return;
    const worldX = sourceX * 16 + localX;
    const worldZ = sourceZ * 16 + localZ;
    const column = this._biomes.sampleColumn(worldX, worldZ);
    if (column.height <= SEA_LEVEL + 2 || column.height >= WORLD_HEIGHT - 12) return;
    if ([Biome.OCEAN, Biome.DESERT, Biome.SNOWY_PEAKS, Biome.MOUNTAINS].includes(column.biome)) return;
    const y = column.height + 1;

    // Main road and central well establish an immediately readable settlement.
    for (let dz = -6; dz <= 6; dz++) {
      for (let dx = -1; dx <= 1; dx++) this._put(context, worldX + dx, y - 1, worldZ + dz, Block.COBBLESTONE, true);
    }
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      this._put(context, worldX + dx, y, worldZ + dz, (dx === 0 && dz === 0) ? Block.WATER : Block.COBBLESTONE, true);
    }
    this._buildVillageHouse(context, worldX - 5, y, worldZ - 3, 1);
    this._buildVillageHouse(context, worldX + 5, y, worldZ + 3, -1);

    // Irrigated crop strip and a loot chest make the village useful, not scenery.
    for (let dz = -4; dz <= 4; dz++) {
      this._put(context, worldX + 5, y - 1, worldZ + dz, Block.WATER, true);
      for (const dx of [3, 4, 6, 7]) {
        this._put(context, worldX + dx, y - 1, worldZ + dz, Block.FARMLAND, true);
        this._put(context, worldX + dx, y, worldZ + dz, (dz & 1) ? Block.CARROT_CROP : Block.WHEAT_CROP, true);
      }
    }
    this._put(context, worldX, y, worldZ + 5, Block.CHEST, true);
    this._put(context, worldX, y + 1, worldZ - 5, Block.TORCH, true);
  }

  _buildVillageHouse(context, centreX, y, centreZ, doorDirection) {
    for (let dz = -2; dz <= 2; dz++) for (let dx = -3; dx <= 3; dx++) {
      this._put(context, centreX + dx, y - 1, centreZ + dz, Block.COBBLESTONE, true);
      const edge = Math.abs(dx) === 3 || Math.abs(dz) === 2;
      if (!edge) continue;
      for (let dy = 0; dy <= 2; dy++) {
        const door = dz === doorDirection * 2 && dx === 0 && dy < 2;
        const window = dy === 1 && ((Math.abs(dx) === 3 && dz === 0) || (Math.abs(dz) === 2 && Math.abs(dx) === 2));
        if (door) this._put(context, centreX + dx, y + dy, centreZ + dz, Block.AIR, true);
        else this._put(context, centreX + dx, y + dy, centreZ + dz, window ? Block.GLASS : Block.OAK_PLANKS, true);
      }
    }
    for (let dz = -3; dz <= 3; dz++) for (let dx = -4; dx <= 4; dx++) {
      const roofY = y + 3 + (Math.abs(dx) < 3 && Math.abs(dz) < 2 ? 1 : 0);
      this._put(context, centreX + dx, roofY, centreZ + dz, Block.OAK_PLANKS, true);
    }
    this._put(context, centreX, y, centreZ, Block.CRAFTING_TABLE, true);
    this._put(context, centreX + 2, y, centreZ, Block.CHEST, true);
  }

  // ------------------------------------------------------------ ground cover

  /**
   * Grass, ferns, flowers, dead bushes and the snow layer.
   * Local to the chunk, and validated against the *actual* voxel data so cover
   * is never placed on a block a cave removed or a tree replaced.
   */
  _placeGroundCover(context, chunkX, chunkZ, heightMap, biomeMap) {
    const { blocks, indexOf } = context;
    const random = mulberry32(hash3(chunkX, chunkZ, SALT_COVER, this.seed));

    for (let localZ = 0; localZ < 16; localZ++) {
      for (let localX = 0; localX < 16; localX++) {
        const mapIndex = localX + localZ * 16;
        const surfaceY = heightMap[mapIndex];
        const definition = getBiome(biomeMap[mapIndex]);
        const aboveY = surfaceY + 1;
        if (aboveY >= WORLD_HEIGHT - 1) continue;

        const surfaceIndex = indexOf(localX, surfaceY, localZ);
        const aboveIndex = indexOf(localX, aboveY, localZ);
        const surfaceBlock = blocks[surfaceIndex];
        const aboveBlock = blocks[aboveIndex];

        if (aboveBlock !== Block.AIR) continue;

        // Snow layer sits on any solid surface in a cold column.
        if (definition.snowy && IS_OPAQUE[surfaceBlock] && surfaceY >= SEA_LEVEL) {
          if (surfaceBlock === Block.GRASS) blocks[surfaceIndex] = Block.SNOWY_GRASS;
          else if (surfaceBlock === Block.STONE && random() > 0.35) {
            blocks[aboveIndex] = Block.SNOW_BLOCK;
            continue;
          }
        }

        const plantable = surfaceBlock === Block.GRASS || surfaceBlock === Block.SNOWY_GRASS;
        const sandy = surfaceBlock === Block.SAND || surfaceBlock === Block.RED_SAND;
        if (!plantable && !sandy) continue;
        if (surfaceY < SEA_LEVEL) continue;

        const roll = random();
        if (plantable) {
          const grassChance = definition.grassDensity / 256;
          const flowerChance = definition.flowerDensity / 256;
          if (roll < flowerChance) {
            blocks[aboveIndex] = random() > 0.5 ? Block.FLOWER_RED : Block.FLOWER_YELLOW;
          } else if (roll < flowerChance + grassChance) {
            blocks[aboveIndex] = random() > 0.7 ? Block.FERN : Block.TALL_GRASS;
          }
        } else if (roll < definition.grassDensity / 512) {
          blocks[aboveIndex] = Block.DEAD_BUSH;
        }
      }
    }
  }

  // ---------------------------------------------------------------- internals

  /**
   * Writes one block, clipped to the chunk being generated.
   *
   * @param {{blocks: Uint16Array, indexOf: Function, originX: number, originZ: number}} context
   * @param {number} worldX
   * @param {number} worldY
   * @param {number} worldZ
   * @param {number} blockId
   * @param {boolean} overwrite When false, only air and leaves are replaced.
   */
  _put(context, worldX, worldY, worldZ, blockId, overwrite) {
    const localX = worldX - context.originX;
    const localZ = worldZ - context.originZ;
    // This is the clip that makes cross-chunk features work: blocks outside the
    // chunk are silently dropped, because the neighbouring chunk will place
    // them itself from the identical deterministic roll.
    if (localX < 0 || localX > 15 || localZ < 0 || localZ > 15) return;
    if (worldY < 1 || worldY >= WORLD_HEIGHT) return;

    const index = context.indexOf(localX, worldY, localZ);
    const existing = context.blocks[index];
    if (!overwrite) {
      // Leaves may fill air and overwrite other leaves, nothing else.
      const replaceable =
        existing === Block.AIR ||
        existing === Block.OAK_LEAVES ||
        existing === Block.BIRCH_LEAVES ||
        existing === Block.SPRUCE_LEAVES ||
        existing === Block.TALL_GRASS ||
        existing === Block.FERN ||
        existing === Block.FLOWER_RED ||
        existing === Block.FLOWER_YELLOW ||
        existing === Block.DEAD_BUSH;
      if (!replaceable) return;
    } else if (existing === Block.BEDROCK || IS_LIQUID[existing]) {
      return;
    }
    context.blocks[index] = blockId;
  }
}

export default StructureGenerator;
