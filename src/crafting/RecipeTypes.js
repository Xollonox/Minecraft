/**
 * Recipe kinds, ingredient matching and the normalisers.
 *
 * Mirrors the `BlockTypes` -> `BlockRegistry` split: this module defines the
 * *shape* of a recipe and how one ingredient slot is satisfied, `Recipes.js`
 * holds the data, and `RecipeRegistry.js` indexes and matches. Keeping matching
 * here rather than in the registry means it can be reasoned about — and tested —
 * without building an index first.
 *
 * ## Ingredients
 *
 * An ingredient slot accepts one of three forms, in increasing generality:
 *
 *  - `'oak_log'` — exactly that item.
 *  - `'#wooden'` — any item carrying the `wooden` recipe tag.
 *  - `['coal', 'charcoal']` — any of these, each of which may itself be a tag.
 *
 * Tags matter because "planks" is four different items. Without them every recipe
 * that consumes planks would need four copies, and adding a fifth wood type would
 * mean editing every one of them.
 *
 * ## Why recipe ids are explicit strings
 *
 * Recipe ids appear in the recipe book's save data (which recipes the player has
 * unlocked) and in quest objectives. Deriving an id from the output would break
 * the moment two recipes produce the same item — and there are several: planks
 * come from four log types.
 *
 * Worker-safe: no DOM, no Three.js.
 */

import { getItem, isValidItemId, itemsWithTag } from '../items/ItemRegistry.js';

/** Recipe kinds. */
export const RecipeKind = Object.freeze({
  /** Position matters. Matched at any offset within the grid. */
  SHAPED: 'shaped',
  /** Only the multiset of ingredients matters. */
  SHAPELESS: 'shapeless',
  /** One input, one output, consumed over time in a furnace. */
  SMELTING: 'smelting',
});

/** Which grid a recipe can be crafted in. */
export const CraftingStation = Object.freeze({
  /** The 2x2 grid carried by the player. */
  PLAYER: 'player',
  /** The 3x3 grid of a crafting table. */
  TABLE: 'table',
  /** A furnace. */
  FURNACE: 'furnace',
});

/** Default furnace cook time, in seconds. */
export const DEFAULT_COOK_SECONDS = 10;

/**
 * @typedef {string|string[]} Ingredient
 */

/**
 * @typedef {Object} RecipeResult
 * @property {string} id Item id produced.
 * @property {number} count How many.
 */

/**
 * @typedef {Object} Recipe
 * @property {string} id Stable identifier.
 * @property {string} kind One of `RecipeKind`.
 * @property {string} station One of `CraftingStation`.
 * @property {number} width Pattern width (shaped only).
 * @property {number} height Pattern height (shaped only).
 * @property {Array<Ingredient|null>} grid Row-major pattern (shaped only).
 * @property {Ingredient[]} ingredients Flat list (shapeless and smelting).
 * @property {boolean} mirrored Whether a horizontally flipped match counts.
 * @property {RecipeResult} result
 * @property {number} cookSeconds Furnace duration (smelting only).
 * @property {string} group Recipe-book grouping key.
 */

/**
 * Validates and freezes an ingredient.
 *
 * Throws on an unknown item or an empty tag, because both fail silently
 * otherwise: the recipe simply never matches, and there is nothing in the log to
 * say why.
 *
 * @param {Ingredient} ingredient
 * @param {string} recipeId For error messages.
 * @returns {Ingredient}
 */
function normaliseIngredient(ingredient, recipeId) {
  if (Array.isArray(ingredient)) {
    if (ingredient.length === 0) {
      throw new Error(`Recipe "${recipeId}" has an empty alternatives list`);
    }
    return Object.freeze(ingredient.map((entry) => normaliseIngredient(entry, recipeId)));
  }
  if (typeof ingredient !== 'string' || ingredient.length === 0) {
    throw new Error(`Recipe "${recipeId}" has a malformed ingredient ${JSON.stringify(ingredient)}`);
  }
  if (ingredient.startsWith('#')) {
    const tag = ingredient.slice(1);
    if (itemsWithTag(tag).length === 0) {
      throw new Error(`Recipe "${recipeId}" uses tag "${tag}", which no item carries`);
    }
    return ingredient;
  }
  if (!isValidItemId(ingredient)) {
    throw new Error(`Recipe "${recipeId}" uses unknown item "${ingredient}"`);
  }
  return ingredient;
}

/**
 * Whether a stack satisfies an ingredient slot.
 *
 * @param {Ingredient|null} ingredient Null means the slot must be empty.
 * @param {import('../items/ItemStack.js').ItemStack|null} stack
 * @returns {boolean}
 */
export function matchesIngredient(ingredient, stack) {
  if (ingredient === null || ingredient === undefined) return stack === null;
  if (!stack || stack.isEmpty) return false;

  if (Array.isArray(ingredient)) {
    return ingredient.some((entry) => matchesIngredient(entry, stack));
  }
  if (ingredient.startsWith('#')) {
    return getItem(stack.itemId)?.recipeTags.includes(ingredient.slice(1)) === true;
  }
  return stack.itemId === ingredient;
}

/**
 * Every item id that could satisfy an ingredient, for the recipe book.
 * @param {Ingredient|null} ingredient
 * @returns {string[]}
 */
export function ingredientOptions(ingredient) {
  if (ingredient === null || ingredient === undefined) return [];
  if (Array.isArray(ingredient)) {
    return [...new Set(ingredient.flatMap((entry) => ingredientOptions(entry)))];
  }
  if (ingredient.startsWith('#')) return itemsWithTag(ingredient.slice(1));
  return [ingredient];
}

