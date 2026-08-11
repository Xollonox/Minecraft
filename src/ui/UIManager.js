/**
 * Owns every UI surface and the input context that goes with it.
 *
 * ## Screens and input are one decision
 *
 * The bug this class exists to prevent is a menu being visible while the world is
 * still receiving input (or worse, invisible while still swallowing it). So screen
 * visibility and input context are set together in `setScreen()`, never separately:
 *
 * | screen      | visible surfaces          | input context | pointer lock |
 * |-------------|---------------------------|---------------|--------------|
 * | `menu`      | main menu                 | `MENU`        | released     |
 * | `loading`   | loading screen            | `LOADING`     | released     |
 * | `playing`   | HUD, hotbar, touch        | `GAMEPLAY`    | requested    |
 * | `paused`    | pause menu                | `PAUSED`      | released     |
 * | `settings`  | settings menu             | `SETTINGS`    | released     |
 * | `inventory` | palette, HUD, hotbar      | `INVENTORY`   | released     |
 *
 * Because the input manager drops every held action on a context change, leaving
 * gameplay always stops the player — there is no path where a menu opens and the
 * player keeps walking into a wall.
 *
 * `settings` remembers where it was opened from, so closing it returns to the
 * pause menu or the main menu correctly rather than guessing.
 */

import { InputContext } from '../config/KeyBindings.js';
import { Events } from '../core/EventBus.js';
import { clamp } from '../utils/MathUtils.js';
import { ContainerScreen } from './ContainerScreen.js';
import { DeathScreen } from './DeathScreen.js';
import { DebugOverlay } from './DebugOverlay.js';
import { HUD } from './HUD.js';
import { Hotbar } from './Hotbar.js';
import { InventoryUI } from './InventoryUI.js';
import { LoadingScreen } from './LoadingScreen.js';
import { MainMenu } from './MainMenu.js';
import { MobileControls } from './MobileControls.js';
import { Notifications } from './Notifications.js';
import { PauseMenu } from './PauseMenu.js';
import { SettingsMenu } from './SettingsMenu.js';
import { StoryScreen } from './StoryScreen.js';

/** @enum {string} */
export const Screen = Object.freeze({
  MENU: 'menu',
  LOADING: 'loading',
  PLAYING: 'playing',
  PAUSED: 'paused',
  SETTINGS: 'settings',
  INVENTORY: 'inventory',
  /**
   * Any container: the survival inventory, a crafting table, a furnace, a chest.
   *
   * Distinct from `INVENTORY`, which is the creative block palette. The two are
   * genuinely different screens — one is a searchable list of every block, the
   * other is slot management — and conflating them would mean one screen with a
   * mode flag threaded through all of it.
   */
  CONTAINER: 'container',
  DEAD: 'dead',
  STORY: 'story',
});

