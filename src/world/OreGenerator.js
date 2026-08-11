/**
 * Ore vein placement.
 *
 * Veins are placed per chunk from a PRNG seeded with `(worldSeed, chunkX,
 * chunkZ, oreId)`. That keeps generation deterministic and, crucially, keeps
 * each ore type independent: adding a new ore later does not shift the position
 * of every existing vein, because it draws from its own stream.
 *
 * Veins are clipped to the chunk they were rolled in rather than bleeding into
 * neighbours. A vein is at most a few blocks across, so the visual cost of
 * clipping is negligible compared to the alternative (every chunk having to
 * evaluate its eight neighbours' ore rolls).
 *
 * Worker-safe.
 */

import { BEDROCK_HEIGHT, WORLD_HEIGHT } from '../config/GameConfig.js';
import { mulberry32, hash3 } from '../utils/MathUtils.js';
import { Block } from './BlockTypes.js';

/**
 * @typedef {Object} OreDefinition
 * @property {number} block Ore block id.
 * @property {number} attempts Vein attempts per chunk.
 * @property {number} minY
 * @property {number} maxY
 * @property {number} minSize Minimum blocks per vein.
 * @property {number} maxSize Maximum blocks per vein.
 * @property {number} [surfaceBias] 0 = uniform depth, 1 = strongly favours minY.
 */

/**
 * Ore distribution. Rarer and more valuable ores get fewer attempts, tighter
 * depth bands and smaller veins.
 * @type {ReadonlyArray<OreDefinition>}
 */
export const ORE_DEFINITIONS = Object.freeze([
  { block: Block.GRAVEL, attempts: 5, minY: 8, maxY: 64, minSize: 12, maxSize: 30 },
  { block: Block.CLAY, attempts: 2, minY: 30, maxY: 58, minSize: 6, maxSize: 16 },
  { block: Block.COAL_ORE, attempts: 11, minY: 6, maxY: 82, minSize: 6, maxSize: 18 },
  { block: Block.IRON_ORE, attempts: 8, minY: 4, maxY: 62, minSize: 4, maxSize: 11 },
  {
    block: Block.REDSTONE_ORE,
    attempts: 7,
    minY: 3,
    maxY: 22,
    minSize: 4,
    maxSize: 10,
    surfaceBias: 0.72,
  },
  { block: Block.GOLD_ORE, attempts: 3, minY: 3, maxY: 34, minSize: 3, maxSize: 8, surfaceBias: 0.7 },
  {
    block: Block.DIAMOND_ORE,
    attempts: 2,
    minY: 3,
    maxY: 18,
    minSize: 2,
    maxSize: 7,
    surfaceBias: 0.85,
  },
]);

export class OreGenerator {
  /**
   * @param {number} seed
   */
  constructor(seed) {
    this.seed = seed >>> 0;
  }

  /**
   * Places every ore type into a chunk. Only stone is replaced, so a vein that
   * would have intersected a cave, a lake or the surface simply has fewer
   * blocks rather than floating in mid-air.
   *
   * @param {Uint16Array} blocks Chunk voxel data, mutated in place.
   * @param {number} chunkX
   * @param {number} chunkZ
   * @param {(localX:number, y:number, localZ:number) => number} indexOf
   * @returns {number} Number of ore blocks placed.
   */
  generate(blocks, chunkX, chunkZ, indexOf) {
    let placed = 0;
    for (let i = 0; i < ORE_DEFINITIONS.length; i++) {
      placed += this._generateOre(ORE_DEFINITIONS[i], i, blocks, chunkX, chunkZ, indexOf);
    }
    return placed;
  }

  _generateOre(definition, oreIndex, blocks, chunkX, chunkZ, indexOf) {
    const random = mulberry32(hash3(chunkX, chunkZ, oreIndex + 1, this.seed ^ 0x0b1e_5eed));
    const minY = Math.max(BEDROCK_HEIGHT + 1, definition.minY);
    const maxY = Math.min(WORLD_HEIGHT - 2, definition.maxY);
    if (maxY <= minY) return 0;

    let placed = 0;
    for (let attempt = 0; attempt < definition.attempts; attempt++) {
      // Depth distribution: `surfaceBias` biases towards the bottom of the band
      // by raising a uniform sample to a power.
      const t = definition.surfaceBias
        ? random() ** (1 + definition.surfaceBias * 3)
        : random();
      const centreY = Math.floor(minY + t * (maxY - minY));
      const centreX = Math.floor(random() * 16);
      const centreZ = Math.floor(random() * 16);
      const size =
        definition.minSize + Math.floor(random() * (definition.maxSize - definition.minSize + 1));

      placed += this._placeVein(blocks, definition.block, centreX, centreY, centreZ, size, random, indexOf);
    }
    return placed;
  }

  /**
   * Grows one vein as a short self-avoiding random walk with a small blob
   * around each step. This produces the compact, slightly irregular clusters
   * ore is expected to form, without needing a full 3D noise field.
   */
  _placeVein(blocks, oreId, startX, startY, startZ, size, random, indexOf) {
    let x = startX;
    let y = startY;
    let z = startZ;
    let placed = 0;

    for (let step = 0; step < size; step++) {
      // Blob radius shrinks towards the tail of the vein.
      const radius = step < size * 0.5 ? 1 : 0;

      for (let dy = -radius; dy <= radius; dy++) {
        const by = y + dy;
        if (by <= BEDROCK_HEIGHT || by >= WORLD_HEIGHT - 1) continue;
        for (let dz = -radius; dz <= radius; dz++) {
          const bz = z + dz;
          if (bz < 0 || bz > 15) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            const bx = x + dx;
            if (bx < 0 || bx > 15) continue;
            // Skip the eight corners so the blob is rounded, not cubic.
            if (radius > 0 && Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 2) continue;
            const index = indexOf(bx, by, bz);
            if (blocks[index] !== Block.STONE) continue;
            blocks[index] = oreId;
            placed++;
          }
        }
      }

      // Step to a face neighbour, biased horizontally so veins form seams.
      const direction = Math.floor(random() * 6);
      switch (direction) {
        case 0:
          x++;
          break;
        case 1:
          x--;
          break;
        case 2:
          z++;
          break;
        case 3:
          z--;
          break;
        case 4:
          y++;
          break;
        default:
          y--;
          break;
      }
      if (x < 0 || x > 15 || z < 0 || z > 15 || y <= BEDROCK_HEIGHT || y >= WORLD_HEIGHT - 1) break;
    }

    return placed;
  }
}

export default OreGenerator;
