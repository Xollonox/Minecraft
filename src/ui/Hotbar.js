/**
 * The nine-slot hotbar.
 *
 * ## Why the DOM is only touched on change
 *
 * A hotbar that rebuilt itself every frame would add nine layout invalidations to
 * every single frame for no reason — the contents change a few times a minute.
 * Slot elements are therefore created once and mutated only when the inventory
 * emits a change, and the *selection* is a single class toggle on two elements.
 *
 * Icons come from `TextureAtlas.getItemIcon`, which renders an isometric
 * composite for block items and a flat tile for everything else, caching both as
 * data URLs. So the hotbar shows real art with no extra assets and no per-frame
 * canvas work.
 */

import { HOTBAR_SIZE } from '../player/Inventory.js';
import { el, setVisible } from './dom.js';
import { ItemDetails } from './ItemDetails.js';

/** How long the block-name tooltip stays after a slot change, in ms. */
const TOOLTIP_DURATION = 1400;
/** Milliseconds a press must last to open item details. */
const LONG_PRESS_MS = 420;

export class Hotbar {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.root
   * @param {import('../rendering/TextureAtlas.js').TextureAtlas} options.atlas
   * @param {(slot: number) => void} options.onSelect
   * @param {() => void} [options.onOpenInventory]
   */
  constructor({ root, atlas, onSelect, onOpenInventory }) {
    this._atlas = atlas;
    this._onSelect = onSelect;
    this._onOpenInventory = onOpenInventory;

    /** @type {Array<{node: HTMLElement, icon: HTMLImageElement, count: HTMLElement}>} */
    this._slots = [];
    this._selected = 0;
    this._tooltipTimer = 0;

    this._tooltip = el('div', { className: 'hotbar-tooltip' });

    const children = [];
    for (let slot = 0; slot < HOTBAR_SIZE; slot++) {
      const icon = el('img', {
        className: 'hotbar-slot-icon',
        alt: '',
        attrs: { 'aria-hidden': 'true', draggable: 'false' },
      });
      icon.hidden = true;

      const count = el('span', { className: 'hotbar-slot-count' });
      const key = el('span', { className: 'hotbar-slot-key', text: String(slot + 1) });

      // Durability bar, hidden unless the slot holds a damaged tool. Built up
      // front rather than created on demand so a swing never allocates DOM.
      const durabilityFill = el('div', { className: 'hotbar-slot-durability-fill' });
      const durability = el('div', { className: 'hotbar-slot-durability' }, [durabilityFill]);
      durability.hidden = true;

      const node = el(
        'div',
        {
          className: 'hotbar-slot',
          attrs: {
            role: 'button',
            tabindex: '-1',
            'aria-label': `Hotbar slot ${slot + 1}`,
          },
          dataset: { slot: String(slot) },
          on: {
            // `pointerdown` rather than `click`: on touch this fires immediately,
            // and it also prevents the canvas underneath from receiving the event.
            pointerdown: (event) => {
              event.preventDefault();
              event.stopPropagation();
              this._onSelect(slot);
              // A long press opens item details. Safe to bind here because
              // splitting — what long press does inside a container — has no
              // meaning on the hotbar, and touch devices have no hover.
              this._beginPress(slot, event.clientX, event.clientY);
            },
            pointerup: () => this._endPress(),
            pointercancel: () => this._endPress(),
            pointerleave: () => this._endPress(),
            // Pointer devices get the same information on hover, where it costs
            // nothing and needs no gesture.
            pointerenter: (event) => {
              if (event.pointerType === 'touch') return;
              this._showDetails(slot, event.clientX, event.clientY);
            },
          },
        },
        [icon, count, durability, key]
      );

      this._slots.push({ node, icon, count, durability, durabilityFill });
      children.push(node);
    }

    // Dedicated BAG button directly beside the hotbar on the right side
    const bagIcon = el('span', { className: 'hotbar-bag-icon', text: '🎒' });
    const bagLabel = el('span', { className: 'hotbar-bag-label', text: 'BAG' });

    this._bagButton = el(
      'button',
      {
        className: 'hotbar-slot hotbar-bag-btn',
        type: 'button',
        attrs: {
          tabindex: '-1',
          'aria-label': 'Open block palette inventory',
          title: 'Open Block Palette (E)',
        },
        on: {
          pointerdown: (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (this._onOpenInventory) {
              this._onOpenInventory();
            }
          },
          click: (event) => {
            event.preventDefault();
            event.stopPropagation();
          },
        },
      },
      [bagIcon, bagLabel]
    );

    this.element = el('div', {
      className: 'hotbar',
      attrs: { role: 'toolbar', 'aria-label': 'Block hotbar' },
    }, [...children, this._bagButton, this._tooltip]);

    root.appendChild(this.element);
    this._details = new ItemDetails({ root });
    this._pressTimer = 0;
    /** @type {Array<import('../items/ItemStack.js').ItemStack|null>} */
    this._contents = [];
    this._applySelection();
  }

