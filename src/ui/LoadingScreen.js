/**
 * World loading screen.
 *
 * Covers the gap between "the player pressed Play" and "there is enough terrain
 * under their feet to stand on". Chunk streaming is asynchronous, so without this
 * the player would spawn into a void and fall while the world materialised around
 * them.
 *
 * The progress bar tracks the chunks immediately around the spawn point rather
 * than the whole render distance, because waiting for a 14-chunk radius before
 * showing anything would take many seconds on a phone. Once the local
 * neighbourhood is ready the game is playable and the rest streams in behind the
 * fog.
 */

import { el, setVisible } from './dom.js';

/**
 * Rotating hints. Original text, written for this project.
 * @type {ReadonlyArray<string>}
 */
const TIPS = Object.freeze([
  'Hold Shift to sprint. Double-tap Space to toggle flight.',
  'Middle-click (or press Q) to copy the block you are looking at into your hotbar.',
  'Press F3 for the debug overlay: coordinates, biome, chunk queues and frame time.',
  'Lower the Max Pixel Ratio before lowering render distance — it is usually the bigger win.',
  'Caves are genuinely dark. Take torches.',
  'Sand and gravel fall when you dig underneath them.',
  'Your world is stored as a seed plus the blocks you changed, so saves stay tiny.',
  'On a phone, drag anywhere on the right of the screen to look around.',
  'Dynamic resolution trades sharpness for a steady frame rate. It is on by default.',
  'The same seed always builds the same world.',
]);

export class LoadingScreen {
  /**
   * @param {HTMLElement} root
   */
  constructor(root) {
    this._fill = el('div', { className: 'progress-fill' });
    this._status = el('p', { className: 'loading-status', text: 'Preparing…' });
    this._tip = el('p', { className: 'loading-tip' });
    this._title = el('h2', { className: 'loading-title', text: 'Generating world' });

    this.element = el(
      'div',
      {
        className: 'loading-screen',
        attrs: { role: 'status', 'aria-live': 'polite' },
        hidden: true,
      },
      [
        el('div', { className: 'loading-inner' }, [
          this._title,
          el('div', { className: 'progress-bar' }, [this._fill]),
          this._status,
          this._tip,
        ]),
      ]
    );

    root.appendChild(this.element);
    this._visible = false;
    this._tipTimer = 0;
    this._tipIndex = 0;
    this._progress = 0;
  }

  /** True while the screen is covering the world. */
  get visible() {
    return this._visible;
  }

  /**
   * Shows the screen.
   * @param {string} [title]
   */
  show(title = 'Generating world') {
    this._title.textContent = title;
    this.setProgress(0);
    this.setStatus('Preparing…');
    this._cycleTip();
    setVisible(this.element, true);
    this._visible = true;

    if (this._tipTimer) clearInterval(this._tipTimer);
    this._tipTimer = setInterval(() => this._cycleTip(), 7000);
  }

  /** Hides the screen and stops the tip rotation. */
  hide() {
    setVisible(this.element, false);
    this._visible = false;
    if (this._tipTimer) {
      clearInterval(this._tipTimer);
      this._tipTimer = 0;
    }
  }

  /**
   * Updates the progress bar.
   * @param {number} progress 0..1
   */
  setProgress(progress) {
    // Never go backwards: streaming progress can dip as the render distance grows
    // and a bar that retreats looks like a bug.
    const clamped = Math.max(this._progress, Math.min(1, Math.max(0, progress)));
    this._progress = clamped;
    this._fill.style.width = `${(clamped * 100).toFixed(1)}%`;
  }

  /** Resets progress, for a second load in the same session. */
  resetProgress() {
    this._progress = 0;
    this._fill.style.width = '0%';
  }

  /**
   * Sets the status line.
   * @param {string} text
   */
  setStatus(text) {
    this._status.textContent = text;
  }

  _cycleTip() {
    // Start from a random tip so the same one is not always first, then rotate in
    // order so the player is not shown the same hint twice in a row.
    if (this._tipIndex === 0) this._tipIndex = Math.floor(Math.random() * TIPS.length);
    this._tip.textContent = `Tip: ${TIPS[this._tipIndex % TIPS.length]}`;
    this._tipIndex++;
  }

  /** Removes the element and clears the timer. */
  destroy() {
    if (this._tipTimer) clearInterval(this._tipTimer);
    this.element.remove();
  }
}

export default LoadingScreen;
