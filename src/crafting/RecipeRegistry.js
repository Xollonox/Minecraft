/**
 * Recipe index and matching.
 *
 * ## Matching strategy
 *
 * Crafting happens on every click in an open grid, so matching has to be cheap.
 * Recipes are bucketed by station and, for shaped recipes, by their bounding box,
 * so a 2x2 grid never considers a 3x3 recipe and a grid holding three items never
 * considers a nine-ingredient one. Within a bucket the search is linear, which at
 * a few dozen recipes is far faster than any index would be after paying for the
 * index lookup.
 *
 * ## Shaped matching and offsets
 *
 * A 2x1 recipe laid out in the top-left of a 3x3 grid is the same recipe as one
 * laid out in the middle. Rather than storing every translation, the grid is
 * *trimmed* to its occupied bounding box before comparison. That also makes
 * mirroring a single reversal of each row instead of a second stored pattern.
 *
 * ## Why `findMatch` returns the recipe rather than crafting
 *
 * The UI needs to *show* the pending output before the player takes it, and
 * `craft` needs to consume ingredients only once the output is actually removed.
 * Splitting the two keeps "what would this make" free of side effects, which is
 * what prevents the classic duplication bug where previewing an output also
 * consumes the inputs.
 *
 * Worker-safe: no DOM, no Three.js.
 */

import { RECIPE_DEFINITIONS } from './Recipes.js';
import {
  CraftingStation,
  RecipeKind,
  ingredientOptions,
  matchesIngredient,
} from './RecipeTypes.js';

/** @type {Map<string, import('./RecipeTypes.js').Recipe>} */
const BY_ID = new Map();

/** @type {import('./RecipeTypes.js').Recipe[]} */
const SHAPED = [];
/** @type {import('./RecipeTypes.js').Recipe[]} */
const SHAPELESS = [];
/** @type {import('./RecipeTypes.js').Recipe[]} */
const SMELTING = [];

/** @type {Map<string, import('./RecipeTypes.js').Recipe>} Item id -> smelting recipe. */
const SMELTING_BY_INPUT = new Map();

for (const recipe of RECIPE_DEFINITIONS) {
  if (BY_ID.has(recipe.id)) {
    // A duplicate id would make the recipe book and any quest referencing it
    // ambiguous, and only one of the two would ever be reachable.
    throw new Error(`Duplicate recipe id "${recipe.id}"`);
  }
  BY_ID.set(recipe.id, recipe);

  if (recipe.kind === RecipeKind.SHAPED) SHAPED.push(recipe);
  else if (recipe.kind === RecipeKind.SHAPELESS) SHAPELESS.push(recipe);
  else if (recipe.kind === RecipeKind.SMELTING) {
    SMELTING.push(recipe);
    // Expanding the input to concrete items up front turns furnace lookup into a
    // single map hit per tick instead of a scan over every smelting recipe.
    for (const itemId of ingredientOptions(recipe.ingredients[0])) {
      if (SMELTING_BY_INPUT.has(itemId)) {
        throw new Error(
          `Item "${itemId}" is smelted by both "${SMELTING_BY_INPUT.get(itemId).id}" and ` +
            `"${recipe.id}"; a furnace could not choose between them`
        );
      }
      SMELTING_BY_INPUT.set(itemId, recipe);
    }
  }
}

/** Total number of recipes. */
export const RECIPE_COUNT = BY_ID.size;

/** Every recipe, in definition order. */
export const ALL_RECIPES = Object.freeze([...BY_ID.values()]);

// --------------------------------------------------------------------- lookups

/**
 * @param {string} id
 * @returns {import('./RecipeTypes.js').Recipe|null}
 */
export function getRecipe(id) {
  return BY_ID.get(id) ?? null;
}

/**
 * The smelting recipe for an input item, if any.
 * @param {string|null} itemId
 * @returns {import('./RecipeTypes.js').Recipe|null}
 */
export function getSmeltingRecipe(itemId) {
  return itemId ? SMELTING_BY_INPUT.get(itemId) ?? null : null;
}