export class UIManager {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.root
   * @param {import('../core/EventBus.js').EventBus} options.bus
   * @param {import('../core/SettingsManager.js').SettingsManager} options.settings
   * @param {import('../core/InputManager.js').InputManager} options.input
   * @param {import('../utils/DeviceDetector.js').DeviceCapabilities} options.capabilities
   * @param {import('../rendering/TextureAtlas.js').TextureAtlas} options.atlas
   * @param {Object} options.handlers Callbacks into `Game`.
   */
  constructor({ root, bus, settings, input, capabilities, atlas, handlers }) {
    this._root = root;
    this._bus = bus;
    this._settings = settings;
    this._input = input;
    this._caps = capabilities;
    this._handlers = handlers;

    this.screen = Screen.MENU;
    /** Where `settings` was opened from, so closing returns there. */
    this._settingsReturn = Screen.MENU;

    // --- components ---
    this.notifications = new Notifications(root);
    this.loadingScreen = new LoadingScreen(root);

    this.mainMenu = new MainMenu({
      root,
      settings,
      handlers: {
        onCreateWorld: (options) => handlers.onCreateWorld(options),
        onPlayWorld: (worldId) => handlers.onPlayWorld(worldId),
        onDeleteWorld: (worldId) => handlers.onDeleteWorld(worldId),
        onExportWorld: (worldId) => handlers.onExportWorld(worldId),
        onImportWorld: (file) => handlers.onImportWorld(file),
        onSettings: () => this.openSettings(Screen.MENU),
      },
    });

    this.hud = new HUD({
      root,
      bus,
      settings,
      capabilities,
      onPause: () => handlers.onPause(),
      onSettings: () => this.openSettings(Screen.PLAYING),
      onToggleFullscreen: () => this.toggleFullscreen(),
    });

    this.hotbar = new Hotbar({
      root,
      atlas,
      onSelect: (slot) => handlers.onSelectHotbarSlot(slot),
      onOpenInventory: () => handlers.onToggleInventory(),
    });

    this.inventory = new InventoryUI({
      root,
      atlas,
      onPick: (blockId, targetSlot) => {
        handlers.onPickBlock(blockId, targetSlot);
        this._bus.emit(Events.PLAY_SOUND, { name: 'ui.select' });
      },
      onClose: () => this.closeInventory(),
    });

    this.deathScreen = new DeathScreen({
      root,
      onRespawn: () => handlers.onRespawn(),
      onQuit: () => handlers.onQuitToMenu(),
    });

    this.containerScreen = new ContainerScreen({
      root,
      atlas,
      bus,
      // Closing hands control back to `Game`, which reclaims crafting-grid
      // contents and the cursor stack before returning to gameplay.
      onClose: () => handlers.onCloseContainer(),
    });

    this.pauseMenu = new PauseMenu({
      root,
      capabilities,
      handlers: {
        onResume: () => handlers.onResume(),
        onSettings: () => this.openSettings(Screen.PAUSED),
        onSave: () => handlers.onSaveNow(),
        onQuit: () => handlers.onQuitToMenu(),
        onToggleFullscreen: () => this.toggleFullscreen(),
        onShowProgress: () => handlers.onShowProgress?.(),
      },
    });

    this.storyScreen = new StoryScreen({
      root,
      onClose: () => handlers.onCloseStory?.(),
      onCreditsFinished: () => handlers.onCreditsFinished?.(),
    });

    this.settingsMenu = new SettingsMenu({
      root,
      settings,
      bus,
      onClose: () => this.closeSettings(),
    });

    this.debugOverlay = new DebugOverlay(root, capabilities);

    this.mobileControls = new MobileControls({
      root,
      input,
      settings,
      capabilities,
      handlers: {
        onPause: () => handlers.onPause(),
        onInventory: () => handlers.onToggleInventory(),
        onCamera: () => handlers.onToggleCamera?.(),
        getCameraMode: () => handlers.getCameraMode?.() ?? 0,
      },
    });

    // --- wiring ---
    this._unsubscribers = [
      bus.on(Events.NOTIFY, (payload) => this.notifications.show(payload)),
      bus.on(Events.HOTBAR_CHANGED, (hotbar, selected) => {
        this.hotbar.update(hotbar, selected);
        this.inventory.updateHotbar(hotbar, selected);
      }),
      bus.on(Events.SLOT_SELECTED, (slot) => this.hotbar.setSelected(slot)),
      bus.on(Events.SETTINGS_CHANGED, (values) => this.applySettings(values)),
      bus.on(Events.PLAYER_MODE_CHANGED, (state) =>
        this.mobileControls.setFlyMode(state.flying, state.mode)
      ),
    ];

    this._onOrientationChange = () => {
      this.mobileControls.checkOrientation();
    };
    window.addEventListener('orientationchange', this._onOrientationChange);
    window.addEventListener('resize', this._onOrientationChange);

    this.applySettings(settings.values);
    this.setScreen(Screen.MENU);
  }

  // ---------------------------------------------------------------- screen state

  /**
   * Switches screen, applying visibility, input context and pointer lock together.
   * @param {string} screen One of `Screen`.
   */
  setScreen(screen) {
    const previous = this.screen;
    this.screen = screen;

    const playing = screen === Screen.PLAYING;
    const inventoryOpen = screen === Screen.INVENTORY;

    // Every surface is explicitly shown or hidden on every transition, so no
    // combination of screens can leave a stale overlay behind.
    if (screen === Screen.MENU) {
      this.mainMenu.show(this._lastWorlds || [], this._lastStorage || { persistent: true, error: null });
    } else {
      this.mainMenu.hide();
    }

    if (screen !== Screen.LOADING) this.loadingScreen.hide();

    if (screen === Screen.PAUSED) this.pauseMenu.show(this._pauseInfo || {});
    else this.pauseMenu.hide();

    if (screen === Screen.SETTINGS) this.settingsMenu.show();
    else this.settingsMenu.hide();

    if (inventoryOpen) this.inventory.show();
    else this.inventory.hide();

    if (screen === Screen.DEAD) this.deathScreen.show(this._deathInfo || {});
    else this.deathScreen.hide();

    if (screen !== Screen.STORY) this.storyScreen.hide();

    // The container screen is opened by `openContainer`, which configures it and
    // then switches screen. Any transition *away* closes it, and closing always
    // runs its reclaim hook — so a crafting grid can never be abandoned with items
    // still on it, however the player leaves.
    if (screen !== Screen.CONTAINER && this.containerScreen.isOpen) {
      this.containerScreen.close();
    }

    // The HUD and hotbar stay up while the palette is open, so the player can see
    // which slot they are filling. Both are hidden while dead: an empty heart row
    // behind the death dialog is just noise.
    const containerOpen = screen === Screen.CONTAINER;
    this.hud.setVisible(playing || inventoryOpen);
    this.hotbar.setVisible(playing || inventoryOpen || containerOpen);

    // Touch controls are only live during actual gameplay.
    const wantTouch = playing && (this._caps.touch || this._caps.coarsePointer);
    this.mobileControls.setVisible(wantTouch);

    this._input.setContext(contextForScreen(screen));

    // Pointer lock is only meaningful during gameplay on a device with a mouse.
    if (playing) {
      if (!this._caps.touch || !this._caps.coarsePointer) this._input.requestPointerLock();
    } else {
      this._input.exitPointerLock();
    }

    document.body.classList.toggle('pointer-locked', playing && this._input.pointerLocked);

    if (previous !== screen) this._bus.emit(Events.UI_SCREEN_CHANGED, screen, previous);
  }

