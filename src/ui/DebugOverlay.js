/**
 * F3-style debug overlay.
 *
 * ## Updated four times a second, not sixty
 *
 * Every line here is a DOM text write, and a debug overlay that refreshes every
 * frame is a classic way to make a profiler blame the renderer for what is
 * actually layout thrash. The whole panel is rebuilt as two `textContent`
 * assignments on a 250 ms timer, which is faster than the eye can read anyway.
 *
 * The two panels are split left/right so the left column stays stable (player and
 * world state) while the right column carries the volatile performance numbers.
 */

import { WORLD_HEIGHT } from '../config/GameConfig.js';
import { STATUS_EFFECT_DEFINITIONS } from '../entities/StatusEffects.js';
import { formatBytes, yawToFacing } from '../utils/MathUtils.js';
import { getBlockName } from '../world/BlockRegistry.js';
import { Block } from '../world/BlockTypes.js';
import { getVoxelShape } from '../world/BlockModels.js';
import { powerLevel } from '../world/BlockState.js';
import { el, setVisible } from './dom.js';

/** Seconds between refreshes. */
const REFRESH_INTERVAL = 0.25;

export class DebugOverlay {
  /**
   * @param {HTMLElement} root
   * @param {import('../utils/DeviceDetector.js').DeviceCapabilities} capabilities
   */
  constructor(root, capabilities) {
    this._caps = capabilities;
    this._left = el('div', { className: 'debug-overlay', hidden: true });
    this._right = el('div', { className: 'debug-overlay debug-overlay-right', hidden: true });
    root.appendChild(this._left);
    root.appendChild(this._right);

    this._visible = false;
    this._timer = 0;
  }

  /** True while the overlay is shown. */
  get visible() {
    return this._visible;
  }

  /** Toggles the overlay. */
  toggle() {
    this.setVisible(!this._visible);
    return this._visible;
  }

  /** Shows or hides both panels. */
  setVisible(visible) {
    this._visible = visible;
    setVisible(this._left, visible);
    setVisible(this._right, visible);
    // Refresh immediately on show rather than waiting up to 250 ms.
    this._timer = REFRESH_INTERVAL;
  }

  /**
   * Refreshes the text, at most four times a second.
   *
   * @param {number} dt
   * @param {Object} state Everything the overlay reports; assembled by `Game`.
   */
  update(dt, state) {
    if (!this._visible) return;
    this._timer += dt;
    if (this._timer < REFRESH_INTERVAL) return;
    this._timer = 0;

    this._left.textContent = this._buildLeft(state);
    this._right.textContent = this._buildRight(state);
  }

