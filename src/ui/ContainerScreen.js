/**
 * The screen shown for any container: inventory, crafting table, furnace, chest.
 *
 * ## One screen, configured differently
 *
 * Every container screen is the same layout — some container-specific panels on
 * top, the player's inventory underneath — and the same interaction rules. Building
 * four separate screens would mean four copies of the slot routing, and the copy
 * that got shift-click wrong would silently eat items.
 *
 * So this class takes a list of *panels*, each of which knows how to read its
 * slots and what a click on them means. A chest is one 27-slot panel; a furnace is
 * three single slots plus a progress gauge; a crafting table is a 3x3 panel plus a
 * result panel. The player inventory panel is added automatically because every
 * container needs somewhere to move things to.
 *
 * ## Why the cursor is drawn here
 *
 * The held stack follows the pointer, so it has to be a single element positioned
 * from a `pointermove` listener on the screen root. It reads from
 * `Inventory.cursor`, which is where the data lives so that closing the screen
 * mid-move cannot lose it.
 *
 * ## Closing
 *
 * `close()` always runs the `onClose` hook, which is what returns crafting-grid
 * contents and puts the cursor stack back. There is no path out of the screen that
 * skips it: escape, the close button and the world tearing down all funnel here.
 */

import { button, el, setVisible } from './dom.js';
import { SlotGrid } from './SlotGrid.js';
import { SLOT } from '../player/Inventory.js';
import {
  containerToPlayer,
  cursorClickContainer,
  cursorSplitContainer,
  quickMoveWithinPlayer,
  swapContainerWithHotbar,
} from '../containers/ItemTransfer.js';

/**
 * @typedef {Object} PanelConfig
 * @property {string} id
 * @property {string} label
 * @property {number} columns
 * @property {number} count
 * @property {string} [className]
 * @property {boolean} [takeOnly]
 * @property {(index: number) => import('../items/ItemStack.js').ItemStack|null} read
 * @property {(index: number, action: any) => void} act
 */

export class ContainerScreen {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.root
   * @param {import('../rendering/TextureAtlas.js').TextureAtlas} options.atlas
   * @param {import('../core/EventBus.js').EventBus} options.bus
   * @param {() => void} options.onClose
   */
  constructor({ root, atlas, bus, onClose }) {
    this._atlas = atlas;
    this._bus = bus;
    this._onClose = onClose;

    /** @type {import('../player/Inventory.js').Inventory|null} */
    this._inventory = null;
    /** @type {PanelConfig[]} */
    this._panels = [];
    /** @type {Map<string, SlotGrid>} */
    this._grids = new Map();

    this._title = el('h2', { className: 'dialog-title container-title' });
    this._upper = el('div', { className: 'container-upper' });
    this._lower = el('div', { className: 'container-lower' });

    /** Extra widget area, used by the furnace gauges and the recipe book. */
    this._extra = el('div', { className: 'container-extra' });

    // The held stack, following the pointer.
    this._cursorIcon = el('img', {
      className: 'cursor-icon',
      alt: '',
      attrs: { 'aria-hidden': 'true', draggable: 'false' },
    });
    this._cursorCount = el('span', { className: 'cursor-count' });
    this._cursorNode = el('div', { className: 'cursor-stack' }, [
      this._cursorIcon,
      this._cursorCount,
    ]);
    this._cursorNode.hidden = true;

    this._hint = el('p', { className: 'container-hint' });

    this.element = el(
      'div',
      {
        className: 'screen screen--dim screen--container',
        hidden: true,
        attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Container' },
      },
      [
        el('div', { className: 'panel dialog dialog--container' }, [
          this._title,
          this._upper,
          this._extra,
          el('div', { className: 'container-divider' }),
          this._lower,
          this._hint,
          el('div', { className: 'dialog-actions' }, [
            button('Sort inventory', () => {
              if (this._inventory?.sortStorage()) this.refresh();
            }, { attrs: { title: 'Consolidate and sort the main inventory; the hotbar stays unchanged' } }),
            button('Close', () => this.close(), { className: 'ui-button--primary' }),
          ]),
        ]),
        this._cursorNode,
      ]
    );

    // Track the pointer so the held stack follows it. Attached to the screen root
    // rather than the document so it costs nothing while the screen is closed.
    this.element.addEventListener('pointermove', (event) => {
      this._cursorX = event.clientX;
      this._cursorY = event.clientY;
      this._positionCursor();
    });

    // A click on the backdrop closes, matching every other dialog in the game.
    this.element.addEventListener('pointerdown', (event) => {
      if (event.target === this.element) this.close();
    });

    this._cursorX = 0;
    this._cursorY = 0;
    this._visible = false;

    root.appendChild(this.element);
  }

