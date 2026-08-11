/**
 * Phase 4: the five Nether biomes.
 *
 * These append to the Overworld biome table rather than replacing anything.
 * Two rules make that safe:
 *
 * 1. Ids continue from the end of the Overworld table, so a biome id already
 *    written into a save file still means what it used to mean.
 * 2. Every entry is flagged `nether: true`, and `BiomeGenerator` excludes those
 *    from `CLIMATE_BIOMES` -- the subset it blends between. Overworld terrain is
 *    therefore generated from exactly the same candidate set as before, so an
 *    existing world regenerates byte-identically.
 *
 * The module is deliberately free of THREE and of any renderer import so the
 * chunk worker can load it, and so it can be executed directly under Node in
 * the self-test.
 */

import { Block } from './BlockTypes.js';

/**
 * Id of the first Nether biome.
 *
 * The Overworld table currently ends at 44, so the Nether starts at 45.
 * `validateNetherBiomes` re-checks this against the real table; if someone adds
 * an Overworld biome without moving this constant, the self-test fails loudly
 * instead of two biomes silently sharing an id.
 */
export const NETHER_BIOME_BASE_ID = 45;

/** Nether biome ids. */
export const NetherBiome = Object.freeze({
  NETHER_WASTES: NETHER_BIOME_BASE_ID,
  SOUL_SAND_VALLEY: NETHER_BIOME_BASE_ID + 1,
  CRIMSON_FOREST: NETHER_BIOME_BASE_ID + 2,
  WARPED_FOREST: NETHER_BIOME_BASE_ID + 3,
  BASALT_DELTAS: NETHER_BIOME_BASE_ID + 4,
});

/**
 * `TreeType.NONE`, inlined as a literal on purpose.
 *
 * Importing it from `BiomeGenerator.js` would close an import cycle, because
 * that module imports this one. The binding would then still be in its temporal
 * dead zone while these definitions are being built at module-evaluation time.
 * The self-test asserts this literal still equals `TreeType.NONE`.
 */
const NO_TREE = 'none';

/**
 * @typedef {Object} NetherVegetation
 * @property {number} fungusChance Per-surface-column chance of a small fungus.
 * @property {number} rootsChance Per-column chance of a roots/sprouts tuft.
 * @property {number} hugeFungusChance Per-column chance of a huge fungus tree.
 * @property {number} vineChance Per-ceiling-column chance of hanging vines.
 * @property {number} fireChance Per-column chance of a fire block.
 * @property {number|null} fungus Small fungus block, or null.
 * @property {number|null} roots Ground tuft block, or null.
 * @property {number|null} vine Vine block, or null.
 * @property {boolean} vinesHangFromCeiling Weeping vines hang; twisting climb.
 * @property {number|null} fire Fire block used by this biome, or null.
 * @property {number|null} stem Huge fungus stem block, or null.
 * @property {number|null} wart Huge fungus cap block, or null.
 * @property {number|null} shroomlight Light block embedded in the cap, or null.
 */

/**
 * Builds one Nether biome, filling in the fields the Overworld biome consumers
 * expect (`tree`, `grassDensity`, `flowerDensity`, ...) so that anything which
 * reads a biome definition generically keeps working when handed a Nether one.
 */
function netherBiome(definition) {
  return Object.freeze({
    id: definition.id,
    name: definition.name,
    // Climate coordinates, used only to pick between Nether biomes.
    temperature: definition.temperature,
    moisture: definition.moisture,
    // Shape of the netherrack mass.
    baseHeight: definition.baseHeight ?? 64,
    amplitude: definition.amplitude ?? 1,
    roughness: definition.roughness ?? 1,
    floorVariance: definition.floorVariance ?? 6,
    ceilingVariance: definition.ceilingVariance ?? 8,
    // Materials.
    surface: definition.surface,
    subsurface: definition.subsurface,
    subsurfaceDepth: definition.subsurfaceDepth ?? 4,
    filler: definition.filler ?? Block.NETHERRACK,
    // Overworld compatibility fields. Nether decoration is done by
    // `NetherGenerator`, never by the Overworld structure pass, so these are
    // all inert.
    tree: NO_TREE,
    treeDensity: 0,
    grassDensity: 0,
    flowerDensity: 0,
    snowy: false,
    underground: false,
    // Nether marker. `BiomeGenerator` filters on this to keep the Overworld
    // climate blend unchanged.
    nether: true,
    // Presentation.
    grassTint: definition.grassTint,
    fogColour: definition.fogColour,
    ambientParticle: definition.ambientParticle ?? null,
    // Decoration.
    vegetation: Object.freeze({
      fungusChance: definition.vegetation?.fungusChance ?? 0,
      rootsChance: definition.vegetation?.rootsChance ?? 0,
      hugeFungusChance: definition.vegetation?.hugeFungusChance ?? 0,
      vineChance: definition.vegetation?.vineChance ?? 0,
      fireChance: definition.vegetation?.fireChance ?? 0,
      fungus: definition.vegetation?.fungus ?? null,
      roots: definition.vegetation?.roots ?? null,
      vine: definition.vegetation?.vine ?? null,
      vinesHangFromCeiling: definition.vegetation?.vinesHangFromCeiling ?? true,
      fire: definition.vegetation?.fire ?? null,
      stem: definition.vegetation?.stem ?? null,
      wart: definition.vegetation?.wart ?? null,
      shroomlight: definition.vegetation?.shroomlight ?? null,
    }),
    // Terrain features.
    glowstoneChance: definition.glowstoneChance ?? 0.012,
    magmaChance: definition.magmaChance ?? 0.01,
    basaltColumnChance: definition.basaltColumnChance ?? 0,
    lavaPoolChance: definition.lavaPoolChance ?? 0,
  });
}

