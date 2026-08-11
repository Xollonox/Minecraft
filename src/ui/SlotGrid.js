/**
 * A grid of item slots, and every way a player can interact with one.
 *
 * ## One component for every container
 *
 * The player inventory, a chest, a furnace and a crafting grid all present the
 * same affordance: a rectangle of slots you click. Implementing that four times
 * would mean four subtly different click behaviours, and the differences would all
 * be bugs. So the interaction model lives here once and the containers differ only
 * in size and in which transfers they allow.
 *
 * ## Desktop interaction
 *
 * | Input                | Behaviour                                  |
 * |----------------------|--------------------------------------------|
 * | Left click           | Pick up / put down a whole stack, or merge |
 * | Right click          | Take half / place one                      |
 * | Shift + left click   | Transfer the stack to the linked container |
 * | Number key 1-9       | Swap the slot with that hotbar slot        |
 * | Q                    | Drop one; with shift, drop the stack       |
 *
 * ## Touch interaction
 *
 * A phone has no right button, no shift and no hover, so the same operations are
 * reached differently rather than being unavailable:
 *
 * - **Tap** an occupied slot to lift it, tap a destination to place it — the
 *   cursor stack is what makes this work without drag tracking, which is
 *   unreliable across mobile browsers.
 * - **Long press** splits the stack in half, the touch equivalent of right click.
 * - **Double tap** transfers, the equivalent of shift-click.
 * - Slots are sized from `--ui-scale` and never smaller than a comfortable
 *   target, and the grid scrolls rather than shrinking below that.
 *
 * Because the cursor stack lives in `Inventory` rather than in this component,
 * closing the screen mid-move cannot destroy the held items.
 */

import { el } from './dom.js';

/** Milliseconds a press must last to count as a long press. */
const LONG_PRESS_MS = 380;
/** Maximum gap between taps for a double tap, in milliseconds. */
const DOUBLE_TAP_MS = 300;
/** Pixels of movement that cancels a long press. */
const MOVE_CANCEL_PX = 12;

export class SlotGrid {
  /**
   * @param {Object} options
   * @param {import('../rendering/TextureAtlas.js').TextureAtlas} options.atlas
   * @param {number} options.columns
   * @param {number} options.count Number of slots.
   * @param {string} [options.label] Accessible group label.
   * @param {string} [options.className] Extra class on the grid element.
   * @param {(index: number, action: SlotAction) => void} options.onSlotAction
   * @param {boolean} [options.takeOnly] Slots may only be taken from.
   */
  constructor({ atlas, columns, count, label = 'Items', className = '', onSlotAction, takeOnly = false }) {
    this._atlas = atlas;
    this._onSlotAction = onSlotAction;
    this._takeOnly = takeOnly;
    this.count = count;

    /** @type {Array<{node: HTMLElement, icon: HTMLImageElement, count: HTMLElement, bar: HTMLElement, fill: HTMLElement}>} */
    this._slots = [];

    const children = [];
    for (let index = 0; index < count; index++) {
      const icon = el('img', {
        className: 'slot-icon',
        alt: '',
        attrs: { 'aria-hidden': 'true', draggable: 'false' },
      });
      icon.hidden = true;

      const quantity = el('span', { className: 'slot-count' });
      const fill = el('div', { className: 'slot-durability-fill' });
      const bar = el('div', { className: 'slot-durability' }, [fill]);
      bar.hidden = true;

      const node = el(
        'div',
        {
          className: 'slot',
          attrs: { role: 'button', tabindex: '0', 'aria-label': `Empty slot ${index + 1}` },
          dataset: { index: String(index) },
        },
        [icon, quantity, bar]
      );

      this._attachHandlers(node, index);
      this._slots.push({ node, icon, count: quantity, bar, fill });
      children.push(node);
    }

    this.element = el(
      'div',
      {
        className: `slot-grid ${className}`.trim(),
        attrs: { role: 'group', 'aria-label': label },
        style: { '--slot-columns': String(columns) },
      },
      children
    );

    this._pressTimer = 0;
    this._pressIndex = -1;
    this._pressHandled = false;
    this._lastTapAt = 0;
    this._lastTapIndex = -1;
    this._startX = 0;
    this._startY = 0;
  }

  /**
   * @typedef {'primary'|'split'|'transfer'|'drop'|'dropStack'|{hotbar: number}} SlotAction
   */

