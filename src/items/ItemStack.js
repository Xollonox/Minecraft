/**
 * A quantity of one item, optionally damaged, optionally carrying extra state.
 *
 * ## Mutable, not a value type
 *
 * Stacks are mutated in place (`merge`, `split`, `shrink`) rather than replaced.
 * Inventory transfers happen every time a player clicks a slot, and allocating a
 * fresh object per click would churn the heap during exactly the interaction that
 * needs to feel instant. The cost is that callers must not alias a stack into two
 * slots — `clone()` exists for that, and `Inventory` uses it.
 *
 * ## The empty representation
 *
 * An empty slot is `null`, never an `ItemStack` with `quantity === 0`. Allowing
 * both would double every slot test in the codebase and guarantee that some path
 * checks only one of them. `ItemStack` still tracks `isEmpty` because a stack can
 * become empty mid-operation, and `Inventory` normalises those to `null`
 * immediately.
 *
 * ## Why damaged tools cannot stack
 *
 * Two pickaxes with 40 and 200 uses left cannot share a slot without discarding
 * one of the two numbers. `ItemRegistry` already refuses to define an item with
 * both durability and a stack size above one, and `canMergeWith` enforces the
 * runtime half: identical id, identical damage, identical metadata.
 *
 * Worker-safe: no DOM, no Three.js.
 */

import { getItem, isValidItemId } from './ItemRegistry.js';

export class ItemStack {
  /**
   * @param {string} itemId
   * @param {number} [quantity]
   * @param {Object} [options]
   * @param {number} [options.damage] Uses consumed, 0 = pristine.
   * @param {Object|null} [options.metadata] Extra per-stack state.
   */
  constructor(itemId, quantity = 1, { damage = 0, metadata = null } = {}) {
    if (!isValidItemId(itemId)) {
      throw new Error(`Cannot create a stack of unknown item "${itemId}"`);
    }
    this.itemId = itemId;
    this.quantity = 0;
    this.damage = 0;
    /** @type {Object|null} */
    this.metadata = metadata ? { ...metadata } : null;

    this.setQuantity(quantity);
    this.setDamage(damage);
  }

  // ----------------------------------------------------------------- accessors

  /** The immutable definition behind this stack. */
  get definition() {
    return getItem(this.itemId);
  }

  get displayName() {
    return this.definition.displayName;
  }

  get maxStack() {
    return this.definition.maxStack;
  }

  /** Total uses this item has before breaking; 0 for non-tools. */
  get maxDurability() {
    return this.definition.durability;
  }

  /** Uses remaining, or `Infinity` for items that never break. */
  get remainingDurability() {
    const max = this.maxDurability;
    return max === 0 ? Infinity : Math.max(0, max - this.damage);
  }

  /** 1 = pristine, 0 = about to break. `1` for indestructible items. */
  get durabilityFraction() {
    const max = this.maxDurability;
    return max === 0 ? 1 : Math.max(0, Math.min(1, (max - this.damage) / max));
  }

  get isDamageable() {
    return this.maxDurability > 0;
  }

  get isDamaged() {
    return this.isDamageable && this.damage > 0;
  }

  get isEmpty() {
    return this.quantity <= 0;
  }

  get isFull() {
    return this.quantity >= this.maxStack;
  }

  /** How many more items this stack could accept. */
  get freeSpace() {
    return Math.max(0, this.maxStack - this.quantity);
  }

  get isTool() {
    return this.definition.toolType !== 'none' && this.definition.toolType !== 'bucket';
  }

  get isFood() {
    return this.definition.foodValue > 0;
  }

  get isFuel() {
    return this.definition.fuelValue > 0;
  }

  get isArmour() {
    return this.definition.armourSlot !== null;
  }

  // ------------------------------------------------------------------ mutation