  /** Starts the long-press timer that opens item details. */
  _beginPress(slot, x, y) {
    this._endPress();
    this._pressTimer = window.setTimeout(() => {
      this._showDetails(slot, x, y);
      try {
        navigator.vibrate?.(10);
      } catch {
        /* haptics are a nicety */
      }
    }, LONG_PRESS_MS);
  }

  _endPress() {
    if (this._pressTimer) {
      clearTimeout(this._pressTimer);
      this._pressTimer = 0;
    }
    this._details.hide();
  }

  _showDetails(slot, x, y) {
    this._details.show(this._contents[slot] ?? null, x, y);
  }

  /**
   * Rebuilds the slot contents.
   * @param {Array<import('../items/ItemStack.js').ItemStack|null>} hotbar
   * @param {number} selectedSlot
   */
  update(hotbar, selectedSlot) {
    // Kept so the long-press handler can describe a slot without reaching back
    // into the inventory, which the hotbar deliberately has no reference to.
    this._contents = hotbar;

    for (let slot = 0; slot < HOTBAR_SIZE; slot++) {
      const stack = hotbar[slot];
      const target = this._slots[slot];
      if (!target) continue;

      if (!stack || stack.isEmpty) {
        target.icon.hidden = true;
        target.icon.removeAttribute('src');
        target.count.textContent = '';
        target.durability.hidden = true;
        target.node.setAttribute('aria-label', `Hotbar slot ${slot + 1}: empty`);
        continue;
      }

      const source = this._atlas.getItemIcon(stack.itemId, 48);
      // Only assign when it actually changed: setting `src` to the same data URL
      // still triggers a decode in some browsers.
      if (target.icon.getAttribute('src') !== source) target.icon.setAttribute('src', source);
      target.icon.hidden = false;
      // A count of one is implicit, as is an infinite creative stack.
      target.count.textContent = stack.quantity > 1 ? String(stack.quantity) : '';

      // Only damaged tools show a bar; a pristine one would be visual noise on
      // every slot.
      if (stack.isDamaged) {
        const fraction = stack.durabilityFraction;
        target.durability.hidden = false;
        target.durabilityFill.style.width = `${Math.round(fraction * 100)}%`;
        // Green through amber to red, so wear is readable without counting pixels.
        const hue = Math.round(fraction * 110);
        target.durabilityFill.style.background = `hsl(${hue} 78% 46%)`;
      } else {
        target.durability.hidden = true;
      }

      const wear = stack.isDamaged
        ? `, ${stack.remainingDurability} of ${stack.maxDurability} uses left`
        : '';
      target.node.setAttribute(
        'aria-label',
        `Hotbar slot ${slot + 1}: ${stack.displayName}` +
          `${stack.quantity > 1 ? ` x${stack.quantity}` : ''}${wear}`
      );
    }

    if (selectedSlot !== this._selected) {
      this._selected = selectedSlot;
      this._applySelection();
    }
    this._showTooltip(hotbar[this._selected]);
  }

  /**
   * Moves the selection highlight.
   * @param {number} slot
   */
  setSelected(slot) {
    if (slot === this._selected) return;
    this._selected = slot;
    this._applySelection();
  }

  /** Applies the `is-selected` class to exactly one slot. */
  _applySelection() {
    for (let slot = 0; slot < this._slots.length; slot++) {
      this._slots[slot].node.classList.toggle('is-selected', slot === this._selected);
      this._slots[slot].node.setAttribute('aria-pressed', slot === this._selected ? 'true' : 'false');
    }
  }

  /** Briefly names the selected item, the way a hotbar normally does. */
  _showTooltip(stack) {
    if (this._tooltipTimer) clearTimeout(this._tooltipTimer);
    if (!stack || stack.isEmpty) {
      this._tooltip.classList.remove('is-visible');
      return;
    }
    this._tooltip.textContent = stack.isDamaged
      ? `${stack.displayName}  ${stack.remainingDurability}/${stack.maxDurability}`
      : stack.displayName;
    this._tooltip.classList.add('is-visible');
    this._tooltipTimer = setTimeout(() => {
      this._tooltip.classList.remove('is-visible');
    }, TOOLTIP_DURATION);
  }

  /** Shows or hides the hotbar. */
  setVisible(visible) {
    setVisible(this.element, visible);
  }

  /** Removes the element and clears the tooltip timer. */
  destroy() {
    if (this._tooltipTimer) clearTimeout(this._tooltipTimer);
    this._endPress();
    this._details.destroy();
    this.element.remove();
  }
}

export default Hotbar;
