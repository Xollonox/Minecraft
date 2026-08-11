/**
 * Touch controls.
 *
 * ## Multi-touch by pointer id
 *
 * Every gesture owns a specific `pointerId` for its whole lifetime. The joystick
 * remembers the id that started it, the look area remembers its own, and each
 * button remembers the id pressing it. Nothing looks at "the current touch",
 * which is what makes walking and looking *at the same time* work — the single
 * most important thing to get right, and the thing a naive
 * `touchstart`/`touchmove` implementation always breaks.
 *
 * `setPointerCapture` is used on press so that sliding a thumb off a button still
 * delivers the release to that button. Without it, dragging off a held "break"
 * button leaves it stuck down forever.
 *
 * ## Tap versus hold on the look area
 *
 * The look area distinguishes three gestures from one pointer:
 *
 *  - **drag** (moved past a threshold) → rotate the camera;
 *  - **hold** (still, past a delay) → break the targeted block, continuously;
 *  - **tap** (released quickly, without moving) → place a block.
 *
 * Movement cancels the tap and hold intents, so looking around never accidentally
 * mines a hole in the floor. Explicit break and place buttons are provided as well,
 * because precise building wants a dedicated button.
 *
 * ## Robustness
 *
 * `pointercancel` is handled everywhere — the browser fires it when a system
 * gesture (notification shade, app switcher, an incoming call) steals the touch,
 * and treating it as anything other than a release is exactly how a joystick ends
 * up stuck at full deflection after returning to the tab.
 */

import { Action } from '../config/KeyBindings.js';
import { applyDeadZone, clamp } from '../utils/MathUtils.js';
import { el, setVisible } from './dom.js';

/** Radial dead zone of the joystick, as a fraction of its radius. */
const JOYSTICK_DEAD_ZONE = 0.18;
/** Pixels of movement that turn a tap into a look drag. */
const DRAG_THRESHOLD = 11;
/** Milliseconds a still touch must be held to start breaking. */
const HOLD_TO_BREAK_MS = 190;
/** Vibration duration for a confirmed action, in milliseconds. */
const HAPTIC_MS = 12;

