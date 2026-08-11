/**
 * Every way an item moves between two places.
 *
 * ## Why this is centralised
 *
 * There are a lot of transfer paths: player to chest, chest to player, player to
 * furnace fuel, furnace output to player, hotbar to main grid, crafting result to
 * cursor. Each one is "take from a source slot, insert into a destination, put back
 * whatever did not fit". Written per screen, that becomes six copies of the same
 * three lines — and the copy that forgets the "put back what did not fit" step
 * deletes the player's items.
 *
 * So every path funnels through the helpers here. There is exactly one place where
 * a partial transfer can be mishandled, and it is covered by tests.
 *
 * ## The safety invariant
 *
 * Every function either moves items or leaves both sides untouched. None of them
 * can reduce the total item count in the system. The pattern that guarantees it is
 * always the same: mutate the source stack *in place* as items leave it, so
 * anything that did not transfer is still sitting in the source. There is no
 * intermediate variable holding items that a missing line could drop.
 *
 * Worker-safe: no DOM, no Three.js.
 */

import { SLOT } from '../player/Inventory.js';

/**
 * @typedef {Object} SlotSource
 * @property {(index: number) => import('../items/ItemStack.js').ItemStack|null} getSlot
 * @property {(index: number, stack: import('../items/ItemStack.js').ItemStack|null) => any} setSlot
 */

/**
 * Moves a whole stack from one container to another, keeping the remainder.
 *
 * @param {SlotSource} from
 * @param {number} fromSlot
 * @param {{insert: (stack: any, slots?: number[]) => number}} to
 * @param {number[]} [allowedSlots] Restrict the destination slots.
 * @returns {number} How many items moved.
 */
export function transferSlot(from, fromSlot, to, allowedSlots = null) {
  const stack = from.getSlot(fromSlot);
  if (!stack || stack.isEmpty) return 0;

  // `insert` drains the stack as items are accepted, so whatever is left is still
  // in the source. That is the whole safety argument: there is no temporary
  // holding the items.
  const moved = to.insert(stack, allowedSlots);
  if (stack.isEmpty) from.setSlot(fromSlot, null);
  return moved;
}

/**
 * Moves a stack from a container into the player's inventory.
 *
 * @param {{getSlot: Function, setSlot: Function}} container
 * @param {number} slot
 * @param {import('../player/Inventory.js').Inventory} inventory
 * @returns {number} How many items moved.
 */
export function containerToPlayer(container, slot, inventory) {
  const stack = container.getSlot(slot);
  if (!stack || stack.isEmpty) return 0;
  if (inventory.creative) return 0;
  const before = stack.quantity;
  // `Inventory.addItem` also drains in place.
  inventory.addItem(stack);
  if (stack.isEmpty) container.setSlot(slot, null);
  else container.revision++;
  return before - stack.quantity;
}

/**
 * Moves a stack from the player's inventory into a container.
 *
 * @param {import('../player/Inventory.js').Inventory} inventory
 * @param {number} slot
 * @param {{insert: Function}} container
 * @param {number[]} [allowedSlots]
 * @returns {number} How many items moved.
 */
export function playerToContainer(inventory, slot, container, allowedSlots = null) {
  const stack = inventory.getSlot(slot);
  if (!stack || stack.isEmpty) return 0;
  const clone = stack.clone();
  const before = clone.quantity;
  container.insert(clone, allowedSlots);
  const moved = before - clone.quantity;
  if (moved <= 0) return 0;
  stack.shrink(moved);
  if (stack.isEmpty) inventory.setSlot(slot, null);
  return moved;
}

/**
 * Shift-click inside the player's own inventory: hotbar <-> main grid.
 *
 * Delegates to `Inventory.quickMove`, which owns the range logic. Wrapped here so
 * every screen calls one transfer API rather than some calling the inventory
 * directly and some calling this module.
 *
 * @param {import('../player/Inventory.js').Inventory} inventory
 * @param {number} slot
 * @returns {boolean}
 */
export function quickMoveWithinPlayer(inventory, slot) {
  return inventory.quickMove(slot);
}