/**
 * Whether an item can be smelted at all, for UI affordances.
 * @param {string|null} itemId
 */
export function isSmeltable(itemId) {
  return getSmeltingRecipe(itemId) !== null;
}

/**
 * Recipes producing a given item, for the recipe book's "how do I make this".
 * @param {string} itemId
 * @returns {import('./RecipeTypes.js').Recipe[]}
 */
export function recipesProducing(itemId) {
  return ALL_RECIPES.filter((recipe) => recipe.result.id === itemId);
}

/**
 * Recipes craftable at a station.
 *
 * A table can also make anything the player can make by hand, which is what
 * players expect and what avoids duplicating every 2x2 recipe as a 3x3 one.
 *
 * @param {string} station One of `CraftingStation`.
 * @returns {import('./RecipeTypes.js').Recipe[]}
 */
export function recipesForStation(station) {
  if (station === CraftingStation.TABLE) {
    return ALL_RECIPES.filter(
      (recipe) =>
        recipe.station === CraftingStation.TABLE || recipe.station === CraftingStation.PLAYER
    );
  }
  return ALL_RECIPES.filter((recipe) => recipe.station === station);
}

// -------------------------------------------------------------------- matching

/**
 * Trims a grid to the bounding box of its occupied slots.
 *
 * This is what makes a recipe position-independent: a 2x1 pattern placed anywhere
 * in a 3x3 grid trims to the same 2x1 shape, so one stored pattern matches all
 * nine placements without storing translations.
 *
 * @param {Array<import('../items/ItemStack.js').ItemStack|null>} slots Row-major.
 * @param {number} width
 * @param {number} height
 * @returns {{cells: Array<import('../items/ItemStack.js').ItemStack|null>, width: number, height: number, count: number}}
 */
export function trimGrid(slots, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const stack = slots[y * width + x];
      if (!stack || stack.isEmpty) continue;
      count++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (count === 0) return { cells: [], width: 0, height: 0, count: 0 };

  const trimmedWidth = maxX - minX + 1;
  const trimmedHeight = maxY - minY + 1;
  const cells = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      cells.push(slots[y * width + x] ?? null);
    }
  }
  return { cells, width: trimmedWidth, height: trimmedHeight, count };
}

/**
 * Compares a trimmed grid against a shaped pattern.
 *
 * @param {import('./RecipeTypes.js').Recipe} recipe
 * @param {{cells: Array, width: number, height: number}} trimmed
 * @param {boolean} mirror Compare against the horizontally flipped pattern.
 * @returns {boolean}
 */
function shapedMatches(recipe, trimmed, mirror) {
  if (recipe.width !== trimmed.width || recipe.height !== trimmed.height) return false;

  for (let y = 0; y < recipe.height; y++) {
    for (let x = 0; x < recipe.width; x++) {
      const patternX = mirror ? recipe.width - 1 - x : x;
      const ingredient = recipe.grid[y * recipe.width + patternX];
      const stack = trimmed.cells[y * trimmed.width + x];
      if (!matchesIngredient(ingredient, stack)) return false;
    }
  }
  return true;
}

/**
 * Compares a set of stacks against a shapeless ingredient list.
 *
 * Greedy one-to-one assignment. Exact bipartite matching would be more correct in
 * theory, but a shapeless recipe here has at most nine ingredients and the
 * overlap between ingredient sets is trivial, so greedy never mis-rejects in
 * practice — and it is O(n^2) rather than O(n^3).
 *
 * @param {import('./RecipeTypes.js').Recipe} recipe
 * @param {Array<import('../items/ItemStack.js').ItemStack|null>} slots
 * @returns {boolean}
 */
