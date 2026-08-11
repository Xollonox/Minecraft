/**
 * The heads-up display: crosshair, coordinate readout, overlays and save status.
 *
 * ## Throttled DOM writes
 *
 * The coordinate readout changes every frame the player moves, but a human cannot
 * read more than a few updates a second and every write is a style recalculation.
 * Text is therefore refreshed on a timer (about six times a second) and only when
 * the formatted string actually differs. The crosshair and overlays are pure CSS,
 * so they cost nothing per frame at all.
 *
 * The underwater tint is a CSS gradient rather than a shader pass: it works with
 * post-processing disabled, costs no GPU time, and cannot break if the composer
 * fails to build.
 */

import { Events } from '../core/EventBus.js';
import { clamp } from '../utils/MathUtils.js';
import { Block } from '../world/BlockTypes.js';
import { getDifficulty } from '../gameplay/Difficulty.js';
import { el, setVisible } from './dom.js';
import { StatusBars } from './StatusBars.js';

/** Seconds between text refreshes. */
const TEXT_INTERVAL = 0.16;
/** Seconds the save indicator stays visible after a save completes. */
const SAVE_INDICATOR_DURATION = 1.6;

export class HUD {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.root
   * @param {import('../core/EventBus.js').EventBus} options.bus
   * @param {import('../core/SettingsManager.js').SettingsManager} options.settings
   * @param {import('../utils/DeviceDetector.js').DeviceCapabilities} options.capabilities
   * @param {() => void} options.onPause
   * @param {() => void} [options.onSettings]
   * @param {() => void} options.onToggleFullscreen
   */
  constructor({ root, bus, settings, capabilities, onPause, onSettings, onToggleFullscreen }) {
    this._bus = bus;
    this._settings = settings;
    this._caps = capabilities;
    this._onToggleCamera = null;

    this._coordinates = el('div', { className: 'hud-chip' });
    this._statsLine = el('div', { className: 'hud-chip' });
    this._modeLine = el('div', { className: 'hud-chip' });

    this._underwater = el('div', { className: 'underwater-overlay' });
    this._vignette = el('div', { className: 'vignette-overlay' });
    this._saveIndicator = el('div', { className: 'save-indicator', text: 'Saved' });
    this._bossName = el('span', { text:'Ender Dragon' });
    this._bossPhase = el('small');
    this._bossFill = el('div', { className:'boss-bar-fill' });
    this._bossBar = el('div', { className:'boss-bar', hidden:true }, [
      el('div', { className:'boss-bar-label' }, [this._bossName, this._bossPhase]),
      el('div', { className:'boss-bar-track' }, [this._bossFill]),
    ]);

    const iconButtons = [];
    const usesTouchControls = capabilities.touch || capabilities.coarsePointer;
    // Touch already has camera and pause in its utility bar; duplicating them in
    // the HUD creates overlapping controls on phones and tablets.
    this._cameraBtn = usesTouchControls ? null : el('button', {
      className: 'ui-button hud-icon-button',
      type: 'button',
      text: '◧',
      attrs: { 'aria-label': 'Toggle camera', title: 'Camera (F5)' },
      on: {
        pointerdown: (event) => {
          event.preventDefault();
          event.stopPropagation();
          this._onToggleCamera?.();
        },
      },
    });
    if (this._cameraBtn) iconButtons.push(this._cameraBtn);
    if (onSettings) {
      iconButtons.push(
        el('button', {
          className: 'ui-button hud-icon-button',
          type: 'button',
          text: '⚙',
          attrs: { 'aria-label': 'Settings', title: 'Settings' },
          on: {
            pointerdown: (event) => {
              event.preventDefault();
              event.stopPropagation();
              onSettings();
            },
          },
        })
      );
    }
    if (capabilities.fullscreenSupported) {
      iconButtons.push(
        el('button', {
          className: 'ui-button hud-icon-button',
          type: 'button',
          // Plain ASCII: the decorative Unicode glyphs for fullscreen and pause
          // are absent from most monospace fonts and render as tofu boxes.
          text: '[ ]',
          attrs: { 'aria-label': 'Toggle fullscreen', title: 'Fullscreen' },
          on: {
            pointerdown: (event) => {
              event.preventDefault();
              event.stopPropagation();
              onToggleFullscreen();
            },
          },
        })
      );
    }
    if (!usesTouchControls) {
      iconButtons.push(
        el('button', {
          className: 'ui-button hud-icon-button',
          type: 'button',
          text: 'II',
          attrs: { 'aria-label': 'Pause', title: 'Pause' },
          on: {
            pointerdown: (event) => {
              event.preventDefault();
              event.stopPropagation();
              onPause();
            },
          },
        })
      );
    }

    // Host for the survival bars, so they sit above the hotbar in the same
    // stacking context as the rest of the HUD.
    this._statusHost = el('div', { className: 'hud-status-host' });

    this._chipContainer = el('div', { className: 'hud-top-left' }, [
      this._coordinates,
      this._statsLine,
      this._modeLine,
    ]);
    this._chipsVisible = true;

    // Held as a field so the crosshair can carry tool and cooldown feedback.
    this._crosshair = el('div', { className: 'crosshair' });
    this._wrongTool = false;
    this._readiness = 1;

    this._statusBars = new StatusBars({ root: this._statusHost });

    this.element = el('div', { className: 'hud', hidden: true }, [
      this._underwater,
      this._vignette,
      this._crosshair,
      this._bossBar,
      this._chipContainer,
      el('div', { className: 'hud-top-right' }, iconButtons),
      this._statusHost,
      this._saveIndicator,
    ]);

    root.appendChild(this.element);

    this._textTimer = 0;
    this._saveTimer = 0;
    this._lastCoordinates = '';
    this._lastStats = '';
    this._lastMode = '';
    this._visible = false;

    this._unsubscribers = [
      bus.on(Events.SAVE_COMPLETED, (event) => {
        this._showSaveIndicator(event.persistent === false ? 'Saved (session only)' : 'Saved');
      }),
      bus.on(Events.SAVE_STARTED, () => this._showSaveIndicator('Saving…', true)),
      bus.on(Events.SAVE_FAILED, () => this._showSaveIndicator('Save failed', true)),
    ];
  }

