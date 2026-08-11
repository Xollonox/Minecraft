/**
 * The single source of truth for player input.
 *
 * Every device — keyboard, mouse, touch, gamepad — is translated into the same
 * abstract `Action` set from `config/KeyBindings.js`. Gameplay code never asks
 * "is W down"; it asks "is MOVE_FORWARD active". That is what makes the mobile
 * and gamepad paths first-class instead of bolted on: they write to the same
 * state the keyboard does.
 *
 * Look input is normalised to **radians** at the source. Mouse pixels, touch
 * pixels and gamepad stick deflection have nothing in common, so converting
 * them here (with their own sensitivity settings) keeps the camera controller
 * from having to know which device the player is holding.
 */

import {
  Action,
  CONTEXT_ACTIONS,
  DEFAULT_GAMEPAD_BUTTONS,
  DEFAULT_KEY_BINDINGS,
  DEFAULT_MOUSE_BINDINGS,
  EDGE_TRIGGERED_ACTIONS,
  GAMEPAD_AXES,
  GAMEPAD_TUNING,
  HOTBAR_ACTIONS,
  InputContext,
} from '../config/KeyBindings.js';
import { Events, SubscriptionGroup } from './EventBus.js';
import { applyDeadZone, clamp } from '../utils/MathUtils.js';

/** Radians of camera rotation per pixel of mouse movement at sensitivity 1. */
const MOUSE_RADIANS_PER_PIXEL = 0.0022;
/** Radians of camera rotation per pixel of touch drag at sensitivity 1. */
const TOUCH_RADIANS_PER_PIXEL = 0.0027;
/** Ignore single mouse events larger than this; they are driver/OS glitches. */
const MAX_MOUSE_DELTA_PIXELS = 260;

export class InputManager {
  /**
   * @param {Object} options
   * @param {HTMLCanvasElement} options.canvas
   * @param {import('./EventBus.js').EventBus} options.bus
   * @param {import('./SettingsManager.js').SettingsManager} options.settings
   * @param {import('../utils/DeviceDetector.js').DeviceCapabilities} options.capabilities
   */
  constructor({ canvas, bus, settings, capabilities }) {
    this._canvas = canvas;
    this._bus = bus;
    this._settings = settings;
    this._caps = capabilities;
    this._subscriptions = new SubscriptionGroup();

    this._keyBindings = { ...DEFAULT_KEY_BINDINGS };
    this._mouseBindings = { ...DEFAULT_MOUSE_BINDINGS };
    this._gamepadBindings = { ...DEFAULT_GAMEPAD_BUTTONS };

    this._context = InputContext.LOADING;
    /** @type {Set<string>} Actions allowed by the current context. */
    this._allowed = new Set(CONTEXT_ACTIONS[InputContext.LOADING]);

    /** @type {Set<string>} Held actions from any device. */
    this._down = new Set();
    /** @type {Set<string>} Actions that went down since the last `endFrame()`. */
    this._pressed = new Set();
    /** @type {Set<string>} Actions that went up since the last `endFrame()`. */
    this._released = new Set();

    /** Per-device held sets, so releasing a key cannot clear a held button. */
    this._keyboardDown = new Set();
    this._mouseDown = new Set();
    this._touchDown = new Set();
    this._gamepadDown = new Set();

    /** Accumulated look delta in radians, drained by the camera each frame. */
    this._lookYaw = 0;
    this._lookPitch = 0;

    /** Analog movement from the touch joystick, in `[-1, 1]`. */
    this._virtualMove = { x: 0, y: 0 };
    /** Analog movement from a gamepad stick. */
    this._gamepadMove = { x: 0, y: 0 };
    /** Combined movement axis, recomputed each frame. */
    this.moveAxis = { x: 0, y: 0 };

    /** Hotbar scroll steps accumulated from the wheel, drained per frame. */
    this._hotbarScroll = 0;
    /** Requested hotbar slot (0..8) or -1. Drained per frame. */
    this._requestedSlot = -1;

    this._pointerLocked = false;
    this._pointerLockRequested = false;
    this._pointerLockUnavailableReported = false;

    /** @type {number|null} Index of the active gamepad. */
    this._gamepadIndex = null;
    this._gamepadId = '';
    this._gamepadWarned = false;
    /** Previous button states for edge detection. */
    this._gamepadPrevButtons = [];

    this._scratchStick = { x: 0, y: 0 };
    this._attached = false;
  }

