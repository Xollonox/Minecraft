/**
 * Live, world-scoped owner for every Phase 5 End system.
 *
 * Mirrors `Phase4Runtime` exactly: the systems it owns (`Stronghold`,
 * `EnderDragon`) are pure and independently testable, and this class is the one
 * place that holds their live state, binds them to a world, and decides what
 * survives a save.
 *
 * ## What persists and what does not
 *
 * Filled portal frames and lit portals **do** persist -- they are world edits the
 * player paid twelve ender pearls for, and losing them on reload would be a
 * disaster. The in-progress dragon fight also persists: health, crystal state,
 * flight state and the death sequence resume on reload. The renderer rebuilds
 * its articulated body from that pure runtime state when the world starts.
 */

import { Block } from '../world/BlockTypes.js';
import { PORTAL_FRAME_OFFSETS, StrongholdMarker, nearestPortalRoom } from '../world/Stronghold.js';
import { END_ISLAND_SURFACE_Y, endCrystalPositions, endPillars } from '../world/EndGenerator.js';
import { EnderDragonFight } from './EnderDragon.js';
import { nearestEndCity } from '../world/EndCity.js';

/** How many frames a complete End portal needs. */
export const PORTAL_FRAME_COUNT = PORTAL_FRAME_OFFSETS.length;

/** Squared distance within which a hit counts as hitting an end crystal. */
const CRYSTAL_HIT_RANGE_SQ = 9;
const RESPAWN_CRYSTAL_OFFSETS = Object.freeze([[4,0],[-4,0],[0,4],[0,-4]]);
const DRAGON_DEATH_SECONDS = 4;
const DRAGON_PROTECTED_BLOCKS = new Set([
  Block.AIR, Block.BEDROCK, Block.OBSIDIAN, Block.END_PORTAL,
  Block.END_PORTAL_FRAME, Block.END_GATEWAY, Block.DRAGON_EGG,
]);

function cellKey(x, y, z) {
  return `${x | 0},${y | 0},${z | 0}`;
}

export class Phase5Runtime {
  constructor({ world = null, player = null, seed = 0 } = {}) {
    this.world = world;
    this.player = player;
    this.seed = Number(seed) >>> 0;
    /** Frames that hold an eye, keyed by cell. */
    this.filledFrames = new Set();
    /** Ring centres whose portal has been lit, keyed by cell. */
    this.litPortals = new Set();
    /** @type {EnderDragonFight|null} */
    this.fight = null;
    this.dragonsDefeated = 0;
    this.exitPortalOpen = false;
    this._exitPortalPending = false;
    this.pendingRewards = [];
    this.respawnCrystals = new Set();
    this.dragonResummons = 0;
    this.endCompleted = false;
    this.creditsSeen = false;
    this.lastEyeThrow = null;
    this.activeBreathCloud = null;
    this.spawnedEndCities = new Set();
    this._spawnerCooldown = 3;
    this._bodyDamageCooldown = 0;
    this._blockBreakCooldown = 0;
    this.arenaRegeneratedBlocks = 0;
    this._attackables = [];
    this._refreshAttackables();
  }

  /* ---------------------------------------------------------------- portal */

  /**
   * Puts an Eye of Ender into a portal frame.
   *
   * @returns {{placed:boolean, filled:number, total:number, lit:boolean}|null}
   *   Null when the target is not an empty frame, so the caller knows not to
   *   consume the item.
   */
  placeEyeOfEnder(x, y, z) {
    if (!this.world) return null;
    if (this.world.getBlock(x, y, z) !== Block.END_PORTAL_FRAME) return null;
    const key = cellKey(x, y, z);
    if (this.filledFrames.has(key)) return null;

    const centre = this._ringCentreFor(x, y, z);
    if (centre) this._ensureGeneratedFrameEyes(centre);
    if (this.filledFrames.has(key)) return null;
    this.filledFrames.add(key);
    const filled = centre ? this._filledCount(centre) : 1;
    let lit = false;
    if (centre && filled === PORTAL_FRAME_COUNT) lit = this._lightPortal(centre);

    return { placed: true, filled, total: PORTAL_FRAME_COUNT, lit };
  }

