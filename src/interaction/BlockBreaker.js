/**
 * Block breaking.
 *
 * Two modes share one state machine:
 *
 *  - **Creative**: instant break, with a repeat delay so holding the button
 *    tunnels at a controlled rate instead of deleting a corridor in one frame.
 *  - **Survival-like**: progress accumulates while the button is held, at a rate
 *    derived from the block's hardness.
 *
 * ## Cancelling on target change
 *
 * Progress is tied to a specific block position, not to "whatever is under the
 * crosshair". The moment the target changes — because the player looked away, or
 * because the block was replaced — progress resets. Without that check, grinding
 * away at a hard block and then flicking to a soft one would break the soft block
 * instantly, and progress would appear to teleport between blocks.
 */

import { INTERACTION } from '../config/GameConfig.js';
import { Events } from '../core/EventBus.js';
import { Block } from '../world/BlockTypes.js';
import { IS_BREAKABLE, getBlock } from '../world/BlockRegistry.js';
import { describeMining, shouldConsumeDurability } from './MiningCalculator.js';

export class BlockBreaker {
  /**
   * @param {Object} options
   * @param {import('../world/World.js').World} options.world
   * @param {import('../core/EventBus.js').EventBus} options.bus
   * @param {import('../core/SettingsManager.js').SettingsManager} options.settings
   * @param {import('./BlockParticles.js').BlockParticles} options.particles
   */
  constructor({ world, bus, settings, particles }) {
    this._world = world;
    this._bus = bus;
    this._settings = settings;
    this._particles = particles;

    /** Progress towards breaking the current target, 0..1. */
    this.progress = 0;
    /** Coordinates the progress belongs to. */
    this._targetX = Number.NaN;
    this._targetY = Number.NaN;
    this._targetZ = Number.NaN;
    this._targetBlockId = Block.AIR;
    /** Cooldown between creative breaks. */
    this._repeatTimer = 0;
    /** Accumulates time so particle bursts are throttled while mining. */
    this._particleTimer = 0;

    /**
     * Whether the current target would actually drop with the held item.
     *
     * Exposed so the HUD can warn before the block breaks rather than after.
     */
    this.willDrop = true;
    /** Whether the held item is the right kind of tool for the current target. */
    this.usingCorrectTool = true;
  }

  /** True when a break is in progress. */
  get isBreaking() {
    return this.progress > 0;
  }

  /**
   * Advances breaking.
   *
   * @param {number} dt
   * @param {import('./BlockRaycaster.js').RaycastHit|null} target
   * @param {boolean} held True while the break action is held.
   * @param {Object} [context]
   * @param {boolean} [context.creative]
   * @param {string|null} [context.itemId] Held item, for speed and tier checks.
   * @param {boolean} [context.underwater]
   * @param {boolean} [context.airborne]
   * @returns {{blockId: number, dropped: boolean, itemId: string|null}|null}
   *   Details of the block broken this frame, or `null`.
   */
  update(dt, target, held, context = {}) {
    this._repeatTimer = Math.max(0, this._repeatTimer - dt);

    if (!held || !target || !target.hit) {
      this.cancel();
      return null;
    }

    const blockId = target.blockId;
    if (blockId === Block.AIR || !IS_BREAKABLE[blockId]) {
      this.cancel();
      return null;
    }

    // Target changed: restart progress rather than carrying it over.
    if (
      target.blockX !== this._targetX ||
      target.blockY !== this._targetY ||
      target.blockZ !== this._targetZ ||
      blockId !== this._targetBlockId
    ) {
      this._targetX = target.blockX;
      this._targetY = target.blockY;
      this._targetZ = target.blockZ;
      this._targetBlockId = blockId;
      this.progress = 0;
      this._particleTimer = 0;
      this._bus.emit(Events.TARGET_CHANGED, target);
    }

    const itemId = context.itemId ?? null;

    if (context.creative) {
      if (this._repeatTimer > 0) return null;
      this._repeatTimer = INTERACTION.creativeBreakRepeatSeconds;
      return this._break(target, blockId, itemId, false);
    }

    // One call rather than three, because all of this is needed every frame and
    // each part would otherwise repeat the same registry lookups.
    const mining = describeMining(blockId, itemId, {
      underwater: context.underwater,
      airborne: context.airborne,
    });

    if (!Number.isFinite(mining.seconds)) {
      // Unbreakable. Report zero progress so the crack overlay does not stick.
      this.cancel();
      return null;
    }

    // Surfaced so the HUD can warn *before* the block breaks. Discovering that a
    // wooden pickaxe yields no iron only after mining a whole vein is a miserable
    // way to learn the rule.
    this.willDrop = mining.drops;
    this.usingCorrectTool = mining.correctTool;

    this.progress += dt / mining.seconds;

    // Chips fly off while mining, throttled so a long mine is not a particle
    // firehose.
    this._particleTimer += dt;
    if (this._particleTimer > 0.18) {
      this._particleTimer = 0;
      this._particles.spawnBreak(target.blockX, target.blockY, target.blockZ, blockId, 2);
    }

    this._bus.emit(Events.BREAK_PROGRESS, {
      progress: Math.min(1, this.progress),
      blockId,
      x: target.blockX,
      y: target.blockY,
      z: target.blockZ,
      willDrop: mining.drops,
      correctTool: mining.correctTool,
    });

    if (this.progress >= 1) return this._break(target, blockId, itemId, mining.drops);
    return null;
  }

  /**
   * Removes the block, spawns effects and resets state.
   *
   * @param {import('./BlockRaycaster.js').RaycastHit} target
   * @param {number} blockId
   * @param {string|null} itemId
   * @param {boolean} harvested Whether the tool was good enough for a drop.
   */
  _break(target, blockId, itemId, harvested) {
    // Only survival-like mode drops items; creative simply removes the block.
    const survival = this._settings.get('gameplay.mode') === 'survival';
    const drop = survival && this._settings.get('gameplay.dropItems') && harvested;

    const removed = this._world.breakBlock(target.blockX, target.blockY, target.blockZ, {
      drop,
      context: { itemId, harvested },
    });
    if (removed === Block.AIR) {
      this.cancel();
      return null;
    }

    this._particles.spawnBreak(target.blockX, target.blockY, target.blockZ, removed, 14);

    this._bus.emit(Events.BLOCK_BROKEN, {
      x: target.blockX,
      y: target.blockY,
      z: target.blockZ,
      blockId: removed,
      soundGroup: getBlock(removed).soundGroup,
      dropped: drop,
    });

    // Tool wear is charged here, once, on the frame the block actually breaks —
    // not per frame of mining, which would consume a pickaxe in seconds.
    const wears = survival && shouldConsumeDurability(blockId, itemId);

    this.cancel();
    return { blockId: removed, dropped: drop, itemId, wears };
  }

  /** Abandons progress on the current target. */
  cancel() {
    if (this.progress !== 0) {
      this._bus.emit(Events.BREAK_PROGRESS, { progress: 0, blockId: Block.AIR, x: 0, y: 0, z: 0 });
    }
    this.progress = 0;
    this._targetX = Number.NaN;
    this._targetY = Number.NaN;
    this._targetZ = Number.NaN;
    this._targetBlockId = Block.AIR;
    this._particleTimer = 0;
    this.willDrop = true;
    this.usingCorrectTool = true;
  }
}

export default BlockBreaker;
