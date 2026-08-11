/**
 * A furnace: three slots, a fire, and a smelting timer.
 *
 * ```
 *  0  input   what is being smelted
 *  1  fuel    what is burning
 *  2  output  the result, take-only
 * ```
 *
 * ## Why it keeps running while the UI is closed
 *
 * A furnace is a machine, not a dialog. Closing the screen must not pause it, so
 * the timer lives here and is advanced by the world tick, entirely independently
 * of whether anything is looking at it. The UI reads state; it never drives it.
 *
 * ## Blocked output
 *
 * When the result slot cannot accept another item the furnace *pauses* mid-smelt
 * rather than discarding the result or continuing to burn fuel. Both alternatives
 * lose the player material, and losing material to a UI state they cannot see is
 * indefensible. Fuel already alight keeps burning — it is on fire — but no new
 * fuel is consumed.
 *
 * ## Catching up after a chunk unload
 *
 * Block entities only tick while their chunk is loaded, so a furnace in an
 * unloaded chunk stops. On load it reconciles against wall-clock time and
 * simulates what it would have done, capped at the fuel it actually holds. Without
 * that, walking away from a furnace would silently cancel the smelt, which reads
 * as the furnace eating the ore.
 */

import { Container } from '../../containers/Container.js';
import { ItemStack } from '../../items/ItemStack.js';
import { getItem } from '../../items/ItemRegistry.js';
import { getSmeltingRecipe } from '../../crafting/RecipeRegistry.js';
import { Block } from '../BlockTypes.js';
import { BlockEntity, registerBlockEntity } from './BlockEntity.js';

/** Slot indices. */
export const FURNACE_SLOT = Object.freeze({ INPUT: 0, FUEL: 1, OUTPUT: 2 });
/** Number of slots. */
export const FURNACE_SIZE = 3;

/**
 * Longest catch-up simulated on load, in seconds.
 *
 * A furnace left for three real days should not spend a frame simulating three
 * days of smelting. An hour is far more than any fuel load can sustain, so the cap
 * never truncates a legitimate result.
 */
const MAX_CATCHUP_SECONDS = 3600;

export class FurnaceBlockEntity extends BlockEntity {
  static get type() {
    return 'furnace';
  }

  constructor(options) {
    super(options);

    this.container = new Container({
      size: FURNACE_SIZE,
      title: 'Furnace',
      outputSlots: [FURNACE_SLOT.OUTPUT],
      // Only fuel belongs in the fuel slot and only smeltable things in the input
      // slot. Enforced as data here rather than as checks in the UI, so an
      // automated transfer cannot bypass it.
      slotFilter: (slot, stack) => {
        if (slot === FURNACE_SLOT.FUEL) return getItem(stack.itemId)?.fuelValue > 0;
        if (slot === FURNACE_SLOT.INPUT) return getSmeltingRecipe(stack.itemId) !== null;
        return false;
      },
    });

    /** Seconds of fuel left in the current burn. */
    this.burnRemaining = 0;
    /** Seconds the current burn started with, for the flame gauge. */
    this.burnDuration = 0;
    /** Seconds of progress into the current smelt. */
    this.cookElapsed = 0;
    /** Seconds the current item needs in total. */
    this.cookDuration = 0;

    /** Wall-clock stamp of the last tick, used to catch up after a reload. */
    this.lastTickAt = Date.now();
    /** XP banked by smelting, granted when the player takes the result. */
    this.storedXp = 0;
  }

  get needsTick() {
    return true;
  }

  // ----------------------------------------------------------------- accessors

  get inputStack() {
    return this.container.getSlot(FURNACE_SLOT.INPUT);
  }

  get fuelStack() {
    return this.container.getSlot(FURNACE_SLOT.FUEL);
  }

  get outputStack() {
    return this.container.getSlot(FURNACE_SLOT.OUTPUT);
  }

  /** True while fuel is alight. */
  get isBurning() {
    return this.burnRemaining > 0;
  }