  /**
   * Sets the quantity, clamped to `[0, maxStack]`.
   * @param {number} quantity
   * @returns {this}
   */
  setQuantity(quantity) {
    const value = Math.floor(Number(quantity));
    if (!Number.isFinite(value)) throw new Error(`Invalid stack quantity ${quantity}`);
    this.quantity = Math.max(0, Math.min(this.maxStack, value));
    return this;
  }

  /**
   * Sets accumulated damage, clamped to `[0, maxDurability]`.
   * @param {number} damage
   * @returns {this}
   */
  setDamage(damage) {
    if (!this.isDamageable) {
      this.damage = 0;
      return this;
    }
    const value = Math.floor(Number(damage));
    if (!Number.isFinite(value)) throw new Error(`Invalid stack damage ${damage}`);
    this.damage = Math.max(0, Math.min(this.maxDurability, value));
    return this;
  }

  /**
   * Consumes durability.
   *
   * @param {number} [amount]
   * @returns {boolean} True when the item just broke and should be removed.
   */
  applyDamage(amount = 1) {
    if (!this.isDamageable || amount <= 0) return false;
    this.damage = Math.min(this.maxDurability, this.damage + Math.floor(amount));
    return this.damage >= this.maxDurability;
  }

  /** Repairs by `amount` uses. */
  repair(amount = 1) {
    if (!this.isDamageable) return this;
    this.damage = Math.max(0, this.damage - Math.floor(amount));
    return this;
  }

  /**
   * Removes items from this stack.
   * @param {number} [amount]
   * @returns {number} How many were actually removed.
   */
  shrink(amount = 1) {
    const removed = Math.min(this.quantity, Math.max(0, Math.floor(amount)));
    this.quantity -= removed;
    return removed;
  }

  /**
   * Adds items, respecting the stack ceiling.
   * @param {number} [amount]
   * @returns {number} How many did not fit.
   */
  grow(amount = 1) {
    const wanted = Math.max(0, Math.floor(amount));
    const accepted = Math.min(this.freeSpace, wanted);
    this.quantity += accepted;
    return wanted - accepted;
  }

  // ------------------------------------------------------- combining and split

  /**
   * Whether two stacks describe the same thing closely enough to share a slot.
   *
   * @param {ItemStack|null} other
   * @returns {boolean}
   */
  canMergeWith(other) {
    if (!other || other === this) return false;
    if (other.itemId !== this.itemId) return false;
    if (this.maxStack <= 1) return false;
    // Differing wear would have to be averaged or discarded; refuse instead.
    if (this.damage !== other.damage) return false;
    return sameMetadata(this.metadata, other.metadata);
  }

  /**
   * Moves as much of `other` into this stack as will fit.
   *
   * @param {ItemStack} other Mutated: whatever transferred is removed from it.
   * @returns {number} How many items moved.
   */
  merge(other) {
    if (!this.canMergeWith(other)) return 0;
    const moved = Math.min(this.freeSpace, other.quantity);
    if (moved <= 0) return 0;
    this.quantity += moved;
    other.quantity -= moved;
    return moved;
  }

  /**
   * Removes `amount` items into a new stack.
   *
   * @param {number} amount
   * @returns {ItemStack|null} Null when nothing could be taken.
   */
  split(amount) {
    const taken = Math.min(this.quantity, Math.max(0, Math.floor(amount)));
    if (taken <= 0) return null;
    this.quantity -= taken;
    return new ItemStack(this.itemId, taken, {
      damage: this.damage,
      metadata: this.metadata,
    });
  }

  /**
   * Removes half of this stack, rounding up.
   *
   * Rounding up is what makes right-clicking a stack of one hand you the item
   * rather than nothing.
   *
   * @returns {ItemStack|null}
   */
  splitHalf() {
    return this.split(Math.ceil(this.quantity / 2));
  }

  /** An independent copy. */
  clone() {
    return new ItemStack(this.itemId, this.quantity, {
      damage: this.damage,
      metadata: this.metadata,
    });
  }

