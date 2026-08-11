/**
 * The settings menu, generated from `SETTINGS_SCHEMA`.
 *
 * Nothing here knows what any individual setting *means*. Each schema item
 * declares its type, range and label; this module turns that into a control and
 * writes changes back through `SettingsManager`, which validates them. Adding an
 * option is therefore a one-line schema change with no markup to write and no
 * chance of the UI and the stored value disagreeing about a range.
 *
 * Two details that matter in practice:
 *
 *  - **Sliders write on `input`, persist on a debounce.** Dragging a render
 *    distance slider fires dozens of events; applying each one immediately is what
 *    the player expects to see, but writing to `localStorage` dozens of times is
 *    not, so persistence is debounced inside `SettingsManager`.
 *  - **The panel re-reads state instead of tracking it.** After any change the
 *    whole visible section is refreshed from the settings tree, so a preset change
 *    that alters fifteen values updates all fifteen controls with no bookkeeping.
 */

import { PRESET_LABELS } from '../config/GraphicsPresets.js';
import { Events } from '../core/EventBus.js';
import { el, setVisible, button, clear, settingRow } from './dom.js';
import {
  ACTION_LABELS,
  Action,
  DEFAULT_KEY_BINDINGS,
  DEFAULT_MOUSE_BINDINGS,
  HOTBAR_ACTIONS,
  WHEEL_BINDINGS,
} from '../config/KeyBindings.js';

export class SettingsMenu {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.root
   * @param {import('../core/SettingsManager.js').SettingsManager} options.settings
   * @param {import('../core/EventBus.js').EventBus} options.bus
   * @param {() => void} options.onClose
   * @param {() => void} [options.onResetWorldRequested]
   */
  constructor({ root, settings, bus, onClose }) {
    this._settings = settings;
    this._bus = bus;
    this._onClose = onClose;

    this._sections = settings.getVisibleSchema();
    this._activeSection = this._sections[0]?.id ?? 'display';
    /** @type {Map<string, {refresh: () => void}>} */
    this._controls = new Map();

    this._tabBar = el('div', { className: 'tab-bar', attrs: { role: 'tablist' } });
    this._body = el('div', { className: 'dialog-body' });
    this._reloadNote = el('p', { className: 'settings-note', hidden: true });

    this.element = el(
      'div',
      {
        className: 'screen screen--dim',
        hidden: true,
        attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' },
      },
      [
        el('div', { className: 'panel dialog dialog--wide' }, [
          el('h2', { className: 'dialog-title', text: 'Settings' }),
          this._tabBar,
          this._reloadNote,
          this._body,
          el('div', { className: 'dialog-actions' }, [
            button('Reset to defaults', () => this._resetAll(), { className: 'ui-button--danger' }),
            button('Done', () => this._onClose(), { className: 'ui-button--primary' }),
          ]),
        ]),
      ]
    );

    root.appendChild(this.element);
    this._buildTabs();
    this._renderSection();

    // A settings change from anywhere (a preset, a keyboard shortcut, another
    // panel) refreshes the controls so the UI can never drift from the truth.
    this._unsubscribe = bus.on(Events.SETTINGS_CHANGED, () => {
      if (this._visible) this._refreshVisible();
    });
    this._visible = false;
  }

  _buildTabs() {
    clear(this._tabBar);
    for (const section of this._sections) {
      const tab = button(
        section.label,
        () => {
          this._activeSection = section.id;
          this._buildTabs();
          this._renderSection();
        },
        {
          className: this._activeSection === section.id ? 'is-active' : '',
        }
      );
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', this._activeSection === section.id ? 'true' : 'false');
      this._tabBar.appendChild(tab);
    }
  }

  _renderSection() {
    clear(this._body);
    this._controls.clear();

    const section = this._sections.find((entry) => entry.id === this._activeSection);
    if (!section) return;

    for (const item of section.items) {
      const control = this._buildControl(item);
      if (control) this._body.appendChild(control);
    }

    // The controls reference lives at the end of the Controls section. It is
    // generated from the binding tables rather than written out, so it can never
    // drift from what the keys actually do — which matters, because the bindings
    // have already changed once (Q became "drop").
    if (section.id === 'controls') this._body.appendChild(buildControlsReference());

    this._body.scrollTop = 0;
    this._updateReloadNote();
  }

