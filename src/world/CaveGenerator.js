/**
 * Cave carving.
 *
 * Two independent systems are combined, which is what stops caves from looking
 * like one repeated noise pattern:
 *
 *  - **Tunnels** ("spaghetti"): the *intersection* of two ridged 3D noise
 *    fields. A single ridged field produces sheets; requiring two of them to
 *    peak at the same point leaves long, winding, roughly tubular passages.
 *  - **Caverns** ("cheese"): a low-frequency 3D fBm threshold, restricted to
 *    deeper layers, which opens the occasional large room.
 *
 * Both are faded out near the surface so cave mouths are an occasional feature
 * rather than the terrain being perforated everywhere, and neither is allowed to
 * breach the floor of an ocean (which would silently drain it, since water is
 * only placed in open ocean columns).
 *
 * The carve decision for a voxel depends only on its world position and the
 * seed, so the same passage continues seamlessly across chunk borders.
 *
 * Worker-safe.
 */

import { BEDROCK_HEIGHT, SEA_LEVEL } from '../config/GameConfig.js';
import { clamp01, smoothstep } from '../utils/MathUtils.js';
import { NoiseSet } from './Noise.js';
import { Block } from './BlockTypes.js';
import { IS_LIQUID } from './BlockRegistry.js';

/** Highest Y that tunnels are allowed to reach. */
const TUNNEL_CEILING = SEA_LEVEL + 26;
/** Y below which large caverns may form. */
const CAVERN_CEILING = SEA_LEVEL - 8;
/** Blocks of solid rock kept beneath an ocean floor. */
const OCEAN_FLOOR_MARGIN = 6;
/** Blocks of rock kept beneath a land surface before a cave may open. */
const SURFACE_MARGIN = 4;

export class CaveGenerator {
  /**
   * @param {number} seed
   */
  constructor(seed) {
    this.seed = seed >>> 0;
    this._noise = new NoiseSet(this.seed ^ 0x5eed_cafe, [
      'tunnelA',
      'tunnelB',
      'cavern',
      'density',
    ]);
  }

  /**
   * Carves caves into an already-shaped chunk.
   *
   * @param {Uint16Array} blocks Chunk voxel data, mutated in place.
   * @param {number} chunkX
   * @param {number} chunkZ
   * @param {Int16Array} heightMap 16x16 surface heights, indexed `x + z * 16`.
   * @param {(localX:number, y:number, localZ:number) => number} indexOf
   * @returns {number} Number of voxels removed, for diagnostics.
   */
  carve(blocks, chunkX, chunkZ, heightMap, indexOf) {
    const tunnelA = this._noise.get('tunnelA');
    const tunnelB = this._noise.get('tunnelB');
    const cavern = this._noise.get('cavern');
    const density = this._noise.get('density');

    const originX = chunkX * 16;
    const originZ = chunkZ * 16;
    let carved = 0;

    for (let localZ = 0; localZ < 16; localZ++) {
      const worldZ = originZ + localZ;
      for (let localX = 0; localX < 16; localX++) {
        const worldX = originX + localX;
        const surface = heightMap[localX + localZ * 16];

        // How high caves may reach in this column.
        const isOceanColumn = surface < SEA_LEVEL;
        const columnCeiling = Math.min(
          TUNNEL_CEILING,
          surface - (isOceanColumn ? OCEAN_FLOOR_MARGIN : SURFACE_MARGIN)
        );
        if (columnCeiling <= BEDROCK_HEIGHT + 1) continue;

        // A slowly varying field that locally suppresses or encourages caves,
        // so some regions are honeycombed and others nearly solid.
        const regionBias = density.noise2(worldX * 0.0032, worldZ * 0.0032) * 0.12;

        for (let y = BEDROCK_HEIGHT + 1; y <= columnCeiling; y++) {
          const index = indexOf(localX, y, localZ);
          const current = blocks[index];
          if (current === Block.AIR || current === Block.BEDROCK || IS_LIQUID[current]) continue;

          // Fade caves out as they approach the surface and the bedrock.
          const surfaceFade = smoothstep(columnCeiling, columnCeiling - 10, y);
          const floorFade = smoothstep(BEDROCK_HEIGHT, BEDROCK_HEIGHT + 5, y);
          const openness = surfaceFade * floorFade;
          if (openness <= 0.001) continue;

          // Squashing Y makes passages run more horizontally, which reads as
          // "caves" rather than "vertical shafts".
          const ny = y * 1.7;

          const a = ridgedValue(tunnelA, worldX * 0.0132, ny * 0.0132, worldZ * 0.0132);
          if (a < 0.62) continue; // cheap early out: most voxels stop here
          const b = ridgedValue(tunnelB, worldX * 0.0129 + 91.3, ny * 0.0129, worldZ * 0.0129 - 47.7);

          const tunnelThreshold = 0.72 - openness * 0.1 - regionBias;
          let carve = a > tunnelThreshold && b > tunnelThreshold;

          if (!carve && y < CAVERN_CEILING) {
            const room = cavern.fbm3(worldX * 0.019, y * 0.031, worldZ * 0.019, 2, 1, 2.1, 0.5);
            const depthBonus = clamp01((CAVERN_CEILING - y) / 40) * 0.1;
            carve = room > 0.56 - depthBonus - regionBias;
          }

          if (carve) {
            blocks[index] = Block.AIR;
            carved++;
          }
        }
      }
    }
    return carved;
  }
}

/** Single-octave ridged value in `[0, 1]`; sharper and ~3x cheaper than fBm. */
function ridgedValue(noise, x, y, z) {
  const signal = 1 - Math.abs(noise.noise3(x, y, z));
  return signal * signal;
}

export default CaveGenerator;
