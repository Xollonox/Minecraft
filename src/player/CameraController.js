/**
 * Player camera.
 *
 * Owns yaw/pitch, the eye transform and the "feel" effects: view bob, landing dip
 * and the sprint field-of-view shift.
 *
 * ## Deliberately unsmoothed rotation
 *
 * Look input is applied directly with no interpolation. Camera smoothing feels
 * responsive in a trailer and terrible to actually play — it decouples the
 * crosshair from the mouse and makes precise block placement guesswork. The only
 * smoothing here is on *positional* effects (bob, dip, FOV), never on rotation.
 *
 * ## Pitch clamping
 *
 * Pitch is hard-clamped just short of straight up and straight down. Allowing
 * exactly ±90° makes the yaw axis degenerate and produces a visible roll snap when
 * the player looks at their feet.
 */

import * as THREE from 'three';

import { PHYSICS } from '../config/GameConfig.js';
import { clamp, damp, lerp } from '../utils/MathUtils.js';
import { cameraClipFraction } from './ThirdPersonCameraMath.js';

/** Maximum pitch, just under a right angle. */
const MAX_PITCH = Math.PI / 2 - 0.0015;
/** Extra field of view while sprinting, in degrees. */
const SPRINT_FOV_BOOST = 7;
/** Field of view multiplier while underwater. */
const UNDERWATER_FOV_SCALE = 0.94;
/** Bob amplitude in blocks at full walking speed. */
const BOB_AMPLITUDE = 0.055;
/** Bob cycles per block travelled. */
const BOB_FREQUENCY = 0.9;
/** How far the camera dips on a hard landing, in blocks. */
const LANDING_DIP = 0.18;
/** Radius used when probing camera collision around the lens. */
const CAMERA_COLLISION_RADIUS = 0.13;
const CAMERA_COLLISION_PROBES = Object.freeze([
  [0, 0, 0],
  [CAMERA_COLLISION_RADIUS, 0, 0],
  [-CAMERA_COLLISION_RADIUS, 0, 0],
  [0, CAMERA_COLLISION_RADIUS, 0],
  [0, -CAMERA_COLLISION_RADIUS, 0],
  [0, 0, CAMERA_COLLISION_RADIUS],
  [0, 0, -CAMERA_COLLISION_RADIUS],
]);

export class CameraController {
  /**
   * @param {Object} options
   * @param {THREE.PerspectiveCamera} options.camera
   * @param {import('../core/SettingsManager.js').SettingsManager} options.settings
   */
  constructor({ camera, settings }) {
    this.camera = camera;
    this._settings = settings;

    /** Rotation about Y. 0 looks towards -Z. */
    this.yaw = 0;
    /** Rotation about the local X axis. Positive looks up. */
    this.pitch = 0;

    /** 0=first, 1=third behind, 2=third front */
    this.personMode = 0;
    this.thirdPersonDistance = 4;

    /** Distance travelled on foot, drives the bob phase. */
    this._bobDistance = 0;
    this._bobOffset = 0;
    this._bobLateral = 0;
    this._landingDip = 0;
    this._currentFov = settings.get('display.fov');
    this._targetFov = this._currentFov;

    /** World-space forward vector, recomputed each frame. */
    this.forward = new THREE.Vector3(0, 0, -1);
    /** Horizontal forward, used for movement. */
    this.forwardFlat = new THREE.Vector3(0, 0, -1);
    /** Horizontal right, used for strafing. */
    this.rightFlat = new THREE.Vector3(1, 0, 0);
    /** Eye position in world space. */
    this.eye = new THREE.Vector3();

    this._scratchEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    this.applySettings(settings.values);
  }

  /**
   * Applies a look delta in radians.
   * @param {number} yawDelta
   * @param {number} pitchDelta
   */
  addLook(yawDelta, pitchDelta) {
    if (yawDelta === 0 && pitchDelta === 0) return;
    this.yaw += yawDelta;
    // Keep yaw in a sane range so the float never loses precision after hours of
    // spinning in one direction.
    if (this.yaw > Math.PI * 4 || this.yaw < -Math.PI * 4) {
      this.yaw = this.yaw % (Math.PI * 2);
    }
    this.pitch = clamp(this.pitch + pitchDelta, -MAX_PITCH, MAX_PITCH);
  }

  /** Sets the rotation directly, e.g. when loading a save. */
  setRotation(yaw, pitch) {
    this.yaw = Number.isFinite(yaw) ? yaw : 0;
    this.pitch = clamp(Number.isFinite(pitch) ? pitch : 0, -MAX_PITCH, MAX_PITCH);
    this._updateBasis();
  }

  /** Cycle 0->1->2->0 */
  togglePerson() {
    this.personMode = (this.personMode + 1) % 3;
    return this.personMode;
  }

  /** 0/1/2 directly */
  setPersonMode(mode) {
    this.personMode = clamp(Math.floor(mode), 0, 2);
  }

