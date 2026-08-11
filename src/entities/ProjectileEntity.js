/**
 * Pooled arrow projectile with swept voxel/entity collision.
 *
 * The simulation is dependency-free and uses segment tests rather than checking
 * only the final point, so a fast arrow cannot tunnel through a one-block wall or
 * a narrow creature during a slow frame.
 */

import { DamageType } from '../player/DamageTypes.js';
import { StatusEffect } from './StatusEffects.js';

const DEFAULT_LIFETIME = 30;
const DEFAULT_GRAVITY = 9.8;
const BLOCK_SAMPLE_SPACING = 0.08;
const ARROW_KNOCKBACK = 2.8;

/** Segment/AABB intersection fraction in [0,1], or null on a miss. */
export function segmentAabbFraction(start, end, bounds) {
  let near = 0;
  let far = 1;
  for (const axis of ['x', 'y', 'z']) {
    const delta = end[axis] - start[axis];
    const low = bounds[`min${axis.toUpperCase()}`];
    const high = bounds[`max${axis.toUpperCase()}`];
    if (Math.abs(delta) < 1e-9) {
      if (start[axis] < low || start[axis] > high) return null;
      continue;
    }
    let a = (low - start[axis]) / delta;
    let b = (high - start[axis]) / delta;
    if (a > b) [a, b] = [b, a];
    near = Math.max(near, a);
    far = Math.min(far, b);
    if (near > far) return null;
  }
  return near >= 0 && near <= 1 ? near : null;
}

/** First blocked sample along a segment, as a fraction in [0,1]. */
export function firstBlockedFraction(world, start, end, spacing = BLOCK_SAMPLE_SPACING) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const distance = Math.hypot(dx, dy, dz);
  const steps = Math.max(1, Math.ceil(distance / Math.max(0.025, spacing)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = start.x + dx * t;
    const y = start.y + dy * t;
    const z = start.z + dz * t;
    if (world.isCollidable(Math.floor(x), Math.floor(y), Math.floor(z))) return t;
  }
  return null;
}

export class ProjectileEntity {
  constructor() {
    this.alive = false;
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.velocityX = 0;
    this.velocityY = 0;
    this.velocityZ = 0;
    this.age = 0;
    this.lifetime = DEFAULT_LIFETIME;
    this.damage = 2;
    this.gravity = DEFAULT_GRAVITY;
    this.ownerKind = 'player';
    this.owner = null;
    this.sourceX = 0;
    this.sourceY = 0;
    this.sourceZ = 0;
    this.justHit = null;
    this.statusEffect = null;
    this.visualKind = 'arrow';
  }

  spawn(x, y, z, direction, options = {}) {
    const length = Math.hypot(direction.x, direction.y, direction.z);
    if (!(length > 1e-6)) throw new Error('Projectile direction must be non-zero');
    const speed = Math.max(0.1, Number(options.speed) || 24);
    this.alive = true;
    this.x = x;
    this.y = y;
    this.z = z;
    this.velocityX = (direction.x / length) * speed;
    this.velocityY = (direction.y / length) * speed;
    this.velocityZ = (direction.z / length) * speed;
    this.age = 0;
    this.lifetime = Math.max(0.1, Number(options.lifetime) || DEFAULT_LIFETIME);
    this.damage = Math.max(0, Number(options.damage) || 2);
    this.gravity = Math.max(0, Number(options.gravity ?? DEFAULT_GRAVITY));
    this.ownerKind = options.ownerKind === 'mob' ? 'mob' : 'player';
    this.owner = options.owner ?? null;
    this.sourceX = Number(options.sourceX ?? x);
    this.sourceY = Number(options.sourceY ?? y);
    this.sourceZ = Number(options.sourceZ ?? z);
    this.justHit = null;
    this.statusEffect = options.statusEffect === StatusEffect.LEVITATION
      ? { id:StatusEffect.LEVITATION, duration:Math.max(1, Number(options.effectDuration) || 10), amplifier:Math.max(0, Number(options.effectAmplifier) || 0) }
      : null;
    this.visualKind = options.visualKind === 'dragon_fireball' ? 'dragon_fireball' : 'arrow';
    return this;
  }