  // -------------------------------------------------------------------- state

  /** The active input context. */
  get context() {
    return this._context;
  }

  /** True while the pointer is locked to the canvas. */
  get pointerLocked() {
    return this._pointerLocked;
  }

  /** True when a gamepad is currently connected and being polled. */
  get gamepadConnected() {
    return this._gamepadIndex !== null;
  }

  /** Identifier of the active gamepad, for the debug overlay. */
  get gamepadId() {
    return this._gamepadId;
  }

  /**
   * True while the action is held.
   * @param {string} action
   */
  isDown(action) {
    return this._down.has(action);
  }

  /**
   * True when the action went down since the previous frame.
   * @param {string} action
   */
  justPressed(action) {
    return this._pressed.has(action);
  }

  /**
   * True when the action was released since the previous frame.
   * @param {string} action
   */
  justReleased(action) {
    return this._released.has(action);
  }

  /**
   * Drains the accumulated look rotation.
   * @param {{yaw:number,pitch:number}} out
   * @returns {{yaw:number,pitch:number}} Radians to add to the camera.
   */
  consumeLook(out = { yaw: 0, pitch: 0 }) {
    out.yaw = this._lookYaw;
    out.pitch = this._lookPitch;
    this._lookYaw = 0;
    this._lookPitch = 0;
    return out;
  }

  /**
   * Drains the hotbar scroll delta in slot steps.
   * @returns {number}
   */
  consumeHotbarScroll() {
    const value = this._hotbarScroll;
    this._hotbarScroll = 0;
    return value;
  }

  /**
   * Drains a direct hotbar slot request.
   * @returns {number} 0-based slot index, or -1 when nothing was requested.
   */
  consumeRequestedSlot() {
    const slot = this._requestedSlot;
    this._requestedSlot = -1;
    return slot;
  }

  // ------------------------------------------------------------------ lifecycle

  /** Attaches every DOM listener. Idempotent. */
  attach() {
    if (this._attached) return;
    this._attached = true;
    const group = this._subscriptions;
    const canvas = this._canvas;

    group.dom(window, 'keydown', this._onKeyDown, { passive: false });
    group.dom(window, 'keyup', this._onKeyUp);
    group.dom(window, 'blur', this._onWindowBlur);
    group.dom(document, 'visibilitychange', this._onVisibilityChange);

    group.dom(canvas, 'pointerdown', this._onPointerDown);
    group.dom(window, 'pointerup', this._onPointerUp);
    group.dom(window, 'pointercancel', this._onPointerUp);
    group.dom(canvas, 'pointermove', this._onPointerMove);
    group.dom(canvas, 'wheel', this._onWheel, { passive: false });
    group.dom(canvas, 'contextmenu', this._onContextMenu);

    group.dom(document, 'pointerlockchange', this._onPointerLockChange);
    group.dom(document, 'pointerlockerror', this._onPointerLockError);

    group.dom(window, 'gamepadconnected', this._onGamepadConnected);
    group.dom(window, 'gamepaddisconnected', this._onGamepadDisconnected);

    // A gamepad may already be connected before the page loaded; the connect
    // event only fires after the first input, so probe once at startup too.
    this._pollGamepadPresence();
  }

  /** Removes every listener and clears all held state. */
  destroy() {
    this._subscriptions.dispose();
    this._attached = false;
    this.clearAll();
  }

  /**
   * Switches input context. Actions the new context does not accept are
   * released immediately, which is what stops the player from continuing to
   * walk after the inventory opens.
   *
   * @param {string} context One of `InputContext`.
   */
  setContext(context) {
    if (!CONTEXT_ACTIONS[context]) {
      console.warn(`[Input] unknown context "${context}"`);
      return;
    }
    if (this._context === context) return;
    const previous = this._context;
    this._context = context;
    this._allowed = new Set(CONTEXT_ACTIONS[context]);

    // Drop held actions the new context does not forward.
    for (const action of Array.from(this._down)) {
      if (!this._allowed.has(action)) this._down.delete(action);
    }
    this._pressed.clear();
    this._released.clear();
    this._lookYaw = 0;
    this._lookPitch = 0;
    this._hotbarScroll = 0;
    if (context !== InputContext.GAMEPLAY) {
      this._virtualMove.x = 0;
      this._virtualMove.y = 0;
      this._gamepadMove.x = 0;
      this._gamepadMove.y = 0;
      this.moveAxis.x = 0;
      this.moveAxis.y = 0;
      this._touchDown.clear();
    }

    this._bus.emit(Events.INPUT_CONTEXT_CHANGED, context, previous);
  }