  /**
   * Updates the camera transform.
   *
   * @param {number} dt
   * @param {import('./Player.js').Player} player
   * @param {boolean} underwater
   */
  update(dt, player, underwater) {
    this._updateBasis();

    const controls = this._settings.values.controls;
    const display = this._settings.values.display;

    // --- view bob ---
    const horizontalSpeed = Math.hypot(player.velocity.x, player.velocity.z);
    if (controls.cameraBob && player.onGround && !player.flying) {
      this._bobDistance += horizontalSpeed * dt;
      const phase = this._bobDistance * Math.PI * 2 * BOB_FREQUENCY;
      // Amplitude scales with speed so walking is subtle and sprinting is not.
      const amplitude = BOB_AMPLITUDE * clamp(horizontalSpeed / PHYSICS.walkSpeed, 0, 1.6);
      this._bobOffset = Math.abs(Math.sin(phase)) * amplitude;
      this._bobLateral = Math.sin(phase * 0.5) * amplitude * 0.6;
    } else {
      // Ease the bob out rather than snapping it to zero on take-off.
      this._bobOffset = damp(this._bobOffset, 0, 0.0001, dt);
      this._bobLateral = damp(this._bobLateral, 0, 0.0001, dt);
    }

    // --- landing dip ---
    if (player.justLanded && controls.cameraBob) {
      // Scale with impact speed, capped so a long fall does not slam the camera
      // through the floor.
      const strength = clamp(player.landingImpact / PHYSICS.terminalVelocity, 0, 1);
      this._landingDip = Math.max(this._landingDip, LANDING_DIP * strength);
    }
    this._landingDip = damp(this._landingDip, 0, 0.000002, dt);

    // --- field of view ---
    let targetFov = display.fov;
    if (controls.sprintFov && player.intent.sprint && horizontalSpeed > 0.5) {
      targetFov += SPRINT_FOV_BOOST;
    }
    if (underwater) targetFov *= UNDERWATER_FOV_SCALE;
    this._targetFov = targetFov;
    this._currentFov = damp(this._currentFov, this._targetFov, 0.0001, dt);
    if (Math.abs(this._currentFov - this.camera.fov) > 0.01) {
      this.camera.fov = this._currentFov;
      this.camera.updateProjectionMatrix();
    }

    // --- transform ---
    const eyeHeight = player.eyeHeight;
    this.eye.set(
      player.position.x + this.rightFlat.x * this._bobLateral,
      player.position.y + eyeHeight - this._bobOffset - this._landingDip,
      player.position.z + this.rightFlat.z * this._bobLateral
    );

    const camPos = this.eye.clone();
    if (this.personMode !== 0 && player) {
      const signedDistance = this.personMode === 1
        ? this.thirdPersonDistance
        : -this.thirdPersonDistance;

      // Desired camera point: behind for mode 1, in front for mode 2. The small
      // lift keeps the head comfortably below the centre of the frame.
      camPos.x -= this.forward.x * signedDistance;
      camPos.y -= this.forward.y * signedDistance;
      camPos.z -= this.forward.z * signedDistance;
      camPos.y += 0.4;

      // Clip the full eye-to-camera segment against collision geometry. The old
      // implementation checked `player.world` even though Player exposed only
      // `_world`, so this branch never ran and the camera freely entered walls.
      const world = player.world;
      if (world) {
        const fraction = cameraClipFraction(this.eye, camPos, (x, y, z) => {
          for (const [ox, oy, oz] of CAMERA_COLLISION_PROBES) {
            if (world.isCollidable(
              Math.floor(x + ox),
              Math.floor(y + oy),
              Math.floor(z + oz)
            )) return true;
          }
          return false;
        });
        camPos.lerpVectors(this.eye, camPos, fraction);
      }
    }

    this.camera.position.copy(camPos);
    if (this.personMode === 2) {
      // Front view is a reverse-facing camera. Looking at the eye directly also
      // fixes vertical aiming: adding PI to yaw alone left pitch uninverted.
      if (this.camera.position.distanceToSquared(this.eye) > 1e-8) {
        this.camera.lookAt(this.eye);
      } else {
        this._scratchEuler.set(-this.pitch, this.yaw + Math.PI, 0, 'YXZ');
        this.camera.quaternion.setFromEuler(this._scratchEuler);
      }
    } else {
      this._scratchEuler.set(this.pitch, this.yaw, 0, 'YXZ');
      this.camera.quaternion.setFromEuler(this._scratchEuler);
    }
  }

  /** Recomputes the cached basis vectors from yaw and pitch. */
  _updateBasis() {
    const cosPitch = Math.cos(this.pitch);
    this.forward.set(
      -Math.sin(this.yaw) * cosPitch,
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * cosPitch
    );
    this.forwardFlat.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    // Right is forward rotated -90° about Y.
    this.rightFlat.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  /**
   * Converts a 2D movement axis into world-space movement directions.
   *
   * @param {number} axisX Strafe, -1..1.
   * @param {number} axisY Forward, -1..1.
   * @param {{x: number, z: number}} out
   */
  getMoveDirection(axisX, axisY, out) {
    out.x = this.forwardFlat.x * axisY + this.rightFlat.x * axisX;
    out.z = this.forwardFlat.z * axisY + this.rightFlat.z * axisX;
    const length = Math.hypot(out.x, out.z);
    if (length > 1) {
      out.x /= length;
      out.z /= length;
    }
    return out;
  }

  /**
   * Applies display settings.
   * @param {Object} settings The whole settings tree.
   */
  applySettings(settings) {
    const fov = clamp(settings.display.fov, 50, 120);
    this._targetFov = fov;
    // Snap rather than animate: a settings change should show its result at once.
    this._currentFov = fov;
    this.camera.fov = fov;
    this.camera.near = 0.08;
    this.camera.far = Math.max(
      220,
      clamp(settings.graphics.renderDistance, 2, 24) * 16 * 2.2
    );
    this.camera.updateProjectionMatrix();
  }

  /** Clears transient effects, e.g. after a teleport. */
  reset() {
    this._bobDistance = 0;
    this._bobOffset = 0;
    this._bobLateral = 0;
    this._landingDip = 0;
  }

  /** Interpolation helper exposed for tests and tooling. */
  static blend(a, b, t) {
    return lerp(a, b, t);
  }
}

export default CameraController;
