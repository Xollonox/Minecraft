/**
 * The player's full inventory.
 *
 * ## One flat slot array
 *
 * Hotbar, main grid, armour and offhand are ranges within a single `slots`
 * array rather than four separate arrays. Every transfer in the game — shift
 * clicking, furnace output collection, chest moves, death drops — then becomes
 * "move between two indices", and the tricky logic (merge, split, respect the
 * stack ceiling) exists exactly once. Four arrays would mean four nearly
 * identical copies of that logic and, inevitably, a duplication bug in one of
 * them.
 *
 * Layout:
 * ```
 *  0 ..  8   hotbar          (the row drawn on screen)
 *  9 .. 35   main inventory  (the 27-slot grid)
 * 36 .. 39   armour          (helmet, chest, legs, boots)
 * 40         offhand
 * ```
 *
 * Armour and offhand are wired into storage, serialisation, death drops and the
 * UI's slot model now, but nothing yet *reads* them for damage reduction — no
 * armour items exist. They are included because retrofitting slots into a save
 * format is a migration, whereas leaving four unused indices costs nothing.
 *
 * ## Empty is `null`
 *
 * A slot holds `ItemStack` or `null`, never a zero-quantity stack. Every mutator
 * funnels through `_store`, which normalises emptiness in one place.
 *
 * ## Creative mode
 *
 * Creative does not decrement stacks and never reports itself full. That check
 * lives in this class rather than at each call site so a new consumer cannot
 * forget it and quietly consume a creative player's blocks.
 *
 * Worker-safe: no DOM, no Three.js.
 */

import { Events } from '../core/EventBus.js';
import { ItemStack } from '../items/ItemStack.js';
import { getItem, isValidItemId, itemIdForBlock } from '../items/ItemRegistry.js';
import { armourDurabilityLoss, damageAfterArmour } from './Armour.js';

/** Number of slots in the on-screen hotbar row. */
export const HOTBAR_SIZE = 9;
/** Number of slots in the main storage grid. */
export const MAIN_SIZE = 27;
/** Number of armour slots. */
export const ARMOUR_SIZE = 4;

/** First index of each region, and the total. */
export const SLOT = Object.freeze({
  HOTBAR_SIZE,
  HOTBAR_START: 0,
  HOTBAR_END: HOTBAR_SIZE - 1,
  MAIN_START: HOTBAR_SIZE,
  MAIN_END: HOTBAR_SIZE + MAIN_SIZE - 1,
  ARMOUR_START: HOTBAR_SIZE + MAIN_SIZE,
  ARMOUR_END: HOTBAR_SIZE + MAIN_SIZE + ARMOUR_SIZE - 1,
  OFFHAND: HOTBAR_SIZE + MAIN_SIZE + ARMOUR_SIZE,
  TOTAL: HOTBAR_SIZE + MAIN_SIZE + ARMOUR_SIZE + 1,
});

/** Armour slot ordering, from head to feet. */
export const ARMOUR_SLOTS = Object.freeze(['helmet', 'chestplate', 'leggings', 'boots']);

export class Inventory {
  /**
   * @param {import('../core/EventBus.js').EventBus|null} bus
   */
  constructor(bus = null) {
    this._bus = bus;

    /** @type {Array<ItemStack|null>} */
    this.slots = new Array(SLOT.TOTAL).fill(null);

    /**
     * The stack "held by the mouse" while rearranging.
     *
     * Part of the inventory rather than the UI because it must survive the
     * inventory screen closing — otherwise closing mid-drag silently destroys
     * whatever was on the cursor.
     * @type {ItemStack|null}
     */
    this.cursor = null;

    this.selectedSlot = 0;
    this.creative = false;
  }

  // ----------------------------------------------------------------- accessors

  /** The stack in the currently selected hotbar slot. */
  get selectedStack() {
    return this.slots[this.selectedSlot] ?? null;
  }

  /** The item id held, or null. */
  get selectedItemId() {
    return this.selectedStack?.itemId ?? null;
  }

