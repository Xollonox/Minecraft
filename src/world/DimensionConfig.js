/**
 * Per-dimension world parameters.
 *
 * ## Why this exists
 *
 * FinalV2 imported `WORLD_HEIGHT` and `SEA_LEVEL` directly from `GameConfig` in
 * twenty-odd modules. That is correct for a single-dimension game and fatal for a
 * three-dimension one: the Nether has a solid ceiling and no sea, and the End has
 * no sky and floating islands over a void. Hard-coding the Overworld's numbers
 * into the mesher, the lighting pass and the navigator means adding a dimension
 * later requires touching every one of those files.
 *
 * This registry is the seam. Systems that care about world shape take a
 * `DimensionConfig` instead of importing the constants, and the Overworld config
 * is byte-identical to the old constants — so this change is behaviour-preserving
 * today and load-bearing in Phase 4 and Phase 5.
 *
 * ## Invariants every dimension must satisfy
 *
 *  - `height` matches `GameConfig.WORLD_HEIGHT`. The chunk storage, the padded
 *    mesh volume and the light volume are all sized from that constant at module
 *    load, so a dimension cannot currently choose its own height. Dimensions vary
 *    by *what they put in* those 128 blocks, not by how many there are.
 *  - `seaLevel` is inside `[0, height)`, or `null` for a dimension with no sea.
 *  - `skyLight` false means the lighting pass seeds no sunlight, which is what
 *    makes the Nether and the End dark by default rather than by painting them.
 */

import { SEA_LEVEL, WORLD_HEIGHT } from '../config/GameConfig.js';

/** @enum {string} */
export const Dimension = Object.freeze({
  OVERWORLD: 'overworld',
  NETHER: 'nether',
  END: 'end',
});

/**
 * @typedef {Object} DimensionDefinition
 * @property {string} id
 * @property {string} name Player-facing name.
 * @property {number} height Build height in blocks.
 * @property {number|null} seaLevel Y of the liquid surface, or null.
 * @property {boolean} hasCeiling True when the top of the world is solid.
 * @property {boolean} skyLight True when the lighting pass seeds sunlight.
 * @property {boolean} hasWeather True when the weather system runs here.
 * @property {boolean} hasDayNight True when the sky animates on the world clock.
 * @property {number} ambientLight Baseline light level 0..15 with no sources.
 * @property {number} respawnY Fallback spawn height.
 * @property {number} coordinateScale Blocks travelled per Overworld block.
 * @property {number} seedSalt Mixed into the world seed so dimensions differ.
 */

/** @type {Readonly<Record<string, DimensionDefinition>>} */
export const DIMENSIONS = Object.freeze({
  [Dimension.OVERWORLD]: Object.freeze({
    id: Dimension.OVERWORLD,
    name: 'Overworld',
    height: WORLD_HEIGHT,
    seaLevel: SEA_LEVEL,
    hasCeiling: false,
    skyLight: true,
    hasWeather: true,
    hasDayNight: true,
    ambientLight: 0,
    respawnY: SEA_LEVEL + 8,
    coordinateScale: 1,
    seedSalt: 0x0000_0000,
  }),
  [Dimension.NETHER]: Object.freeze({
    id: Dimension.NETHER,
    name: 'The Nether',
    height: WORLD_HEIGHT,
    // Lava sea rather than water, and much lower in the column.
    seaLevel: 31,
    hasCeiling: true,
    skyLight: false,
    hasWeather: false,
    hasDayNight: false,
    // A dim red glow everywhere, so caves are navigable without torches.
    ambientLight: 4,
    respawnY: 64,
    // The classic 8:1 ratio: one Nether block is eight Overworld blocks.
    coordinateScale: 8,
    seedSalt: 0x4e45_5448,
  }),
  [Dimension.END]: Object.freeze({
    id: Dimension.END,
    name: 'The End',
    height: WORLD_HEIGHT,
    seaLevel: null,
    hasCeiling: false,
    skyLight: false,
    hasWeather: false,
    hasDayNight: false,
    ambientLight: 2,
    respawnY: 72,
    coordinateScale: 1,
    seedSalt: 0x0054_4845,
  }),
});

