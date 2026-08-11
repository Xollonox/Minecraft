/**
 * Pause menu.
 *
 * Pausing does three things that have to happen together, or the game misbehaves:
 * the simulation stops, pointer lock is released so the cursor can be used, and
 * the input context changes so held keys are dropped. Doing only the first would
 * leave the player still walking when they resume; doing only the second would
 * leave the world simulating behind a menu.
 *
 * The menu also owns the destructive actions (save, quit) and reports save state,
 * because that is where a player looks for them.
 */

import { el, setVisible, button } from './dom.js';

export class PauseMenu {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.root
   * @param {Object} options.handlers
   * @param {() => void} options.handlers.onResume
   * @param {() => void} options.handlers.onSettings
   * @param {() => void} options.handlers.onSave
   * @param {() => void} options.handlers.onQuit
   * @param {() => void} options.handlers.onToggleFullscreen
   * @param {import('../utils/DeviceDetector.js').DeviceCapabilities} options.capabilities
   */
  constructor({ root, handlers, capabilities }) {
    this._handlers = handlers;
    this._status = el('p', { className: 'dialog-subtitle' });
    this._worldName = el('h2', { className: 'dialog-title', text: 'Paused' });

    const actions = [
      button('Resume', () => handlers.onResume(), {
        className: 'ui-button--primary ui-button--wide',
      }),
      button('Settings', () => handlers.onSettings(), { className: 'ui-button--wide' }),
      button('Save now', () => handlers.onSave(), { className: 'ui-button--wide' }),
      button('Advancements & statistics', () => handlers.onShowProgress?.(), {
        className: 'ui-button--wide',
      }),
    ];

    if (capabilities.fullscreenSupported) {
      actions.push(
        button('Toggle fullscreen', () => handlers.onToggleFullscreen(), {
          className: 'ui-button--wide',
        })
      );
    }

    actions.push(
      button('Save and quit to menu', () => handlers.onQuit(), {
        className: 'ui-button--danger ui-button--wide',
      })
    );

    this.element = el(
      'div',
      {
        className: 'screen screen--dim',
        hidden: true,
        attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Game paused' },
      },
      [
        el('div', { className: 'panel dialog' }, [
          this._worldName,
          this._status,
          el('div', { className: 'dialog-actions', style: { flexDirection: 'column' } }, actions),
        ]),
      ]
    );

    root.appendChild(this.element);
    this._visible = false;
  }

  /** True while the menu is open. */
  get visible() {
    return this._visible;
  }

  /**
   * Opens the menu.
   * @param {Object} info
   * @param {string} info.worldName
   * @param {number} info.seed
   * @param {boolean} info.persistent True when saves survive a reload.
   * @param {number} info.editedChunks
   */
  show(info = {}) {
    this._worldName.textContent = info.worldName ? `Paused — ${info.worldName}` : 'Paused';

    const parts = [];
    if (Number.isFinite(info.seed)) parts.push(`Seed ${info.seed}`);
    if (Number.isFinite(info.editedChunks)) {
      parts.push(`${info.editedChunks} modified chunk${info.editedChunks === 1 ? '' : 's'}`);
    }
    if (info.persistent === false) {
      parts.push('Storage unavailable — progress will not survive a reload');
    }
    this._status.textContent = parts.join('  ·  ');

    setVisible(this.element, true);
    this._visible = true;

    // Focus the resume button so Enter and Space do the obvious thing.
    const resume = this.element.querySelector('.ui-button--primary');
    if (resume instanceof HTMLElement) resume.focus({ preventScroll: true });
  }

  /** Closes the menu. */
  hide() {
    setVisible(this.element, false);
    this._visible = false;
  }

  /** Removes the element. */
  destroy() {
    this.element.remove();
  }
}

export default PauseMenu;