/**
 * Applies a cursor interaction to an arbitrary container slot.
 *
 * The cursor lives on `Inventory` so it survives a screen closing, but the slot
 * being clicked may belong to a chest or a furnace. This is the shared
 * implementation of "left click a slot" for anything that is not the player's own
 * inventory.
 *
 * @param {import('../player/Inventory.js').Inventory} inventory Owns the cursor.
 * @param {{getSlot: Function, setSlot: Function, acceptsInSlot: Function, outputSlots: ReadonlyArray<number>}} container
 * @param {number} slot
 * @returns {boolean} True when anything changed.
 */
export function cursorClickContainer(inventory, container, slot) {
  const cursor = inventory.cursor;
  const existing = container.getSlot(slot);
  const isOutput = container.outputSlots.includes(slot);

  // Output slots can only be emptied, never filled.
  if (isOutput) {
    if (!existing) return false;
    if (!cursor) {
      inventory.cursor = container.takeSlot(slot);
      return true;
    }
    // Holding something compatible? Absorb the output into it.
    if (cursor.canMergeWith(existing)) {
      const moved = cursor.merge(existing);
      if (existing.isEmpty) container.setSlot(slot, null);
      return moved > 0;
    }
    return false;
  }

  if (cursor && existing && existing.canMergeWith(cursor)) {
    const moved = existing.merge(cursor);
    inventory.cursor = cursor.isEmpty ? null : cursor;
    return moved > 0;
  }

  if (cursor && !container.acceptsInSlot(slot, cursor)) {
    // A filtered slot refusing the held item must be a visible no-op rather than
    // a silent swap that hides the item somewhere unexpected.
    return false;
  }

  inventory.cursor = existing;
  container.setSlot(slot, cursor);
  return true;
}

/**
 * Right-click equivalent for an arbitrary container slot: take half, or place one.
 *
 * @param {import('../player/Inventory.js').Inventory} inventory
 * @param {{getSlot: Function, setSlot: Function, acceptsInSlot: Function, outputSlots: ReadonlyArray<number>}} container
 * @param {number} slot
 * @returns {boolean} True when anything changed.
 */
export function cursorSplitContainer(inventory, container, slot) {
  const cursor = inventory.cursor;
  const existing = container.getSlot(slot);

  if (container.outputSlots.includes(slot)) {
    // Halving an output makes no sense; treat it as a plain take.
    return cursorClickContainer(inventory, container, slot);
  }

  if (!cursor) {
    if (!existing) return false;
    const half = existing.splitHalf();
    if (existing.isEmpty) container.setSlot(slot, null);
    else container.revision++;
    inventory.cursor = half;
    return true;
  }

  if (!container.acceptsInSlot(slot, cursor)) return false;

  if (!existing) {
    const one = cursor.split(1);
    container.setSlot(slot, one);
    inventory.cursor = cursor.isEmpty ? null : cursor;
    return true;
  }

  if (existing.canMergeWith(cursor) && !existing.isFull) {
    existing.grow(1);
    cursor.shrink(1);
    container.revision++;
    inventory.cursor = cursor.isEmpty ? null : cursor;
    return true;
  }

  return false;
}

/**
 * Swaps a container slot with one of the player's hotbar slots.
 *
 * @param {import('../player/Inventory.js').Inventory} inventory
 * @param {{getSlot: Function, setSlot: Function, acceptsInSlot: Function, outputSlots: ReadonlyArray<number>}} container
 * @param {number} slot
 * @param {number} hotbarSlot
 * @returns {boolean}
 */
export function swapContainerWithHotbar(inventory, container, slot, hotbarSlot) {
  if (hotbarSlot < 0 || hotbarSlot >= SLOT.HOTBAR_SIZE) return false;
  const held = inventory.getSlot(hotbarSlot);
  const inContainer = container.getSlot(slot);

  if (container.outputSlots.includes(slot)) {
    // Only pull out of an output slot.
    if (!inContainer || held) return false;
    inventory.setSlot(hotbarSlot, container.takeSlot(slot));
    return true;
  }
  if (held && !container.acceptsInSlot(slot, held)) return false;

  container.setSlot(slot, held);
  inventory.setSlot(hotbarSlot, inContainer);
  return true;
}
