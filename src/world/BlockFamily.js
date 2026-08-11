/**
 * Data-driven block family generation.
 *
 * ## Why this exists
 *
 * A full clone needs roughly 250-300 blocks; this project has 73. Most of that
 * gap is not *new* blocks, it is the same thirteen variants repeated per wood
 * type and the same six repeated per stone type. Hand-writing them means
 * writing `oak_slab`, `spruce_slab`, `birch_slab`... and then editing all seven
 * again the first time slabs need a property changed.
 *
 * So the family is the unit of authoring: describe a wood once, get its log,
 * stripped log, planks, slab, stairs, fence, gate, door, trapdoor, button,
 * pressure plate and sign, plus the recipes that connect them.
 *
 * ## Scope note
 *
 * This module *generates and validates* descriptors in exactly the shape
 * `BlockTypes.block()` accepts. It deliberately does not mutate the live `Block`
 * enum: block IDs are baked into every saved chunk, so renumbering them is a
 * save-format migration, not a refactor. `allocateIds` exists to do that
 * assignment safely and reproducibly when the catalogue is expanded.
 */

/**
 * Local mirrors of `BlockTypes.RenderShape` / `BlockTypes.SoundGroup`.
 *
 * Declared here rather than imported because `BlockTypes.js` now imports *this*
 * module to generate its catalogue. An ES module cycle would leave the imported
 * bindings in the temporal dead zone at the moment `VARIANT_RULES` is
 * evaluated, throwing at load. `selftest.mjs` asserts these stay identical to
 * the real enums, so the duplication cannot silently drift.
 */
const RenderShape = Object.freeze({ CUBE: 'cube', BOXES: 'boxes' });
const SoundGroup = Object.freeze({ WOOD: 'wood', STONE: 'stone' });

/** Exported purely so the test suite can compare them against BlockTypes. */
export const FAMILY_RENDER_SHAPES = RenderShape;
export const FAMILY_SOUND_GROUPS = SoundGroup;

/** Variants produced for a wood family, in stable order. */
export const WOOD_VARIANTS = Object.freeze([
  'log',
  'stripped_log',
  'wood',
  'planks',
  'slab',
  'stairs',
  'fence',
  'fence_gate',
  'door',
  'trapdoor',
  'button',
  'pressure_plate',
  'sign',
]);

/** Variants produced for a stone family, in stable order. */
export const STONE_VARIANTS = Object.freeze([
  'base',
  'polished',
  'bricks',
  'slab',
  'stairs',
  'wall',
]);

/** Per-variant rules shared by every family. */
const VARIANT_RULES = Object.freeze({
  log: { hardness: 2, shape: RenderShape.CUBE, solid: true },
  stripped_log: { hardness: 2, shape: RenderShape.CUBE, solid: true },
  wood: { hardness: 2, shape: RenderShape.CUBE, solid: true },
  planks: { hardness: 2, shape: RenderShape.CUBE, solid: true },
  base: { hardness: 1.5, shape: RenderShape.CUBE, solid: true },
  polished: { hardness: 1.5, shape: RenderShape.CUBE, solid: true },
  bricks: { hardness: 1.5, shape: RenderShape.CUBE, solid: true },
  slab: { hardness: 1.5, shape: RenderShape.BOXES, solid: false, transparent: true },
  stairs: { hardness: 1.5, shape: RenderShape.BOXES, solid: false, transparent: true },
  fence: { hardness: 2, shape: RenderShape.BOXES, solid: false, transparent: true },
  wall: { hardness: 2, shape: RenderShape.BOXES, solid: false, transparent: true },
  fence_gate: { hardness: 2, shape: RenderShape.BOXES, solid: false, transparent: true },
  door: { hardness: 3, shape: RenderShape.BOXES, solid: false, transparent: true },
  trapdoor: { hardness: 3, shape: RenderShape.BOXES, solid: false, transparent: true },
  button: { hardness: 0.5, shape: RenderShape.BOXES, solid: false, transparent: true, collidable: false },
  pressure_plate: { hardness: 0.5, shape: RenderShape.BOXES, solid: false, transparent: true, collidable: false },
  sign: { hardness: 1, shape: RenderShape.BOXES, solid: false, transparent: true, collidable: false },
});

/** Human-readable suffix per variant. */
const VARIANT_LABELS = Object.freeze({
  log: 'Log',
  stripped_log: 'Stripped Log',
  wood: 'Wood',
  planks: 'Planks',
  base: '',
  polished: 'Polished',
  bricks: 'Bricks',
  slab: 'Slab',
  stairs: 'Stairs',
  fence: 'Fence',
  wall: 'Wall',
  fence_gate: 'Fence Gate',
  door: 'Door',
  trapdoor: 'Trapdoor',
  button: 'Button',
  pressure_plate: 'Pressure Plate',
  sign: 'Sign',
});

