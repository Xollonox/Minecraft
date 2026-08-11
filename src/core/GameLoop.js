/**
 * The frame scheduler.
 *
 * Responsibilities:
 *  - drive `requestAnimationFrame`
 *  - split real time into a fixed physics step and a variable render step
 *  - clamp pathological deltas (tab switch, phone lock, debugger pause) so the
 *    player never teleports through the world on the first frame back
 *  - honour an optional FPS cap
 *  - keep smoothed timing statistics for the debug overlay and for dynamic
 *    resolution
 */

import { PHYSICS } from '../config/GameConfig.js';
import { clamp } from '../utils/MathUtils.js';

export class GameLoop {
  /**
   * @param {Object} options
   * @param {(step: number) => void} options.fixedUpdate Simulation step; called
   *   0..`maxStepsPerFrame` times per frame with a constant `step`.
   * @param {(dt: number, alpha: number) => void} options.update Per-frame
   *   update. `alpha` is the interpolation factor into the next physics step.
   * @param {(dt: number) => void} options.render Draw call.
   */
  constructor({ fixedUpdate, update, render }) {
    this._fixedUpdate = fixedUpdate;
    this._update = update;
    this._render = render;

    this._running = false;
    this._rafId = 0;
    this._lastTime = 0;
    this._accumulator = 0;
    this._maxFps = 0;
    this._frameBudget = 0;

    /** Smoothed frame time in milliseconds (exponential moving average). */
    this.smoothedFrameTime = 16.7;
    /** Instantaneous frame time in milliseconds. */
    this.frameTime = 16.7;
    /** Frames completed since construction. */
    this.frameCount = 0;
    /** Whole seconds of simulated time. */
    this.elapsed = 0;
    /** Frames per second, recomputed roughly four times per second. */
    this.fps = 0;
    /** Number of fixed steps executed on the previous frame. */
    this.lastStepCount = 0;
    /** How many times the loop had to discard a huge delta. */
    this.clampedFrames = 0;

    this._fpsWindowStart = 0;
    this._fpsWindowFrames = 0;
    this._boundFrame = (timestamp) => this._frame(timestamp);
  }

  /** True while the loop is scheduled. */
  get running() {
    return this._running;
  }

  /**
   * Sets the frame rate cap.
   * @param {number} fps `0` disables the cap.
   */
  setMaxFps(fps) {
    this._maxFps = Math.max(0, Number(fps) || 0);
    // Subtract a slice of a millisecond so a 60 FPS cap does not systematically
    // miss every other vsync on a 60 Hz display.
    this._frameBudget = this._maxFps > 0 ? 1000 / this._maxFps - 0.8 : 0;
  }

  /** Starts the loop. Safe to call when already running. */
  start() {
    if (this._running) return;
    this._running = true;
    this._lastTime = now();
    this._fpsWindowStart = this._lastTime;
    this._fpsWindowFrames = 0;
    this._accumulator = 0;
    this._rafId = requestAnimationFrame(this._boundFrame);
  }

  /** Stops the loop and cancels the pending frame. */
  stop() {
    if (!this._running) return;
    this._running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
  }

  /**
   * Discards accumulated time without simulating it.
   *
   * Called when returning from a hidden tab, regaining focus or finishing a
   * long synchronous operation such as loading a save. Without this the
   * accumulator would hold minutes of pending physics.
   */
  resetTiming() {
    this._lastTime = now();
    this._accumulator = 0;
    this._fpsWindowStart = this._lastTime;
    this._fpsWindowFrames = 0;
  }

  _frame(timestamp) {
    if (!this._running) return;
    this._rafId = requestAnimationFrame(this._boundFrame);

    const time = typeof timestamp === 'number' ? timestamp : now();
    let deltaMs = time - this._lastTime;

    // FPS cap: bail out early but keep `_lastTime` so the skipped time is
    // still counted on the frame that does run.
    if (this._frameBudget > 0 && deltaMs < this._frameBudget) return;

    this._lastTime = time;

    if (deltaMs < 0) deltaMs = 0;
    let dt = deltaMs / 1000;

    if (dt > PHYSICS.maxFrameDelta) {
      // The gap is too large to simulate honestly. Advance by a single nominal
      // frame instead of trying to catch up, and drop the accumulator so we do
      // not queue a burst of steps.
      dt = PHYSICS.timeStep;
      this._accumulator = 0;
      this.clampedFrames++;
    }

    this.frameTime = deltaMs;
    this.smoothedFrameTime += (deltaMs - this.smoothedFrameTime) * 0.1;
    this.elapsed += dt;
    this.frameCount++;
    this._fpsWindowFrames++;

    if (time - this._fpsWindowStart >= 250) {
      this.fps = (this._fpsWindowFrames * 1000) / (time - this._fpsWindowStart);
      this._fpsWindowStart = time;
      this._fpsWindowFrames = 0;
    }

    // ---- fixed-step simulation ----
    this._accumulator += dt;
    const step = PHYSICS.timeStep;
    let steps = 0;
    while (this._accumulator >= step && steps < PHYSICS.maxStepsPerFrame) {
      this._accumulator -= step;
      steps++;
      try {
        this._fixedUpdate(step);
      } catch (error) {
        console.error('[GameLoop] fixedUpdate threw:', error);
        this._accumulator = 0;
        break;
      }
    }
    if (steps === PHYSICS.maxStepsPerFrame) {
      // We are running slower than the simulation rate. Drop the backlog rather
      // than accumulating an unpayable debt.
      this._accumulator = Math.min(this._accumulator, step);
    }
    this.lastStepCount = steps;

    const alpha = clamp(this._accumulator / step, 0, 1);

    try {
      this._update(dt, alpha);
    } catch (error) {
      console.error('[GameLoop] update threw:', error);
    }

    try {
      this._render(dt);
    } catch (error) {
      console.error('[GameLoop] render threw:', error);
    }
  }
}

/** Monotonic clock with a `Date.now` fallback for very old environments. */
function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export default GameLoop;