export class MobileControls {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.root
   * @param {import('../core/InputManager.js').InputManager} options.input
   * @param {import('../core/SettingsManager.js').SettingsManager} options.settings
   * @param {import('../utils/DeviceDetector.js').DeviceCapabilities} options.capabilities
   * @param {Object} options.handlers
   * @param {() => void} options.handlers.onPause
   * @param {() => void} options.handlers.onInventory
   */
  constructor({ root, input, settings, capabilities, handlers }) {
    this._input = input;
    this._settings = settings;
    this._caps = capabilities;
    this._handlers = handlers;

    /** @type {number|null} */
    this._lookPointerId = null;
    /** @type {number|null} */
    this._joystickPointerId = null;
    /** @type {Map<number, {action: string|null, element: HTMLElement, onRelease: (() => void)|null}>} */
    this._buttonPointers = new Map();

    this._lookStartX = 0;
    this._lookStartY = 0;
    this._lookLastX = 0;
    this._lookLastY = 0;
    this._lookMoved = false;
    this._holdTimer = 0;
    this._holdActive = false;

    this._joystickCentreX = 0;
    this._joystickCentreY = 0;
    this._joystickRadius = 1;
    this._stick = { x: 0, y: 0 };

    this._flyMode = false;

    // --- elements ---
    this._lookArea = el('div', {
      className: 'touch-look-area',
      attrs: { 'aria-hidden': 'true' },
    });

    this._joystickThumb = el('div', { className: 'touch-joystick-thumb' });
    this._joystick = el('div', {
      className: 'touch-joystick',
      attrs: { 'aria-label': 'Movement joystick', role: 'application' },
    }, [this._joystickThumb]);

    this._breakButton = this._createHoldButton('MINE', Action.BREAK_BLOCK, 'Break block');
    this._placeButton = this._createHoldButton('PLACE', Action.PLACE_BLOCK, 'Place block');
    this._jumpButton = this._createHoldButton('JUMP', Action.JUMP, 'Jump');
    this._sprintButton = this._createHoldButton('RUN', Action.SPRINT, 'Sprint');
    this._crouchButton = this._createHoldButton('DUCK', Action.CROUCH, 'Crouch');
    this._flyUpButton = this._createHoldButton('UP', Action.FLY_UP, 'Fly up');
    this._flyDownButton = this._createHoldButton('DOWN', Action.FLY_DOWN, 'Fly down');

    this._pauseButton = this._createTapButton('II', 'Pause', () => this._handlers.onPause());

    /*
     * Camera perspective toggle: first -> third behind -> third front
     */
    this._cameraButton = this._createTapButton('◧', 'Toggle camera', () => {
      if (this._handlers.onCamera) this._handlers.onCamera();
      const labels = ['◧', '◨', '◩'];
      const mode = this._handlers.getCameraMode ? this._handlers.getCameraMode() : 0;
      this._cameraButton.textContent = labels[mode] ?? '◧';
      this._cameraButton.title = mode === 0 ? 'First person' : mode === 1 ? 'Third behind' : 'Third front';
    });

    /*
     * A dedicated drop button. Touch has no Q key and no shift, so without this
     * there is no way to throw an item away at all — and "get rid of this" is a
     * routine action once the inventory starts filling up.
     *
     * A tap drops one; a long press drops the whole stack, matching the
     * long-press-means-more convention the slot grid already uses.
     */
    this._dropButton = this._createTapButton('DROP', 'Drop held item', () =>
      this._pulseAction(Action.DROP_ITEM)
    );
    this._attachLongPress(this._dropButton, () => this._pulseAction(Action.DROP_STACK));

    this._flyToggleButton = this._createTapButton('FLY', 'Toggle flying', () => {
      this._pulseAction(Action.TOGGLE_FLY);
    });

    /*
     * Explicit grid placement, so hiding a button never reshuffles the others.
     * Fly up/down deliberately occupy the *same* cells as jump/crouch, since only
     * one of each pair is ever visible: with grid auto-flow the buttons would
     * jump to new positions the moment flight was toggled, which is exactly the
     * kind of moving target that makes touch controls feel broken.
     */
    placeInGrid(this._jumpButton, 3, 1);
    placeInGrid(this._flyUpButton, 3, 1);
    placeInGrid(this._crouchButton, 2, 1);
    placeInGrid(this._flyDownButton, 2, 1);
    placeInGrid(this._breakButton, 3, 2);
    placeInGrid(this._placeButton, 2, 2);
    placeInGrid(this._sprintButton, 3, 3);

    this._buttonGrid = el('div', { className: 'touch-buttons' }, [
      this._jumpButton,
      this._flyUpButton,
      this._crouchButton,
      this._flyDownButton,
      this._placeButton,
      this._breakButton,
      this._sprintButton,
    ]);

    this._utilityBar = el('div', { className: 'touch-utility' }, [
      this._cameraButton,
      this._flyToggleButton,
      this._dropButton,
      this._pauseButton,
    ]);

    this._rotateNotice = el(
      'div',
      { className: 'rotate-notice', hidden: true },
      [
        el('div', { className: 'rotate-notice-inner' }, [
          el('span', { className: 'rotate-notice-icon', text: '⟲' }),
          el('p', {
            text: 'Rotate your device to landscape. The controls need the extra width, and the view is much better sideways.',
          }),
        ]),
      ]
    );

    this.element = el('div', { className: 'mobile-controls', hidden: true }, [
      this._lookArea,
      this._joystick,
      this._buttonGrid,
      this._utilityBar,
      this._rotateNotice,
    ]);

    root.appendChild(this.element);

    this._attachLookArea();
    this._attachJoystick();

    this._visible = false;
    this._enabled = false;
    // Establish the walking layout up front; `setFlyMode` only ever toggles it.
    this._applyFlyLayout(false);
    this.applySettings(settings.values);
  }

  /** True while touch controls are shown. */
  get visible() {
    return this._visible;
  }

  // -------------------------------------------------------------------- buttons

  /**
   * Creates a button that holds an action down while pressed.
   * @param {string} label
   * @param {string} action
   * @param {string} ariaLabel
   */
  _createHoldButton(label, action, ariaLabel) {
    const element = el('button', {
      className: 'touch-button',
      type: 'button',
      text: label,
      attrs: { 'aria-label': ariaLabel, tabindex: '-1' },
    });

    element.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this._buttonPointers.has(event.pointerId)) return;

