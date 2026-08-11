/**
 * The screen shown when the player dies.
 *
 * ## Why it is a screen rather than an overlay
 *
 * Death must take control away. If it were a floating panel the player would keep
 * walking, keep mining and keep taking damage behind it, and the respawn button
 * would fight the pointer lock for the mouse. Registering it as a real
 * `Screen` means `UIManager` releases the pointer lock and switches the input
 * context in the same transition it uses for the pause menu, so the "controls are
 * disabled while dead" requirement is satisfied structurally rather than by a
 * scattering of `if (dead) return` guards.
 *
 * ## Mobile
 *
 * The two actions are full-width, stacked and sized from `--ui-scale`, so they
 * remain comfortable thumb targets on a phone. Nothing here depends on hover, and
 * the dialog scrolls rather than clipping on a short landscape viewport.
 */

import { button, el, setVisible } from './dom.js';

export class DeathScreen {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.root
   * @param {() => void} options.onRespawn
   * @param {() => void} options.onQuit
   */
  constructor({ root, onRespawn, onQuit }) {
    this._onRespawn = onRespawn;

    this._title = el('h2', { className: 'dialog-title', text: 'You died' });
    this._cause = el('p', { className: 'death-cause' });
    this._detail = el('p', { className: 'death-detail' });

    this._respawnButton = button('Respawn', () => this._onRespawn(), {
      className: 'ui-button--primary death-action',
    });
    this._quitButton = button('Return to menu', () => onQuit(), {
      className: 'death-action',
    });

    this.element = el(
      'div',
      {
        className: 'screen screen--dim screen--death',
        hidden: true,
        attrs: {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': 'You died',
        },
      },
      [
        el('div', { className: 'panel dialog dialog--death' }, [
          this._title,
          this._cause,
          this._detail,
          el('div', { className: 'dialog-actions dialog-actions--stacked' }, [
            this._respawnButton,
            this._quitButton,
          ]),
        ]),
      ]
    );

    root.appendChild(this.element);
  }

  /**
   * Shows the screen with a cause of death.
   *
   * @param {Object} info
   * @param {string} info.message Human-readable cause.
   * @param {boolean} info.keptInventory Whether items were retained.
   * @param {boolean} info.permadeath Whether this one-life world is now locked.
   * @param {string} info.difficultyLabel Name of the active difficulty.
   */
  show({
    message = 'You died',
    keptInventory = true,
    permadeath = false,
    difficultyLabel = 'Hardcore',
  } = {}) {
    this._title.textContent = permadeath ? `${difficultyLabel} world lost` : 'You died';
    this.element.setAttribute('aria-label', permadeath ? `${difficultyLabel} world lost` : 'You died');
    this._cause.textContent = message;
    this._detail.textContent = permadeath
      ? 'This was a one-life world. You can export it or delete it from the world list, but it cannot be played again.'
      : keptInventory
        ? 'Your items are still with you.'
        : 'Your items were scattered where you fell.';
    setVisible(this._respawnButton, !permadeath);
    setVisible(this.element, true);
    // Focus the primary action so a keyboard or gamepad user can respawn without
    // hunting for the mouse.
    requestAnimationFrame(() => (permadeath ? this._quitButton : this._respawnButton).focus());
  }

  hide() {
    setVisible(this.element, false);
  }

  destroy() {
    this.element.remove();
  }
}

export default DeathScreen;