  /**
   * Builds the row for one schema item.
   * @param {Object} item
   * @returns {HTMLElement|null}
   */
  _buildControl(item) {
    switch (item.type) {
      case 'toggle':
        return this._buildToggle(item);
      case 'range':
        return this._buildRange(item);
      case 'select':
        return this._buildSelect(item);
      default:
        return null;
    }
  }

  _buildToggle(item) {
    const control = el('button', {
      className: 'toggle',
      type: 'button',
      attrs: {
        role: 'switch',
        'aria-checked': this._settings.get(item.key) ? 'true' : 'false',
        'aria-label': item.label,
      },
      on: {
        click: (event) => {
          event.preventDefault();
          const next = !this._settings.get(item.key);
          this._settings.set(item.key, next);
          this._bus.emit(Events.PLAY_SOUND, { name: 'ui.click' });
        },
      },
    });

    const refresh = () => {
      control.setAttribute('aria-checked', this._settings.get(item.key) ? 'true' : 'false');
    };
    this._controls.set(item.key, { refresh });

    return settingRow(item.label, control, {
      hint: item.hint,
      reloadRequired: item.reloadRequired,
    });
  }

  _buildRange(item) {
    const valueLabel = el('span', { className: 'setting-value' });

    const control = el('input', {
      className: 'range-input',
      type: 'range',
      min: String(item.min ?? 0),
      max: String(item.max ?? 1),
      step: String(item.step ?? 0.01),
      value: String(this._settings.get(item.key)),
      attrs: { 'aria-label': item.label },
      on: {
        // `input` fires while dragging, which is what makes render distance and
        // brightness feel live. Persistence is debounced by SettingsManager.
        input: (event) => {
          const raw = Number.parseFloat(event.target.value);
          this._settings.set(item.key, raw);
        },
      },
    });

    const refresh = () => {
      const value = this._settings.get(item.key);
      if (document.activeElement !== control) control.value = String(value);
      valueLabel.textContent = item.format ? item.format(value) : String(value);
    };
    this._controls.set(item.key, { refresh });
    refresh();

    return settingRow(item.label, control, {
      hint: item.hint,
      reloadRequired: item.reloadRequired,
      valueLabel,
    });
  }

  _buildSelect(item) {
    const control = el('select', {
      className: 'select-input',
      attrs: { 'aria-label': item.label },
      on: {
        change: (event) => {
          const raw = event.target.value;
          // `<select>` values are always strings; restore the original type by
          // matching against the declared options.
          const option = (item.options || []).find((entry) => String(entry.value) === raw);
          const value = option ? option.value : raw;

          if (item.key === 'graphics.preset') {
            this._settings.applyPreset(String(value));
          } else {
            this._settings.set(item.key, value);
          }
          this._bus.emit(Events.PLAY_SOUND, { name: 'ui.select' });
        },
      },
    });

    for (const option of item.options || []) {
      control.appendChild(
        el('option', { value: String(option.value), text: option.label })
      );
    }

    const refresh = () => {
      const value = this._settings.get(item.key);
      const stringValue = String(value);
      if (control.value !== stringValue) control.value = stringValue;
      // The preset dropdown gains a `custom` entry only once it is in use.
      if (item.key === 'graphics.preset') {
        const hasCustom = Array.from(control.options).some((option) => option.value === 'custom');
        if (!hasCustom) {
          control.appendChild(el('option', { value: 'custom', text: PRESET_LABELS.custom }));
        }
        control.value = stringValue;
      }
    };
    this._controls.set(item.key, { refresh });
    refresh();

    return settingRow(item.label, control, {
      hint: item.hint,
      reloadRequired: item.reloadRequired,
    });
  }

  /** Re-reads every visible control from the settings tree. */
  _refreshVisible() {
    for (const entry of this._controls.values()) entry.refresh();
    this._updateReloadNote();
  }

  _updateReloadNote() {
    const keys = this._settings.pendingReloadKeys;
    if (keys.length === 0) {
      setVisible(this._reloadNote, false);
      return;
    }
    this._reloadNote.textContent =
      'Some changes take effect the next time this world is loaded: ' +
      keys.map((key) => key.split('.').pop()).join(', ') +
      '.';
    setVisible(this._reloadNote, true);
  }