      // Capture so a thumb that slides off still releases this button.
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        // Capture is best-effort; the global pointerup listener is the backstop.
      }

      this._buttonPointers.set(event.pointerId, { action, element, onRelease: null });
      element.classList.add('is-active');
      this._input.setTouchAction(action, true);
      this._vibrate();
    });

    const release = (event) => {
      const entry = this._buttonPointers.get(event.pointerId);
      if (!entry || entry.element !== element) return;
      event.preventDefault();
      this._buttonPointers.delete(event.pointerId);
      element.classList.remove('is-active');
      this._input.setTouchAction(action, false);
    };

    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', release);
    // `lostpointercapture` covers the case where capture is broken by the browser.
    element.addEventListener('lostpointercapture', release);

    return element;
  }

  /**
   * Creates a button that fires once per press.
   * @param {string} label
   * @param {string} ariaLabel
   * @param {() => void} onActivate
   */
  /**
   * Presses and immediately releases an edge-triggered action.
   *
   * Edge-triggered actions are read with `justPressed`, which only reports the
   * frame a press begins. A touch button therefore has to synthesise both halves;
   * holding the press would either be ignored or, worse, re-fire. Releasing on a
   * timer rather than in the same call gives the game loop a frame to observe it.
   *
   * @param {string} action
   */
  _pulseAction(action) {
    this._input.setTouchAction(action, true);
    setTimeout(() => this._input.setTouchAction(action, false), 16);
  }

  /**
   * Adds a long-press alternative to a tap button.
   *
   * The convention matches the slot grid: a long press does the "more" version of
   * whatever a tap does. Movement cancels it, so a scroll or a mis-slide does not
   * dump a whole stack on the floor.
   *
   * @param {HTMLElement} element
   * @param {() => void} onLongPress
   * @param {number} [holdMs]
   */
  _attachLongPress(element, onLongPress, holdMs = 420) {
    let timer = 0;
    let startX = 0;
    let startY = 0;
    let fired = false;

    const cancel = () => {
      if (timer) {
        clearTimeout(timer);
        timer = 0;
      }
    };

    element.addEventListener('pointerdown', (event) => {
      fired = false;
      startX = event.clientX;
      startY = event.clientY;
      timer = window.setTimeout(() => {
        fired = true;
        onLongPress();
        this._vibrate();
      }, holdMs);
    });
    element.addEventListener('pointermove', (event) => {
      if (!timer) return;
      if (Math.hypot(event.clientX - startX, event.clientY - startY) > 12) cancel();
    });
    // A long press must swallow the tap that follows it, or one gesture would drop
    // the stack *and* then drop one more.
    element.addEventListener(
      'click',
      (event) => {
        if (!fired) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        fired = false;
      },
      true
    );
    element.addEventListener('pointerup', cancel);
    element.addEventListener('pointercancel', cancel);
    element.addEventListener('pointerleave', cancel);
  }

  _createTapButton(label, ariaLabel, onActivate) {
    const element = el('button', {
      className: 'touch-button',
      type: 'button',
      text: label,
      attrs: { 'aria-label': ariaLabel, tabindex: '-1' },
    });

    element.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      element.classList.add('is-active');
      this._vibrate();
      onActivate();
    });

    const release = (event) => {
      event.preventDefault();
      element.classList.remove('is-active');
    };
    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', release);

    return element;
  }

  // ------------------------------------------------------------------ look area

  _attachLookArea() {
    this._lookArea.addEventListener('pointerdown', (event) => {
      if (!this._enabled) return;
      // Only the first pointer on the look area drives the camera; a second finger
      // landing here is ignored rather than fighting the first.
      if (this._lookPointerId !== null) return;
      event.preventDefault();

      this._lookPointerId = event.pointerId;
      this._lookStartX = event.clientX;
      this._lookStartY = event.clientY;
      this._lookLastX = event.clientX;
      this._lookLastY = event.clientY;
      this._lookMoved = false;
      this._holdActive = false;

      try {
        this._lookArea.setPointerCapture(event.pointerId);
      } catch {
        /* best effort */
      }

      // Hold-to-mine.
      this._holdTimer = setTimeout(() => {
        if (this._lookPointerId === null || this._lookMoved) return;
        this._holdActive = true;
        this._input.setTouchAction(Action.BREAK_BLOCK, true);
        this._vibrate();
      }, HOLD_TO_BREAK_MS);
    });

    this._lookArea.addEventListener('pointermove', (event) => {
      if (event.pointerId !== this._lookPointerId) return;
      event.preventDefault();

      const deltaX = event.clientX - this._lookLastX;
      const deltaY = event.clientY - this._lookLastY;
      this._lookLastX = event.clientX;
      this._lookLastY = event.clientY;

      if (!this._lookMoved) {
        const travelled = Math.hypot(
          event.clientX - this._lookStartX,
          event.clientY - this._lookStartY
        );
        if (travelled > DRAG_THRESHOLD) {
          this._lookMoved = true;
          // Committing to a drag cancels the tap-to-place intent. A hold that has
          // already started keeps going, which is how you mine while adjusting aim.
          this._cancelHoldTimer();
        }
      }

      if (this._lookMoved || this._holdActive) {
        this._input.addTouchLook(deltaX, deltaY);
      }
    });

    const finish = (event) => {
      if (event.pointerId !== this._lookPointerId) return;
      event.preventDefault();
      this._cancelHoldTimer();

      const wasHolding = this._holdActive;
      const wasTap = !this._lookMoved && !wasHolding;

      if (wasHolding) this._input.setTouchAction(Action.BREAK_BLOCK, false);
      this._holdActive = false;
      this._lookPointerId = null;

      // A quick, still tap places a block. `pointercancel` never counts as a tap:
      // the gesture was taken away, not completed.
      if (wasTap && event.type === 'pointerup') {
        this._input.setTouchAction(Action.PLACE_BLOCK, true);
        setTimeout(() => this._input.setTouchAction(Action.PLACE_BLOCK, false), 32);
        this._vibrate();
      }
    };

    this._lookArea.addEventListener('pointerup', finish);
    this._lookArea.addEventListener('pointercancel', finish);
    this._lookArea.addEventListener('lostpointercapture', finish);
  }

  _cancelHoldTimer() {
    if (this._holdTimer) {
      clearTimeout(this._holdTimer);
      this._holdTimer = 0;
    }
  }

  // ------------------------------------------------------------------- joystick

  _attachJoystick() {
    this._joystick.addEventListener('pointerdown', (event) => {
      if (!this._enabled) return;
      if (this._joystickPointerId !== null) return;
      event.preventDefault();
      event.stopPropagation();

      this._joystickPointerId = event.pointerId;
      const rect = this._joystick.getBoundingClientRect();
      this._joystickRadius = Math.max(1, rect.width * 0.5);

      if (this._settings.get('controls.joystickMode') === 'floating') {
        // Floating: the stick centres wherever the thumb landed, so the first
        // touch never yanks the player sideways.
        this._joystickCentreX = event.clientX;
        this._joystickCentreY = event.clientY;
      } else {
        this._joystickCentreX = rect.left + rect.width * 0.5;
        this._joystickCentreY = rect.top + rect.height * 0.5;
      }

      try {
        this._joystick.setPointerCapture(event.pointerId);
      } catch {
        /* best effort */
      }
      this._updateJoystick(event.clientX, event.clientY);
    });

    this._joystick.addEventListener('pointermove', (event) => {
      if (event.pointerId !== this._joystickPointerId) return;
      event.preventDefault();
      this._updateJoystick(event.clientX, event.clientY);
    });

    const release = (event) => {
      if (event.pointerId !== this._joystickPointerId) return;
      event.preventDefault();
      this._joystickPointerId = null;
      this._resetJoystick();
    };

    this._joystick.addEventListener('pointerup', release);
    this._joystick.addEventListener('pointercancel', release);
    this._joystick.addEventListener('lostpointercapture', release);
  }

  _updateJoystick(clientX, clientY) {
    const rawX = (clientX - this._joystickCentreX) / this._joystickRadius;
    // Screen Y grows downwards; forward is negative Y.
    const rawY = -(clientY - this._joystickCentreY) / this._joystickRadius;

    const magnitude = Math.hypot(rawX, rawY);
    const scale = magnitude > 1 ? 1 / magnitude : 1;
    const clampedX = rawX * scale;
    const clampedY = rawY * scale;

    applyDeadZone(clampedX, clampedY, JOYSTICK_DEAD_ZONE, this._stick);
    this._input.setVirtualMove(this._stick.x, this._stick.y);

    // The thumb follows the raw (clamped) position, not the dead-zoned value, so
    // it tracks the finger exactly even inside the dead zone.
    const offsetX = clampedX * 50;
    const offsetY = -clampedY * 50;
    this._joystickThumb.style.transform = `translate(calc(-50% + ${offsetX}%), calc(-50% + ${offsetY}%))`;
  }

  _resetJoystick() {
    this._stick.x = 0;
    this._stick.y = 0;
    this._input.setVirtualMove(0, 0);
    this._joystickThumb.style.transform = 'translate(-50%, -50%)';
  }

  // -------------------------------------------------------------------- lifecycle

  /**
   * Releases every held touch input.
   *
   * Called on pause, on losing visibility and on orientation change. This is what
   * guarantees the player is not still walking after the app was backgrounded
   * mid-stride.
   */
  releaseAll() {
    this._cancelHoldTimer();

    for (const [pointerId, entry] of this._buttonPointers) {
      entry.element.classList.remove('is-active');
      if (entry.action) this._input.setTouchAction(entry.action, false);
      void pointerId;
    }
    this._buttonPointers.clear();

    if (this._holdActive) {
      this._input.setTouchAction(Action.BREAK_BLOCK, false);
      this._holdActive = false;
    }
    this._lookPointerId = null;
    this._joystickPointerId = null;
    this._resetJoystick();
  }

  /**
   * Shows or hides the controls, and enables or disables input handling.
   * @param {boolean} visible
   */
  setVisible(visible) {
    if (this._visible === visible) return;
    this._visible = visible;
    this._enabled = visible;
    setVisible(this.element, visible);
    if (!visible) this.releaseAll();
    else this.checkOrientation();
  }

  /**
   * Switches the button layout between walking and flying.
   * @param {boolean} flying
   */
  setFlyMode(flying, mode = this._settings.get('gameplay.mode')) {
    const canFly = Boolean(this._settings.get('gameplay.allowFly')) && mode !== 'survival';
    setVisible(this._flyToggleButton, canFly);
    const effectiveFlying = canFly && Boolean(flying);
    if (this._flyMode !== effectiveFlying) this._applyFlyLayout(effectiveFlying);
    else this._flyToggleButton.classList.toggle('is-active', effectiveFlying);
  }

  /** Swaps the jump/crouch pair for the fly up/down pair. */
  _applyFlyLayout(flying) {
    this._flyMode = flying;
    // Fly up/down replace jump/crouch, which are meaningless while flying.
    setVisible(this._flyUpButton, flying);
    setVisible(this._flyDownButton, flying);
    setVisible(this._jumpButton, !flying);
    setVisible(this._crouchButton, !flying);
    this._flyToggleButton.classList.toggle('is-active', flying);
  }

  /**
   * Shows the rotate-to-landscape notice when appropriate.
   *
   * Only on genuinely narrow portrait viewports: a tablet in portrait has plenty
   * of room and should not be nagged.
   */
  checkOrientation() {
    if (!this._visible) {
      setVisible(this._rotateNotice, false);
      return;
    }
    const portrait = window.innerHeight > window.innerWidth;
    const narrow = Math.min(window.innerWidth, window.innerHeight) < 520;
    const shouldWarn = portrait && narrow && this._caps.mobile;
    setVisible(this._rotateNotice, shouldWarn);
    if (shouldWarn) this.releaseAll();
  }

  /**
   * Applies control settings: size, opacity, handedness and button scale.
   * @param {Object} settings The whole settings tree.
   */
  applySettings(settings) {
    const controls = settings.controls;
    this.element.style.setProperty('--joystick-scale', String(clamp(controls.joystickSize, 0.5, 2)));
    this.element.style.setProperty('--button-scale', String(clamp(controls.buttonScale, 0.5, 2)));
    this.element.style.setProperty('--touch-opacity', String(clamp(controls.joystickOpacity, 0.1, 1)));
    this.element.classList.toggle('is-left-handed', Boolean(controls.leftHanded));
    const canFly = Boolean(settings.gameplay.allowFly) && settings.gameplay.mode !== 'survival';
    setVisible(this._flyToggleButton, canFly);
    // DROP stays always, pause stays always
    if (!canFly) this._applyFlyLayout(false);
  }

  _vibrate() {
    if (!this._caps.vibrationSupported) return;
    if (!this._settings.get('controls.vibration')) return;
    try {
      navigator.vibrate(HAPTIC_MS);
    } catch {
      // Vibration is a nicety; a rejection is not worth reporting.
    }
  }

  /** Removes the element and releases every held input. */
  destroy() {
    this.releaseAll();
    this.element.remove();
  }
}

/**
 * Pins a touch button to a fixed cell of the control grid.
 * @param {HTMLElement} element
 * @param {number} column 1-based.
 * @param {number} row 1-based.
 */
function placeInGrid(element, column, row) {
  element.style.gridColumn = String(column);
  element.style.gridRow = String(row);
}

export default MobileControls;
