/**
 * A fixed array of item slots, shared by every container in the game.
 *
 * ## Why one class for chests, furnaces and crafting grids
 *
 * Each of those is "some slots you can put items in", and each needs the same
 * fiddly operations: insert respecting stack ceilings, extract, merge, split,
 * serialise. Writing that three times guarantees the third copy has a bug the
 * other two do not — and in a container system that bug is item duplication or
 * item loss, which are the two worst outcomes available.
 *
 * So the slot mechanics live here exactly once. Behaviour that genuinely differs
 * (a furnace only accepts fuel in the fuel slot; its output slot cannot be
 * inserted into) is expressed through `slotFilter` and `outputSlots` rather than
 * by subclassing, because those are data, not logic.
 *
 * ## Empty is `null`
 *
 * Same invariant as `Inventory`: a slot holds an `ItemStack` or `null`, never a
 * zero-quantity stack. `_store` is the single write path that enforces it.
 *
 * Worker-safe: no DOM, no Three.js.
 */

import { ItemStack } from '../items/ItemStack.js';

export class Container {
  /**
   * @param {Object} options
   * @param {number} options.size Number of slots.
   * @param {string} [options.title] Shown in the UI.
   * @param {(slot: number, stack: ItemStack) => boolean} [options.slotFilter]
   *   Whether a stack may be placed in a slot. Defaults to allowing everything.
   * @param {number[]} [options.outputSlots]
   *   Slots that automated insertion must never target, and which the player may
   *   only take from. A furnace's result slot is the motivating case.
   */
  constructor({ size, title = 'Container', slotFilter = null, outputSlots = [] }) {
    if (!Number.isInteger(size) || size <= 0) {
      throw new Error(`Container needs a positive integer size, got ${size}`);
    }
    this.size = size;
    this.title = title;
    /** @type {Array<ItemStack|null>} */
    this.slots = new Array(size).fill(null);
    this._slotFilter = slotFilter;
    this.outputSlots = Object.freeze([...outputSlots]);

    /**
     * Bumped on every change.
     *
     * The UI polls this instead of subscribing, because a container can be
     * mutated by the furnace tick sixty times a second and an event per change
     * would be sixty DOM updates for a progress bar that only needs one.
     */
    this.revision = 0;
  }

  // ----------------------------------------------------------------- accessors

  /**
   * @param {number} slot
   * @returns {ItemStack|null}
   */
  getSlot(slot) {
    return this._isValid(slot) ? this.slots[slot] ?? null : null;
  }

  /** True when every slot is empty. */
  get isEmpty() {
    return this.slots.every((stack) => stack === null);
  }

  /** Number of occupied slots. */
  get usedSlots() {
    let used = 0;
    for (const stack of this.slots) if (stack) used++;
    return used;
  }

  /** True when nothing more can be inserted. */
  get isFull() {
    for (let slot = 0; slot < this.size; slot++) {
      if (this.outputSlots.includes(slot)) continue;
      const stack = this.slots[slot];
      if (!stack || !stack.isFull) return false;
    }
    return true;
  }

  /**
   * Whether a stack is allowed in a slot.
   * @param {number} slot
   * @param {ItemStack} stack
   */
  acceptsInSlot(slot, stack) {
    if (!this._isValid(slot) || !stack || stack.isEmpty) return false;
    // An output slot is a result, not a destination.
    if (this.outputSlots.includes(slot)) return false;
    return this._slotFilter ? this._slotFilter(slot, stack) : true;
  }

  _isValid(slot) {
    return Number.isInteger(slot) && slot >= 0 && slot < this.size;
  }

  // ------------------------------------------------------------- slot plumbing

  /**
   * The single write path. Normalises empty stacks to `null`.
   * @param {number} slot
   * @param {ItemStack|null} stack
   */
  setSlot(slot, stack) {
    if (!this._isValid(slot)) return null;
    this.slots[slot] = ItemStack.orNull(stack);
    this.revision++;
    return this.slots[slot];
  }

  /** Empties a slot and returns what was there. */
  takeSlot(slot) {
    const stack = this.getSlot(slot);
    if (!stack) return null;
    this.setSlot(slot, null);
    return stack;
  }