  /**
   * Shows the main menu with a fresh world list.
   * @param {Array<Object>} worlds
   * @param {{persistent: boolean, error: Error|null}} storage
   */
  showMenu(worlds, storage) {
    this._lastWorlds = worlds;
    this._lastStorage = storage;
    this.setScreen(Screen.MENU);
    this.mainMenu.setWorlds(worlds, storage);
  }

  /**
   * Shows the loading screen.
   * @param {string} [title]
   */
  showLoading(title) {
    this.loadingScreen.resetProgress();
    this.loadingScreen.show(title);
    this.setScreen(Screen.LOADING);
  }

  /** Updates loading progress and status text. */
  setLoadingProgress(progress, status) {
    this.loadingScreen.setProgress(progress);
    if (status) this.loadingScreen.setStatus(status);
  }

  /** Enters gameplay. */
  startPlaying() {
    this.setScreen(Screen.PLAYING);
  }

  /**
   * Opens the pause menu.
   * @param {Object} info Passed to `PauseMenu.show`.
   */
  showPaused(info) {
    this._pauseInfo = info;
    this.setScreen(Screen.PAUSED);
  }

  /** Opens the settings menu, remembering where to return. */
  openSettings(returnTo = Screen.PAUSED) {
    this._settingsReturn = returnTo;
    this.setScreen(Screen.SETTINGS);
  }

  /** Closes the settings menu and returns to the previous screen. */
  closeSettings() {
    const target = this._settingsReturn;
    if (target === Screen.MENU) {
      this.setScreen(Screen.MENU);
    } else if (target === Screen.PLAYING) {
      this.startPlaying();
    } else {
      this.showPaused(this._pauseInfo || {});
    }
  }

  /**
   * Opens a container.
   *
   * The configuration is built by `Game`, which is the only place that knows about
   * both the world's block entities and the player's inventory.
   *
   * @param {Object} config Passed straight to `ContainerScreen.open`.
   */
  openContainer(config) {
    this.containerScreen.open(config);
    this.setScreen(Screen.CONTAINER);
  }

  /** True while a container is open. */
  get isContainerOpen() {
    return this.screen === Screen.CONTAINER;
  }

  /**
   * Shows the death screen.
   * @param {Object} info Passed to `DeathScreen.show`.
   */
  showDeath(info) {
    this._deathInfo = info;
    this.setScreen(Screen.DEAD);
  }

  showCredits(snapshot) {
    this.setScreen(Screen.STORY);
    this.storyScreen.showCredits(snapshot);
  }

  showProgress(snapshot) {
    this.setScreen(Screen.STORY);
    this.storyScreen.showProgress(snapshot);
  }

  /** True while the death screen is up. */
  get isDead() {
    return this.screen === Screen.DEAD;
  }

  /** Opens the block palette. */
  openInventory() {
    this.setScreen(Screen.INVENTORY);
  }

  /** Closes the block palette and returns to gameplay. */
  closeInventory() {
    this.setScreen(Screen.PLAYING);
  }

  /** True when a screen other than gameplay is showing. */
  get isMenuOpen() {
    return this.screen !== Screen.PLAYING;
  }

  /** True when the world should be simulated. */
  get isPlaying() {
    // CONTAINER counts as playing so the world keeps simulating while a chest or
    // furnace is open: a furnace that paused whenever you looked at it would be
    // both wrong and infuriating.
    return (
      this.screen === Screen.PLAYING ||
      this.screen === Screen.INVENTORY ||
      this.screen === Screen.CONTAINER
    );
  }