  /**
   * Releases every held input across all devices.
   * Called on blur, page hide, pointer-lock loss and context switches.
   */
  clearAll() {
    this._keyboardDown.clear();
    this._mouseDown.clear();
    this._touchDown.clear();
    this._gamepadDown.clear();
    this._down.clear();
    this._pressed.clear();
    this._released.clear();
    this._lookYaw = 0;
    this._lookPitch = 0;
    this._hotbarScroll = 0;
    this._requestedSlot = -1;
    this._virtualMove.x = 0;
    this._virtualMove.y = 0;
    this._gamepadMove.x = 0;
    this._gamepadMove.y = 0;
    this.moveAxis.x = 0;
    this.moveAxis.y = 0;
  }

  // ---------------------------------------------------------------- per frame

  /**
   * Polls the gamepad and recomputes the combined movement axis.
   * Must run once per frame, before gameplay systems read the input state.
   * @param {number} dt Seconds since the previous frame.
   */
  update(dt) {
    this._pollGamepad(dt);

    // Keyboard contributes a digital axis; touch and gamepad contribute analog.
    // The largest magnitude per axis wins so holding W while nudging a stick
    // never produces 2.0.
    let x = 0;
    let y = 0;
    if (this._isAllowed(Action.MOVE_RIGHT) && this._down.has(Action.MOVE_RIGHT)) x += 1;
    if (this._isAllowed(Action.MOVE_LEFT) && this._down.has(Action.MOVE_LEFT)) x -= 1;
    if (this._isAllowed(Action.MOVE_FORWARD) && this._down.has(Action.MOVE_FORWARD)) y += 1;
    if (this._isAllowed(Action.MOVE_BACKWARD) && this._down.has(Action.MOVE_BACKWARD)) y -= 1;

    if (this._context === InputContext.GAMEPLAY) {
      x = pickLarger(x, this._virtualMove.x, this._gamepadMove.x);
      y = pickLarger(y, this._virtualMove.y, this._gamepadMove.y);
    } else {
      x = 0;
      y = 0;
    }

    const magnitude = Math.hypot(x, y);
    if (magnitude > 1) {
      x /= magnitude;
      y /= magnitude;
    }
    this.moveAxis.x = x;
    this.moveAxis.y = y;
  }

  /** Clears edge-triggered state. Call at the very end of the frame. */
  endFrame() {
    this._pressed.clear();
    this._released.clear();
  }

  // ------------------------------------------------------------- touch bridge

  /**
   * Sets the analog movement axis from the on-screen joystick.
   * @param {number} x `-1` (left) to `1` (right)
   * @param {number} y `-1` (backward) to `1` (forward)
   */
  setVirtualMove(x, y) {
    this._virtualMove.x = clamp(x, -1, 1);
    this._virtualMove.y = clamp(y, -1, 1);
  }

  /**
   * Presses or releases an action from a touch control.
   * @param {string} action
   * @param {boolean} pressed
   */
  setTouchAction(action, pressed) {
    if (pressed) {
      if (this._touchDown.has(action)) return;
      this._touchDown.add(action);
      this._press(action);
    } else {
      if (!this._touchDown.has(action)) return;
      this._touchDown.delete(action);
      this._release(action);
    }
  }

  /**
   * Adds camera rotation from a touch drag, in pixels.
   * @param {number} dxPixels
   * @param {number} dyPixels
   */
  addTouchLook(dxPixels, dyPixels) {
    if (this._context !== InputContext.GAMEPLAY) return;
    const controls = this._settings.values.controls;
    const scale = TOUCH_RADIANS_PER_PIXEL * controls.touchSensitivity;
    this._lookYaw -= dxPixels * scale;
    this._lookPitch += (controls.invertMouseY ? dyPixels : -dyPixels) * scale;
  }