  /** 0..1 flame gauge. */
  get burnFraction() {
    return this.burnDuration > 0 ? Math.max(0, this.burnRemaining / this.burnDuration) : 0;
  }

  /** 0..1 smelting arrow. */
  get cookFraction() {
    return this.cookDuration > 0 ? Math.min(1, this.cookElapsed / this.cookDuration) : 0;
  }

  /** The recipe the current input would produce, or null. */
  get activeRecipe() {
    const input = this.inputStack;
    return input ? getSmeltingRecipe(input.itemId) : null;
  }

  // ---------------------------------------------------------------- simulation

  /**
   * @param {number} step Seconds.
   * @param {import('../World.js').World} world
   */
  tick(step, world) {
    this.lastTickAt = Date.now();
    const changed = this._advance(step);
    if (changed) this._syncLitBlock(world);
  }

  /**
   * Simulates the time missed while the chunk was unloaded.
   *
   * Called by the store immediately after loading. Runs in coarse slices rather
   * than one giant step so a smelt that finishes partway through still respects
   * the output-blocked rule at the moment it would have completed.
   *
   * @param {import('../World.js').World} world
   */
  catchUp(world) {
    const missed = Math.min(MAX_CATCHUP_SECONDS, (Date.now() - this.lastTickAt) / 1000);
    this.lastTickAt = Date.now();
    if (missed <= 0.5) return;

    // One slice per second of missed time is plenty: nothing in a furnace changes
    // faster than the shortest cook time, and it bounds the loop at 3600.
    const slice = 1;
    let remaining = missed;
    while (remaining > 0) {
      const dt = Math.min(slice, remaining);
      remaining -= dt;
      if (!this._advance(dt)) {
        // Nothing further can happen without player input, so stop early rather
        // than spinning through the rest of the window.
        if (!this.isBurning && !this._canStartBurn()) break;
      }
    }
    this._syncLitBlock(world);
  }

  /**
   * The core state machine. Returns whether the lit state may have changed.
   * @param {number} step Seconds.
   * @returns {boolean}
   */
  _advance(step) {
    const wasBurning = this.isBurning;

    if (this.burnRemaining > 0) {
      this.burnRemaining = Math.max(0, this.burnRemaining - step);
    }

    const recipe = this.activeRecipe;
    const canSmelt = recipe !== null && this._outputAccepts(recipe);

    // Light new fuel only when there is something worth smelting *and* somewhere
    // to put the result. Burning fuel for a blocked furnace wastes it.
    if (!this.isBurning && canSmelt && this._canStartBurn()) {
      this._consumeFuel();
    }

    if (this.isBurning && canSmelt) {
      this.cookDuration = recipe.cookSeconds;
      this.cookElapsed += step;
      if (this.cookElapsed >= this.cookDuration) {
        this._completeSmelt(recipe);
      }
      this.container.revision++;
    } else if (!canSmelt) {
      // Losing the input resets progress: a half-cooked item that was removed
      // should not credit its progress to whatever is put in next.
      if (this.cookElapsed !== 0) {
        this.cookElapsed = 0;
        this.container.revision++;
      }
      this.cookDuration = recipe ? recipe.cookSeconds : 0;
    }

    return wasBurning !== this.isBurning;
  }

  /** Whether the output slot could take another of this recipe's result. */
  _outputAccepts(recipe) {
    const output = this.outputStack;
    if (!output) return true;
    if (output.itemId !== recipe.result.id) return false;
    return output.freeSpace >= recipe.result.count;
  }

  _canStartBurn() {
    const fuel = this.fuelStack;
    return Boolean(fuel) && getItem(fuel.itemId)?.fuelValue > 0;
  }