  /**
   * Swaps the contents of two stacks in place.
   *
   * Used by cursor/slot interactions, where the two stacks are already sitting
   * in their containers and reassigning the references is the caller's job.
   *
   * @param {ItemStack} other
   */
  swapWith(other) {
    const id = this.itemId;
    const quantity = this.quantity;
    const damage = this.damage;
    const metadata = this.metadata;

    this.itemId = other.itemId;
    this.quantity = other.quantity;
    this.damage = other.damage;
    this.metadata = other.metadata;

    other.itemId = id;
    other.quantity = quantity;
    other.damage = damage;
    other.metadata = metadata;
  }

  // ------------------------------------------------------------- serialisation

  /**
   * Compact save form.
   *
   * Fields that are at their default are omitted, which keeps a 36-slot
   * inventory of plain blocks close to the size of the old `{id, count}` format.
   *
   * @returns {{id: string, n: number, d?: number, m?: Object}}
   */
  toJSON() {
    /** @type {{id: string, n: number, d?: number, m?: Object}} */
    const out = { id: this.itemId, n: this.quantity };
    if (this.damage > 0) out.d = this.damage;
    if (this.metadata && Object.keys(this.metadata).length > 0) out.m = { ...this.metadata };
    return out;
  }

  /**
   * Rebuilds a stack from its save form.
   *
   * Returns `null` for anything unusable rather than throwing: a save written by
   * a newer build, or one referencing an item that has since been removed, must
   * cost the player that slot and nothing more. Losing a slot is recoverable;
   * failing to load the world is not.
   *
   * @param {unknown} data
   * @returns {ItemStack|null}
   */
  static fromJSON(data) {
    if (!data || typeof data !== 'object') return null;

    // Accept the legacy `{id: <blockId>, count}` shape so existing saves keep
    // their hotbars. Block ids were numeric; item ids are strings.
    const raw = /** @type {Record<string, unknown>} */ (data);
    const id = raw.id ?? raw.itemId;
    const quantity = raw.n ?? raw.count ?? raw.quantity ?? 1;

    if (typeof id !== 'string') return null;
    if (!isValidItemId(id)) return null;

    const count = Math.floor(Number(quantity));
    if (!Number.isFinite(count) || count <= 0) return null;

    const stack = new ItemStack(id, count);
    if (typeof raw.d === 'number') stack.setDamage(raw.d);
    else if (typeof raw.damage === 'number') stack.setDamage(raw.damage);
    if (raw.m && typeof raw.m === 'object') stack.metadata = { ...raw.m };

    return stack.isEmpty ? null : stack;
  }

  /**
   * Convenience constructor that returns `null` instead of throwing.
   * @param {string} itemId
   * @param {number} [quantity]
   * @returns {ItemStack|null}
   */
  static of(itemId, quantity = 1) {
    if (!isValidItemId(itemId) || quantity <= 0) return null;
    return new ItemStack(itemId, quantity);
  }

  /**
   * Normalises a possibly-empty stack to `null`.
   * @param {ItemStack|null} stack
   * @returns {ItemStack|null}
   */
  static orNull(stack) {
    return stack && !stack.isEmpty ? stack : null;
  }

  toString() {
    const wear = this.isDamaged ? ` (${this.remainingDurability}/${this.maxDurability})` : '';
    return `${this.quantity}x ${this.itemId}${wear}`;
  }
}

/**
 * Structural comparison of two metadata bags.
 *
 * Shallow on purpose: metadata holds flat scalars (eat time, fluid name, crop
 * id). A deep compare would invite nested state that has no save story.
 *
 * @param {Object|null} a
 * @param {Object|null} b
 * @returns {boolean}
 */
export function sameMetadata(a, b) {
  const aEmpty = !a || Object.keys(a).length === 0;
  const bEmpty = !b || Object.keys(b).length === 0;
  if (aEmpty && bEmpty) return true;
  if (aEmpty !== bEmpty) return false;

  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
    if (a[aKeys[i]] !== b[bKeys[i]]) return false;
  }
  return true;
}

export default ItemStack;
