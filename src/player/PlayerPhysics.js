/**
 * Player movement integration.
 *
 * Runs on the fixed simulation step, never on the render frame, so movement speed
 * is identical at 30, 60 and 144 FPS and a graphics setting can never change how
 * the player moves.
 *
 * ## Movement model
 *
 * Acceleration towards a desired velocity, plus friction, rather than directly
 * setting velocity. That gives the controller weight without feeling sluggish, and
 * it makes the three media — ground, air and water — differ by parameters rather
 * than by separate code paths:
 *
 *  - **ground**: high acceleration, high friction. Stops crisply.
 *  - **air**: low acceleration, almost no friction. Momentum is preserved, and you
 *    retain a little steering authority (air control) as in most voxel games.
 *  - **water**: moderate acceleration in all three axes, heavy friction, reduced
 *    gravity and a much lower terminal velocity. Buoyancy is modelled as a gentle
 *    upward push that is stronger the deeper you are, so you bob to the surface.
 *
 * Fly mode replaces gravity with direct vertical control and raises the speed
 * ceiling, but reuses the same collision resolution — flying through a wall would
 * otherwise be a whole separate class of bug.
 */

import { PHYSICS } from '../config/GameConfig.js';
import { clamp } from '../utils/MathUtils.js';
import { SLOT } from './Inventory.js';

/** Upward acceleration applied per block of submersion. */
const BUOYANCY = 5.2;
/** Maximum buoyant acceleration regardless of depth. */
const MAX_BUOYANCY = 14;
/** Seconds of coyote time: jumping is allowed briefly after leaving the ground. */
const COYOTE_TIME = 0.12;
/** Seconds a jump press is remembered while airborne. */
const JUMP_BUFFER = 0.14;

export class PlayerPhysics {
  /**
   * @param {import('../world/World.js').World} world
   * @param {import('./PlayerCollision.js').PlayerCollision} collision
   */
  constructor(world, collision) {
    this._world = world;
    this._collision = collision;
    this._delta = { x: 0, y: 0, z: 0 };
    this._coyoteTimer = 0;
    this._jumpBufferTimer = 0;
  }

  /**
   * Advances the player by one fixed step.
   *
   * @param {import('./Player.js').Player} player
   * @param {number} step Fixed timestep in seconds.
   */
  step(player, step) {
    // `LiquidContact` is the single source of truth and always sets both flags,
    // so the old `?? player.inWater` fallback masked the real failure mode: a
    // caller that never ran the contact test at all. Read the field directly and
    // let an undefined value be falsy rather than silently borrowing the other.
    const inLiquid = player.inLiquid === true;
    const flying = player.flying;
    const chest = player.inventory?.getSlot(SLOT.ARMOUR_START + 1);
    const hasElytra = chest?.definition.metadata.glider === true && !chest.isBroken;
    if (player.onGround || inLiquid || flying || !hasElytra) player.gliding = false;
    else if (player.intent.jump && player.velocity.y < 0) player.gliding = true;

    this._updateTimers(player, step);

    if (flying) this._applyFlight(player, step);
    else if (player.gliding) this._applyGliding(player, step, chest);
    else if (inLiquid) this._applySwimming(player, step);
    else if (player.onLadder) this._applyClimbing(player, step);
    else this._applyWalking(player, step);

    this._integrate(player, step);
  }

  _applyGliding(player, step, elytra) {
    const velocity = player.velocity;
    const look = player.lookDirection ?? { x:0, z:-1 };
    const speed = Math.max(7, Math.hypot(velocity.x, velocity.z));
    const desiredX = look.x * Math.min(18, speed + 2.2);
    const desiredZ = look.z * Math.min(18, speed + 2.2);
    this._accelerateHorizontal(velocity, desiredX, desiredZ, 5.5, .35, step);
    velocity.y = Math.max(-1.35, velocity.y - 2.2 * step);
    if (player.intent.crouch) velocity.y = Math.max(-3.2, velocity.y - 5 * step);

    player._glideWear = (player._glideWear ?? 0) + step;
    if (player._glideWear >= 1) {
      player._glideWear -= 1;
      if (elytra.applyDamage(1)) {
        player.inventory.setSlot(SLOT.ARMOUR_START + 1, null);
        player.gliding = false;
      }
    }
  }