  /**
   * The block the held item would place, or `null` when it places nothing.
   * @returns {number|null}
   */
  get selectedBlockId() {
    const stack = this.selectedStack;
    if (!stack) return null;
    return stack.definition.placeableBlockId;
  }

  /** The hotbar as a plain array, for the HUD. */
  get hotbar() {
    return this.slots.slice(SLOT.HOTBAR_START, SLOT.HOTBAR_END + 1);
  }

  /** The offhand stack. */
  get offhand() {
    return this.slots[SLOT.OFFHAND] ?? null;
  }

  /** Slot currently supplying a usable shield, preferring the selected hand. */
  get shieldSlot() {
    const selected = this.selectedStack;
    if (selected?.definition.metadata.shield) return this.selectedSlot;
    if (this.offhand?.definition.metadata.shield) return SLOT.OFFHAND;
    return -1;
  }

  get hasShield() {
    return this.shieldSlot >= 0;
  }

  /** Equipped armour, in head-to-feet order. */
  get armour() {
    return this.slots.slice(SLOT.ARMOUR_START, SLOT.ARMOUR_END + 1);
  }

  /** Total protection points supplied by equipped, valid pieces. */
  get armourPoints() {
    let total = 0;
    for (let i = SLOT.ARMOUR_START; i <= SLOT.ARMOUR_END; i++) {
      total += this.slots[i]?.definition.armourPoints ?? 0;
    }
    return Math.min(20, total);
  }

  /** Total toughness supplied by equipped pieces. */
  get armourToughness() {
    let total = 0;
    for (let i = SLOT.ARMOUR_START; i <= SLOT.ARMOUR_END; i++) {
      total += this.slots[i]?.definition.armourToughness ?? 0;
    }
    return total;
  }

  /** True when no storage slot can accept anything more. */
  get isFull() {
    if (this.creative) return false;
    for (let i = SLOT.HOTBAR_START; i <= SLOT.MAIN_END; i++) {
      const stack = this.slots[i];
      if (!stack || !stack.isFull) return false;
    }
    return true;
  }

  /** Count of occupied storage slots. */
  get usedSlots() {
    let used = 0;
    for (let i = SLOT.HOTBAR_START; i <= SLOT.MAIN_END; i++) {
      if (this.slots[i]) used++;
    }
    return used;
  }

  /**
   * Whether an index addresses a real slot.
   * @param {number} index
   */
  static isValidIndex(index) {
    return Number.isInteger(index) && index >= 0 && index < SLOT.TOTAL;
  }

  /**
   * Whether an index is general storage (not armour, not offhand).
   * @param {number} index
   */
  static isStorage(index) {
    return index >= SLOT.HOTBAR_START && index <= SLOT.MAIN_END;
  }

  /** Equipment slot name for an inventory index, or null. */
  static armourSlotForIndex(index) {
    if (index < SLOT.ARMOUR_START || index > SLOT.ARMOUR_END) return null;
    return ARMOUR_SLOTS[index - SLOT.ARMOUR_START] ?? null;
  }

  /** Index reserved for a wearable slot name, or -1. */
  static indexForArmourSlot(slot) {
    const offset = ARMOUR_SLOTS.indexOf(slot);
    return offset < 0 ? -1 : SLOT.ARMOUR_START + offset;
  }

  /** Whether a stack may legally occupy a player slot. */
  acceptsInSlot(index, stack) {
    if (!Inventory.isValidIndex(index)) return false;
    if (!stack) return true;
    const armourSlot = Inventory.armourSlotForIndex(index);
    if (armourSlot) {
      return (stack.definition.armourSlot ?? stack.definition.metadata.equipmentSlot) === armourSlot;
    }
    return true;
  }

  // ------------------------------------------------------------- slot plumbing

  /**
   * Reads a slot.
   * @param {number} index
   * @returns {ItemStack|null}
   */
  getSlot(index) {
    return Inventory.isValidIndex(index) ? this.slots[index] ?? null : null;
  }