  // -------------------------------------------------------------------- per frame

  /**
   * Per-frame UI update.
   * @param {number} dt
   * @param {Object} state Assembled by `Game`.
   */
  update(dt, state) {
    this.hud.update(dt, state);
    this.debugOverlay.update(dt, state);
  }

  /** Toggles the debug overlay. */
  toggleDebugOverlay() {
    return this.debugOverlay.toggle();
  }

  // ------------------------------------------------------------------- settings

  /**
   * Applies settings that affect the interface.
   * @param {Object} values The whole settings tree.
   */
  applySettings(values) {
    // One custom property drives the size of the entire interface.
    document.documentElement.style.setProperty(
      '--ui-scale',
      String(clamp(values.display.uiScale, 0.5, 2.5))
    );
    this.mobileControls.applySettings(values);
  }

  // ----------------------------------------------------------------- fullscreen

  /**
   * Requests or exits fullscreen.
   *
   * iOS Safari does not implement the Fullscreen API on `<div>`/`<canvas>`, so this
   * is a best-effort operation that reports its failure once rather than throwing.
   */
  async toggleFullscreen() {
    if (!this._caps.fullscreenSupported) {
      this.notifications.warning('Fullscreen is not available in this browser.', {
        id: 'fullscreen-unsupported',
      });
      return;
    }

    try {
      const element = document.documentElement;
      const isFullscreen = document.fullscreenElement || document.webkitFullscreenElement;
      if (isFullscreen) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      } else if (element.requestFullscreen) {
        await element.requestFullscreen({ navigationUI: 'hide' });
      } else if (element.webkitRequestFullscreen) {
        element.webkitRequestFullscreen();
      }
    } catch (error) {
      this.notifications.warning(
        `Fullscreen was refused: ${error instanceof Error ? error.message : error}`,
        { id: 'fullscreen-failed' }
      );
    }
  }

  /** Hides the static boot screen once the engine is ready. */
  dismissBootScreen() {
    const boot = document.getElementById('boot-screen');
    if (!boot) return;
    boot.classList.add('is-hidden');
    // Remove after the transition so it cannot intercept pointer events.
    setTimeout(() => boot.remove(), 420);
  }

  /**
   * Updates the boot screen's progress bar and status, before the UI exists.
   * @param {number} progress 0..1
   * @param {string} [status]
   */
  static setBootProgress(progress, status) {
    const fill = document.querySelector('.boot-bar-fill');
    const text = document.querySelector('.boot-status');
    if (fill instanceof HTMLElement) fill.style.width = `${Math.round(clamp(progress, 0, 1) * 100)}%`;
    if (status && text instanceof HTMLElement) text.textContent = status;
  }

  /** Tears down every component and listener. */
  destroy() {
    for (const unsubscribe of this._unsubscribers) unsubscribe();
    this._unsubscribers.length = 0;
    window.removeEventListener('orientationchange', this._onOrientationChange);
    window.removeEventListener('resize', this._onOrientationChange);

    this.mobileControls.destroy();
    this.debugOverlay.destroy();
    this.settingsMenu.destroy();
    this.storyScreen.destroy();
    this.pauseMenu.destroy();
    this.inventory.destroy();
    this.deathScreen.destroy();
    this.containerScreen.destroy();
    this.hotbar.destroy();
    this.hud.destroy();
    this.mainMenu.destroy();
    this.loadingScreen.destroy();
    this.notifications.destroy();
  }
}

/** Maps a screen to its input context. */
function contextForScreen(screen) {
  switch (screen) {
    case Screen.PLAYING:
      return InputContext.GAMEPLAY;
    case Screen.INVENTORY:
      return InputContext.INVENTORY;
    case Screen.PAUSED:
      return InputContext.PAUSED;
    case Screen.SETTINGS:
      return InputContext.SETTINGS;
    case Screen.LOADING:
      return InputContext.LOADING;
    case Screen.CONTAINER:
      // Same allowance as the block palette: hotbar keys and escape work, nothing
      // that moves the player or acts on the world does.
      return InputContext.INVENTORY;
    case Screen.DEAD:
      // Reuses the paused context: the allowed action set is identical (nothing
      // that moves or acts on the world), so a separate context would be two
      // tables to keep in step for no behavioural difference.
      return InputContext.PAUSED;
    case Screen.STORY:
      return InputContext.PAUSED;
    default:
      return InputContext.MENU;
  }
}

export default UIManager;
