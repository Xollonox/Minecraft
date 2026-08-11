/**
 * Deterministic low-level mob decision helpers.
 *
 * This module deliberately owns no entity objects and imports no renderer. A
 * mob passes its current state in, receives a movement/attack intent out, and
 * remains responsible for physics. Keeping the decision layer pure makes the
 * awkward edge cases — losing a target, passive flee behaviour, ranged spacing
 * and blocked sight lines — testable without Three.js or a running game.
 */

import { WORLD_HEIGHT } from '../../config/GameConfig.js';
import { MobFamily } from '../MobTypes.js';

export const MobBrainState = Object.freeze({
  IDLE: 'idle',
  WANDER: 'wander',
  CHASE: 'chase',
  FLEE: 'flee',
});

/** Squared horizontal distance. */
export function horizontalDistanceSquared(a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  return dx * dx + dz * dz;
}

/**
 * Normalised horizontal direction from `from` to `to`.
 * @returns {{x:number,z:number,distance:number}}
 */
export function horizontalDirection(from, to) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 1e-8) return { x: 0, z: 0, distance: 0 };
  return { x: dx / distance, z: dz / distance, distance };
}

/**
 * Voxel DDA visibility test.
 *
 * The origin and target voxels are ignored: a mob's eye can sit inside a wide
 * hitbox, and the player's eye can graze the floor of their own voxel. Only
 * intervening opaque/collidable cells block sight.
 *
 * @param {{getBlock:(x:number,y:number,z:number)=>number,isOpaque?:(x:number,y:number,z:number)=>boolean,isCollidable?:(x:number,y:number,z:number)=>boolean}} world
 * @param {{x:number,y:number,z:number}} from
 * @param {{x:number,y:number,z:number}} to
 */
export function hasVoxelLineOfSight(world, from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance < 1e-8) return true;

  const dirX = dx / distance;
  const dirY = dy / distance;
  const dirZ = dz / distance;

  let voxelX = Math.floor(from.x);
  let voxelY = Math.floor(from.y);
  let voxelZ = Math.floor(from.z);
  const endX = Math.floor(to.x);
  const endY = Math.floor(to.y);
  const endZ = Math.floor(to.z);

  const stepX = dirX > 0 ? 1 : dirX < 0 ? -1 : 0;
  const stepY = dirY > 0 ? 1 : dirY < 0 ? -1 : 0;
  const stepZ = dirZ > 0 ? 1 : dirZ < 0 ? -1 : 0;
  const deltaX = stepX === 0 ? Infinity : Math.abs(1 / dirX);
  const deltaY = stepY === 0 ? Infinity : Math.abs(1 / dirY);
  const deltaZ = stepZ === 0 ? Infinity : Math.abs(1 / dirZ);

  let tMaxX = stepX === 0
    ? Infinity
    : stepX > 0
      ? (voxelX + 1 - from.x) * deltaX
      : (from.x - voxelX) * deltaX;
  let tMaxY = stepY === 0
    ? Infinity
    : stepY > 0
      ? (voxelY + 1 - from.y) * deltaY
      : (from.y - voxelY) * deltaY;
  let tMaxZ = stepZ === 0
    ? Infinity
    : stepZ > 0
      ? (voxelZ + 1 - from.z) * deltaZ
      : (from.z - voxelZ) * deltaZ;

  const isBlocking = (x, y, z) => {
    if (y < 0) return true;
    if (y >= WORLD_HEIGHT) return false;
    if (typeof world.isOpaque === 'function') return world.isOpaque(x, y, z);
    if (typeof world.isCollidable === 'function') return world.isCollidable(x, y, z);
    return world.getBlock(x, y, z) !== 0;
  };

  const maxSteps = Math.ceil(distance * 3) + 8;
  for (let step = 0; step < maxSteps; step++) {
    if (voxelX === endX && voxelY === endY && voxelZ === endZ) return true;

    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      voxelX += stepX;
      tMaxX += deltaX;
    } else if (tMaxY <= tMaxZ) {
      voxelY += stepY;
      tMaxY += deltaY;
    } else {
      voxelZ += stepZ;
      tMaxZ += deltaZ;
    }

    if (voxelX === endX && voxelY === endY && voxelZ === endZ) return true;
    if (isBlocking(voxelX, voxelY, voxelZ)) return false;
  }

  return true;
}

/**
 * Starts a new deterministic wander segment.
 *
 * A separate function rather than inline random calls means tests can assert
 * the exact ranges and a replay can supply its own random stream.
 */