  kill() {
    this.alive = false;
    this.owner = null;
    this.visualKind = 'arrow';
  }

  /**
   * Advances one projectile and resolves the nearest block/entity collision.
   * @param {number} dt
   * @param {Object} world
   * @param {{mobs?:Iterable<Object>,player?:Object|null}} context
   */
  update(dt, world, context = {}) {
    if (!this.alive) return;
    this.age += dt;
    if (this.age >= this.lifetime) {
      this.kill();
      return;
    }

    // Integrate gravity at the half step so trajectory remains stable across
    // frame rates without needing the full shared entity collision solver.
    this.velocityY -= this.gravity * dt;
    const start = { x: this.x, y: this.y, z: this.z };
    const end = {
      x: this.x + this.velocityX * dt,
      y: this.y + this.velocityY * dt,
      z: this.z + this.velocityZ * dt,
    };

    let bestFraction = firstBlockedFraction(world, start, end);
    let target = null;

    if (this.ownerKind === 'player') {
      for (const mob of context.mobs ?? []) {
        if (!mob || !mob.alive || mob.isDead || mob === this.owner) continue;
        const half = mob.halfSize ?? 0.3;
        const fraction = segmentAabbFraction(start, end, {
          minX: mob.x - half,
          maxX: mob.x + half,
          minY: mob.y,
          maxY: mob.y + (mob.height ?? 1.8),
          minZ: mob.z - half,
          maxZ: mob.z + half,
        });
        if (fraction === null || (bestFraction !== null && fraction >= bestFraction)) continue;
        bestFraction = fraction;
        target = mob;
      }
    } else {
      const player = context.player;
      if (player && !player.stats?.isDead && player !== this.owner) {
        const half = (player.width ?? 0.6) * 0.5;
        const fraction = segmentAabbFraction(start, end, {
          minX: player.position.x - half,
          maxX: player.position.x + half,
          minY: player.position.y,
          maxY: player.position.y + (player.height ?? 1.8),
          minZ: player.position.z - half,
          maxZ: player.position.z + half,
        });
        if (fraction !== null && (bestFraction === null || fraction < bestFraction)) {
          bestFraction = fraction;
          target = player;
        }
      }
    }

    if (bestFraction !== null) {
      this.x = start.x + (end.x - start.x) * bestFraction;
      this.y = start.y + (end.y - start.y) * bestFraction;
      this.z = start.z + (end.z - start.z) * bestFraction;
      if (target) this._hitTarget(target);
      else this.justHit = { type: 'block', x: this.x, y: this.y, z: this.z };
      this.kill();
      return;
    }

    this.x = end.x;
    this.y = end.y;
    this.z = end.z;
  }

  _hitTarget(target) {
    const source = { x: this.sourceX, y: this.sourceY, z: this.sourceZ };
    let applied = false;
    if (this.ownerKind === 'player') {
      applied = target.hurt?.(this.damage, {
        ...source,
        attacker: 'player',
        kind: 'projectile',
      }) !== false;
      if (applied && typeof target.velocityX === 'number') {
        const horizontal = Math.hypot(this.velocityX, this.velocityZ) || 1;
        target.velocityX += (this.velocityX / horizontal) * ARROW_KNOCKBACK;
        target.velocityZ += (this.velocityZ / horizontal) * ARROW_KNOCKBACK;
        target.velocityY = Math.max(target.velocityY ?? 0, 1.7);
        target.onGround = false;
      }
    } else {
      applied = target.hurt?.(this.damage, DamageType.PROJECTILE, source) !== false;
      if (applied && this.statusEffect && target.effects?.apply) {
        target.effects.apply(this.statusEffect.id, this.statusEffect.duration, this.statusEffect.amplifier);
      }
    }
    this.justHit = {
      type: 'entity',
      target,
      applied,
      damage: this.damage,
      ownerKind: this.ownerKind,
    };
  }
}

export default ProjectileEntity;