  /**
   * Removes up to `amount` from a slot.
   * @param {number} slot
   * @param {number} amount
   * @returns {ItemStack|null}
   */
  extract(slot, amount) {
    const stack = this.getSlot(slot);
    if (!stack) return null;
    const taken = stack.split(amount);
    if (stack.isEmpty) this.setSlot(slot, null);
    else this.revision++;
    return taken;
  }

  // ------------------------------------------------------------------ insertion

  /**
   * Inserts a stack, topping up compatible slots before opening empty ones.
   *
   * Mutates `stack`, removing whatever fitted. Returning the leftover *in the
   * stack itself* rather than as a number is what makes a partial transfer
   * impossible to get wrong at the call site: whatever is still in the stack is
   * still the caller's problem.
   *
   * @param {ItemStack} stack
   * @param {number[]} [allowedSlots] Restrict insertion to these slots.
   * @returns {number} How many items moved.
   */
  insert(stack, allowedSlots = null) {
    if (!stack || stack.isEmpty) return 0;
    const candidates = allowedSlots ?? this._insertableSlots();
    let moved = 0;

    // Phase 1: top up existing compatible stacks.
    if (stack.maxStack > 1) {
      for (const slot of candidates) {
        if (stack.isEmpty) break;
        const existing = this.slots[slot];
        if (!existing || existing.isFull || !existing.canMergeWith(stack)) continue;
        if (!this.acceptsInSlot(slot, stack)) continue;
        moved += existing.merge(stack);
      }
    }

    // Phase 2: fill empty slots.
    for (const slot of candidates) {
      if (stack.isEmpty) break;
      if (this.slots[slot]) continue;
      if (!this.acceptsInSlot(slot, stack)) continue;
      const taken = Math.min(stack.maxStack, stack.quantity);
      this.setSlot(
        slot,
        new ItemStack(stack.itemId, taken, { damage: stack.damage, metadata: stack.metadata })
      );
      stack.shrink(taken);
      moved += taken;
    }

    if (moved > 0) this.revision++;
    return moved;
  }

  /** Slots that automated insertion may target. */
  _insertableSlots() {
    const slots = [];
    for (let slot = 0; slot < this.size; slot++) {
      if (!this.outputSlots.includes(slot)) slots.push(slot);
    }
    return slots;
  }

  /**
   * Total quantity of an item held.
   * @param {string} itemId
   */
  countOf(itemId) {
    let total = 0;
    for (const stack of this.slots) {
      if (stack && stack.itemId === itemId) total += stack.quantity;
    }
    return total;
  }

  /**
   * Removes everything and returns it, for a broken container.
   * @returns {ItemStack[]}
   */
  drainAll() {
    /** @type {ItemStack[]} */
    const out = [];
    for (let slot = 0; slot < this.size; slot++) {
      const stack = this.slots[slot];
      if (stack) out.push(stack);
      this.slots[slot] = null;
    }
    this.revision++;
    return out;
  }

  /** Empties every slot without returning the contents. */
  clear() {
    this.slots.fill(null);
    this.revision++;
  }

  // ------------------------------------------------------------- serialisation

  /**
   * Sparse save form: only occupied slots are written.
   *
   * A 27-slot chest holding two items costs two entries rather than 27 nulls,
   * which matters when a world can hold hundreds of chests.
   *
   * @returns {Array<{s: number, i: Object}>}
   */
  toJSON() {
    const out = [];
    for (let slot = 0; slot < this.size; slot++) {
      const stack = this.slots[slot];
      if (stack) out.push({ s: slot, i: stack.toJSON() });
    }
    return out;
  }

  /**
   * Restores from the sparse save form.
   *
   * An unreadable entry costs that slot, not the container: dropping one item is
   * recoverable, failing to load a chunk is not. Out-of-range slot indices are
   * ignored, which is what makes shrinking a container in a later version safe.
   *
   * @param {Array<{s: number, i: Object}>|null} data
   */
  fromJSON(data) {
    this.slots.fill(null);
    if (Array.isArray(data)) {
      for (const entry of data) {
        if (!entry || typeof entry !== 'object') continue;
        const slot = Number(entry.s);
        if (!this._isValid(slot)) continue;
        this.slots[slot] = ItemStack.fromJSON(entry.i);
      }
    }
    this.revision++;
  }
}

export default Container;