  /** Directly requests a hotbar slot (touch/UI click). */
  requestHotbarSlot(slot) {
    if (slot >= 0 && slot < 9) this._requestedSlot = slot;
  }

  /** Adds hotbar scroll steps (touch swipe on the hotbar). */
  addHotbarScroll(steps) {
    this._hotbarScroll += steps;
  }

  // -------------------------------------------------------------- pointer lock

  /**
   * Requests pointer lock on the canvas.
   *
   * Returns silently when unsupported (touch-only devices, some embedded
   * webviews); the mobile look area covers that case.
   */
  requestPointerLock() {
    if (!this._caps.pointerLockSupported) {
      if (!this._pointerLockUnavailableReported) {
        this._pointerLockUnavailableReported = true;
        this._bus.emit(Events.POINTER_LOCK_CHANGED, false, 'unsupported');
      }
      return;
    }
    if (this._pointerLocked || this._pointerLockRequested) return;
    this._pointerLockRequested = true;
    try {
      const result = this._canvas.requestPointerLock({ unadjustedMovement: false });
      // Chromium returns a promise; Firefox/Safari return undefined.
      if (result && typeof result.catch === 'function') {
        result.catch(() => {
          this._pointerLockRequested = false;
        });
      }
    } catch {
      // Older signature without options.
      try {
        this._canvas.requestPointerLock();
      } catch {
        this._pointerLockRequested = false;
      }
    }
  }

  /** Releases pointer lock if we hold it. */
  exitPointerLock() {
    this._pointerLockRequested = false;
    if (typeof document === 'undefined') return;
    if (document.pointerLockElement === this._canvas) {
      try {
        document.exitPointerLock();
      } catch {
        /* ignore */
      }
    }
  }

  // ----------------------------------------------------------------- internals

  _isAllowed(action) {
    return this._allowed.has(action);
  }

  /** Registers an action press, respecting the active context. */
  _press(action) {
    if (!action || !this._isAllowed(action)) return;

    const slot = HOTBAR_ACTIONS.indexOf(action);
    if (slot >= 0) this._requestedSlot = slot;
    if (action === Action.HOTBAR_NEXT) this._hotbarScroll += 1;
    if (action === Action.HOTBAR_PREVIOUS) this._hotbarScroll -= 1;

    if (EDGE_TRIGGERED_ACTIONS.has(action)) {
      // Edge actions still record a press even if something else holds them.
      this._pressed.add(action);
      this._down.add(action);
      return;
    }
    if (this._down.has(action)) return;
    this._down.add(action);
    this._pressed.add(action);
  }

  /** Registers an action release once no device still holds it. */
  _release(action) {
    if (!action) return;
    if (
      this._keyboardDown.has(action) ||
      this._mouseDown.has(action) ||
      this._touchDown.has(action) ||
      this._gamepadDown.has(action)
    ) {
      return;
    }
    if (!this._down.delete(action)) return;
    this._released.add(action);
  }

  // --- keyboard ---

  _onKeyDown = (event) => {
    if (event.repeat) return;

    // Never swallow a browser shortcut. Control is itself bound to crouch, so
    // pressing Control alone is allowed through, but Control/Meta/Alt plus
    // another key always belongs to the browser (Ctrl+R, Cmd+W, Alt+Tab...).
    // `KeyC` is bound to crouch as well, so nothing becomes unreachable.
    const isBareModifier = event.code === 'ControlLeft' || event.code === 'ControlRight';
    if (!isBareModifier && (event.ctrlKey || event.metaKey || event.altKey)) return;

    const action = this._keyBindings[event.code];
    if (!action) return;
    if (!this._isAllowed(action)) {
      // Escape and F-keys must keep working in menus even if unbound there.
      if (action !== Action.PAUSE) return;
    }

    // F3/F11/Escape/Space would otherwise scroll, open dev tools or leave
    // fullscreen. Only suppress while the game owns input.
    if (this._shouldPreventKeyDefault(event.code)) event.preventDefault();

    this._keyboardDown.add(action);
    this._press(action);
  };

  _onKeyUp = (event) => {
    const action = this._keyBindings[event.code];
    if (!action) return;
    this._keyboardDown.delete(action);
    this._release(action);
  };