/**
 * Builds a shaped recipe.
 *
 * The pattern is an array of equal-length strings; a space is an empty slot. A
 * `key` maps each character to an ingredient. This is far easier to read and to
 * diff than a flat array of nine entries, and it makes an accidentally ragged
 * pattern a load-time error.
 *
 * @param {Object} definition
 * @returns {Recipe}
 */
export function shaped(definition) {
  const id = requireId(definition);
  const pattern = definition.pattern;
  if (!Array.isArray(pattern) || pattern.length === 0) {
    throw new Error(`Shaped recipe "${id}" needs a pattern`);
  }
  const height = pattern.length;
  const width = pattern[0].length;
  if (width === 0) throw new Error(`Shaped recipe "${id}" has a zero-width pattern`);
  for (const row of pattern) {
    if (typeof row !== 'string' || row.length !== width) {
      throw new Error(`Shaped recipe "${id}" has a ragged pattern`);
    }
  }
  if (width > 3 || height > 3) {
    throw new Error(`Shaped recipe "${id}" is ${width}x${height}; the largest grid is 3x3`);
  }

  const key = definition.key ?? {};
  /** @type {Array<Ingredient|null>} */
  const grid = [];
  for (const row of pattern) {
    for (const character of row) {
      if (character === ' ') {
        grid.push(null);
        continue;
      }
      const ingredient = key[character];
      if (ingredient === undefined) {
        throw new Error(`Shaped recipe "${id}" uses "${character}" with no key entry`);
      }
      grid.push(normaliseIngredient(ingredient, id));
    }
  }

  // A recipe that fits in 2x2 is craftable without a table. Deriving this rather
  // than declaring it removes a whole class of "why can't I craft this by hand"
  // inconsistency.
  const station =
    definition.station ??
    (width <= 2 && height <= 2 ? CraftingStation.PLAYER : CraftingStation.TABLE);

  return Object.freeze({
    id,
    kind: RecipeKind.SHAPED,
    station,
    width,
    height,
    grid: Object.freeze(grid),
    ingredients: Object.freeze(grid.filter((entry) => entry !== null)),
    // Mirrored by default: a player who lays out a symmetric-looking recipe
    // left-handed should not be silently refused. Recipes where handedness is
    // meaningful can opt out.
    mirrored: definition.mirrored ?? true,
    result: normaliseResult(definition.result, id),
    cookSeconds: 0,
    group: definition.group ?? definition.result.id,
  });
}

/**
 * Builds a shapeless recipe: any arrangement, as long as the counts match.
 * @param {Object} definition
 * @returns {Recipe}
 */
export function shapeless(definition) {
  const id = requireId(definition);
  const list = definition.ingredients;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`Shapeless recipe "${id}" needs ingredients`);
  }
  if (list.length > 9) {
    throw new Error(`Shapeless recipe "${id}" has ${list.length} ingredients; the grid holds 9`);
  }
  const ingredients = Object.freeze(list.map((entry) => normaliseIngredient(entry, id)));

  return Object.freeze({
    id,
    kind: RecipeKind.SHAPELESS,
    station:
      definition.station ?? (list.length <= 4 ? CraftingStation.PLAYER : CraftingStation.TABLE),
    width: 0,
    height: 0,
    grid: Object.freeze([]),
    ingredients,
    mirrored: false,
    result: normaliseResult(definition.result, id),
    cookSeconds: 0,
    group: definition.group ?? definition.result.id,
  });
}

/**
 * Builds a smelting recipe.
 * @param {Object} definition
 * @returns {Recipe}
 */
export function smelting(definition) {
  const id = requireId(definition);
  const input = normaliseIngredient(definition.input, id);
  const cookSeconds = definition.cookSeconds ?? DEFAULT_COOK_SECONDS;
  if (!(cookSeconds > 0)) {
    throw new Error(`Smelting recipe "${id}" needs a positive cook time`);
  }

  return Object.freeze({
    id,
    kind: RecipeKind.SMELTING,
    station: CraftingStation.FURNACE,
    width: 0,
    height: 0,
    grid: Object.freeze([]),
    ingredients: Object.freeze([input]),
    mirrored: false,
    result: normaliseResult(definition.result, id),
    cookSeconds,
    group: definition.group ?? definition.result.id,
  });
}

function requireId(definition) {
  const id = definition?.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Every recipe needs a non-empty string id');
  }
  if (!/^[a-z0-9_/]+$/.test(id)) {
    throw new Error(`Recipe id "${id}" must be lower_snake_case, optionally with slashes`);
  }
  return id;
}

function normaliseResult(result, recipeId) {
  if (!result || typeof result.id !== 'string') {
    throw new Error(`Recipe "${recipeId}" has no result item`);
  }
  if (!isValidItemId(result.id)) {
    throw new Error(`Recipe "${recipeId}" produces unknown item "${result.id}"`);
  }
  const count = Math.floor(Number(result.count ?? 1));
  const maxStack = getItem(result.id).maxStack;
  if (!(count >= 1)) {
    throw new Error(`Recipe "${recipeId}" produces a non-positive count`);
  }
  if (count > maxStack) {
    // Producing more than a slot can hold would silently discard the excess the
    // moment the output is collected.
    throw new Error(
      `Recipe "${recipeId}" produces ${count} of "${result.id}", above its stack size ${maxStack}`
    );
  }
  return Object.freeze({ id: result.id, count });
}

export default RecipeKind;
