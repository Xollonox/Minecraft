/**
 * Water presentation: submersion state and the transition in and out of it.
 *
 * The water *material* lives in `Materials`; this module owns the part that
 * depends on where the camera is:
 *
 *  - deciding whether the eye is submerged, with hysteresis around the surface
 *    so bobbing at the waterline does not strobe the underwater fog on and off;
 *  - reporting depth below the surface, which drives how strongly the fog closes
 *    in;
 *  - a short cross-fade on entry and exit, so breaking the surface is a visible
 *    moment rather than an instant switch.
 *
 * The screen tint itself is a CSS overlay owned by the HUD. Doing it in CSS
 * rather than as a full-screen shader pass costs nothing on the GPU and keeps
 * working even if post-processing is disabled or the composer fails.
 */

import { Events } from '../core/EventBus.js';
import { clamp01, damp } from '../utils/MathUtils.js';
import { Block } from '../world/BlockTypes.js';
import { IS_LIQUID } from '../world/BlockRegistry.js';

/**
 * Height of an open liquid surface within its block, matching the mesher.
 * The eye must be below this to count as submerged.
 */
const LIQUID_SURFACE_HEIGHT = 0.875;
/** Extra depth required to *enter* the submerged state, in blocks. */
const ENTER_MARGIN = 0.06;
/** Depth at which the state is released again, in blocks. */
const EXIT_MARGIN = 0.02;
/** Seconds for the entry/exit transition. */
const TRANSITION_SMOOTHING = 0.0005;

export class WaterRenderer {
  /**
   * @param {Object} options
   * @param {import('../world/World.js').World} options.world
   * @param {import('./LightingSystem.js').LightingSystem} options.lighting
   * @param {import('../core/EventBus.js').EventBus} options.bus
   */
  constructor({ world, lighting, bus }) {
    this._world = world;
    this._lighting = lighting;
    this._bus = bus;

    /** True while the camera's eye is below a water surface. */
    this.isUnderwater = false;
    /** True while the camera's eye is below a lava surface. */
    this.isUnderLava = false;
    /** True while below either supported liquid. */
    this.isSubmerged = false;
    /** Blocks between the eye and the surface above it. */
    this.submersionDepth = 0;
    /** Smoothed 0..1 transition value for the overlay. */
    this.transition = 0;
    /** Block id of the liquid the eye is inside, or air. */
    this.liquidBlock = Block.AIR;
    /** Liquid colour retained while the exit transition fades to zero. */
    this.overlayBlock = Block.AIR;
  }

  /**
   * Updates submersion state from the eye position.
   *
   * @param {number} dt
   * @param {{x: number, y: number, z: number}} eyePosition
   */
  update(dt, eyePosition) {
    const blockX = Math.floor(eyePosition.x);
    const blockY = Math.floor(eyePosition.y);
    const blockZ = Math.floor(eyePosition.z);

    const blockId = this._world.getBlock(blockX, blockY, blockZ);
    const inLiquidVoxel = IS_LIQUID[blockId] === 1;

    let submerged = false;
    let depth = 0;

    if (inLiquidVoxel) {
      // The voxel's surface is either flush (liquid above) or lowered.
      const above = this._world.getBlock(blockX, blockY + 1, blockZ);
      const surfaceY = blockY + (IS_LIQUID[above] ? 1 : LIQUID_SURFACE_HEIGHT);
      depth = surfaceY - eyePosition.y;

      // Hysteresis: it takes a little more depth to submerge than to surface.
      const threshold = this.isSubmerged ? EXIT_MARGIN : ENTER_MARGIN;
      submerged = depth > threshold;
    }

    const nextLiquid = submerged ? blockId : Block.AIR;
    if (nextLiquid !== this.liquidBlock) {
      this.liquidBlock = nextLiquid;
      if (nextLiquid !== Block.AIR) this.overlayBlock = nextLiquid;
      this.isSubmerged = nextLiquid !== Block.AIR;
      this.isUnderwater = nextLiquid === Block.WATER;
      this.isUnderLava = nextLiquid === Block.LAVA;
      this._lighting.setSubmergedLiquid?.(nextLiquid);
      this._bus.emit(Events.PLAYER_WATER_STATE, {
        underwater: this.isUnderwater,
        inLava: this.isUnderLava,
        submerged: this.isSubmerged,
        blockId: this.liquidBlock,
      });
    }

    this.submersionDepth = this.isSubmerged ? Math.max(0, depth) : 0;
    this.transition = damp(this.transition, this.isSubmerged ? 1 : 0, TRANSITION_SMOOTHING, dt);
    // Snap the tail of the fade so the overlay reaches exactly 0 or 1.
    if (this.transition < 0.002) {
      this.transition = 0;
      if (!this.isSubmerged) this.overlayBlock = Block.AIR;
    }
    if (this.transition > 0.998) this.transition = 1;
  }

  /**
   * Overlay strength for the HUD, 0..1.
   *
   * Ramps with depth as well as the transition so a shallow dip is a light tint
   * and a deep dive is heavy.
   */
  getOverlayStrength() {
    if (this.transition <= 0) return 0;
    const depthRamp = 0.55 + clamp01(this.submersionDepth / 6) * 0.45;
    return this.transition * depthRamp;
  }

  /** Resets state, e.g. after a teleport or a respawn. */
  reset() {
    this.isUnderwater = false;
    this.isUnderLava = false;
    this.isSubmerged = false;
    this.submersionDepth = 0;
    this.transition = 0;
    this.liquidBlock = Block.AIR;
    this.overlayBlock = Block.AIR;
    this._lighting.setSubmergedLiquid?.(Block.AIR);
  }
}

export default WaterRenderer;