  _buildLeft(state) {
    const { player, world, camera, target, timeOfDay, weather } = state;
    const lines = [];

    lines.push('— player —');
    if (player) {
      lines.push(
        `pos    ${player.position.x.toFixed(3)} / ${player.position.y.toFixed(3)} / ${player.position.z.toFixed(3)}`
      );
      lines.push(
        `block  ${Math.floor(player.position.x)} / ${Math.floor(player.position.y)} / ${Math.floor(player.position.z)}`
      );
      lines.push(
        `chunk  ${Math.floor(player.position.x / 16)} / ${Math.floor(player.position.z / 16)}` +
          `  (local ${((Math.floor(player.position.x) % 16) + 16) % 16}, ${((Math.floor(player.position.z) % 16) + 16) % 16})`
      );
      lines.push(
        `facing ${yawToFacing(camera.yaw)}  yaw ${degrees(camera.yaw)}  pitch ${degrees(camera.pitch)}`
      );
      lines.push(
        `vel    ${player.velocity.x.toFixed(2)} / ${player.velocity.y.toFixed(2)} / ${player.velocity.z.toFixed(2)}` +
          `  |h| ${player.horizontalSpeed.toFixed(2)}`
      );
      lines.push(
        `state  ground=${player.onGround ? 'yes' : 'no'}  water=${player.inWater ? 'yes' : 'no'}` +
          `  fly=${player.flying ? 'yes' : 'no'}  fall=${player.fallDistance.toFixed(1)}`
      );
      if (world) {
        const light = world.getBlockLight(
          Math.floor(player.position.x),
          Math.floor(player.position.y + (player.eyeHeight ?? 1.62)),
          Math.floor(player.position.z)
        );
        lines.push(`light  block ${light}/15  exposure ${(weather.exposure * 15).toFixed(1)}/15`);
      }
      const effects = player.effects?.list?.() ?? [];
      if (effects.length > 0) {
        const labels = effects.map((effect) => {
          const label = STATUS_EFFECT_DEFINITIONS[effect.id]?.label ?? effect.id;
          return `${label} ${effect.amplifier + 1} ${formatDuration(effect.duration)}`;
        });
        lines.push(`effects ${labels.join(', ')}`);
      }
    }

    lines.push('');
    lines.push('— world —');
    if (world) {
      lines.push(`seed   ${world.seed}`);
      lines.push(`biome  ${state.biomeName}`);
      lines.push(`time   ${(timeOfDay * 24).toFixed(2)}h  (${timeOfDay.toFixed(4)})`);
      lines.push(
        `height ${state.surfaceY >= 0 ? state.surfaceY : '—'} / ${WORLD_HEIGHT}` +
          `  edited chunks ${world.editedChunkCount}`
      );
      lines.push(`weather ${weather.state} ${(weather.intensity * 100).toFixed(0)}%  exposure ${(weather.exposure * 100).toFixed(0)}%`);
    }

    lines.push('');
    lines.push('— target —');
    if (target && target.hit) {
      const blockState = world?.getBlockState?.(target.blockX, target.blockY, target.blockZ) ?? 0;
      const blockLight = world?.getBlockLight?.(target.blockX, target.blockY, target.blockZ) ?? 0;
      const shapeBoxes = getVoxelShape(target.blockId, blockState).length;
      lines.push(`block  ${getBlockName(target.blockId)} (id ${target.blockId})`);
      const wirePower = target.blockId === Block.REDSTONE_WIRE
        ? `  wire ${powerLevel(blockState)}/15`
        : '';
      lines.push(`state  ${blockState} (0x${blockState.toString(16).padStart(2, '0')})${wirePower}`);
      lines.push(`shape  ${shapeBoxes} box${shapeBoxes === 1 ? '' : 'es'}  light ${blockLight}/15`);
      lines.push(`at     ${target.blockX} / ${target.blockY} / ${target.blockZ}`);
      lines.push(`normal ${target.normalX} / ${target.normalY} / ${target.normalZ}`);
      lines.push(`dist   ${target.distance.toFixed(3)}`);
      if (state.breakProgress > 0) lines.push(`break  ${(state.breakProgress * 100).toFixed(0)}%`);
    } else {
      lines.push('nothing in reach');
    }

    return lines.join('\n');
  }