  _updateTimers(player, step) {
    if (player.onGround) this._coyoteTimer = COYOTE_TIME;
    else this._coyoteTimer = Math.max(0, this._coyoteTimer - step);

    if (player.intent.jump) this._jumpBufferTimer = JUMP_BUFFER;
    else this._jumpBufferTimer = Math.max(0, this._jumpBufferTimer - step);
  }

  // ------------------------------------------------------------------ walking

  _applyWalking(player, step) {
    const intent = player.intent;
    const velocity = player.velocity;

    const speed = this._targetSpeed(player);
    const desiredX = intent.moveX * speed;
    const desiredZ = intent.moveZ * speed;

    const acceleration = player.onGround ? PHYSICS.groundAcceleration : PHYSICS.airAcceleration;
    const friction = player.onGround ? PHYSICS.groundFriction : PHYSICS.airFriction;

    this._accelerateHorizontal(velocity, desiredX, desiredZ, acceleration, friction, step);

    // Potion motion is resolved in the same fixed step as gravity. Levitation
    // wins while active; slow falling only changes the downward terminal speed.
    const levitation = player.effects?.levitationLevel ?? 0;
    if (levitation > 0) {
      const rise = 2.4 + levitation * 1.15;
      velocity.y += (rise - velocity.y) * Math.min(1, step * 4.5);
    } else {
      velocity.y -= PHYSICS.gravity * step;
      const terminal = player.effects?.slowFalling ? 1.25 : PHYSICS.terminalVelocity;
      if (velocity.y < -terminal) velocity.y = -terminal;
    }

    // Jump: allowed while grounded, and for a short window after leaving the
    // ground (coyote time). The buffered press means a jump entered a few frames
    // before landing still fires, which is what makes running jumps feel right.
    const wantsJump = this._jumpBufferTimer > 0;
    if (wantsJump && this._coyoteTimer > 0 && velocity.y <= 0.001) {
      velocity.y = PHYSICS.jumpVelocity + (player.effects?.jumpBoostLevel ?? 0) * .75;
      this._coyoteTimer = 0;
      this._jumpBufferTimer = 0;
      player.onGround = false;
      player.jumpedThisStep = true;
    }
  }

  // ----------------------------------------------------------------- swimming

  _applySwimming(player, step) {
    const intent = player.intent;
    const velocity = player.velocity;

    const speed = PHYSICS.swimSpeed * (intent.sprint ? 1.3 : 1) * player.movementSpeedMultiplier;
    const desiredX = intent.moveX * speed;
    const desiredZ = intent.moveZ * speed;

    this._accelerateHorizontal(
      velocity,
      desiredX,
      desiredZ,
      PHYSICS.groundAcceleration * 0.45,
      PHYSICS.waterFriction,
      step
    );

    // Reduced gravity plus buoyancy that grows with depth.
    velocity.y -= PHYSICS.waterGravity * step;
    const buoyancy = Math.min(MAX_BUOYANCY, player.submergedDepth * BUOYANCY);
    velocity.y += buoyancy * step;

    // Swimming up is a sustained push rather than an impulse.
    if (intent.jump) velocity.y += PHYSICS.swimUpVelocity * 2.2 * step;
    if (intent.crouch) velocity.y -= PHYSICS.swimUpVelocity * 1.8 * step;

    // Vertical friction, and a much lower terminal velocity than in air.
    velocity.y -= velocity.y * Math.min(1, PHYSICS.waterFriction * 0.5 * step);
    velocity.y = clamp(velocity.y, -PHYSICS.waterTerminalVelocity, PHYSICS.waterTerminalVelocity);

    // Jumping out of water when the head breaks the surface.
    if (intent.jump && player.onGround) {
      velocity.y = PHYSICS.jumpVelocity * 0.7;
      player.onGround = false;
    }
  }

  // ------------------------------------------------------------------ climbing

  _applyClimbing(player, step) {
    const intent = player.intent;
    const velocity = player.velocity;
    const speed = PHYSICS.walkSpeed * 0.72 * player.movementSpeedMultiplier;
    this._accelerateHorizontal(
      velocity,
      intent.moveX * speed,
      intent.moveZ * speed,
      PHYSICS.groundAcceleration * 0.7,
      PHYSICS.groundFriction,
      step
    );

    const moving = Math.hypot(intent.moveX, intent.moveZ) > 0.05;
    if (intent.jump) velocity.y = Math.max(velocity.y, PHYSICS.jumpVelocity * 0.72);
    else if (intent.crouch) velocity.y = -1.5;
    else if (moving) velocity.y = Math.max(velocity.y, 2.35);
    else velocity.y = Math.max(-0.15, Math.min(velocity.y, 0.35));

    player.fallDistance = 0;
  }