  /**
   * Writes a slot, normalising empty stacks to `null`.
   *
   * The single write path for the whole class, which is why emptiness only has
   * to be handled here.
   *
   * @param {number} index
   * @param {ItemStack|null} stack
   * @returns {ItemStack|null} What is now in the slot.
   */
  _store(index, stack) {
    if (!Inventory.isValidIndex(index)) return null;
    this.slots[index] = ItemStack.orNull(stack);
    return this.slots[index];
  }

  /**
   * Writes a slot and announces the change.
   * @param {number} index
   * @param {ItemStack|null} stack
   */
  setSlot(index, stack) {
    if (!this.acceptsInSlot(index, stack)) return this.getSlot(index);
    const result = this._store(index, stack);
    this._emitChanged();
    return result;
  }

  /** Empties a slot and returns what was there. */
  takeSlot(index) {
    const stack = this.getSlot(index);
    if (!stack) return null;
    this._store(index, null);
    this._emitChanged();
    return stack;
  }

  // ------------------------------------------------------------ slot selection

  /**
   * Selects a hotbar slot.
   * @param {number} slot
   * @returns {boolean} True when the selection changed.
   */
  selectSlot(slot) {
    if (!Number.isInteger(slot)) return false;
    const clamped = Math.max(0, Math.min(HOTBAR_SIZE - 1, slot));
    if (clamped === this.selectedSlot) return false;
    this.selectedSlot = clamped;
    this._bus?.emit(Events.SLOT_SELECTED, this.selectedSlot, this.selectedStack);
    this._emitChanged();
    return true;
  }