  /** Shows or hides the whole HUD. */
  setVisible(visible) {
    this._visible = visible;
    setVisible(this.element, visible);
  }

  setCameraHandler(fn, getMode) {
    this._onToggleCamera = fn;
    this._getCameraMode = getMode;
  }

  _updateCameraIcon() {
    if (!this._cameraBtn) return;
    const mode = this._getCameraMode?.() ?? 0;
    const labels = ['◧', '◨', '◩'];
    this._cameraBtn.textContent = labels[mode] ?? '◧';
  }

  /**
   * Per-frame update.
   *
   * @param {number} dt
   * @param {Object} state
   * @param {import('../player/Player.js').Player} state.player
   * @param {import('../world/World.js').World} state.world
   * @param {import('../core/GameLoop.js').GameLoop} state.loop
   * @param {number} state.underwaterStrength 0..1
   * @param {number} state.liquidBlock Block id around the camera.
   * @param {import('../world/ChunkManager.js').ChunkManager} state.chunks
   * @param {number} state.timeOfDay
   */
  update(dt, state) {
    if (!this._visible) return;

    // The debug overlay occupies the same corner and reports the same values in
    // more detail, so the compact chips step aside while it is open.
    const chipsVisible = !state.debugVisible;
    if (this._chipsVisible !== chipsVisible) {
      this._chipsVisible = chipsVisible;
      setVisible(this._chipContainer, chipsVisible);
    }

    // Overlays: cheap style writes, and only when the value changes.
    const underwaterOpacity = clamp(state.underwaterStrength, 0, 1);
    if (this._underwater.style.opacity !== String(underwaterOpacity)) {
      this._underwater.style.opacity = String(underwaterOpacity);
    }
    this._underwater.classList.toggle('lava', state.liquidBlock === Block.LAVA);

    // The vignette now serves two hazards: suffocating in a block, and running
    // low on health. Whichever is more urgent wins, so a suffocating player on
    // one heart does not get a *weaker* warning than a healthy one in a wall.
    const stats = state.player?.stats;
    const lowHealth =
      stats && stats.enabled && !stats.isDead && stats.healthFraction < 0.35
        ? (0.35 - stats.healthFraction) / 0.35 * 0.6
        : 0;
    const vignette = Math.max(state.suffocating ? 0.65 : 0, lowHealth);
    const vignetteValue = String(Math.round(vignette * 100) / 100);
    if (this._vignette.style.opacity !== vignetteValue) {
      this._vignette.style.opacity = vignetteValue;
    }

    // Survival bars are hidden in creative, where full health and full hunger
    // would be permanent decoration.
    this._statusBars.setVisible(Boolean(stats?.enabled) && !stats.isDead);
    this._statusBars.update(stats, state.player?.inventory);

    const boss = state.boss;
    const showBoss = Boolean(boss && !boss.dead);
    setVisible(this._bossBar, showBoss);
    if (showBoss) {
      const fraction = clamp(Number(boss.fraction) || 0, 0, 1);
      this._bossFill.style.width = `${Math.round(fraction * 1000) / 10}%`;
      this._bossPhase.textContent = boss.phase ? String(boss.phase).replaceAll('_', ' ') : '';
      this._bossName.textContent = boss.name ?? 'Ender Dragon';
    }

    // Crosshair feedback. Two independent signals share it:
    //  - the held tool will not harvest what is being mined, so the swing is
    //    about to be wasted;
    //  - the weapon is still on cooldown, so an attack now would be early.
    const wrongTool = Boolean(state.mining && !state.mining.willDrop);
    if (this._wrongTool !== wrongTool) {
      this._wrongTool = wrongTool;
      this._crosshair.classList.toggle('is-wrong-tool', wrongTool);
    }

    const readiness = state.combat ? state.combat.readiness : 1;
    const rounded = Math.round(readiness * 20) / 20;
    if (this._readiness !== rounded) {
      this._readiness = rounded;
      // Below 1 the crosshair dims, so weapon speed is legible without a
      // dedicated gauge.
      this._crosshair.style.setProperty('--attack-readiness', String(rounded));
      this._crosshair.classList.toggle('is-recharging', rounded < 1);
    }

    if (this._saveTimer > 0) {
      this._saveTimer -= dt;
      if (this._saveTimer <= 0) this._saveIndicator.classList.remove('is-visible');
    }

    if (!chipsVisible) return;

    this._textTimer += dt;
    if (this._textTimer < TEXT_INTERVAL) return;
    this._textTimer = 0;
    this._refreshText(state);
  }