  /** True while the screen is showing. */
  get isOpen() {
    return this._visible;
  }

  /**
   * Configures and shows the screen.
   *
   * @param {Object} options
   * @param {string} options.title
   * @param {import('../player/Inventory.js').Inventory} options.inventory
   * @param {PanelConfig[]} options.panels Container-specific panels.
   * @param {string} [options.hint] Help text under the grids.
   * @param {HTMLElement[]} [options.extra] Extra widgets.
   */
  open({ title, inventory, panels, hint = '', extra = [] }) {
    this._inventory = inventory;
    this._title.textContent = title;
    this.element.setAttribute('aria-label', title);
    this._hint.textContent = hint;

    // Rebuild the panels. A container screen is opened a handful of times a
    // session, so rebuilding is far simpler than diffing and costs nothing
    // measurable.
    this._teardownGrids();
    this._panels = [...panels, this._playerPanel(inventory)];

    for (const panel of this._panels) {
      const grid = new SlotGrid({
        atlas: this._atlas,
        columns: panel.columns,
        count: panel.count,
        label: panel.label,
        className: panel.className ?? '',
        takeOnly: panel.takeOnly ?? false,
        onSlotAction: (index, action) => {
          panel.act(index, action);
          this.refresh();
        },
      });
      this._grids.set(panel.id, grid);

      const host = panel.id === 'player' || panel.id === 'hotbar' ? this._lower : this._upper;
      host.appendChild(
        el('div', { className: 'container-panel' }, [
          el('span', { className: 'container-panel-label', text: panel.label }),
          grid.element,
        ])
      );
    }

    this._extra.replaceChildren(...extra);
    setVisible(this.element, true);
    this._visible = true;
    this.refresh();

    requestAnimationFrame(() => this._grids.get(this._panels[0].id)?.focusFirst());
  }

  /**
   * The player's own inventory, always present.
   *
   * Split into main grid and hotbar visually, but a single panel so a transfer
   * between them is just `quickMove`.
   */
  _playerPanel(inventory) {
    return {
      id: 'player',
      label: 'Inventory',
      columns: 9,
      // Main grid plus hotbar, drawn as one 36-slot block with the hotbar last.
      count: SLOT.MAIN_END - SLOT.MAIN_START + 1 + SLOT.HOTBAR_SIZE,
      className: 'slot-grid--player',
      read: (index) => inventory.getSlot(this._playerIndexToSlot(index)),
      act: (index, action) => this._actOnInventory(this._playerIndexToSlot(index), action),
    };
  }

  /**
   * Maps a visual position in the player panel to an inventory slot index.
   *
   * The main grid is drawn above the hotbar, matching where they sit on screen,
   * but the hotbar occupies indices 0-8 in the inventory. Without this mapping the
   * grid would show the hotbar at the top, which is the opposite of the HUD.
   *
   * @param {number} index
   * @returns {number}
   */
  _playerIndexToSlot(index) {
    const mainCount = SLOT.MAIN_END - SLOT.MAIN_START + 1;
    if (index < mainCount) return SLOT.MAIN_START + index;
    return SLOT.HOTBAR_START + (index - mainCount);
  }

  /**
   * Applies an action to one of the player's own slots.
   * @param {number} slot
   * @param {any} action
   */
  _actOnInventory(slot, action) {
    const inventory = this._inventory;
    if (!inventory) return;

    if (action === 'primary') {
      inventory.swapWithCursor(slot);
    } else if (action === 'split') {
      inventory.splitWithCursor(slot);
    } else if (action === 'transfer') {
      // Shift-click prefers the open container, falling back to moving within the
      // inventory when there is nowhere else to go.
      if (!this._transferToContainer(slot)) quickMoveWithinPlayer(inventory, slot);
    } else if (action === 'drop' || action === 'dropStack') {
      this._dropFromSlot(slot, action === 'dropStack');
    } else if (action && typeof action === 'object' && typeof action.hotbar === 'number') {
      inventory.swapWithHotbar(slot, action.hotbar);
    }
  }