  /**
   * Moves the selection by `steps`, wrapping at both ends.
   * @param {number} steps
   */
  cycleSlot(steps) {
    if (!Number.isFinite(steps) || steps === 0) return;
    const next =
      (((this.selectedSlot + Math.round(steps)) % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE;
    this.selectSlot(next);
  }

  // ------------------------------------------------------------------ insertion

  /**
   * Inserts items, topping up partial stacks before opening a new slot.
   *
   * Insertion order is hotbar then main grid, for both phases. Filling the
   * hotbar first is what makes a freshly mined block immediately usable without
   * opening the inventory.
   *
   * @param {ItemStack|string} itemOrId A stack (consumed in place) or an item id.
   * @param {number} [count] Used only when passing an id.
   * @returns {number} How many items did not fit.
   */
  addItem(itemOrId, count = 1) {
    let incoming;
    if (itemOrId instanceof ItemStack) {
      incoming = itemOrId;
    } else {
      if (!isValidItemId(itemOrId)) return count;
      incoming = new ItemStack(itemOrId, Math.max(1, Math.floor(count)));
    }
    if (incoming.isEmpty) return 0;

    // Creative players have everything; swallow the pickup without hoarding.
    if (this.creative) {
      incoming.quantity = 0;
      return 0;
    }

    const definition = incoming.definition;
    let remaining = incoming.quantity;

    // Phase 1: top up compatible partial stacks.
    if (definition.maxStack > 1) {
      for (let i = SLOT.HOTBAR_START; i <= SLOT.MAIN_END && remaining > 0; i++) {
        const existing = this.slots[i];
        if (!existing || existing.isFull) continue;
        if (!existing.canMergeWith(incoming)) continue;
        const moved = Math.min(existing.freeSpace, remaining);
        existing.quantity += moved;
        remaining -= moved;
      }
    }

    // Phase 2: spill into empty slots, honouring the ceiling each time.
    for (let i = SLOT.HOTBAR_START; i <= SLOT.MAIN_END && remaining > 0; i++) {
      if (this.slots[i]) continue;
      const take = Math.min(definition.maxStack, remaining);
      this._store(
        i,
        new ItemStack(incoming.itemId, take, {
          damage: incoming.damage,
          metadata: incoming.metadata,
        })
      );
      remaining -= take;
    }

    const accepted = incoming.quantity - remaining;
    incoming.quantity = remaining;

    if (accepted > 0) {
      this._emitChanged();
      this._bus?.emit(Events.ITEM_PICKED_UP, {
        itemId: incoming.itemId,
        count: accepted,
        displayName: definition.displayName,
      });
    }
    return remaining;
  }

  /**
   * Whether at least one of `itemId` could be inserted right now.
   * @param {string} itemId
   */
  canAccept(itemId) {
    if (this.creative) return true;
    if (!isValidItemId(itemId)) return false;
    const definition = getItem(itemId);
    for (let i = SLOT.HOTBAR_START; i <= SLOT.MAIN_END; i++) {
      const stack = this.slots[i];
      if (!stack) return true;
      if (definition.maxStack > 1 && stack.itemId === itemId && !stack.isFull) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------- removal

  /**
   * Total quantity of an item across storage.
   * @param {string} itemId
   */
  countOf(itemId) {
    let total = 0;
    for (let i = SLOT.HOTBAR_START; i <= SLOT.MAIN_END; i++) {
      const stack = this.slots[i];
      if (stack && stack.itemId === itemId) total += stack.quantity;
    }
    return total;
  }

  /**
   * Whether storage holds at least `count` of an item.
   * @param {string} itemId
   * @param {number} [count]
   */
  hasItems(itemId, count = 1) {
    if (this.creative) return true;
    return this.countOf(itemId) >= count;
  }

  /**
   * Removes up to `count` of an item.
   *
   * Drains the *last* matching slot first so the hotbar keeps its arrangement:
   * consuming a crafting ingredient should not empty the slot the player is
   * looking at while a duplicate sits in the grid.
   *
   * @param {string} itemId
   * @param {number} [count]
   * @returns {number} How many were actually removed.
   */
  removeItem(itemId, count = 1) {
    if (this.creative) return count;
    let toRemove = Math.max(0, Math.floor(count));
    let removed = 0;
    for (let i = SLOT.MAIN_END; i >= SLOT.HOTBAR_START && toRemove > 0; i--) {
      const stack = this.slots[i];
      if (!stack || stack.itemId !== itemId) continue;
      const taken = stack.shrink(toRemove);
      toRemove -= taken;
      removed += taken;
      if (stack.isEmpty) this._store(i, null);
    }
    if (removed > 0) this._emitChanged();
    return removed;
  }

  /**
   * Consumes one of the selected stack.
   * @returns {boolean} True when something was consumed.
   */
  consumeSelected() {
    if (this.creative) return true;
    const stack = this.selectedStack;
    if (!stack) return false;
    stack.shrink(1);
    if (stack.isEmpty) this._store(this.selectedSlot, null);
    this._emitChanged();
    return true;
  }

  /**
   * Applies tool wear to the selected stack.
   *
   * @param {number} [amount]
   * @returns {boolean} True when the item broke and was removed.
   */
  damageSelected(amount = 1) {
    if (this.creative) return false;
    const stack = this.selectedStack;
    if (!stack || !stack.isDamageable) return false;
    const broke = stack.applyDamage(amount);
    if (broke) {
      this._store(this.selectedSlot, null);
      this._bus?.emit(Events.TOOL_BROKE, { itemId: stack.itemId, slot: this.selectedSlot });
    }
    this._emitChanged();
    return broke;
  }

  /**
   * Consumes durability from whichever hand is actively supplying a shield.
   * @returns {boolean} True when the shield broke.
   */
  damageShield(amount = 1) {
    if (this.creative) return false;
    const slot = this.shieldSlot;
    if (slot < 0) return false;
    const stack = this.slots[slot];
    if (!stack?.isDamageable) return false;
    const itemId = stack.itemId;
    const broke = stack.applyDamage(amount);
    if (broke) {
      this._store(slot, null);
      this._bus?.emit(Events.SHIELD_BROKE, { itemId, slot });
    }
    this._emitChanged();
    return broke;
  }

  /**
   * Resolves one incoming hit through equipped armour and consumes durability.
   * Called by `PlayerStats` only after invulnerability checks pass.
   */
  resolveDamage(amount, source) {
    const incoming = Math.max(0, Number(amount) || 0);
    if (incoming <= 0 || !source?.reducedByArmour) return incoming;

    const points = this.armourPoints;
    if (points <= 0) return incoming;
    const resolved = damageAfterArmour(incoming, points, this.armourToughness);
    const wear = armourDurabilityLoss(incoming);
    let changed = false;

    for (let i = SLOT.ARMOUR_START; i <= SLOT.ARMOUR_END; i++) {
      const stack = this.slots[i];
      if (!stack?.isArmour) continue;
      changed = true;
      if (!stack.applyDamage(wear)) continue;
      const itemId = stack.itemId;
      this._store(i, null);
      this._bus?.emit(Events.ARMOUR_BROKE, {
        itemId,
        slot: i,
        armourSlot: Inventory.armourSlotForIndex(i),
      });
    }

    if (changed) this._emitChanged();
    return resolved;
  }

  // ------------------------------------------------- cursor / manual rearranging

  /**
   * Swaps the cursor with a slot's contents, or merges when compatible.
   *
   * This is the left-click behaviour: pick up a whole stack, put a whole stack
   * down, or top up a matching stack.
   *
   * @param {number} index
   */
  swapWithCursor(index) {
    if (!Inventory.isValidIndex(index)) return false;
    const slotStack = this.getSlot(index);
    const cursor = this.cursor;

    if (cursor && !this.acceptsInSlot(index, cursor)) return false;

    if (cursor && slotStack && slotStack.canMergeWith(cursor)) {
      slotStack.merge(cursor);
      this.cursor = ItemStack.orNull(cursor);
    } else {
      this.cursor = slotStack;
      this._store(index, cursor);
    }
    this._emitChanged();
    return true;
  }

  /**
   * Right-click behaviour: take half, or place a single item.
   * @param {number} index
   */
  splitWithCursor(index) {
    if (!Inventory.isValidIndex(index)) return false;
    const slotStack = this.getSlot(index);
    if (this.cursor && !this.acceptsInSlot(index, this.cursor)) return false;

    if (!this.cursor) {
      // Empty cursor: lift half the slot.
      if (!slotStack) return false;
      this.cursor = slotStack.splitHalf();
      if (slotStack.isEmpty) this._store(index, null);
    } else if (!slotStack) {
      // Occupied cursor over an empty slot: drop exactly one.
      if (!this.acceptsInSlot(index, this.cursor)) return false;
      const one = this.cursor.split(1);
      this._store(index, one);
      this.cursor = ItemStack.orNull(this.cursor);
    } else if (slotStack.canMergeWith(this.cursor) && !slotStack.isFull) {
      slotStack.grow(1);
      this.cursor.shrink(1);
      this.cursor = ItemStack.orNull(this.cursor);
    } else {
      // Incompatible: fall back to a plain swap so the click is never a no-op.
      return this.swapWithCursor(index);
    }
    this._emitChanged();
    return true;
  }

  /**
   * Swaps a hotbar slot with another slot, for number-key transfers.
   * @param {number} index
   * @param {number} hotbarSlot
   */
  swapWithHotbar(index, hotbarSlot) {
    if (!Inventory.isValidIndex(index)) return false;
    if (hotbarSlot < 0 || hotbarSlot >= HOTBAR_SIZE) return false;
    if (index === hotbarSlot) return false;
    const a = this.getSlot(index);
    const b = this.getSlot(hotbarSlot);
    if (b && !this.acceptsInSlot(index, b)) return false;
    this._store(index, b);
    this._store(hotbarSlot, a);
    this._emitChanged();
    return true;
  }

  /**
   * Moves a stack between the hotbar and the main grid, as shift-click does.
   *
   * @param {number} index
   * @returns {boolean} True when anything moved.
   */
  quickMove(index) {
    const stack = this.getSlot(index);
    if (!stack) return false;

    // Wearable items prefer their dedicated empty slot before ordinary storage
    // routing. This is the familiar shift-click-to-equip interaction and, more
    // importantly, guarantees the slot filter is never bypassed by transfer code.
    const wearableSlot = stack.definition.armourSlot ?? stack.definition.metadata.equipmentSlot;
    if (Inventory.isStorage(index) && wearableSlot) {
      const equipmentSlot = Inventory.indexForArmourSlot(wearableSlot);
      if (equipmentSlot >= 0 && !this.slots[equipmentSlot]) {
        this._store(equipmentSlot, stack.split(1));
        if (stack.isEmpty) this._store(index, null);
        this._emitChanged();
        return true;
      }
    }

    // Shields prefer the offhand, but only when it is empty. Keeping this rule
    // inside the inventory transfer path prevents the UI and container screens
    // from having subtly different equip behaviour.
    if (
      Inventory.isStorage(index) &&
      stack.definition.metadata.shield &&
      !this.slots[SLOT.OFFHAND]
    ) {
      this._store(SLOT.OFFHAND, stack.split(1));
      if (stack.isEmpty) this._store(index, null);
      this._emitChanged();
      return true;
    }

    // Hotbar goes to the main grid and vice versa; armour and offhand go to
    // storage generally.
    const toHotbar = index > SLOT.HOTBAR_END;
    const from = toHotbar ? SLOT.HOTBAR_START : SLOT.MAIN_START;
    const to = toHotbar ? SLOT.HOTBAR_END : SLOT.MAIN_END;

    const moved = this._insertInRange(stack, from, to);
    if (stack.isEmpty) this._store(index, null);
    if (moved > 0) this._emitChanged();
    return moved > 0;
  }

  /**
   * Consolidates and deterministically sorts the 27-slot storage grid.
   *
   * The hotbar, equipment, offhand and cursor are intentionally untouched: the
   * hotbar is a player's muscle-memory layout, while storage is the part that
   * benefits from automatic organisation. Equal stacks are merged before sorting
   * and every output stack still obeys its registry stack limit.
   *
   * @returns {boolean} True when storage contained anything to sort.
   */
  sortStorage() {
    const pending = [];
    for (let index = SLOT.MAIN_START; index <= SLOT.MAIN_END; index++) {
      const stack = this.slots[index];
      if (stack) pending.push(stack.clone());
    }
    if (pending.length === 0) return false;

    /** @type {ItemStack[]} */
    const compacted = [];
    for (const source of pending) {
      if (source.maxStack > 1) {
        for (const target of compacted) {
          if (source.isEmpty) break;
          if (target.isFull || !target.canMergeWith(source)) continue;
          target.merge(source);
        }
      }
      while (!source.isEmpty) {
        const taken = Math.min(source.quantity, source.maxStack);
        compacted.push(new ItemStack(source.itemId, taken, {
          damage: source.damage,
          metadata: source.metadata,
        }));
        source.shrink(taken);
      }
    }

    compacted.sort(compareStorageStacks);
    for (let index = SLOT.MAIN_START; index <= SLOT.MAIN_END; index++) {
      this.slots[index] = null;
    }
    for (let offset = 0; offset < compacted.length; offset++) {
      this.slots[SLOT.MAIN_START + offset] = compacted[offset];
    }
    this._emitChanged();
    return true;
  }

  /**
   * Inserts a stack into a slot range, merging first then filling gaps.
   *
   * The shared primitive behind `quickMove` and every container transfer, which
   * is what keeps "shift-click into a chest" and "shift-click into the hotbar"
   * from drifting apart.
   *
   * @param {ItemStack} stack Mutated as items leave it.
   * @param {number} from Inclusive.
   * @param {number} to Inclusive.
   * @returns {number} How many items moved.
   */
  _insertInRange(stack, from, to) {
    let moved = 0;
    if (stack.maxStack > 1) {
      for (let i = from; i <= to && !stack.isEmpty; i++) {
        const existing = this.slots[i];
        if (!existing || existing.isFull || !existing.canMergeWith(stack)) continue;
        moved += existing.merge(stack);
      }
    }
    for (let i = from; i <= to && !stack.isEmpty; i++) {
      if (this.slots[i]) continue;
      const taken = Math.min(stack.maxStack, stack.quantity);
      this._store(
        i,
        new ItemStack(stack.itemId, taken, { damage: stack.damage, metadata: stack.metadata })
      );
      stack.shrink(taken);
      moved += taken;
    }
    return moved;
  }

  // -------------------------------------------------------------------- dropping

  /**
   * Removes the selected stack so the caller can spawn it in the world.
   *
   * @param {boolean} [wholeStack]
   * @returns {ItemStack|null} What to drop, already removed from the inventory.
   */
  dropSelected(wholeStack = false) {
    const stack = this.selectedStack;
    if (!stack) return null;
    // Creative drops a copy: the inventory is notional, so removing from it
    // would be meaningless, but the world entity should still appear.
    if (this.creative) {
      return new ItemStack(stack.itemId, wholeStack ? stack.quantity : 1, {
        damage: stack.damage,
        metadata: stack.metadata,
      });
    }
    const dropped = wholeStack ? stack.split(stack.quantity) : stack.split(1);
    if (stack.isEmpty) this._store(this.selectedSlot, null);
    this._emitChanged();
    return dropped;
  }

  /**
   * Removes and returns everything, for a survival death.
   * @returns {ItemStack[]}
   */
  dropEverything() {
    /** @type {ItemStack[]} */
    const dropped = [];
    for (let i = 0; i < SLOT.TOTAL; i++) {
      const stack = this.slots[i];
      if (stack) dropped.push(stack);
      this.slots[i] = null;
    }
    if (this.cursor) {
      dropped.push(this.cursor);
      this.cursor = null;
    }
    this._emitChanged();
    return dropped;
  }

  /** Empties every slot without returning the contents. */
  clear() {
    this.slots.fill(null);
    this.cursor = null;
    this._emitChanged();
  }

  // ----------------------------------------------------------------- utilities

  /**
   * Selects a slot already holding `itemId`, or places it in the selected slot.
   *
   * The creative "pick block" middle-click, extended to items.
   *
   * @param {string} itemId
   * @returns {boolean}
   */
  pickItem(itemId) {
    if (!isValidItemId(itemId)) return false;

    for (let i = SLOT.HOTBAR_START; i <= SLOT.HOTBAR_END; i++) {
      if (this.slots[i]?.itemId === itemId) {
        this.selectSlot(i);
        return true;
      }
    }
    // Already carried but not on the hotbar: bring it forward.
    for (let i = SLOT.MAIN_START; i <= SLOT.MAIN_END; i++) {
      if (this.slots[i]?.itemId === itemId) {
        this.swapWithHotbar(i, this.selectedSlot);
        return true;
      }
    }
    if (!this.creative) return false;

    this._store(this.selectedSlot, new ItemStack(itemId, 1));
    this._emitChanged();
    return true;
  }

  /**
   * `pickItem` addressed by block id, for middle-click on a placed block.
   * @param {number} blockId
   */
  pickBlock(blockId) {
    const itemId = itemIdForBlock(blockId);
    return itemId ? this.pickItem(itemId) : false;
  }

  /**
   * Switches game mode.
   * @param {boolean} creative
   */
  setCreative(creative) {
    const next = Boolean(creative);
    if (next === this.creative) return;
    this.creative = next;
    this._emitChanged();
  }

  /** Gives a new survival player their starting kit (currently nothing). */
  resetToDefaults() {
    this.slots.fill(null);
    this.cursor = null;
    this.selectedSlot = 0;
    this._emitChanged();
  }

  // ------------------------------------------------------------- serialisation

  /**
   * @returns {{slots: Array<Object|null>, selectedSlot: number, cursor: Object|null}}
   */
  toJSON() {
    return {
      slots: this.slots.map((stack) => (stack ? stack.toJSON() : null)),
      selectedSlot: this.selectedSlot,
      cursor: this.cursor ? this.cursor.toJSON() : null,
    };
  }

  /**
   * Restores from a save.
   *
   * Unreadable slots are dropped individually rather than failing the load, and
   * a legacy hotbar-only save is upgraded in place. See `migrateLegacyHotbar`.
   *
   * @param {Object|null} data
   */
  fromJSON(data) {
    this.slots.fill(null);
    this.cursor = null;
    if (!data || typeof data !== 'object') {
      this._emitChanged();
      return;
    }

    const incoming = Array.isArray(data.slots)
      ? data.slots
      : migrateLegacyHotbar(/** @type {Array} */ (data.hotbar));

    for (let i = 0; i < Math.min(incoming.length, SLOT.TOTAL); i++) {
      const stack = ItemStack.fromJSON(incoming[i]);
      this.slots[i] = this.acceptsInSlot(i, stack) ? stack : null;
    }
    if (data.cursor) this.cursor = ItemStack.fromJSON(data.cursor);

    const slot = Number(data.selectedSlot);
    this.selectedSlot = Number.isInteger(slot)
      ? Math.max(0, Math.min(HOTBAR_SIZE - 1, slot))
      : 0;

    this._emitChanged();
  }

  _emitChanged() {
    if (!this._bus) return;
    this._bus.emit(Events.HOTBAR_CHANGED, this.hotbar, this.selectedSlot);
    this._bus.emit(Events.INVENTORY_CHANGED, this);
  }
}
function storageCategory(stack) {
  const definition = stack.definition;
  if (stack.isTool || stack.isArmour || definition.metadata?.shield || definition.metadata?.rangedWeapon) return 0;
  if (Number.isInteger(definition.placeableBlockId) && definition.placeableBlockId >= 0) return 1;
  if (stack.isFood) return 2;
  if (stack.isFuel) return 3;
  return 4;
}

function metadataSortKey(metadata) {
  if (!metadata) return '';
  const ordered = {};
  for (const key of Object.keys(metadata).sort()) ordered[key] = metadata[key];
  try {
    return JSON.stringify(ordered);
  } catch {
    return '';
  }
}

function compareStorageStacks(a, b) {
  const category = storageCategory(a) - storageCategory(b);
  if (category !== 0) return category;
  const name = a.displayName.localeCompare(b.displayName);
  if (name !== 0) return name;
  if (a.damage !== b.damage) return a.damage - b.damage;
  return metadataSortKey(a.metadata).localeCompare(metadataSortKey(b.metadata));
}

/**
 * Converts a pre-item-registry hotbar into the flat slot array.
 *
 * Saves written before items existed stored `{id: <blockId>, count}`. Those
 * numeric block ids have to be mapped through `itemIdForBlock`, because item ids
 * are strings and a raw number would be rejected by `ItemStack.fromJSON`.
 *
 * A block whose item no longer exists yields an empty slot: the player loses one
 * slot rather than the whole world.
 *
 * @param {Array<{id: number, count: number}|null>|undefined} hotbar
 * @returns {Array<Object|null>}
 */
export function migrateLegacyHotbar(hotbar) {
  const slots = new Array(SLOT.TOTAL).fill(null);
  if (!Array.isArray(hotbar)) return slots;

  for (let i = 0; i < Math.min(hotbar.length, HOTBAR_SIZE); i++) {
    const entry = hotbar[i];
    if (!entry || typeof entry !== 'object') continue;

    // Legacy entries keyed by numeric block id.
    const blockId = typeof entry.id === 'number' ? entry.id : null;
    const itemId = blockId === null ? null : itemIdForBlock(blockId);
    if (!itemId) continue;

    const count = Math.max(1, Math.floor(Number(entry.count) || 1));
    slots[i] = { id: itemId, n: count };
  }
  return slots;
}

export default Inventory;
