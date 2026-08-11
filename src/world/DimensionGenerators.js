/**
 * Phase 4: one place that knows which terrain generator belongs to which
 * dimension.
 *
 * Everything downstream -- the chunk worker, the worker pool's inline fallback,
 * and `World` -- asks this factory instead of constructing a generator itself.
 * That is what keeps "add a dimension" from meaning "edit five call sites".
 *
 * Seeds are salted here too, so a caller can never accidentally hand the Nether
 * the raw world seed and get terrain that mirrors the Overworld's noise.
 */

import { Dimension, dimensionSeed, getDimension, isDimension } from './DimensionConfig.js';
import { TerrainGenerator } from './TerrainGenerator.js';
import { NetherGenerator } from './NetherGenerator.js';
import { EndGenerator } from './EndGenerator.js';

/**
 * Dimensions that have a working generator today.
 *
 * The End is defined in `DimensionConfig` because portals, the sky and the save
 * format all need to know it exists, but its terrain landed in Phase 5. It is
 * listed as unimplemented rather than quietly aliased to the Overworld, so a
 * premature attempt to travel there fails with a clear message instead of
 * dropping the player into a copy of the Overworld and calling it the End.
 */
export const IMPLEMENTED_DIMENSIONS = Object.freeze([
  Dimension.OVERWORLD,
  Dimension.NETHER,
  Dimension.END,
]);

/**
 * True when a dimension can actually be generated.
 * @param {string} dimensionId
 */
export function isDimensionImplemented(dimensionId) {
  return IMPLEMENTED_DIMENSIONS.includes(dimensionId);
}

/**
 * Builds the terrain generator for a dimension.
 *
 * @param {string} dimensionId One of `Dimension.*`.
 * @param {number} worldSeed The unsalted world seed.
 * @returns {{generateChunk: Function, getSurfaceHeight: Function, sampleColumn: Function, findSpawn: Function}}
 */
export function createGenerator(dimensionId, worldSeed) {
  if (!isDimension(dimensionId)) {
    throw new Error(`Unknown dimension "${dimensionId}"`);
  }
  if (!isDimensionImplemented(dimensionId)) {
    throw new Error(
      `Dimension "${getDimension(dimensionId).name}" has no terrain generator yet`
    );
  }

  const seed = dimensionSeed(worldSeed, dimensionId);

  switch (dimensionId) {
    case Dimension.NETHER:
      return new NetherGenerator(seed);
    case Dimension.END:
      return new EndGenerator(seed);
    case Dimension.OVERWORLD:
    default:
      // The Overworld keeps the raw world seed. Its salt is zero, so
      // `dimensionSeed` is a no-op here and existing worlds regenerate exactly
      // as they did before dimensions existed.
      return new TerrainGenerator(seed);
  }
}

export default createGenerator;