  /**
   * Wires pointer and keyboard handling for one slot.
   *
   * Pointer events rather than mouse events so a single code path covers mouse,
   * touch and pen; `pointerType` is consulted only where the interaction genuinely
   * has to differ (long press has no mouse equivalent worth having).
   */
  _attachHandlers(node, index) {
    node.addEventListener('contextmenu', (event) => event.preventDefault());

    node.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this._pressHandled = false;
      this._pressIndex = index;
      this._startX = event.clientX;
      this._startY = event.clientY;

      if (event.pointerType === 'touch') {
        // Long press is the touch stand-in for right click.
        this._pressTimer = window.setTimeout(() => {
          this._pressHandled = true;
          this._emit(index, 'split');
          this._vibrate();
        }, LONG_PRESS_MS);
        return;
      }

      // Mouse and pen resolve immediately: button 2 is the split action.
      this._pressHandled = true;
      if (event.button === 2) this._emit(index, 'split');
      else if (event.shiftKey) this._emit(index, 'transfer');
      else this._emit(index, 'primary');
    });

    node.addEventListener('pointermove', (event) => {
      if (this._pressIndex !== index || this._pressHandled) return;
      // A scroll gesture must not become a long press.
      const moved = Math.hypot(event.clientX - this._startX, event.clientY - this._startY);
      if (moved > MOVE_CANCEL_PX) this._cancelPress();
    });

    node.addEventListener('pointerup', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const wasPress = this._pressIndex === index;
      this._cancelPress();
      if (!wasPress || this._pressHandled) return;
      if (event.pointerType !== 'touch') return;

      // A quick second tap on the same slot transfers, standing in for
      // shift-click.
      const now = Date.now();
      if (this._lastTapIndex === index && now - this._lastTapAt < DOUBLE_TAP_MS) {
        this._lastTapIndex = -1;
        this._emit(index, 'transfer');
        return;
      }
      this._lastTapAt = now;
      this._lastTapIndex = index;
      this._emit(index, 'primary');
    });

    node.addEventListener('pointercancel', () => this._cancelPress());
    node.addEventListener('pointerleave', () => {
      if (this._pressIndex === index) this._cancelPress();
    });

    // Keyboard: the whole grid is reachable without a pointer.
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this._emit(index, event.shiftKey ? 'transfer' : 'primary');
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault();
        this._focus(index + (event.key === 'ArrowDown' ? this._columns() : 1));
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        this._focus(index - (event.key === 'ArrowUp' ? this._columns() : 1));
      } else if (/^[1-9]$/.test(event.key)) {
        event.preventDefault();
        this._emit(index, { hotbar: Number(event.key) - 1 });
      } else if (event.key.toLowerCase() === 'q') {
        event.preventDefault();
        this._emit(index, event.shiftKey ? 'dropStack' : 'drop');
      }
    });
  }

  _columns() {
    return Number(this.element.style.getPropertyValue('--slot-columns')) || 9;
  }

  _focus(index) {
    const target = this._slots[Math.max(0, Math.min(this.count - 1, index))];
    target?.node.focus();
  }

  _cancelPress() {
    if (this._pressTimer) {
      clearTimeout(this._pressTimer);
      this._pressTimer = 0;
    }
    this._pressIndex = -1;
  }

  _emit(index, action) {
    // A take-only slot still reports its action; the screen decides what a click
    // on a result slot means, because that differs between a furnace and a
    // crafting grid.
    this._onSlotAction(index, action);
  }

  _vibrate() {
    try {
      navigator.vibrate?.(12);
    } catch {
      /* haptics are a nicety, never a requirement */
    }
  }

  /**
   * Redraws from a slot source.
   *
   * @param {(index: number) => import('../items/ItemStack.js').ItemStack|null} read
   */
  update(read) {
    for (let index = 0; index < this.count; index++) {
      const target = this._slots[index];
      const stack = read(index);

      if (!stack || stack.isEmpty) {
        if (!target.icon.hidden) {
          target.icon.hidden = true;
          target.icon.removeAttribute('src');
        }
        if (target.count.textContent !== '') target.count.textContent = '';
        if (!target.bar.hidden) target.bar.hidden = true;
        target.node.setAttribute('aria-label', `Empty slot ${index + 1}`);
        target.node.classList.toggle('is-takeonly', this._takeOnly);
        continue;
      }

      const source = this._atlas.getItemIcon(stack.itemId, 48);
      if (target.icon.getAttribute('src') !== source) target.icon.setAttribute('src', source);
      target.icon.hidden = false;
      const quantity = stack.quantity > 1 ? String(stack.quantity) : '';
      if (target.count.textContent !== quantity) target.count.textContent = quantity;

      if (stack.isDamaged) {
        const fraction = stack.durabilityFraction;
        target.bar.hidden = false;
        target.fill.style.width = `${Math.round(fraction * 100)}%`;
        target.fill.style.background = `hsl(${Math.round(fraction * 110)} 78% 46%)`;
      } else if (!target.bar.hidden) {
        target.bar.hidden = true;
      }

      const wear = stack.isDamaged
        ? `, ${stack.remainingDurability} of ${stack.maxDurability} uses left`
        : '';
      target.node.setAttribute(
        'aria-label',
        `${stack.displayName}${stack.quantity > 1 ? ` x${stack.quantity}` : ''}${wear}`
      );
      target.node.classList.toggle('is-takeonly', this._takeOnly);
    }
  }

  /** Highlights one slot, for the selected hotbar entry. */
  setHighlight(index) {
    for (let i = 0; i < this._slots.length; i++) {
      this._slots[i].node.classList.toggle('is-selected', i === index);
    }
  }

  /** Focuses the first slot, so a keyboard user lands somewhere sensible. */
  focusFirst() {
    this._slots[0]?.node.focus();
  }

  destroy() {
    this._cancelPress();
    this.element.remove();
  }
}

export default SlotGrid;