  /**
   * Hook for a subclass-style configuration to receive shift-clicked items.
   * Overwritten by `open` callers that have somewhere to put them.
   * @type {(slot: number) => boolean}
   */
  transferHandler = () => false;

  _transferToContainer(slot) {
    return this.transferHandler(slot);
  }

  /**
   * Hook for dropping an item into the world.
   * @type {(stack: import('../items/ItemStack.js').ItemStack) => void}
   */
  dropHandler = () => {};

  _dropFromSlot(slot, wholeStack) {
    const inventory = this._inventory;
    const stack = inventory?.getSlot(slot);
    if (!stack) return;
    const dropped = wholeStack ? stack.split(stack.quantity) : stack.split(1);
    if (stack.isEmpty) inventory.setSlot(slot, null);
    if (dropped) this.dropHandler(dropped);
  }

  /**
   * Standard slot behaviour for a `Container`-backed panel.
   *
   * Exposed so the panel configs built by `Game` do not each reimplement the
   * routing; they pass their container and get correct click, split, transfer and
   * number-key behaviour.
   *
   * @param {import('../containers/Container.js').Container} container
   * @param {number} slot
   * @param {any} action
   */
  actOnContainer(container, slot, action) {
    const inventory = this._inventory;
    if (!inventory) return;

    if (action === 'primary') {
      cursorClickContainer(inventory, container, slot);
    } else if (action === 'split') {
      cursorSplitContainer(inventory, container, slot);
    } else if (action === 'transfer') {
      containerToPlayer(container, slot, inventory);
    } else if (action === 'drop' || action === 'dropStack') {
      const stack = container.getSlot(slot);
      if (!stack) return;
      const dropped = action === 'dropStack' ? stack.split(stack.quantity) : stack.split(1);
      if (stack.isEmpty) container.setSlot(slot, null);
      if (dropped) this.dropHandler(dropped);
    } else if (action && typeof action === 'object' && typeof action.hotbar === 'number') {
      swapContainerWithHotbar(inventory, container, slot, action.hotbar);
    }
  }

  // ------------------------------------------------------------------- painting

  /** Redraws every panel and the cursor. */
  refresh() {
    if (!this._visible) return;
    for (const panel of this._panels) {
      this._grids.get(panel.id)?.update(panel.read);
    }
    this._paintCursor();
  }

  _paintCursor() {
    const cursor = this._inventory?.cursor ?? null;
    if (!cursor || cursor.isEmpty) {
      if (!this._cursorNode.hidden) this._cursorNode.hidden = true;
      return;
    }
    const source = this._atlas.getItemIcon(cursor.itemId, 48);
    if (this._cursorIcon.getAttribute('src') !== source) {
      this._cursorIcon.setAttribute('src', source);
    }
    this._cursorCount.textContent = cursor.quantity > 1 ? String(cursor.quantity) : '';
    this._cursorNode.hidden = false;
    this._positionCursor();
  }

  _positionCursor() {
    if (this._cursorNode.hidden) return;
    this._cursorNode.style.transform = `translate(${this._cursorX}px, ${this._cursorY}px)`;
  }

  // -------------------------------------------------------------------- closing

  /** Closes the screen, always running the close hook. */
  close() {
    if (!this._visible) return;
    this._visible = false;
    setVisible(this.element, false);
    this._cursorNode.hidden = true;
    this._onClose();
  }

  hide() {
    // Used by `UIManager.setScreen` when another screen takes over. Routed through
    // `close` so the reclaim hook cannot be skipped.
    this.close();
  }

  _teardownGrids() {
    for (const grid of this._grids.values()) grid.destroy();
    this._grids.clear();
    this._upper.replaceChildren();
    this._lower.replaceChildren();
    this._extra.replaceChildren();
  }

  destroy() {
    this._teardownGrids();
    this.element.remove();
  }
}

export default ContainerScreen;