/** Turns `dark_oak` into `Dark Oak`. */
export function titleCase(id) {
  return String(id)
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Name of a family variant, e.g. `('spruce', 'slab')` -> `spruce_slab`.
 * The base stone variant is the family name itself: `granite`, not
 * `granite_base`.
 */
export function variantName(familyId, variant) {
  if (variant === 'base') return familyId;
  if (variant === 'polished' || variant === 'stripped_log') {
    const prefix = variant === 'polished' ? 'polished' : 'stripped';
    const suffix = variant === 'stripped_log' ? '_log' : '';
    return `${prefix}_${familyId}${suffix}`;
  }
  return `${familyId}_${variant}`;
}

/** Display name of a family variant. */
export function variantDisplayName(familyId, variant) {
  const label = VARIANT_LABELS[variant] ?? titleCase(variant);
  const base = titleCase(familyId);
  if (variant === 'base') return base;
  if (variant === 'polished') return `Polished ${base}`;
  if (variant === 'stripped_log') return `Stripped ${base} Log`;
  return `${base} ${label}`.trim();
}

function buildVariant(family, variant) {
  const rules = VARIANT_RULES[variant];
  if (!rules) throw new Error(`unknown variant "${variant}"`);

  const wood = family.kind === 'wood';
  const texture = family.textures?.[variant] ?? family.textures?.default ?? family.id;

  return {
    name: variantName(family.id, variant),
    displayName: variantDisplayName(family.id, variant),
    family: family.id,
    variant,
    textureAll: texture,
    preferredTool: wood ? 'axe' : 'pickaxe',
    recipeTags: [wood ? 'wooden' : 'stone_material', variant],
    solid: rules.solid,
    collidable: rules.collidable !== false,
    transparent: rules.transparent === true,
    renderShape: rules.shape,
    // A slab or fence must not block skylight the way a full cube does, or
    // fenced gardens render pitch black underneath.
    lightAttenuation: rules.solid ? 15 : 0,
    hardness: rules.hardness * (family.hardnessScale ?? 1),
    soundGroup: wood ? SoundGroup.WOOD : SoundGroup.STONE,
    flammable: wood && variant !== 'door',
  };
}

/**
 * Expands a family description into block descriptors.
 *
 * @param {{id:string, kind:'wood'|'stone', textures?:Object, variants?:string[], hardnessScale?:number}} family
 * @returns {Object[]}
 */
export function buildFamily(family) {
  if (!family?.id || typeof family.id !== 'string') throw new Error('family needs a string id');
  if (family.kind !== 'wood' && family.kind !== 'stone') {
    throw new Error(`family "${family.id}" needs kind "wood" or "stone"`);
  }
  const variants = family.variants ?? (family.kind === 'wood' ? WOOD_VARIANTS : STONE_VARIANTS);
  return variants.map((variant) => buildVariant(family, variant));
}

/**
 * Expands many families at once.
 * @param {Object[]} families
 * @returns {Object[]}
 */
export function buildFamilies(families) {
  const out = [];
  for (const family of families) out.push(...buildFamily(family));
  return out;
}

/**
 * Recipes implied by a family.
 *
 * Generated rather than authored for the same reason as the blocks: the shape
 * of "4 planks -> 4 sticks worth of fence" does not change per wood type, and
 * duplicating it seven times guarantees the seventh is subtly wrong.
 *
 * @param {{id:string, kind:string}} family
 * @returns {Object[]}
 */
export function familyRecipes(family) {
  const name = (variant) => variantName(family.id, variant);
  if (family.kind === 'wood') {
    return [
      { output: name('planks'), count: 4, ingredients: [{ item: name('log'), count: 1 }], shapeless: true },
      { output: name('slab'), count: 6, ingredients: [{ item: name('planks'), count: 3 }] },
      { output: name('stairs'), count: 4, ingredients: [{ item: name('planks'), count: 6 }] },
      { output: name('fence'), count: 3, ingredients: [{ item: name('planks'), count: 4 }, { item: 'stick', count: 2 }] },
      { output: name('fence_gate'), count: 1, ingredients: [{ item: name('planks'), count: 2 }, { item: 'stick', count: 4 }] },
      { output: name('door'), count: 3, ingredients: [{ item: name('planks'), count: 6 }] },
      { output: name('trapdoor'), count: 2, ingredients: [{ item: name('planks'), count: 6 }] },
      { output: name('button'), count: 1, ingredients: [{ item: name('planks'), count: 1 }], shapeless: true },
      { output: name('pressure_plate'), count: 1, ingredients: [{ item: name('planks'), count: 2 }] },
      { output: name('sign'), count: 3, ingredients: [{ item: name('planks'), count: 6 }, { item: 'stick', count: 1 }] },
    ];
  }
  return [
    { output: name('polished'), count: 4, ingredients: [{ item: name('base'), count: 4 }] },
    { output: name('bricks'), count: 4, ingredients: [{ item: name('polished'), count: 4 }] },
    { output: name('slab'), count: 6, ingredients: [{ item: name('base'), count: 3 }] },
    { output: name('stairs'), count: 4, ingredients: [{ item: name('base'), count: 6 }] },
    { output: name('wall'), count: 6, ingredients: [{ item: name('base'), count: 6 }] },
  ];
}

/**
 * Validates generated descriptors.
 * @param {Object[]} descriptors
 * @returns {string[]} Problems; empty means valid.
 */
export function validateFamilyBlocks(descriptors) {
  const problems = [];
  const seen = new Set();
  for (const entry of descriptors) {
    if (seen.has(entry.name)) problems.push(`duplicate block name "${entry.name}"`);
    seen.add(entry.name);
    if (!entry.displayName) problems.push(`${entry.name}: missing displayName`);
    if (!Number.isFinite(entry.hardness) || entry.hardness <= 0) {
      problems.push(`${entry.name}: hardness must be positive`);
    }
    if (entry.solid && entry.transparent) {
      problems.push(`${entry.name}: a solid block cannot also be transparent`);
    }
    if (!entry.solid && entry.lightAttenuation > 0) {
      problems.push(`${entry.name}: non-solid blocks must not attenuate light`);
    }
  }
  return problems;
}

/**
 * Assigns numeric ids without colliding with the existing catalogue.
 *
 * Ids are handed out in the descriptors' stable order starting from the first
 * free slot, so regenerating the same families twice produces the same numbers
 * — a property saved worlds depend on absolutely.
 *
 * @param {Object[]} descriptors
 * @param {number[]} usedIds Ids already taken.
 * @param {number} [max] Exclusive upper bound.
 * @returns {{assignments:Object[], nextId:number}}
 */
export function allocateIds(descriptors, usedIds, max = 4096) {
  const taken = new Set(usedIds);
  const assignments = [];
  let cursor = 0;
  for (const descriptor of descriptors) {
    while (taken.has(cursor)) cursor++;
    if (cursor >= max) throw new Error(`block id space exhausted at ${max}`);
    taken.add(cursor);
    assignments.push({ ...descriptor, id: cursor });
    cursor++;
  }
  return { assignments, nextId: cursor };
}

/** The wood families a full Overworld needs. */
export const WOOD_FAMILIES = Object.freeze([
  { id: 'oak', kind: 'wood', textures: { default: 'planks', log: 'oak_log_side', stripped_log: 'stripped_oak_log_side', wood: 'oak_log_side' } },
  { id: 'spruce', kind: 'wood', textures: { default: 'spruce_planks', log: 'spruce_log_side', stripped_log: 'stripped_spruce_log_side', wood: 'spruce_log_side' } },
  { id: 'birch', kind: 'wood', textures: { default: 'birch_planks', log: 'birch_log_side', stripped_log: 'stripped_birch_log_side', wood: 'birch_log_side' } },
  { id: 'jungle', kind: 'wood', textures: { default: 'jungle_planks', log: 'jungle_log_side', stripped_log: 'stripped_jungle_log_side', wood: 'jungle_log_side' } },
  { id: 'acacia', kind: 'wood', textures: { default: 'acacia_planks', log: 'acacia_log_side', stripped_log: 'stripped_acacia_log_side', wood: 'acacia_log_side' } },
  { id: 'dark_oak', kind: 'wood', textures: { default: 'dark_oak_planks', log: 'dark_oak_log_side', stripped_log: 'stripped_dark_oak_log_side', wood: 'dark_oak_log_side' } },
  { id: 'mangrove', kind: 'wood', textures: { default: 'mangrove_planks', log: 'mangrove_log_side', stripped_log: 'stripped_mangrove_log_side', wood: 'mangrove_log_side' } },
]);

/** The stone families a full Overworld needs. */
export const STONE_FAMILIES = Object.freeze([
  { id: 'granite', kind: 'stone', textures: { default: 'granite', polished: 'polished_granite', bricks: 'granite_bricks' } },
  { id: 'diorite', kind: 'stone', textures: { default: 'diorite', polished: 'polished_diorite', bricks: 'diorite_bricks' } },
  { id: 'andesite', kind: 'stone', textures: { default: 'andesite', polished: 'polished_andesite', bricks: 'andesite_bricks' } },
  { id: 'deepslate', kind: 'stone', textures: { default: 'deepslate', polished: 'polished_deepslate', bricks: 'deepslate_bricks' }, hardnessScale: 2 },
  { id: 'tuff', kind: 'stone', textures: { default: 'tuff', polished: 'polished_tuff', bricks: 'tuff_bricks' } },
  { id: 'calcite', kind: 'stone', textures: { default: 'calcite', polished: 'polished_calcite', bricks: 'calcite_bricks' } },
]);

/** Every planned family. */
export const ALL_FAMILIES = Object.freeze([...WOOD_FAMILIES, ...STONE_FAMILIES]);

/** Block count the full expansion produces. */
export function plannedBlockCount() {
  return WOOD_FAMILIES.length * WOOD_VARIANTS.length + STONE_FAMILIES.length * STONE_VARIANTS.length;
}

export default buildFamily;