  _consumeFuel() {
    const fuel = this.fuelStack;
    if (!fuel) return;
    const value = getItem(fuel.itemId)?.fuelValue ?? 0;
    if (value <= 0) return;

    this.burnRemaining = value;
    this.burnDuration = value;
    fuel.shrink(1);
    if (fuel.isEmpty) {
      // A lava bucket would empty to a bucket here; expressed through the item's
      // own metadata so the furnace does not need to know about buckets.
      const emptiesTo = getItem(fuel.itemId)?.metadata?.emptiesTo;
      this.container.setSlot(
        FURNACE_SLOT.FUEL,
        emptiesTo ? new ItemStack(emptiesTo, 1) : null
      );
    } else {
      this.container.revision++;
    }
  }

  _completeSmelt(recipe) {
    const input = this.inputStack;
    if (!input) return;

    const output = this.outputStack;
    if (output) {
      output.grow(recipe.result.count);
    } else {
      this.container.setSlot(
        FURNACE_SLOT.OUTPUT,
        new ItemStack(recipe.result.id, recipe.result.count)
      );
    }

    // Bank XP for the player to collect when they take the result.
    const xp = Number(recipe.xp) || 0;
    if (xp > 0) this.storedXp += xp;

    input.shrink(1);
    if (input.isEmpty) this.container.setSlot(FURNACE_SLOT.INPUT, null);

    this.cookElapsed = 0;
  }

  /**
   * Swaps the voxel between the lit and unlit furnace ids.
   *
   * The mesher only ever sees block ids, so a glowing front face has to be a
   * different block. `cascade: false` because a furnace lighting up must not
   * trigger gravity or support checks on its neighbours.
   *
   * @param {import('../World.js').World} world
   */
  _syncLitBlock(world) {
    if (!world) return;
    const wanted = this.isBurning ? Block.FURNACE_LIT : Block.FURNACE;
    const current = world.getBlock(this.x, this.y, this.z);
    if (current !== Block.FURNACE && current !== Block.FURNACE_LIT) return;
    if (current === wanted) return;

    this.blockId = wanted;
    world.setBlock(this.x, this.y, this.z, wanted, {
      cause: 'blockEntity',
      cascade: false,
    });
  }

  // -------------------------------------------------------------------- breaking

  /** XP available for collection. */
  takeStoredXp() {
    const xp = this.storedXp;
    this.storedXp = 0;
    return xp;
  }

  /**
   * Everything inside, so breaking a furnace never destroys its contents.
   * @returns {import('../../items/ItemStack.js').ItemStack[]}
   */
  collectDrops() {
    return this.container.drainAll();
  }

  // ------------------------------------------------------------- serialisation

  toJSON() {
    return {
      items: this.container.toJSON(),
      burnRemaining: Math.round(this.burnRemaining * 100) / 100,
      burnDuration: Math.round(this.burnDuration * 100) / 100,
      cookElapsed: Math.round(this.cookElapsed * 100) / 100,
      storedXp: Math.round(this.storedXp * 100) / 100,
      lastTickAt: this.lastTickAt,
    };
  }

  fromJSON(data) {
    this.container.fromJSON(data?.items ?? null);
    const number = (value, fallback = 0) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    };
    this.burnRemaining = number(data?.burnRemaining);
    this.burnDuration = number(data?.burnDuration, this.burnRemaining);
    this.cookElapsed = number(data?.cookElapsed);
    this.storedXp = number(data?.storedXp);
    // A missing or future-dated stamp means "no catch-up", which is the safe
    // direction: it can never fabricate results.
    const stamp = Number(data?.lastTickAt);
    this.lastTickAt = Number.isFinite(stamp) && stamp <= Date.now() ? stamp : Date.now();

    const recipe = this.activeRecipe;
    this.cookDuration = recipe ? recipe.cookSeconds : 0;
    // Clamp progress into the current recipe's duration, in case the recipe's
    // cook time changed between versions.
    if (this.cookDuration > 0) this.cookElapsed = Math.min(this.cookElapsed, this.cookDuration);
    else this.cookElapsed = 0;
  }
}

registerBlockEntity(FurnaceBlockEntity, [Block.FURNACE, Block.FURNACE_LIT]);

export default FurnaceBlockEntity;