export function chooseWander(random = Math.random) {
  const moving = random() >= 0.22;
  const angle = random() * Math.PI * 2;
  return {
    state: moving ? MobBrainState.WANDER : MobBrainState.IDLE,
    directionX: moving ? Math.sin(angle) : 0,
    directionZ: moving ? Math.cos(angle) : 0,
    duration: moving ? 1.8 + random() * 3.8 : 0.8 + random() * 2.2,
  };
}

/**
 * Resolves one AI intent.
 *
 * @param {Object} options
 * @param {import('../MobTypes.js').MobDefinition} options.definition
 * @param {{x:number,y:number,z:number,eyeHeight?:number}} options.mob
 * @param {{x:number,y:number,z:number,eyeHeight?:number,isDead?:boolean,isCreative?:boolean}|null} options.target
 * @param {string} options.currentState
 * @param {number} options.wanderDirectionX
 * @param {number} options.wanderDirectionZ
 * @param {number} options.wanderTime
 * @param {number} options.fleeTime
 * @param {{x:number,z:number}|null} options.fleeFrom
 * @param {boolean} options.targetVisible
 * @param {() => number} options.random
 */
export function decideMobIntent({
  definition,
  mob,
  target,
  currentState = MobBrainState.IDLE,
  wanderDirectionX = 0,
  wanderDirectionZ = 0,
  wanderTime = 0,
  fleeTime = 0,
  fleeFrom = null,
  targetVisible = false,
  random = Math.random,
}) {
  const noMove = {
    state: MobBrainState.IDLE,
    directionX: 0,
    directionZ: 0,
    speed: 0,
    wantsAttack: false,
    keepTarget: false,
    nextWanderTime: Math.max(0, wanderTime),
  };

  if (fleeTime > 0 && fleeFrom) {
    const away = horizontalDirection(fleeFrom, mob);
    return {
      state: MobBrainState.FLEE,
      directionX: away.x,
      directionZ: away.z,
      speed: definition.chaseSpeed,
      wantsAttack: false,
      keepTarget: false,
      nextWanderTime: 0,
    };
  }

  const canTarget = Boolean(
    target &&
      !target.isDead &&
      !target.isCreative &&
      definition.family === MobFamily.HOSTILE
  );

  if (canTarget) {
    const toward = horizontalDirection(mob, target);
    const withinDetect = toward.distance <= definition.detectRange;
    const withinLose = toward.distance <= definition.loseRange;
    const alreadyChasing = currentState === MobBrainState.CHASE;
    const keepTarget = alreadyChasing ? withinLose : withinDetect && targetVisible;

    if (keepTarget) {
      let directionX = toward.x;
      let directionZ = toward.z;
      let speed = definition.chaseSpeed;

      // Ranged mobs maintain a useful band instead of running directly into the
      // player. Too close: retreat. Comfortably in range: stop and aim.
      if (definition.ranged) {
        const comfortableMin = Math.max(3.5, definition.attackRange * 0.42);
        const comfortableMax = definition.attackRange * 0.78;
        if (toward.distance < comfortableMin) {
          directionX = -toward.x;
          directionZ = -toward.z;
        } else if (toward.distance <= comfortableMax && targetVisible) {
          directionX = 0;
          directionZ = 0;
          speed = 0;
        }
      } else if (toward.distance <= definition.attackRange * 0.82) {
        directionX = 0;
        directionZ = 0;
        speed = 0;
      }

      return {
        state: MobBrainState.CHASE,
        directionX,
        directionZ,
        speed,
        wantsAttack: targetVisible && toward.distance <= definition.attackRange,
        keepTarget: true,
        nextWanderTime: 0,
      };
    }
  }

  if (wanderTime > 0) {
    return {
      state: currentState === MobBrainState.IDLE ? MobBrainState.IDLE : MobBrainState.WANDER,
      directionX: wanderDirectionX,
      directionZ: wanderDirectionZ,
      speed: currentState === MobBrainState.IDLE ? 0 : definition.walkSpeed,
      wantsAttack: false,
      keepTarget: false,
      nextWanderTime: wanderTime,
    };
  }

  const wander = chooseWander(random);
  return {
    state: wander.state,
    directionX: wander.directionX,
    directionZ: wander.directionZ,
    speed: wander.state === MobBrainState.WANDER ? definition.walkSpeed : 0,
    wantsAttack: false,
    keepTarget: false,
    nextWanderTime: wander.duration,
  };
}

export default decideMobIntent;