  _resetAll() {
    // Deliberately confirmed: resetting silently would be a nasty surprise for
    // someone who has tuned a dozen sliders.
    const confirmed =
      typeof window.confirm !== 'function' ||
      window.confirm('Reset every setting to its default value?');
    if (!confirmed) return;
    this._settings.reset();
    this._sections = this._settings.getVisibleSchema();
    this._buildTabs();
    this._renderSection();
    this._bus.emit(Events.NOTIFY, {
      level: 'success',
      message: 'Settings reset to defaults',
      id: 'settings-reset',
    });
  }

  /** True while the menu is open. */
  get visible() {
    return this._visible;
  }

  /** Opens the menu. */
  show() {
    setVisible(this.element, true);
    this._visible = true;
    this._refreshVisible();
  }

  /** Closes the menu. */
  hide() {
    setVisible(this.element, false);
    this._visible = false;
  }

  /** Removes the element and unsubscribes. */
  destroy() {
    this._unsubscribe?.();
    this.element.remove();
  }
}

/**
 * Keyboard, mouse and gamepad reference, generated from the binding tables.
 *
 * Generated rather than written out so it cannot drift from the bindings — the
 * failure mode being a help screen that confidently tells the player the wrong
 * key. It also means `ACTION_LABELS` is load-bearing instead of an exported table
 * nothing reads.
 *
 * Rebinding is not offered here: it needs conflict detection, persistence and a
 * capture UI, and claiming to support it with a list would be worse than being
 * honest that the bindings are fixed.
 *
 * @returns {HTMLElement}
 */
function buildControlsReference() {
  /**
   * Human-readable name for a `KeyboardEvent.code`.
   *
   * Arrow keys are matched before the generic left/right suffix rule, because
   * chaining the replacements the other way turned `ArrowLeft` into " (left)".
   */
  const keyName = (code) => {
    const arrows = {
      ArrowUp: 'Up arrow',
      ArrowDown: 'Down arrow',
      ArrowLeft: 'Left arrow',
      ArrowRight: 'Right arrow',
    };
    if (arrows[code]) return arrows[code];
    if (code === 'Escape') return 'Esc';
    if (code === 'Space') return 'Space';
    return code
      .replace(/^Key/, '')
      .replace(/^Digit/, '')
      .replace(/Left$/, ' (left)')
      .replace(/Right$/, ' (right)');
  };

  /** @type {Map<string, string[]>} action -> input names */
  const byAction = new Map();
  const add = (action, name) => {
    if (!action) return;
    if (!byAction.has(action)) byAction.set(action, []);
    const list = byAction.get(action);
    if (!list.includes(name)) list.push(name);
  };

  for (const [code, action] of Object.entries(DEFAULT_KEY_BINDINGS)) add(action, keyName(code));
  const mouseNames = { 0: 'Left click', 1: 'Middle click', 2: 'Right click' };
  for (const [buttonIndex, action] of Object.entries(DEFAULT_MOUSE_BINDINGS)) {
    add(action, mouseNames[buttonIndex] ?? `Mouse ${buttonIndex}`);
  }
  // The wheel is a third input channel. Without this, hotbar scrolling was absent
  // from the list and appeared to be unbound.
  for (const [direction, action] of Object.entries(WHEEL_BINDINGS)) {
    add(action, `Wheel ${direction}`);
  }

  // Hotbar slots collapse to one row: nine near-identical lines would bury
  // everything else.
  const hotbarSet = new Set(HOTBAR_ACTIONS);
  const rows = [];
  for (const action of Object.values(Action)) {
    if (hotbarSet.has(action)) continue;
    const inputs = byAction.get(action);
    if (!inputs || inputs.length === 0) continue;
    rows.push(
      el('div', { className: 'controls-row' }, [
        el('span', { className: 'controls-action', text: ACTION_LABELS[action] ?? action }),
        el('span', { className: 'controls-keys', text: inputs.join(' / ') }),
      ])
    );
  }
  rows.push(
    el('div', { className: 'controls-row' }, [
      el('span', { className: 'controls-action', text: 'Hotbar slots 1-9' }),
      el('span', { className: 'controls-keys', text: '1 - 9' }),
    ])
  );

  return el('div', { className: 'controls-reference' }, [
    el('h3', { className: 'controls-heading', text: 'Controls' }),
    el('div', { className: 'controls-list' }, rows),
    el('p', {
      className: 'controls-note',
      text: 'On touch devices, use the on-screen buttons. Long-press the DROP button to throw a whole stack, and long-press a hotbar slot to inspect an item.',
    }),
  ]);
}

export default SettingsMenu;
