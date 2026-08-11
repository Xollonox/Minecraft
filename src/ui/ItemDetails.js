/**
 * A popover describing an item's stats.
 *
 * ## Why this exists separately from the hotbar tooltip
 *
 * The hotbar already flashes an item's *name* when the selection changes. That is
 * enough to know what you are holding, but not enough to answer "is this pickaxe
 * good enough for iron?" — and on a phone there is no hover, so there is otherwise
 * no way to find out at all.
 *
 * So details are bound to an explicit gesture: a long press on a hotbar slot, or a
 * hover on a pointer device. Long press is free to use here because splitting a
 * stack — what long press does inside a container — is meaningless on the hotbar.
 *
 * ## What it shows
 *
 * Only the fields that affect a decision: damage and speed for a weapon, mining
 * tier for a tool, nutrition for food, burn time for fuel. A stat that is the same
 * for every item is noise, so nothing shows a stack size.
 */

import { el, setVisible } from './dom.js';
import { getItem } from '../items/ItemRegistry.js';
import { TIER_DATA, ToolType } from '../items/ItemTypes.js';

/** Human-readable tier names, capitalised for display. */
const TIER_LABELS = Object.freeze({
  hand: 'Hand',
  wood: 'Wood',
  stone: 'Stone',
  iron: 'Iron',
  diamond: 'Diamond',
});

export class ItemDetails {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.root
   */
  constructor({ root }) {
    this._name = el('span', { className: 'item-details-name' });
    this._rows = el('div', { className: 'item-details-rows' });
    this._note = el('span', { className: 'item-details-note' });

    this.element = el('div', { className: 'item-details', hidden: true }, [
      this._name,
      this._rows,
      this._note,
    ]);
    root.appendChild(this.element);
    this._visible = false;
  }

  /**
   * Shows the popover for a stack, anchored near a screen position.
   *
   * @param {import('../items/ItemStack.js').ItemStack|null} stack
   * @param {number} x Anchor in client pixels.
   * @param {number} y
   */
  show(stack, x, y) {
    if (!stack || stack.isEmpty) {
      this.hide();
      return;
    }
    const definition = getItem(stack.itemId);
    if (!definition) {
      this.hide();
      return;
    }

    this._name.textContent = stack.displayName;
    /** @type {HTMLElement[]} */
    const rows = [];

    const row = (label, value) =>
      el('div', { className: 'item-details-row' }, [
        el('span', { text: label }),
        el('span', { text: String(value) }),
      ]);

    const isTool = definition.toolType !== ToolType.NONE && definition.toolType !== ToolType.BUCKET;

    if (isTool) {
      rows.push(row('Type', capitalise(definition.toolType)));
      rows.push(row('Tier', TIER_LABELS[definition.toolTier] ?? definition.toolTier));
      // Harvest level is the number that answers "can this mine iron?", so it is
      // shown as a level rather than left implicit in the tier name.
      rows.push(row('Harvest level', TIER_DATA[definition.toolTier]?.level ?? 0));
      if (definition.miningSpeed > 1) rows.push(row('Mining speed', `${definition.miningSpeed}x`));
    }

    if (definition.attackDamage > 1) {
      // Displayed in hearts, because that is the unit the health bar uses.
      rows.push(row('Attack damage', `${(definition.attackDamage / 2).toFixed(1)} hearts`));
      rows.push(row('Attack speed', `${definition.attackSpeed.toFixed(1)}/s`));
    }

    if (definition.armourSlot) {
      rows.push(row('Slot', capitalise(definition.armourSlot)));
      rows.push(row('Armour', definition.armourPoints));
      if (definition.armourToughness > 0) {
        rows.push(row('Toughness', definition.armourToughness));
      }
    }

    if (definition.durability > 0) {
      rows.push(row('Durability', `${stack.remainingDurability} / ${definition.durability}`));
    }

    if (definition.foodValue > 0) {
      rows.push(row('Restores', `${(definition.foodValue / 2).toFixed(1)} drumsticks`));
      rows.push(row('Saturation', definition.saturation.toFixed(1)));
    }

    if (definition.fuelValue > 0) {
      rows.push(row('Burns for', `${definition.fuelValue}s`));
    }

    this._rows.replaceChildren(...rows);
    this._note.textContent = rows.length === 0 ? 'A building material.' : '';

    setVisible(this.element, true);
    this._visible = true;
    this._position(x, y);
  }

  /**
   * Keeps the popover on screen.
   *
   * Measured after showing, because an unrendered element has no size — which is
   * why this cannot be folded into `show` before `setVisible`.
   */
  _position(x, y) {
    const rect = this.element.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(Math.max(margin, x - rect.width / 2), window.innerWidth - rect.width - margin);
    // Prefer above the anchor; flip below when there is no room.
    const preferred = y - rect.height - margin;
    const top = preferred < margin ? y + margin * 2 : preferred;
    this.element.style.left = `${Math.round(left)}px`;
    this.element.style.top = `${Math.round(top)}px`;
  }

  hide() {
    if (!this._visible) return;
    this._visible = false;
    setVisible(this.element, false);
  }

  destroy() {
    this.element.remove();
  }
}

function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export default ItemDetails;