  /** Generated strongholds start with 0..2 deterministic eyes already fitted. */
  _ensureGeneratedFrameEyes(centre) {
    const nearest = this.locatePortalRoom(centre.x, centre.z);
    if (!nearest || Math.abs(nearest.x - centre.x) > 1 || Math.abs(nearest.z - centre.z) > 1) return 0;
    const count = ((this.seed ^ (centre.x * 31) ^ (centre.z * 131)) >>> 0) % 3;
    for (let index = 0; index < count; index++) {
      const [dx, dz] = PORTAL_FRAME_OFFSETS[index];
      this.filledFrames.add(cellKey(centre.x + dx, centre.y, centre.z + dz));
    }
    return count;
  }

  /**
   * Throws an eye toward the real nearest stronghold. The returned Bezier-like
   * samples let the renderer/particles draw the arc without owning wayfinding.
   */
  throwEyeOfEnder(x, y, z) {
    const target = this.locatePortalRoom(x, z);
    if (!target) return null;
    const dx = target.x - x;
    const dz = target.z - z;
    const distance = Math.hypot(dx, dz) || 1;
    const travel = Math.min(18, distance);
    const end = { x: x + dx / distance * travel, y: y + 8, z: z + dz / distance * travel };
    const shatters = (((Math.floor(x) * 73856093) ^ (Math.floor(z) * 19349663) ^ this.seed) >>> 0) % 5 === 0;
    this.lastEyeThrow = {
      start: { x, y, z }, end, target: { ...target }, shatters,
      samples: Array.from({ length: 13 }, (_, index) => {
        const t = index / 12;
        return {
          x: x + (end.x - x) * t,
          y: y + (end.y - y) * t + Math.sin(Math.PI * t) * 3,
          z: z + (end.z - z) * t,
        };
      }),
    };
    return this.lastEyeThrow;
  }

  /** True when this frame cell already holds an eye. */
  frameIsFilled(x, y, z) {
    return this.filledFrames.has(cellKey(x, y, z));
  }

  /**
   * Finds the ring centre a given frame belongs to.
   *
   * A frame sits at a known offset from its centre, so every offset is tried as
   * a hypothesis and confirmed by checking that all twelve ring cells really are
   * frames. That avoids trusting generator coordinates, which means a
   * player-built portal works exactly like a generated one.
   */
  _ringCentreFor(x, y, z) {
    for (const [dx, dz] of PORTAL_FRAME_OFFSETS) {
      const cx = x - dx;
      const cz = z - dz;
      let complete = true;
      for (const [ox, oz] of PORTAL_FRAME_OFFSETS) {
        if (this.world.getBlock(cx + ox, y, cz + oz) !== Block.END_PORTAL_FRAME) {
          complete = false;
          break;
        }
      }
      if (complete) return { x: cx, y, z: cz };
    }
    return null;
  }

  /** How many of one ring's twelve frames hold an eye. */
  _filledCount(centre) {
    let filled = 0;
    for (const [dx, dz] of PORTAL_FRAME_OFFSETS) {
      if (this.filledFrames.has(cellKey(centre.x + dx, centre.y, centre.z + dz))) filled++;
    }
    return filled;
  }

