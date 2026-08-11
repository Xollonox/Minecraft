/**
 * Phase 4: the Wither.
 *
 * The Wither is the only mob in the game that cannot spawn on its own -- see the
 * `boss` flag in entities/MobTypes.js, which the wandering spawner skips. It has
 * to be built out of blocks, so most of this file is about recognising that
 * shape the instant the last skull lands, and doing it cheaply enough to run
 * inside a block-placement handler.
 *
 * The ritual is a T: three wither skeleton skulls in a row on top of four soul
 * sand blocks.
 *
 *     S S S      <- skulls
 *     . | .      <- soul sand arms and spine
 *       |
 *
 * Both horizontal orientations count, matching vanilla, and soul soil is a legal
 * substitute for soul sand.
 */

import { Block } from '../world/BlockTypes.js';
import { BossController } from '../automation/AutomationSystems.js';

/** Offsets of the three skulls, relative to the middle skull. */
const SKULL_OFFSETS = Object.freeze([-1, 0, 1]);

/** Soul-sand offsets relative to the middle skull, as [across, down]. */
const BASE_OFFSETS = Object.freeze([
  [0, -1], [-1, -1], [1, -1], [0, -2],
]);

/** The two orientations a Wither can be built along. */
const AXES = Object.freeze([
  Object.freeze({ name: 'x', dx: 1, dz: 0 }),
  Object.freeze({ name: 'z', dx: 0, dz: 1 }),
]);

/** Soul sand and soul soil are interchangeable for the ritual. */
export function isSoulBlock(blockId) {
  return blockId === Block.SOUL_SAND || blockId === Block.SOUL_SOIL;
}

/**
 * The Wither's three heads take damage independently, and it gains an armour
 * phase at half health during which explosions cannot hurt it.
 */
export const WITHER_PHASES = Object.freeze([
  Object.freeze({ id: 'descent', threshold: 1, explosionImmune: false, flying: true }),
  Object.freeze({ id: 'armoured', threshold: 0.5, explosionImmune: true, flying: false }),
  Object.freeze({ id: 'enraged', threshold: 0.25, explosionImmune: true, flying: false }),
]);

/**
 * Checks whether a skull placed at this position completes a Wither.
 *
 * The placed skull may be any of the three, so every candidate middle position
 * along both axes is tried. Returns a summon plan describing which blocks to
 * consume, or `null` when the shape is incomplete.
 *
 * @param {{getBlock: (x: number, y: number, z: number) => number}} world
 * @returns {{origin: {x: number, y: number, z: number}, axis: string,
 *   skulls: Array<[number, number, number]>,
 *   base: Array<[number, number, number]>} | null}
 */
export function detectWitherSummon(world, x, y, z) {
  if (!world || typeof world.getBlock !== 'function') return null;
  if (world.getBlock(x, y, z) !== Block.WITHER_SKELETON_SKULL) return null;

  for (const axis of AXES) {
    // The placed skull sits at one of three slots, so shift the assumed middle.
    for (const slot of SKULL_OFFSETS) {
      const mx = x - slot * axis.dx;
      const mz = z - slot * axis.dz;

      const skulls = [];
      let ok = true;
      for (const offset of SKULL_OFFSETS) {
        const sx = mx + offset * axis.dx;
        const sz = mz + offset * axis.dz;
        if (world.getBlock(sx, y, sz) !== Block.WITHER_SKELETON_SKULL) { ok = false; break; }
        skulls.push([sx, y, sz]);
      }
      if (!ok) continue;

      const base = [];
      for (const [across, down] of BASE_OFFSETS) {
        const bx = mx + across * axis.dx;
        const bz = mz + across * axis.dz;
        if (!isSoulBlock(world.getBlock(bx, y + down, bz))) { ok = false; break; }
        base.push([bx, y + down, bz]);
      }
      if (!ok) continue;

      return { origin: { x: mx, y, z: mz }, axis: axis.name, skulls, base };
    }
  }
  return null;
}

/**
 * Clears the ritual blocks. Called once the summon is accepted, so the player
 * does not get their skulls back and the Wither is not rebuilt from leftovers.
 */
export function consumeSummonBlocks(world, plan) {
  if (!world || typeof world.setBlock !== 'function' || !plan) return 0;
  let cleared = 0;
  for (const [bx, by, bz] of [...plan.skulls, ...plan.base]) {
    // `cause` marks these as world-driven so the edit is not credited to a
    // player action, and no drops are produced.
    if (world.setBlock(bx, by, bz, Block.AIR, { cause: 'wither_summon' })) cleared += 1;
  }
  return cleared;
}

/** Where the Wither's body should appear for a given plan. */
export function witherSpawnPoint(plan) {
  if (!plan) return null;
  return { x: plan.origin.x + 0.5, y: plan.origin.y - 1, z: plan.origin.z + 0.5 };
}