  _shouldPreventKeyDefault(code) {
    if (code === 'F2' || code === 'F3' || code === 'F11') return true;
    if (this._context !== InputContext.GAMEPLAY) return false;
    return (
      code === 'Space' ||
      code === 'Tab' ||
      code.startsWith('Arrow') ||
      code.startsWith('Digit') ||
      code === 'Slash' ||
      code === 'Quote'
    );
  }

  // --- mouse ---

  _onPointerDown = (event) => {
    // Touch is handled by MobileControls, which owns its own pointer ids.
    if (event.pointerType === 'touch') return;
    if (this._context !== InputContext.GAMEPLAY) return;

    const action = this._mouseBindings[event.button];
    if (!action) return;
    event.preventDefault();
    this._mouseDown.add(action);
    this._press(action);
  };

  _onPointerUp = (event) => {
    if (event.pointerType === 'touch') return;
    const action = this._mouseBindings[event.button];
    if (!action) return;
    this._mouseDown.delete(action);
    this._release(action);
  };

  _onPointerMove = (event) => {
    if (event.pointerType === 'touch') return;
    if (!this._pointerLocked || this._context !== InputContext.GAMEPLAY) return;

    let dx = event.movementX || 0;
    let dy = event.movementY || 0;
    // Guard against the occasional multi-thousand-pixel spike some drivers
    // report on the first locked frame.
    if (Math.abs(dx) > MAX_MOUSE_DELTA_PIXELS || Math.abs(dy) > MAX_MOUSE_DELTA_PIXELS) return;

    const controls = this._settings.values.controls;
    const scale = MOUSE_RADIANS_PER_PIXEL * controls.mouseSensitivity;
    this._lookYaw -= dx * scale;
    this._lookPitch += (controls.invertMouseY ? dy : -dy) * scale;
  };

  _onWheel = (event) => {
    if (this._context !== InputContext.GAMEPLAY) return;
    event.preventDefault();
    // Only the sign matters: trackpads report tiny pixel deltas and mice report
    // large line deltas, and one notch should always be one hotbar slot.
    if (event.deltaY > 0) this._hotbarScroll += 1;
    else if (event.deltaY < 0) this._hotbarScroll -= 1;
  };

  _onContextMenu = (event) => {
    // Right-click places blocks during gameplay, but outside gameplay the
    // browser menu is left alone so the page behaves normally.
    if (this._context === InputContext.GAMEPLAY) event.preventDefault();
  };

  // --- focus / lock ---

  _onWindowBlur = () => {
    this.clearAll();
  };

  _onVisibilityChange = () => {
    if (document.hidden) this.clearAll();
  };

  _onPointerLockChange = () => {
    const locked = document.pointerLockElement === this._canvas;
    this._pointerLockRequested = false;
    if (locked === this._pointerLocked) return;
    this._pointerLocked = locked;
    if (!locked) {
      // Losing the lock (Escape, alt-tab) must not leave movement keys stuck.
      this._mouseDown.clear();
      for (const action of Array.from(this._down)) {
        if (!this._keyboardDown.has(action) && !this._touchDown.has(action)) {
          this._down.delete(action);
        }
      }
    }
    this._bus.emit(Events.POINTER_LOCK_CHANGED, locked, locked ? 'locked' : 'released');
  };

  _onPointerLockError = () => {
    this._pointerLockRequested = false;
    this._bus.emit(Events.POINTER_LOCK_CHANGED, false, 'error');
  };

  // --- gamepad ---

  _onGamepadConnected = (event) => {
    const pad = event.gamepad;
    if (!pad) return;
    if (this._gamepadIndex === null) {
      this._gamepadIndex = pad.index;
      this._gamepadId = pad.id || 'Gamepad';
      this._gamepadPrevButtons = [];
      this._bus.emit(Events.GAMEPAD_CONNECTED, { index: pad.index, id: this._gamepadId });
    }
  };

  _onGamepadDisconnected = (event) => {
    if (!event.gamepad || event.gamepad.index !== this._gamepadIndex) return;
    this._releaseAllGamepadActions();
    this._gamepadIndex = null;
    this._gamepadId = '';
    this._gamepadPrevButtons = [];
    this._bus.emit(Events.GAMEPAD_DISCONNECTED, { index: event.gamepad.index });
    // Another pad may still be attached.
    this._pollGamepadPresence();
  };

