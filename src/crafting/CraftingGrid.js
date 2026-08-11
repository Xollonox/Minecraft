/**
 * A crafting grid and its result slot.
 *
 * Wraps a `Container` of 4 or 9 input slots plus a separate one-slot result. The
 * result is deliberately *not* part of the same container: it is derived state,
 * recomputed whenever the inputs change, and letting it share the container's
 * insertion logic would allow an item to be dropped into it.
 *
 * ## The duplication trap this design avoids
 *
 * The obvious implementation consumes ingredients as soon as a match is found, so
 * it can put a real item in the result slot. That is how crafting duplication bugs
 * happen: any code path that recomputes the match — a UI refresh, a settings
 * change, a re-render — consumes the ingredients again.
 *
 * Here the result slot holds a *preview*: a stack that describes what would be
 * produced, recomputed freely and consuming nothing. Ingredients are consumed
 * exactly once, inside `takeResult`, at the moment the player actually removes the
 * output. Recomputing the preview a thousand times costs nothing.
 *
 * ## Returning ingredients on close
 *
 * A grid with items in it that is closed must give them back. Losing a stack
 * because a menu was dismissed is indefensible, so `reclaim` is the single exit
 * path and the UI has no way to close without calling it.
 *
 * Worker-safe: no DOM, no Three.js.
 */

import { Container } from '../containers/Container.js';
import { ItemStack } from '../items/ItemStack.js';
import { CraftingStation } from './RecipeTypes.js';
import { consumeIngredients, findMatch, maxCrafts } from './RecipeRegistry.js';

export class CraftingGrid {
  /**
   * @param {Object} options
   * @param {number} options.size Grid edge: 2 for the player grid, 3 for a table.
   * @param {string} [options.station] One of `CraftingStation`.
   */
  constructor({ size, station }) {
    if (size !== 2 && size !== 3) {
      throw new Error(`A crafting grid must be 2x2 or 3x3, got ${size}x${size}`);
    }
    this.size = size;
    this.station = station ?? (size === 2 ? CraftingStation.PLAYER : CraftingStation.TABLE);

    this.container = new Container({
      size: size * size,
      title: size === 2 ? 'Crafting' : 'Crafting Table',
    });

    /**
     * What the current inputs would produce. A preview only — removing it is what
     * consumes the ingredients.
     * @type {ItemStack|null}
     */
    this.result = null;

    /** The matched recipe, or null. */
    this.recipe = null;

    this._lastRevision = -1;
    this.refresh();
  }

  /** Row-major input slots. */
  get slots() {
    return this.container.slots;
  }

  /** True when nothing is laid out. */
  get isEmpty() {
    return this.container.isEmpty;
  }

  /**
   * Recomputes the result preview if the inputs changed.
   *
   * Cheap to call every frame: it early-outs on the container's revision counter,
   * so an unchanged grid costs one integer comparison.
   *
   * @param {boolean} [force]
   */
  refresh(force = false) {
    if (!force && this.container.revision === this._lastRevision) return;
    this._lastRevision = this.container.revision;

    const recipe = findMatch(this.container.slots, this.size, this.size, this.station);
    this.recipe = recipe;
    this.result = recipe ? new ItemStack(recipe.result.id, recipe.result.count) : null;
  }

  /**
   * How many times the current layout could be crafted.
   * @returns {number}
   */
  get availableCrafts() {
    this.refresh();
    return this.recipe ? maxCrafts(this.recipe, this.container.slots) : 0;
  }

  /**
   * Takes the output, consuming one set of ingredients.
   *
   * The *only* place ingredients are consumed. Returns null when there is nothing
   * to take, so a click on an empty result is a no-op rather than a silent
   * ingredient loss.
   *
   * @returns {ItemStack|null}
   */
  takeResult() {
    this.refresh();
    if (!this.recipe || !this.result) return null;

    const produced = this.result.clone();
    const emptied = consumeIngredients(this.container.slots, 1);
    for (const slot of emptied) this.container.setSlot(slot, null);
    // Bump the revision even when no slot emptied, so quantities changing is
    // enough to recompute the preview.
    this.container.revision++;
    this.refresh(true);
    return produced;
  }

  /**
   * Crafts as many times as the ingredients allow.
   *
   * Returns the produced stacks rather than one giant stack, because the total can
   * exceed a single slot's capacity and silently truncating would destroy items.
   *
   * @param {number} [limit] Cap on the number of crafts.
   * @returns {ItemStack[]}
   */
  takeAll(limit = Infinity) {
    this.refresh();
    if (!this.recipe) return [];

    const times = Math.min(this.availableCrafts, Math.max(0, limit));
    if (times <= 0) return [];

    const { id, count } = this.recipe.result;
    const total = times * count;

    const emptied = consumeIngredients(this.container.slots, times);
    for (const slot of emptied) this.container.setSlot(slot, null);
    this.container.revision++;
    this.refresh(true);

    // Split the total across as many stacks as it needs.
    /** @type {ItemStack[]} */
    const out = [];
    const maxStack = new ItemStack(id, 1).maxStack;
    let remaining = total;
    while (remaining > 0) {
      const take = Math.min(maxStack, remaining);
      out.push(new ItemStack(id, take));
      remaining -= take;
    }
    return out;
  }

  /**
   * Empties the grid and returns everything in it.
   *
   * Called whenever the screen closes, including on a pause, a death or a world
   * teardown. The result preview is *not* returned — it was never a real item.
   *
   * @returns {ItemStack[]}
   */
  reclaim() {
    const out = this.container.drainAll();
    this.result = null;
    this.recipe = null;
    this.refresh(true);
    return out;
  }

  /**
   * Save form. A grid mid-layout is worth persisting so quitting with items on it
   * does not lose them, and `reclaim` on load hands them back.
   */
  toJSON() {
    return { size: this.size, items: this.container.toJSON() };
  }

  /**
   * @param {Object|null} data
   */
  fromJSON(data) {
    this.container.fromJSON(data?.items ?? null);
    this.refresh(true);
  }
}

export default CraftingGrid;