/**
 * The Wither's two projectiles.
 *
 * The centre head throws black skulls, which are the block-breaking artillery
 * that makes the fight destroy its own arena. The side heads throw blue skulls:
 * cheaper, faster and homing, so the player cannot simply strafe forever. Both
 * apply the wither effect, which is what stops health regeneration and gives the
 * fight its pressure.
 */
export const SKULL_TYPES = Object.freeze({
  BLACK: Object.freeze({
    id: 'black', damage: 8, speed: 14, blastRadius: 1,
    breaksBlocks: true, homing: false, withers: true,
  }),
  BLUE: Object.freeze({
    id: 'blue', damage: 5, speed: 20, blastRadius: 0,
    breaksBlocks: false, homing: true, withers: true,
  }),
});

/** Seconds between skulls, and the odds a skull is blue, per phase. */
const SKULL_RATE = Object.freeze({
  descent: Object.freeze({ cooldown: 3, blueChance: 0 }),
  armoured: Object.freeze({ cooldown: 2, blueChance: 0.25 }),
  enraged: Object.freeze({ cooldown: 1, blueChance: 0.4 }),
});

/**
 * A live Wither fight: health, the three heads, and the phase the fight is in.
 */
export class WitherFight {
  constructor({ maxHealth = 300, spawnPoint = null } = {}) {
    this.controller = new BossController({ maxHealth, phases: WITHER_PHASES });
    // The centre head is the real target; the side heads soak less damage.
    this.controller.addPart('body', 1);
    this.controller.addPart('head_centre', 1);
    this.controller.addPart('head_left', 0.5);
    this.controller.addPart('head_right', 0.5);
    this.spawnPoint = spawnPoint;
    this.invulnerableFor = 10;
    // The first skull comes after the rise, not during it.
    this.skullCooldown = 2;
  }

  /** The spawn animation makes the Wither untouchable for ten seconds. */
  tick(step) {
    const delta = Math.max(0, Number(step) || 0);
    this.invulnerableFor = Math.max(0, this.invulnerableFor - delta);
    // The weapon cooldown only runs once the Wither is actually fighting.
    if (this.invulnerableFor === 0) this.skullCooldown = Math.max(0, this.skullCooldown - delta);
    return this.invulnerableFor === 0;
  }

  get phaseData() {
    const id = this.controller.bar.phase;
    return WITHER_PHASES.find((p) => p.id === id) ?? WITHER_PHASES[0];
  }

  /**
   * Damages the Wither. Explosions are ignored once it is armoured, which is
   * what stops a player from cheesing the whole fight with TNT.
   */
  damage(amount, { part = 'body', source = 'melee' } = {}) {
    if (this.invulnerableFor > 0) return 0;
    if (source === 'explosion' && this.phaseData.explosionImmune) return 0;
    return this.controller.damage(amount, part);
  }

  get bar() { return this.controller.bar; }

  /**
   * Fires a skull if the weapon is off cooldown.
   *
   * Returns the projectile to spawn, or null when the Wither cannot shoot --
   * during its rise, between shots, or once it is dead. Keeping the decision in
   * here rather than in the renderer means the fight's difficulty curve is
   * testable without a scene.
   *
   * @param {() => number} [random]
   * @returns {{type:string, damage:number, speed:number, blastRadius:number,
   *   breaksBlocks:boolean, homing:boolean, withers:boolean, head:string}|null}
   */
  fireSkull(random = Math.random) {
    if (this.invulnerableFor > 0) return null;
    if (this.skullCooldown > 0) return null;
    if (this.controller.bar.dead) return null;

    const rate = SKULL_RATE[this.controller.bar.phase] ?? SKULL_RATE.descent;
    this.skullCooldown = rate.cooldown;

    const blue = rate.blueChance > 0 && random() < rate.blueChance;
    const template = blue ? SKULL_TYPES.BLUE : SKULL_TYPES.BLACK;
    return {
      ...template,
      type: template.id,
      // Blue skulls come from whichever side head; black from the centre.
      head: blue ? (random() < 0.5 ? 'head_left' : 'head_right') : 'head_centre',
    };
  }

  /** The Nether Star is the whole point of the fight. */
  get rewards() {
    return this.controller.bar.dead ? [{ item: 'nether_star', count: 1 }] : [];
  }
}

/**
 * Convenience entry point: given a freshly placed skull, either start a fight or
 * report that nothing happened.
 */
export function trySummonWither(world, x, y, z) {
  const plan = detectWitherSummon(world, x, y, z);
  if (!plan) return null;
  consumeSummonBlocks(world, plan);
  return new WitherFight({ spawnPoint: witherSpawnPoint(plan) });
}

export default WitherFight;