  _refreshText(state) {
    const gameplay = this._settings.values.gameplay;
    const display = this._settings.values.display;
    const player = state.player;

    // --- coordinates ---
    if (gameplay.showCoordinates && player) {
      const text = `XYZ ${player.position.x.toFixed(1)} ${player.position.y.toFixed(1)} ${player.position.z.toFixed(1)}`;
      if (text !== this._lastCoordinates) {
        this._lastCoordinates = text;
        this._coordinates.textContent = text;
      }
      setVisible(this._coordinates, true);
    } else {
      setVisible(this._coordinates, false);
    }

    // --- fps / stats ---
    if (display.showFps || display.showStats) {
      const parts = [`${Math.round(state.loop.fps)} FPS`];
      if (display.showStats) {
        parts.push(`${state.loop.smoothedFrameTime.toFixed(1)}ms`);
        parts.push(`chunks ${state.chunks.stats.loaded}`);
        const queued = state.chunks.stats.queuedGeneration + state.chunks.stats.queuedMeshing;
        if (queued > 0) parts.push(`queue ${queued}`);
      }
      const text = parts.join('  ');
      if (text !== this._lastStats) {
        this._lastStats = text;
        this._statsLine.textContent = text;
      }
      setVisible(this._statsLine, true);
    } else {
      setVisible(this._statsLine, false);
    }

    // --- mode line ---
    if (player) {
      const parts = [];
      if (player.flying) parts.push('Flying');
      if (player.inWater) parts.push('Swimming');
      parts.push(
        gameplay.mode === 'survival'
          ? getDifficulty(player.difficulty).label
          : 'Creative'
      );
      const clock = formatClock(state.timeOfDay);
      parts.push(clock);
      const text = parts.join('  ·  ');
      if (text !== this._lastMode) {
        this._lastMode = text;
        this._modeLine.textContent = text;
      }
      setVisible(this._modeLine, true);
    } else {
      setVisible(this._modeLine, false);
    }
  }

  _showSaveIndicator(text, sticky = false) {
    this._saveIndicator.textContent = text;
    this._saveIndicator.classList.add('is-visible');
    this._saveTimer = sticky ? SAVE_INDICATOR_DURATION * 2 : SAVE_INDICATOR_DURATION;
  }

  /** Removes the HUD and its subscriptions. */
  destroy() {
    for (const unsubscribe of this._unsubscribers) unsubscribe();
    this._unsubscribers.length = 0;
    this._statusBars.destroy();
    this.element.remove();
  }
}

/**
 * Formats normalised time of day as a 24-hour clock.
 * @param {number} timeOfDay 0..1 where 0 is midnight.
 */
function formatClock(timeOfDay) {
  const totalMinutes = Math.floor(((timeOfDay % 1) + 1) % 1 * 24 * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export default HUD;