  _buildRight(state) {
    const { loop, renderer, chunks, entities, particles, audio, settings } = state;
    const lines = [];

    lines.push('— performance —');
    lines.push(`fps    ${loop.fps.toFixed(1)}  (${loop.smoothedFrameTime.toFixed(2)} ms)`);
    lines.push(`steps  ${loop.lastStepCount}  clamped ${loop.clampedFrames}`);
    lines.push(`draws  ${renderer.info.drawCalls}  tris ${formatCount(renderer.info.triangles)}`);
    lines.push(`geom   ${renderer.info.geometries}  tex ${renderer.info.textures}  prog ${renderer.info.programs}`);
    lines.push(`gpu~   ${formatBytes(renderer.memory)}  shadow ${formatBytes(renderer.shadowMemory)}`);

    lines.push('');
    lines.push('— display —');
    lines.push(
      `buffer ${renderer.bufferWidth} x ${renderer.bufferHeight}` +
        `  dpr ${renderer.pixelRatio.toFixed(2)}`
    );
    lines.push(
      `scale  ${settings.display.resolutionScale.toFixed(2)} manual` +
        `  ${renderer.dynamicScale.toFixed(2)} dynamic`
    );
    lines.push(`webgl  ${renderer.isWebGL2 ? '2' : '1'}  post ${renderer.postPasses} pass(es)`);
    lines.push(`preset ${settings.graphics.preset}  shadows ${settings.graphics.shadows ? 'on' : 'off'}`);
    lines.push(`shader ${state.usingFallbackShader ? 'fallback (lambert)' : 'custom voxel'}`);
    if (state.water) {
      const path = state.water.shader ? 'shader' : 'fallback (tinted)';
      const health = state.water.healthy ? 'ok' : 'MISCONFIGURED';
      lines.push(`water  ${path}  scroll ${state.water.scroll.toFixed(3)}  ${health}`);
    }

    lines.push('');
    lines.push('— streaming —');
    lines.push(`loaded ${chunks.loaded}  visible ${chunks.visible}`);
    lines.push(`gen    ${chunks.generating} active  ${chunks.queuedGeneration} queued`);
    lines.push(`mesh   ${chunks.meshing} active  ${chunks.queuedMeshing} queued`);
    lines.push(`upload ${chunks.queuedUpload} pending  budget ${settings.graphics.uploadBudget}/frame`);
    lines.push(`workers ${state.workers.workers}${state.workers.inlineMode ? ' (inline)' : ''}  jobs ${state.workers.inFlight}`);
    lines.push(`totals gen ${formatCount(chunks.generatedTotal)}  mesh ${formatCount(chunks.meshedTotal)}`);
    lines.push(`       dropped ${formatCount(chunks.discardedTotal)}  evicted ${formatCount(chunks.evictedTotal)}`);
    if (chunks.recoveredTotal > 0) lines.push(`       recovered ${chunks.recoveredTotal}`);
    lines.push(`tris   ${formatCount(chunks.triangles)} in chunk meshes`);

    lines.push('');
    lines.push('— entities —');
    lines.push(`items  ${entities.items}/${entities.itemCapacity}  falling ${entities.falling}/${entities.fallingCapacity}`);
    lines.push(`mobs   ${entities.mobs}/${entities.mobCapacity}  babies ${entities.babies}`);
    lines.push(`arrows ${entities.projectiles}/${entities.projectileCapacity}`);
    lines.push(`parts  ${particles.active}/${particles.capacity}  rain ${state.weather.droplets}`);

    lines.push('');
    lines.push('— audio —');
    lines.push(`state  ${audio.state}  ${audio.sampleRate ? `${(audio.sampleRate / 1000).toFixed(1)} kHz` : ''}`);
    lines.push(`voices ${audio.voices}  loops ${audio.loops}  buffers ${audio.buffers}`);

    if (state.heapUsed > 0) {
      lines.push('');
      lines.push('— memory —');
      lines.push(`heap   ${formatBytes(state.heapUsed)} / ${formatBytes(state.heapLimit)}`);
    }

    lines.push('');
    lines.push('— device —');
    lines.push(`cores  ${this._caps.cores}  score ${this._caps.performanceScore}`);
    lines.push(`gpu    ${truncate(this._caps.renderer, 34)}`);

    return lines.join('\n');
  }

  /** Removes both panels. */
  destroy() {
    this._left.remove();
    this._right.remove();
  }
}

function formatDuration(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  if (value >= 60) return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
  return `${value.toFixed(value < 10 ? 1 : 0)}s`;
}

function degrees(radians) {
  return `${((radians * 180) / Math.PI).toFixed(1)}°`;
}

function formatCount(value) {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

function truncate(text, length) {
  const value = String(text ?? '');
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

export default DebugOverlay;