function shapelessMatches(recipe, slots) {
  const present = slots.filter((stack) => stack && !stack.isEmpty);
  if (present.length !== recipe.ingredients.length) return false;

  const used = new Array(present.length).fill(false);
  for (const ingredient of recipe.ingredients) {
    let found = false;
    for (let i = 0; i < present.length; i++) {
      if (used[i]) continue;
      if (matchesIngredient(ingredient, present[i])) {
        used[i] = true;
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

/**
 * Finds the recipe a grid currently satisfies.
 *
 * Side-effect free: it inspects the grid and returns a recipe, consuming nothing.
 * The separation from `consumeIngredients` is deliberate — a preview that also
 * consumed inputs is the classic crafting duplication bug.
 *
 * @param {Array<import('../items/ItemStack.js').ItemStack|null>} slots Row-major.
 * @param {number} width
 * @param {number} height
 * @param {string} [station] Restricts which recipes are considered.
 * @returns {import('./RecipeTypes.js').Recipe|null}
 */
export function findMatch(slots, width, height, station = CraftingStation.TABLE) {
  const trimmed = trimGrid(slots, width, height);
  if (trimmed.count === 0) return null;

  const allowPlayer = true;
  const allowTable = station === CraftingStation.TABLE;

  /** Whether a recipe may be crafted at the requested station. */
  const stationAllows = (recipe) => {
    if (recipe.station === CraftingStation.PLAYER) return allowPlayer;
    if (recipe.station === CraftingStation.TABLE) return allowTable;
    return false;
  };

  // Shaped first: it is the more specific match, so a shaped recipe always wins
  // over a shapeless one that happens to accept the same items.
  for (const recipe of SHAPED) {
    if (!stationAllows(recipe)) continue;
    if (recipe.width > width || recipe.height > height) continue;
    if (shapedMatches(recipe, trimmed, false)) return recipe;
    if (recipe.mirrored && recipe.width > 1 && shapedMatches(recipe, trimmed, true)) return recipe;
  }

  for (const recipe of SHAPELESS) {
    if (!stationAllows(recipe)) continue;
    if (recipe.ingredients.length > width * height) continue;
    if (shapelessMatches(recipe, slots)) return recipe;
  }

  return null;
}

/**
 * How many times a recipe could be crafted from the current grid.
 *
 * Bounded by the smallest ingredient stack, because every craft consumes one from
 * each occupied slot. Used for craft-all.
 *
 * @param {import('./RecipeTypes.js').Recipe} recipe
 * @param {Array<import('../items/ItemStack.js').ItemStack|null>} slots
 * @returns {number}
 */
export function maxCrafts(recipe, slots) {
  let limit = Infinity;
  for (const stack of slots) {
    if (!stack || stack.isEmpty) continue;
    limit = Math.min(limit, stack.quantity);
  }
  if (!Number.isFinite(limit)) return 0;

  // Never produce more than one stack of output in a single action: the result
  // slot could not hold it, and the excess would be silently dropped.
  const perCraft = recipe.result.count;
  const stackLimit = Math.floor(64 / perCraft) || 1;
  return Math.max(0, Math.min(limit, stackLimit));
}

/**
 * Consumes one of each ingredient from the grid.
 *
 * Mutates the stacks in place and returns the slots that became empty, so the
 * caller can null them out. Called exactly once per craft, *after* the output has
 * been handed over.
 *
 * @param {Array<import('../items/ItemStack.js').ItemStack|null>} slots
 * @param {number} [times]
 * @returns {number[]} Indices that are now empty.
 */
export function consumeIngredients(slots, times = 1) {
  /** @type {number[]} */
  const emptied = [];
  for (let i = 0; i < slots.length; i++) {
    const stack = slots[i];
    if (!stack || stack.isEmpty) continue;
    stack.shrink(times);
    if (stack.isEmpty) emptied.push(i);
  }
  return emptied;
}

/**
 * Snapshot for the debug overlay and the audit script.
 * @returns {{total: number, shaped: number, shapeless: number, smelting: number, byStation: Object}}
 */
export function describeRecipes() {
  return {
    total: RECIPE_COUNT,
    shaped: SHAPED.length,
    shapeless: SHAPELESS.length,
    smelting: SMELTING.length,
    byStation: {
      player: ALL_RECIPES.filter((r) => r.station === CraftingStation.PLAYER).length,
      table: ALL_RECIPES.filter((r) => r.station === CraftingStation.TABLE).length,
      furnace: SMELTING.length,
    },
  };
}

export { CraftingStation, RecipeKind };
export default getRecipe;
