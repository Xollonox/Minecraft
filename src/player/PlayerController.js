/**
 * Translates abstract input actions into player intent.
 *
 * This is the *only* module that reads the input manager on the player's behalf.
 * `PlayerPhysics` sees nothing but `player.intent`, which means the same movement
 * code runs identically whether the player is on a keyboard, a phone or a gamepad,
 * and adding a new input device never touches physics.
 *
 * Toggle-versus-hold for sprint and crouch is resolved here too, so the rest of
 * the engine always sees a simple boolean.
 */

import { Action } from '../config/KeyBindings.js';
import { Events } from '../core/EventBus.js';

export class PlayerController {
  /**
   * @param {Object} options
   * @param {import('./Player.js').Player} options.player
   * @param {import('./CameraController.js').CameraController} options.camera
   * @param {import('../core/InputManager.js').InputManager} options.input
   * @param {import('../core/SettingsManager.js').SettingsManager} options.settings
   * @param {import('../core/EventBus.js').EventBus} options.bus
   */
  constructor({ player, camera, input, settings, bus }) {
    this._player = player;
    this._camera = camera;
    this._input = input;
    this._settings = settings;
    this._bus = bus;

    /** Latched state for toggle-style sprint and crouch. */
    this._sprintLatched = false;
    this._crouchLatched = false;

    /** Timestamp of the last fly toggle, for double-tap detection. */
    this._lastJumpPressTime = 0;

    this._moveDirection = { x: 0, z: 0 };
    this._look = { yaw: 0, pitch: 0 };
  }

  /**
   * Reads input and writes `player.intent`.
   *
   * Runs once per rendered frame, before the fixed physics steps, so look input
   * is applied at full frame rate (which is what makes aiming feel smooth) while
   * movement is consumed by the fixed step.
   *
   */
  update() {
    const input = this._input;
    const player = this._player;
    const intent = player.intent;
    const controls = this._settings.values.controls;

    // --- look ---
    const look = input.consumeLook(this._look);
    this._camera.addLook(look.yaw, look.pitch);

    // --- movement axis, rotated into world space by the camera ---
    const axis = input.moveAxis;
    this._camera.getMoveDirection(axis.x, axis.y, this._moveDirection);
    intent.moveX = this._moveDirection.x;
    intent.moveZ = this._moveDirection.z;

    // --- sprint ---
    if (controls.sprintToggle) {
      if (input.justPressed(Action.SPRINT)) this._sprintLatched = !this._sprintLatched;
      // Releasing all movement cancels a latched sprint, which is what stops the
      // player from sprinting away the moment they touch a key again.
      if (axis.x === 0 && axis.y === 0) this._sprintLatched = false;
      intent.sprint = this._sprintLatched;
    } else {
      intent.sprint = input.isDown(Action.SPRINT);
    }
    // Sprinting backwards looks wrong and is a common accidental input.
    if (axis.y < -0.2) intent.sprint = false;
    if (player.stats && !player.stats.canSprint) {
      this._sprintLatched = false;
      intent.sprint = false;
    }

    // --- crouch ---
    if (controls.crouchToggle) {
      if (input.justPressed(Action.CROUCH)) this._crouchLatched = !this._crouchLatched;
      intent.crouch = this._crouchLatched;
    } else {
      intent.crouch = input.isDown(Action.CROUCH);
    }

    // --- jump / vertical ---
    intent.jump = input.isDown(Action.JUMP);
    intent.flyUp = input.isDown(Action.FLY_UP);
    intent.flyDown = input.isDown(Action.FLY_DOWN);

    // Double-tap jump toggles flight, the standard voxel-game gesture. Available
    // in addition to the explicit toggle key so it works on a gamepad too.
    if (input.justPressed(Action.JUMP)) {
      const now = performance.now();
      if (
        now - this._lastJumpPressTime < 280 &&
        player.mode !== 'survival' &&
        this._settings.get('gameplay.allowFly')
      ) {
        player.toggleFlying();
        this._lastJumpPressTime = 0;
      } else {
        this._lastJumpPressTime = now;
      }
    }

    if (input.justPressed(Action.TOGGLE_FLY)) {
      const canEnable = player.mode !== 'survival' && this._settings.get('gameplay.allowFly');
      const wasFlying = player.flying;
      const enabled = wasFlying || canEnable ? player.toggleFlying() : false;
      this._bus.emit(Events.NOTIFY, {
        level: 'info',
        message: !wasFlying && !canEnable
          ? (player.mode === 'survival' ? 'Flight is unavailable in Survival' : 'Flight is disabled')
          : enabled ? 'Flying enabled' : 'Flying disabled',
        id: 'fly-toggle',
        duration: 1400,
      });
    }

    if (input.justPressed(Action.TOGGLE_PERSPECTIVE)) {
      const mode = this._camera.togglePerson();
      const labels = ['First person', 'Third behind', 'Third front'];
      this._bus.emit(Events.NOTIFY, {
        level: 'info',
        message: labels[mode] ?? 'Camera',
        id: 'camera-mode',
        duration: 1600,
      });
      this._bus.emit(Events.PLAY_SOUND, { name: 'ui.click', volume: 0.6 });
    }

    // --- hotbar ---
    const requestedSlot = input.consumeRequestedSlot();
    if (requestedSlot >= 0) player.inventory.selectSlot(requestedSlot);
    const scroll = input.consumeHotbarScroll();
    if (scroll !== 0) player.inventory.cycleSlot(scroll);
  }

  /** Clears latched toggles, e.g. when the input context changes. */
  reset() {
    this._sprintLatched = false;
    this._crouchLatched = false;
    this._lastJumpPressTime = 0;
    this._player.setBlocking?.(false);
    const intent = this._player.intent;
    intent.moveX = 0;
    intent.moveZ = 0;
    intent.jump = false;
    intent.sprint = false;
    intent.crouch = false;
    intent.flyUp = false;
    intent.flyDown = false;
  }
}

export default PlayerController;