/** Every dimension id, in progression order. */
export const DIMENSION_IDS = Object.freeze([
  Dimension.OVERWORLD,
  Dimension.NETHER,
  Dimension.END,
]);

/**
 * Looks up a dimension, falling back to the Overworld.
 *
 * Never throws: an unknown id in a save record should drop the player in the
 * Overworld, not fail the world load.
 *
 * @param {string} id
 * @returns {DimensionDefinition}
 */
export function getDimension(id) {
  return DIMENSIONS[id] || DIMENSIONS[Dimension.OVERWORLD];
}

/** True when `id` names a real dimension. */
export function isDimension(id) {
  return Object.prototype.hasOwnProperty.call(DIMENSIONS, id);
}

/**
 * The Y a dimension's terrain generator should treat as its build ceiling.
 *
 * A dimension with a solid ceiling reserves the top two layers for bedrock, the
 * same way the Overworld reserves the bottom two.
 */
export function buildCeiling(definition) {
  const dimension = typeof definition === 'string' ? getDimension(definition) : definition;
  return dimension.hasCeiling ? dimension.height - 2 : dimension.height;
}

/**
 * Converts a horizontal coordinate between dimensions.
 *
 * Y is deliberately not scaled — portals preserve height, so a portal built at
 * y=70 in the Overworld links to y=70 in the Nether.
 *
 * @param {{x:number, z:number}} position
 * @param {string} fromId
 * @param {string} toId
 * @returns {{x:number, z:number}}
 */
export function convertCoordinates(position, fromId, toId) {
  const from = getDimension(fromId);
  const to = getDimension(toId);
  const ratio = from.coordinateScale / to.coordinateScale;
  return {
    x: Math.floor(position.x * ratio),
    z: Math.floor(position.z * ratio),
  };
}

/**
 * The seed a dimension's generators should use.
 *
 * Salting rather than reusing the world seed means the Nether's cave noise is
 * not a recoloured copy of the Overworld's at the same coordinates.
 */
export function dimensionSeed(worldSeed, id) {
  const definition = getDimension(id);
  return ((worldSeed >>> 0) ^ definition.seedSalt) >>> 0;
}

/**
 * Validates a definition. Exercised by the self-test so a future dimension
 * cannot be added with an out-of-range sea level or a mismatched height.
 *
 * @returns {string[]} Problems found; empty means valid.
 */
export function validateDimension(definition) {
  const problems = [];
  if (!definition || typeof definition !== 'object') return ['not an object'];
  if (definition.height !== WORLD_HEIGHT) {
    problems.push(`height ${definition.height} !== WORLD_HEIGHT ${WORLD_HEIGHT}`);
  }
  if (definition.seaLevel !== null) {
    if (!Number.isInteger(definition.seaLevel)) problems.push('seaLevel must be an integer or null');
    else if (definition.seaLevel < 0 || definition.seaLevel >= definition.height) {
      problems.push(`seaLevel ${definition.seaLevel} outside [0, ${definition.height})`);
    }
  }
  if (!Number.isInteger(definition.ambientLight) || definition.ambientLight < 0 || definition.ambientLight > 15) {
    problems.push('ambientLight must be an integer 0..15');
  }
  if (!(definition.coordinateScale > 0)) problems.push('coordinateScale must be positive');
  if (definition.respawnY < 0 || definition.respawnY >= definition.height) {
    problems.push(`respawnY ${definition.respawnY} outside the world`);
  }
  if (definition.hasWeather && !definition.skyLight) {
    problems.push('a dimension without sky light cannot have weather');
  }
  return problems;
}

export default DIMENSIONS;