/**
 * The five Nether biomes, in id order.
 * @type {ReadonlyArray<Object>}
 */
export const NETHER_BIOME_DEFINITIONS = Object.freeze([
  netherBiome({
    id: NetherBiome.NETHER_WASTES,
    name: 'Nether Wastes',
    temperature: 0,
    moisture: 0,
    surface: Block.NETHERRACK,
    subsurface: Block.NETHERRACK,
    grassTint: [150, 60, 56],
    fogColour: [88, 26, 20],
    glowstoneChance: 0.016,
    magmaChance: 0.012,
    lavaPoolChance: 0.02,
    vegetation: {
      rootsChance: 0.004,
      roots: Block.CRIMSON_ROOTS,
      fireChance: 0.006,
      fire: Block.FIRE,
    },
  }),
  netherBiome({
    id: NetherBiome.SOUL_SAND_VALLEY,
    name: 'Soul Sand Valley',
    temperature: -0.6,
    moisture: -0.5,
    surface: Block.SOUL_SAND,
    subsurface: Block.SOUL_SOIL,
    subsurfaceDepth: 6,
    floorVariance: 10,
    ceilingVariance: 14,
    grassTint: [120, 108, 92],
    fogColour: [30, 26, 32],
    ambientParticle: 'soul',
    glowstoneChance: 0.008,
    magmaChance: 0.004,
    vegetation: {
      rootsChance: 0.03,
      roots: Block.NETHER_SPROUTS,
      fireChance: 0.02,
      fire: Block.SOUL_FIRE,
    },
  }),
  netherBiome({
    id: NetherBiome.CRIMSON_FOREST,
    name: 'Crimson Forest',
    temperature: 0.7,
    moisture: 0.35,
    surface: Block.CRIMSON_NYLIUM,
    subsurface: Block.NETHERRACK,
    subsurfaceDepth: 3,
    grassTint: [148, 36, 44],
    fogColour: [65, 10, 10],
    ambientParticle: 'crimson_spore',
    glowstoneChance: 0.01,
    vegetation: {
      fungusChance: 0.06,
      fungus: Block.CRIMSON_FUNGUS,
      rootsChance: 0.14,
      roots: Block.CRIMSON_ROOTS,
      hugeFungusChance: 0.022,
      vineChance: 0.05,
      vine: Block.WEEPING_VINES,
      vinesHangFromCeiling: true,
      stem: Block.CRIMSON_STEM,
      wart: Block.NETHER_WART_BLOCK,
      shroomlight: Block.SHROOMLIGHT,
    },
  }),
  netherBiome({
    id: NetherBiome.WARPED_FOREST,
    name: 'Warped Forest',
    temperature: -0.2,
    moisture: 0.75,
    surface: Block.WARPED_NYLIUM,
    subsurface: Block.NETHERRACK,
    subsurfaceDepth: 3,
    grassTint: [30, 140, 132],
    fogColour: [10, 42, 44],
    ambientParticle: 'warped_spore',
    glowstoneChance: 0.01,
    vegetation: {
      fungusChance: 0.06,
      fungus: Block.WARPED_FUNGUS,
      rootsChance: 0.14,
      roots: Block.WARPED_ROOTS,
      hugeFungusChance: 0.024,
      vineChance: 0.05,
      vine: Block.TWISTING_VINES,
      vinesHangFromCeiling: false,
      stem: Block.WARPED_STEM,
      wart: Block.WARPED_WART_BLOCK,
      shroomlight: Block.SHROOMLIGHT,
    },
  }),
  netherBiome({
    id: NetherBiome.BASALT_DELTAS,
    name: 'Basalt Deltas',
    temperature: 0.55,
    moisture: -0.7,
    surface: Block.BASALT,
    subsurface: Block.BLACKSTONE,
    subsurfaceDepth: 5,
    filler: Block.BLACKSTONE,
    floorVariance: 12,
    ceilingVariance: 16,
    roughness: 1.6,
    grassTint: [96, 92, 96],
    fogColour: [22, 20, 22],
    ambientParticle: 'ash',
    glowstoneChance: 0.006,
    magmaChance: 0.05,
    basaltColumnChance: 0.05,
    lavaPoolChance: 0.05,
  }),
]);

