/**
 * Hearts, hunger and air bubbles.
 *
 * ## Why these are DOM nodes and not a canvas
 *
 * The rest of the HUD is DOM, and mixing in a canvas would mean a second scaling
 * story for `--ui-scale`, a second high-DPI story, and a per-frame draw for
 * something that changes a few times a minute. Ten hearts is twenty small
 * elements built once; updating them is a class toggle each.
 *
 * ## Why icons are drawn with CSS rather than atlas tiles
 *
 * Hearts and drumsticks are UI chrome, not world art. Rendering them from the
 * texture atlas would tie the HUD to the atlas layout and force an icon cache
 * lookup on every change, for shapes that are a handful of CSS gradients.
 *
 * ## Half units
 *
 * Health and hunger are counted in half-units (20 = ten hearts) because that is
 * the resolution damage actually uses — a fall for three points has to be
 * representable. Each icon therefore has three states: full, half and empty.
 */

import { el, setVisible } from './dom.js';
import { clamp } from '../utils/MathUtils.js';

/** Number of heart icons. Health is twice this, in half-hearts. */
const HEART_COUNT = 10;
/** Number of drumstick icons. */
const HUNGER_COUNT = 10;
/** Number of bubble icons. */
const BUBBLE_COUNT = 10;
/** Number of armour icons; two protection points fill one icon. */
const ARMOUR_COUNT = 10;

/**
 * Builds a row of icons.
 * @param {string} className
 * @param {number} count
 * @param {string} label
 * @returns {{row: HTMLElement, icons: HTMLElement[]}}
 */
function buildRow(className, count, label) {
  /** @type {HTMLElement[]} */
  const icons = [];
  for (let i = 0; i < count; i++) {
    icons.push(el('div', { className: `status-icon ${className}` }));
  }
  const row = el(
    'div',
    {
      className: `status-row ${className}-row`,
      attrs: { role: 'img', 'aria-label': label },
    },
    icons
  );
  return { row, icons };
}

/**
 * Applies a value to a row of three-state icons.
 *
 * @param {HTMLElement[]} icons
 * @param {number} halfUnits Current value, in half-units.
 */
function applyRow(icons, halfUnits) {
  for (let i = 0; i < icons.length; i++) {
    const filled = halfUnits - i * 2;
    const state = filled >= 2 ? 'is-full' : filled >= 1 ? 'is-half' : 'is-empty';
    const icon = icons[i];
    // Only touch the DOM when the state actually changed; a heart row that
    // rewrote its classes every frame would invalidate style on every frame.
    if (icon.dataset.state === state) continue;
    icon.dataset.state = state;
    icon.classList.remove('is-full', 'is-half', 'is-empty');
    icon.classList.add(state);
  }
}

export class StatusBars {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.root
   */
  constructor({ root }) {
    const hearts = buildRow('status-heart', HEART_COUNT, 'Health');
    const hunger = buildRow('status-hunger', HUNGER_COUNT, 'Hunger');
    const bubbles = buildRow('status-bubble', BUBBLE_COUNT, 'Air');
    const armour = buildRow('status-armour', ARMOUR_COUNT, 'Armour');

    this._hearts = hearts.icons;
    this._hunger = hunger.icons;
    this._bubbles = bubbles.icons;
    this._armour = armour.icons;

    this._heartRow = hearts.row;
    this._hungerRow = hunger.row;
    this._bubbleRow = bubbles.row;
    this._armourRow = armour.row;
    setVisible(this._bubbleRow, false);
    setVisible(this._armourRow, false);

    /** Red flash shown for a moment after taking damage. */
    this._flash = el('div', { className: 'damage-flash' });

    this._xpFill = el('div', { className: 'status-xp-fill' });
    this._xpLabel = el('span', { className: 'status-xp-label', text: 'Lv 0' });
    this._xpBar = el(
      'div',
      { className: 'status-xp-bar', attrs: { role: 'progressbar', 'aria-label': 'Experience' } },
      [this._xpFill, this._xpLabel]
    );
    this._xpRow = el('div', { className: 'status-row status-xp-row' }, [this._xpBar]);

    this._topRow = el('div', { className: 'status-bars-top' }, [
      el('div', { className: 'status-bars-left' }, [armour.row, hearts.row]),
      el('div', { className: 'status-bars-right' }, [hunger.row, bubbles.row]),
    ]);

    this.element = el('div', { className: 'status-bars', hidden: true }, [
      this._xpRow,
      this._topRow,
    ]);

    root.appendChild(this._flash);
    root.appendChild(this.element);

    this._visible = false;
    this._lastFlash = -1;
    this._bubblesShown = false;
    this._armourShown = false;
    this._lastArmour = -1;
    this._lastLabel = '';
    this._lastXp = '';
  }