  /** Finds an already-connected pad without spamming warnings. */
  _pollGamepadPresence() {
    const pads = this._getGamepads();
    if (!pads) return;
    for (const pad of pads) {
      if (pad && pad.connected) {
        if (this._gamepadIndex !== pad.index) {
          this._gamepadIndex = pad.index;
          this._gamepadId = pad.id || 'Gamepad';
          this._gamepadPrevButtons = [];
          this._bus.emit(Events.GAMEPAD_CONNECTED, { index: pad.index, id: this._gamepadId });
        }
        return;
      }
    }
  }

  _getGamepads() {
    if (!this._caps.gamepadSupported) return null;
    try {
      return navigator.getGamepads();
    } catch (error) {
      if (!this._gamepadWarned) {
        this._gamepadWarned = true;
        console.warn('[Input] gamepad polling unavailable:', error);
      }
      return null;
    }
  }

  _pollGamepad(dt) {
    if (this._gamepadIndex === null) return;
    const pads = this._getGamepads();
    if (!pads) return;
    const pad = pads[this._gamepadIndex];
    if (!pad || !pad.connected) {
      // The pad vanished without firing a disconnect event.
      this._releaseAllGamepadActions();
      this._gamepadIndex = null;
      this._gamepadId = '';
      return;
    }

    const controls = this._settings.values.controls;
    const gameplay = this._context === InputContext.GAMEPLAY;

    // Buttons
    const buttons = pad.buttons || [];
    for (let i = 0; i < buttons.length; i++) {
      const action = this._gamepadBindings[i];
      if (!action) continue;
      const button = buttons[i];
      const value = typeof button === 'object' ? button.value ?? (button.pressed ? 1 : 0) : button;
      const isDown = value >= GAMEPAD_TUNING.buttonThreshold;
      const wasDown = this._gamepadPrevButtons[i] === true;
      if (isDown === wasDown) continue;
      this._gamepadPrevButtons[i] = isDown;
      if (isDown) {
        this._gamepadDown.add(action);
        this._press(action);
      } else {
        this._gamepadDown.delete(action);
        this._release(action);
      }
    }

    // Axes
    const axes = pad.axes || [];
    const deadZone = GAMEPAD_TUNING.defaultStickDeadZone;

    if (gameplay) {
      const move = applyDeadZone(
        axes[GAMEPAD_AXES.moveX] || 0,
        axes[GAMEPAD_AXES.moveY] || 0,
        deadZone,
        this._scratchStick
      );
      this._gamepadMove.x = move.x;
      this._gamepadMove.y = -move.y; // stick Y is inverted relative to forward

      const look = applyDeadZone(
        axes[GAMEPAD_AXES.lookX] || 0,
        axes[GAMEPAD_AXES.lookY] || 0,
        deadZone,
        this._scratchStick
      );
      if (look.x !== 0 || look.y !== 0) {
        const speed = GAMEPAD_TUNING.lookRadiansPerSecond * controls.gamepadSensitivity * dt;
        // Squaring the magnitude gives fine control near centre without
        // sacrificing turn speed at full deflection.
        const magnitude = Math.hypot(look.x, look.y);
        const curve = magnitude > 0 ? magnitude : 1;
        this._lookYaw -= look.x * curve * speed;
        this._lookPitch += (controls.invertGamepadY ? look.y : -look.y) * curve * speed;
      }
    } else {
      this._gamepadMove.x = 0;
      this._gamepadMove.y = 0;
    }
  }

  _releaseAllGamepadActions() {
    for (const action of Array.from(this._gamepadDown)) {
      this._gamepadDown.delete(action);
      this._release(action);
    }
    this._gamepadMove.x = 0;
    this._gamepadMove.y = 0;
  }
}

/** Returns whichever value has the largest absolute magnitude. */
function pickLarger(...values) {
  let best = 0;
  let bestMagnitude = 0;
  for (const value of values) {
    const magnitude = Math.abs(value);
    if (magnitude > bestMagnitude) {
      bestMagnitude = magnitude;
      best = value;
    }
  }
  return best;
}

export default InputManager;