  // -------------------------------------------------------------------- flight

  _applyFlight(player, step) {
    const intent = player.intent;
    const velocity = player.velocity;

    const speed = PHYSICS.flySpeed * (intent.sprint ? PHYSICS.flySprintMultiplier : 1) * player.movementSpeedMultiplier;
    const desiredX = intent.moveX * speed;
    const desiredZ = intent.moveZ * speed;

    // Flight uses strong acceleration and strong friction in every axis, which
    // gives precise positioning for building.
    this._accelerateHorizontal(velocity, desiredX, desiredZ, speed * 9, 9, step);

    let desiredY = 0;
    if (intent.flyUp || intent.jump) desiredY += speed * 0.8;
    if (intent.flyDown || intent.crouch) desiredY -= speed * 0.8;

    const deltaY = desiredY - velocity.y;
    const accelerationY = Math.min(Math.abs(deltaY), speed * 9 * step);
    velocity.y += Math.sign(deltaY) * accelerationY;
    if (desiredY === 0) velocity.y -= velocity.y * Math.min(1, 9 * step);
  }

  // ---------------------------------------------------------------- integration

  /**
   * Applies acceleration towards a target horizontal velocity, then friction.
   *
   * Friction is applied to the component *not* being driven, which is what stops
   * a player from sliding sideways forever after a strafe while still preserving
   * momentum in the direction they are pushing.
   */
  _accelerateHorizontal(velocity, desiredX, desiredZ, acceleration, friction, step) {
    const deltaX = desiredX - velocity.x;
    const deltaZ = desiredZ - velocity.z;
    const deltaLength = Math.hypot(deltaX, deltaZ);

    if (deltaLength > 1e-5) {
      const maxChange = acceleration * step;
      const scale = Math.min(1, maxChange / deltaLength);
      velocity.x += deltaX * scale;
      velocity.z += deltaZ * scale;
    }

    // Friction only when there is no input, so holding a direction does not fight
    // the drag term.
    if (desiredX === 0 && desiredZ === 0) {
      const decay = Math.min(1, friction * step);
      velocity.x -= velocity.x * decay;
      velocity.z -= velocity.z * decay;
      if (Math.abs(velocity.x) < 0.005) velocity.x = 0;
      if (Math.abs(velocity.z) < 0.005) velocity.z = 0;
    }
  }

  /** Speed the player is trying to reach on foot. */
  _targetSpeed(player) {
    const intent = player.intent;
    let speed = PHYSICS.walkSpeed;
    if (intent.crouch && player.onGround) speed *= PHYSICS.crouchMultiplier;
    else if (player.blocking && player.onGround) speed *= 0.5;
    else if (intent.sprint) speed *= PHYSICS.sprintMultiplier;
    // Reduced control in the air, so a jump commits you to your trajectory.
    if (!player.onGround) speed *= 0.92;
    return speed * player.movementSpeedMultiplier;
  }

  /** Moves the player through the world and writes back the collision state. */
  _integrate(player, step) {
    const delta = this._delta;
    delta.x = player.velocity.x * step;
    delta.y = player.velocity.y * step;
    delta.z = player.velocity.z * step;

    const wasOnGround = player.onGround;

    const result = this._collision.move(player.position, player.width, player.height, delta, {
      allowStepUp: !player.flying && (player.autoStep || player.onGround),
      stepHeight: PHYSICS.stepHeight,
    });

    // Zero the velocity components that were blocked, otherwise the player keeps
    // pressing into the wall and friction never gets a chance to act.
    if (result.collidedX) player.velocity.x = 0;
    if (result.collidedZ) player.velocity.z = 0;
    if (result.collidedY) player.velocity.y = 0;

    player.onGround = result.onGround;
    player.hitCeiling = result.hitCeiling;
    player.steppedUp = result.steppedUp;

    // Landing: report the impact speed once, on the step the player touches down.
    if (!wasOnGround && result.onGround) {
      player.landingImpact = result.verticalImpact;
      player.justLanded = true;
    } else {
      player.justLanded = false;
    }
  }
}

export default PlayerPhysics;