  /**
   * Shows or hides the whole group.
   *
   * Creative players see nothing: there is no health to lose and no hunger to
   * manage, so the bars would be permanently full decoration.
   *
   * @param {boolean} visible
   */
  setVisible(visible) {
    if (this._visible === visible) return;
    this._visible = visible;
    setVisible(this.element, visible);
    if (!visible) this._flash.style.opacity = '0';
  }

  /**
   * Pushes the current survival state into the DOM.
   *
   * @param {Object} stats A `PlayerStats` snapshot.
   */
  update(stats, inventory = null) {
    if (!this._visible || !stats) return;

    applyRow(this._hearts, stats.health);
    applyRow(this._hunger, stats.hunger);

    const armourPoints = Math.max(0, Math.min(ARMOUR_COUNT * 2, inventory?.armourPoints ?? 0));
    const showArmour = armourPoints > 0;
    if (showArmour !== this._armourShown) {
      this._armourShown = showArmour;
      setVisible(this._armourRow, showArmour);
    }
    if (showArmour && armourPoints !== this._lastArmour) {
      this._lastArmour = armourPoints;
      applyRow(this._armour, armourPoints);
      this._armourRow.setAttribute(
        'aria-label',
        `Armour ${armourPoints} of ${ARMOUR_COUNT * 2}`
      );
    }

    // The bubble row only exists while submerged, which is what makes it read as
    // urgent rather than as permanent furniture.
    const showBubbles = stats.showAir;
    if (showBubbles !== this._bubblesShown) {
      this._bubblesShown = showBubbles;
      setVisible(this._bubbleRow, showBubbles);
    }
    if (showBubbles) {
      applyRow(this._bubbles, Math.ceil(stats.airFraction * BUBBLE_COUNT * 2));
    }

    // Damage flash. `damageFlash` counts down in seconds, so mapping it directly
    // to opacity gives a fade for free.
    const flash = Math.min(1, Math.max(0, stats.damageFlash / 0.35)) * 0.42;
    const rounded = Math.round(flash * 100) / 100;
    if (rounded !== this._lastFlash) {
      this._lastFlash = rounded;
      this._flash.style.opacity = String(rounded);
    }

    // A single accessible summary rather than one live region per icon, which a
    // screen reader would otherwise announce twenty times.
    const label = `Health ${Math.ceil(stats.health / 2)} of ${HEART_COUNT}, hunger ${Math.ceil(
      stats.hunger / 2
    )} of ${HUNGER_COUNT}`;
    if (label !== this._lastLabel) {
      this._lastLabel = label;
      this._heartRow.setAttribute('aria-label', label);
    }

    const xpFrac = Number.isFinite(stats.xpFraction) ? stats.xpFraction : (stats.xpToNext ? stats.xp / stats.xpToNext : 0);
    const xpText = `Lv ${stats.level ?? 0}  ${stats.xp ?? 0}/${stats.xpToNext ?? 10}`;
    if (xpText !== this._lastXp) {
      this._lastXp = xpText;
      this._xpLabel.textContent = xpText;
      this._xpBar.setAttribute('aria-valuenow', String(Math.round(xpFrac * 100)));
      this._xpBar.setAttribute('aria-valuetext', xpText);
    }
    const xpPct = `${Math.round(clamp(xpFrac, 0, 1) * 100)}%`;
    if (this._xpFill.style.width !== xpPct) this._xpFill.style.width = xpPct;
  }

  destroy() {
    this.element.remove();
    this._flash.remove();
  }
}

export default StatusBars;