  /** Writes the 3x3 of portal blocks inside a completed ring. */
  _lightPortal(centre) {
    const key = cellKey(centre.x, centre.y, centre.z);
    if (this.litPortals.has(key)) return false;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        this.world.setBlock(centre.x + dx, centre.y, centre.z + dz, Block.END_PORTAL);
      }
    }
    this.litPortals.add(key);
    return true;
  }

  /** How many portals this world has lit. */
  get litPortalCount() { return this.litPortals.size; }

  /**
   * Where the nearest stronghold portal room is, for an Eye of Ender throw.
   * @returns {{type:string, x:number, y:number, z:number}|null}
   */
  locatePortalRoom(x, z) {
    return nearestPortalRoom(x, z, this.seed);
  }

  /* ---------------------------------------------------------------- dragon */

  /**
   * Starts the dragon fight on arrival in the End.
   *
   * The first fight starts on arrival. Later fights require the completed
   * four-crystal respawn ritual. Returns the existing fight if one is running.
   */
  beginDragonFight(dimensionId = 'end') {
    if (dimensionId !== 'end') return null;
    if (this.dragonsDefeated > 0 && this.respawnCrystals.size < 4) return null;
    if (this.fight) return this.fight;
    this.fight = new EnderDragonFight({ crystals: endCrystalPositions() });
    this._refreshAttackables();
    return this.fight;
  }

  /** Four crystals around the fountain re-summon the dragon. */
  placeRespawnCrystal(x, y, z, dimensionId = 'end') {
    if (dimensionId !== 'end' || this.dragonsDefeated <= 0 || this.fight) return null;
    const match = RESPAWN_CRYSTAL_OFFSETS.find(([dx, dz]) => Math.abs(x - dx) <= 1 && Math.abs(z - dz) <= 1);
    if (!match) return null;
    const key = `${match[0]},${match[1]}`;
    if (this.respawnCrystals.has(key)) return null;
    this.respawnCrystals.add(key);
    if (this.respawnCrystals.size < 4) return { placed:true, ready:false, count:this.respawnCrystals.size };

    this.dragonResummons++;
    this.respawnCrystals.clear();
    this.exitPortalOpen = false;
    this.fight = new EnderDragonFight({ crystals: endCrystalPositions() });
    this._regenerateArena();
    this._refreshAttackables();
    return { placed:true, ready:true, count:4, fight:this.fight };
  }

  _regenerateArena() {
    if (!this.world) return;
    let restored = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (this.world.setBlock(dx, END_ISLAND_SURFACE_Y + 2, dz, Block.AIR)) restored++;
    }
    this.world.setBlock(0, END_ISLAND_SURFACE_Y + 3, 0, Block.AIR);
    for (const pillar of endPillars()) {
      const topY = END_ISLAND_SURFACE_Y + pillar.height;
      for (let dz = -pillar.radius; dz <= pillar.radius; dz++) for (let dx = -pillar.radius; dx <= pillar.radius; dx++) {
        if ((dx * dx) + (dz * dz) > (pillar.radius + .5) ** 2) continue;
        for (let y = END_ISLAND_SURFACE_Y - 4; y <= topY; y++) {
          if (this.world.setBlock(pillar.x + dx, y, pillar.z + dz, Block.OBSIDIAN)) restored++;
        }
      }
      if (this.world.setBlock(pillar.x, topY + 1, pillar.z, Block.BEDROCK)) restored++;
      if (!pillar.caged) continue;
      for (let dy = 0; dy <= 3; dy++) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        const boundary = Math.abs(dx) === 2 || Math.abs(dz) === 2 || dy === 3;
        const block = boundary ? Block.IRON_BARS : Block.AIR;
        if (this.world.setBlock(pillar.x + dx, topY + 2 + dy, pillar.z + dz, block)) restored++;
      }
    }
    this.arenaRegeneratedBlocks = restored;
  }

  /** The fight the boss bar should show, if any. */
  get activeFight() { return this.fight; }

  /**
   * Destroys the end crystal nearest a hit, if one is close enough.
   * @returns {boolean} True when a crystal was actually destroyed.
   */
  destroyCrystalAt(x, y, z) {
    if (!this.fight) return false;
    let bestIndex = -1;
    let bestDistance = CRYSTAL_HIT_RANGE_SQ;
    this.fight.crystals.forEach((crystal, index) => {
      if (!crystal.alive) return;
      const dx = crystal.x - x;
      const dy = crystal.y - y;
      const dz = crystal.z - z;
      const distance = (dx * dx) + (dy * dy) + (dz * dz);
      if (distance <= bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    if (bestIndex < 0) return false;
    return this.fight.destroyCrystal(bestIndex);
  }

  /** Advances the fight and cashes out a dead dragon. */
  fixedUpdate(step, context = {}) {
    this._tickEndMobs(step, context);
    if (this.exitPortalOpen && this._exitPortalPending) this._writeExitPortal();
    if (!this.fight) return;
    this.fight.tick(step);
    this._bodyDamageCooldown = Math.max(0, this._bodyDamageCooldown - step);
    this._blockBreakCooldown = Math.max(0, this._blockBreakCooldown - step);
    const attack = this.fight.consumeAttack();
    if (attack?.kind === 'breath') this.activeBreathCloud = { ...attack, remaining: attack.duration ?? 12 };
    if (this.activeBreathCloud) this.activeBreathCloud.remaining = Math.max(0, this.activeBreathCloud.remaining - step);
    this._applyLiveAttack(attack, context);
    this._applyDragonBodyCollision();
    this._syncAttackables();
    if (!this.fight.bar.dead) return;
    if (this.fight.deathTime < DRAGON_DEATH_SECONDS) return;

    this.dragonsDefeated += 1;
    for (const reward of this.fight.rewards) this.pendingRewards.push({ ...reward });
    this._openExitPortal(this.fight);
    this.fight = null;
    this._refreshAttackables();
  }

  _tickEndMobs(step, context) {
    if (!this.world || !this.player || typeof context.spawnMob !== 'function') return;
    this._spawnerCooldown = Math.max(0, this._spawnerCooldown - step);
    if (this._spawnerCooldown > 0) return;
    this._spawnerCooldown = 7;
    const px = Math.floor(this.player.position.x);
    const py = Math.floor(this.player.position.y);
    const pz = Math.floor(this.player.position.z);

    if (this.world.dimensionId === 'overworld') {
      for (let y = py - 5; y <= py + 5; y++) for (let z = pz - 7; z <= pz + 7; z++) for (let x = px - 7; x <= px + 7; x++) {
        if (this.world.getBlock(x, y, z) !== Block.SILVERFISH_SPAWNER) continue;
        context.spawnMob('silverfish', x + .5, y + 1, z + .5);
        return;
      }
    }

    if (this.world.dimensionId !== 'end') return;
    const city = nearestEndCity(px, pz, this.seed);
    if (!city || Math.hypot(city.x - px, city.z - pz) > 52) return;
    const key = `${city.x | 0},${city.z | 0}`;
    if (this.spawnedEndCities.has(key)) return;
    this.spawnedEndCities.add(key);
    for (let index = 0; index < 5; index++) {
      context.spawnMob('shulker', city.x + (index % 2 ? 4 : -4), city.y + 2 + index * 3, city.z + ((index % 3) - 1) * 4);
    }
  }

  _applyLiveAttack(attack, context = {}) {
    if (!attack || !this.player || !this.fight) return;
    const dx = this.player.position.x - this.fight.position.x;
    const dy = this.player.position.y - this.fight.position.y;
    const dz = this.player.position.z - this.fight.position.z;
    if (attack.kind === 'fireball') {
      const length = Math.hypot(dx, dy, dz) || 1;
      context.spawnProjectile?.(
        this.fight.position.x,
        this.fight.position.y + 1.2,
        this.fight.position.z,
        { x:dx / length, y:dy / length, z:dz / length },
        {
          ownerKind:'mob', owner:this.fight, speed:attack.speed ?? 15,
          damage:attack.damage ?? 7, gravity:0, lifetime:8,
          visualKind:'dragon_fireball',
          sourceX:this.fight.position.x, sourceY:this.fight.position.y, sourceZ:this.fight.position.z,
        }
      );
      return;
    }
    if ((dx * dx) + (dy * dy) + (dz * dz) > (attack.radius ?? 4) ** 2) return;
    this.player.hurt?.(attack.damage ?? 4, 'mob', this.fight.position);
    if (attack.knockback && this.player.velocity) {
      const length = Math.hypot(dx, dz) || 1;
      this.player.velocity.x += dx / length * attack.knockback;
      this.player.velocity.z += dz / length * attack.knockback;
      this.player.velocity.y = Math.max(this.player.velocity.y, 4);
    }
  }

  _applyDragonBodyCollision() {
    if (!this.fight || this.fight.bar.dead || !this.player) return;
    const position = this.fight.position;
    const dx = this.player.position.x - position.x;
    const dy = (this.player.position.y + .9) - (position.y + 1.2);
    const dz = this.player.position.z - position.z;
    const distanceSq = dx * dx + dy * dy + dz * dz;
    if (distanceSq < 20 && this._bodyDamageCooldown <= 0) {
      this._bodyDamageCooldown = .8;
      this.player.hurt?.(5, 'mob', position);
      if (this.player.velocity) {
        const horizontal = Math.hypot(dx, dz) || 1;
        this.player.velocity.x += dx / horizontal * 8;
        this.player.velocity.z += dz / horizontal * 8;
        this.player.velocity.y = Math.max(this.player.velocity.y, 3.5);
      }
    }
    if (this.fight.flightState === 'charge' && this._blockBreakCooldown <= 0) {
      this._blockBreakCooldown = .22;
      this._breakDragonPath(position);
    }
  }

  _breakDragonPath(position) {
    if (!this.world) return 0;
    let broken = 0;
    const cx = Math.floor(position.x), cy = Math.floor(position.y), cz = Math.floor(position.z);
    for (let y = cy - 1; y <= cy + 2; y++) for (let z = cz - 2; z <= cz + 2; z++) for (let x = cx - 2; x <= cx + 2; x++) {
      const id = this.world.getBlock(x, y, z);
      if (DRAGON_PROTECTED_BLOCKS.has(id)) continue;
      if (this.world.setBlock(x, y, z, Block.AIR, { cause:'dragon', cascade:false })) broken++;
    }
    return broken;
  }

  /** Writes the exit portal and the dragon egg into the world. */
  _openExitPortal(fight) {
    this.exitPortalOpen = true;
    this._exitPortalPending = true;
    this._exitPortalCells = fight.exitPortalBlocks()
      .filter((cell) => cell.block !== Block.DRAGON_EGG || this.dragonsDefeated === 1)
      .map((cell) => ({ ...cell }));
    return this._writeExitPortal();
  }

  _writeExitPortal() {
    if (!this.world) return 0;
    const cells = this._exitPortalCells?.length ? this._exitPortalCells : [
      ...Array.from({ length:9 }, (_, index) => ({
        x:(index % 3) - 1, y:END_ISLAND_SURFACE_Y + 2, z:Math.floor(index / 3) - 1,
        block:Block.END_PORTAL,
      })),
      { x:0, y:END_ISLAND_SURFACE_Y + 3, z:0, block:Block.DRAGON_EGG },
    ];
    const required = [...cells, { x:12, y:END_ISLAND_SURFACE_Y + 7, z:0, block:Block.END_GATEWAY }];
    let ready = 0;
    for (const cell of required) {
      if (this.world.getBlock(cell.x, cell.y, cell.z) === cell.block ||
          this.world.setBlock(cell.x, cell.y, cell.z, cell.block)) ready++;
    }
    this._exitPortalPending = ready < required.length;
    return ready;
  }

  /** Destination of the central-island gateway. */
  outerEndDestination() {
    return nearestEndCity(0, 0, this.seed) ?? { x: 384.5, y: 86, z: 0.5 };
  }

  /** Called when the player takes the exit portal home. */
  completeStory() {
    this.endCompleted = true;
    return { completed:true, firstCredits:!this.creditsSeen, dragonsDefeated:this.dragonsDefeated };
  }

  markCreditsSeen() { this.creditsSeen = true; }

  /** Bottle one active breath cloud. */
  collectDragonBreath() {
    if (!this.activeBreathCloud || this.activeBreathCloud.remaining <= 0) return false;
    this.activeBreathCloud.remaining = Math.max(0, this.activeBreathCloud.remaining - 2);
    return true;
  }

  _refreshAttackables() {
    if (!Array.isArray(this._attackables)) this._attackables = [];
    else this._attackables.length = 0;
    if (!this.fight) return;
    const runtime = this;
    const dragon = {
      kind:'ender_dragon', alive:true, isDead:false, halfSize:3.2, height:4,
      x:this.fight.position.x, y:this.fight.position.y - 2, z:this.fight.position.z,
      hurt(amount, source) { return runtime.fight ? runtime.fight.damage(amount, { part:'body', source:source?.kind === 'projectile' ? 'projectile' : 'melee' }) > 0 : false; },
    };
    this._attackables.push(dragon);
    this.fight.crystals.forEach((crystal, index) => {
      this._attackables.push({
        kind:'end_crystal', crystalIndex:index, alive:crystal.alive, isDead:!crystal.alive,
        halfSize:.7, height:1.6, x:crystal.x, y:crystal.y - .8, z:crystal.z,
        hurt() {
          const destroyed = runtime.fight?.destroyCrystal(index) ?? false;
          this.alive = !destroyed;
          this.isDead = destroyed;
          return destroyed;
        },
      });
    });
  }

  _syncAttackables() {
    if (!this.fight || this._attackables.length === 0) return;
    const dragon = this._attackables[0];
    dragon.x = this.fight.position.x;
    dragon.y = this.fight.position.y - 2;
    dragon.z = this.fight.position.z;
    dragon.alive = !this.fight.bar.dead;
    dragon.isDead = this.fight.bar.dead;
    for (let index = 0; index < this.fight.crystals.length; index++) {
      const target = this._attackables[index + 1];
      target.alive = this.fight.crystals[index].alive;
      target.isDead = !target.alive;
    }
  }

  get attackables() { return this._attackables; }

  /** Takes the loot from every dragon killed since the last call. */
  claimRewards() {
    const rewards = this.pendingRewards;
    this.pendingRewards = [];
    return rewards;
  }

  /* ------------------------------------------------------------ persistence */

  toJSON() {
    return {
      filledFrames: [...this.filledFrames],
      litPortals: [...this.litPortals],
      dragonsDefeated: this.dragonsDefeated,
      exitPortalOpen: this.exitPortalOpen,
      exitPortalPending: this._exitPortalPending,
      pendingRewards: this.pendingRewards.map((reward) => ({ ...reward })),
      respawnCrystals: [...this.respawnCrystals],
      dragonResummons: this.dragonResummons,
      endCompleted: this.endCompleted,
      creditsSeen: this.creditsSeen,
      fight: this.fight?.toJSON() ?? null,
      spawnedEndCities:[...this.spawnedEndCities],
    };
  }

  fromJSON(data) {
    if (!data || typeof data !== 'object') return this;
    if (Array.isArray(data.filledFrames)) {
      this.filledFrames = new Set(data.filledFrames.filter((k) => typeof k === 'string'));
    }
    if (Array.isArray(data.litPortals)) {
      this.litPortals = new Set(data.litPortals.filter((k) => typeof k === 'string'));
    }
    this.dragonsDefeated = Math.max(0, Number(data.dragonsDefeated) || 0);
    this.exitPortalOpen = data.exitPortalOpen === true;
    this._exitPortalPending = data.exitPortalPending === true;
    this.pendingRewards = Array.isArray(data.pendingRewards)
      ? data.pendingRewards
        .filter((r) => r && (typeof r.item === 'string' || Number.isFinite(r.experience)))
        .map((r) => ({ ...r }))
      : [];
    this.respawnCrystals = new Set(Array.isArray(data.respawnCrystals) ? data.respawnCrystals : []);
    this.dragonResummons = Math.max(0, Number(data.dragonResummons) || 0);
    this.endCompleted = data.endCompleted === true;
    this.creditsSeen = data.creditsSeen === true;
    this.spawnedEndCities = new Set(Array.isArray(data.spawnedEndCities) ? data.spawnedEndCities : []);
    if (data.fight) {
      this.fight = new EnderDragonFight({ crystals:endCrystalPositions() }).fromJSON(data.fight);
    }
    this._refreshAttackables();
    return this;
  }

  destroy() {
    this.filledFrames.clear();
    this.litPortals.clear();
    this.fight = null;
    this.pendingRewards = [];
    this.respawnCrystals.clear();
    this.spawnedEndCities.clear();
    this._attackables = [];
    this.world = null;
    this.player = null;
  }
}

export { StrongholdMarker };
export default Phase5Runtime;