/** Nether biome ids, in id order. */
export const NETHER_BIOME_IDS = Object.freeze(
  NETHER_BIOME_DEFINITIONS.map((definition) => definition.id)
);

/**
 * Looks up a Nether biome by id.
 * @param {number} id
 * @returns {Object|null}
 */
export function getNetherBiome(id) {
  const index = id - NETHER_BIOME_BASE_ID;
  return NETHER_BIOME_DEFINITIONS[index] ?? null;
}

/**
 * True when an id belongs to the Nether.
 * @param {number} id
 */
export function isNetherBiome(id) {
  return id >= NETHER_BIOME_BASE_ID
    && id < NETHER_BIOME_BASE_ID + NETHER_BIOME_DEFINITIONS.length;
}

/**
 * Picks the Nether biome closest to a climate point, using the same
 * inverse-distance idea as the Overworld blend but resolved to a single winner:
 * Nether biome boundaries are sharp, not gradients.
 *
 * @param {number} temperature -1..1
 * @param {number} moisture -1..1
 * @returns {Object} the winning biome definition
 */
export function selectNetherBiome(temperature, moisture) {
  let best = NETHER_BIOME_DEFINITIONS[0];
  let bestDistance = Infinity;
  for (const definition of NETHER_BIOME_DEFINITIONS) {
    const dt = definition.temperature - temperature;
    const dm = definition.moisture - moisture;
    const distance = (dt * dt) + (dm * dm);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = definition;
    }
  }
  return best;
}

/**
 * Verifies the Nether table is consistent with the Overworld table it appends
 * to. Called by the self-test so an id clash can never ship.
 *
 * @param {number} overworldBiomeCount `BIOMES.length` before the Nether entries.
 * @param {string} treeTypeNone The real `TreeType.NONE` value.
 * @returns {string[]} problems, empty when valid
 */
export function validateNetherBiomes(overworldBiomeCount, treeTypeNone) {
  const problems = [];
  if (overworldBiomeCount !== NETHER_BIOME_BASE_ID) {
    problems.push(
      `NETHER_BIOME_BASE_ID is ${NETHER_BIOME_BASE_ID} but the Overworld table `
      + `ends at ${overworldBiomeCount}; Nether ids would clash or leave a hole`
    );
  }
  if (treeTypeNone !== undefined && treeTypeNone !== NO_TREE) {
    problems.push(`TreeType.NONE is "${treeTypeNone}" but this module inlines "${NO_TREE}"`);
  }
  const seen = new Set();
  NETHER_BIOME_DEFINITIONS.forEach((definition, index) => {
    if (definition.id !== NETHER_BIOME_BASE_ID + index) {
      problems.push(`${definition.name} has id ${definition.id}, expected ${NETHER_BIOME_BASE_ID + index}`);
    }
    if (seen.has(definition.name)) problems.push(`duplicate biome name ${definition.name}`);
    seen.add(definition.name);
    if (!definition.nether) problems.push(`${definition.name} is missing the nether flag`);
    if (!Number.isInteger(definition.surface)) problems.push(`${definition.name} has no surface block`);
    if (!Number.isInteger(definition.subsurface)) problems.push(`${definition.name} has no subsurface block`);
    if (!Array.isArray(definition.fogColour) || definition.fogColour.length !== 3) {
      problems.push(`${definition.name} has no fog colour`);
    }
    const vegetation = definition.vegetation;
    if (vegetation.hugeFungusChance > 0 && (!vegetation.stem || !vegetation.wart)) {
      problems.push(`${definition.name} grows huge fungi but has no stem/cap block`);
    }
    if (vegetation.vineChance > 0 && !vegetation.vine) {
      problems.push(`${definition.name} places vines but has no vine block`);
    }
    if (vegetation.fungusChance > 0 && !vegetation.fungus) {
      problems.push(`${definition.name} places fungi but has no fungus block`);
    }
    if (vegetation.fireChance > 0 && !vegetation.fire) {
      problems.push(`${definition.name} places fire but has no fire block`);
    }
  });
  return problems;
}

export default NETHER_BIOME_DEFINITIONS;
