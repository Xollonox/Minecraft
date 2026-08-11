/**
 * The WebGL renderer wrapper.
 *
 * Owns the `WebGLRenderer`, the canvas sizing policy, dynamic resolution and
 * WebGL context-loss recovery.
 *
 * ## Sizing policy
 *
 * Three numbers combine into the drawing buffer size:
 *
 *   `drawing buffer = css size x min(devicePixelRatio, maxPixelRatio) x resolutionScale x dynamicScale`
 *
 * Capping the device pixel ratio is the single most effective performance lever
 * on phones — a modern handset reports 3.0, which means nine times the pixels of
 * a naive 1.0 for a display the size of a postcard. `resolutionScale` is the
 * player's manual control and `dynamicScale` is the automatic one. The CSS size
 * never changes, so the DOM UI stays perfectly sharp no matter how low the 3D
 * resolution drops.
 *
 * ## Dynamic resolution
 *
 * A slow controller with hysteresis and a cool-down. Reacting quickly to frame
 * time produces a visibly pulsing image, which players notice far more than a
 * steady slightly-soft one; so the scale moves in small steps, at most a few
 * times a second, and only when the smoothed frame time has been outside the
 * target band for a while.
 *
 * ## Context loss
 *
 * On mobile the browser will take the GL context away when memory is tight or the
 * tab is backgrounded. `webglcontextlost` must be `preventDefault()`-ed for the
 * browser to attempt a restore at all. Between loss and restore all rendering is
 * suspended, and on restore every GPU resource has to be recreated, which is
 * signalled through the event bus so the systems that own them can rebuild.
 */

import * as THREE from 'three';

import { Events, SubscriptionGroup } from '../core/EventBus.js';
import { clamp } from '../utils/MathUtils.js';
import { PostProcessing } from './PostProcessing.js';

/** Tone mapping modes exposed in the settings. */
const TONE_MAPPING = {
  none: THREE.NoToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  cineon: THREE.CineonToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  neutral: THREE.NeutralToneMapping,
};

/** Dynamic resolution bounds and behaviour. */
const DYNAMIC = Object.freeze({
  minScale: 0.5,
  maxScale: 1.0,
  step: 0.06,
  /** Frame time above which we reduce, as a multiple of the target. */
  reduceThreshold: 1.18,
  /** Frame time below which we increase, as a multiple of the target. */
  increaseThreshold: 0.78,
  /** Seconds the frame time must stay out of band before acting. */
  reactionDelay: 0.7,
  /** Seconds to wait after a change before considering another. */
  cooldown: 0.9,
});

export class Renderer {
  /**
   * @param {Object} options
   * @param {HTMLCanvasElement} options.canvas
   * @param {THREE.Scene} options.scene
   * @param {THREE.PerspectiveCamera} options.camera
   * @param {import('../core/EventBus.js').EventBus} options.bus
   * @param {import('../core/SettingsManager.js').SettingsManager} options.settings
   * @param {import('../utils/DeviceDetector.js').DeviceCapabilities} options.capabilities
   */
  constructor({ canvas, scene, camera, bus, settings, capabilities }) {
    this._canvas = canvas;
    this._scene = scene;
    this._camera = camera;
    this._bus = bus;
    this._settings = settings;
    this._caps = capabilities;
    this._subscriptions = new SubscriptionGroup();

    this.contextLost = false;
    this.dynamicScale = 1;
    this._dynamicTimer = 0;
    this._cooldownTimer = 0;
    this._cssWidth = 1;
    this._cssHeight = 1;
    this._effectivePixelRatio = 1;

    /** @type {THREE.WebGLRenderer} */
    this.renderer = this._createRenderer();
    /** @type {PostProcessing} */
    this.post = new PostProcessing({
      renderer: this.renderer,
      scene,
      camera,
      settings,
      capabilities,
    });

    this._attachContextHandlers();
    this.applySettings(settings.values);
    this.resize();
  }

  /** True when WebGL2 is in use. */
  get isWebGL2() {
    return this.renderer.capabilities.isWebGL2;
  }

  /** Current drawing buffer size in device pixels. */
  getDrawingBufferSize(out = new THREE.Vector2()) {
    return this.renderer.getDrawingBufferSize(out);
  }

  /** Renderer info for the debug overlay. */
  getInfo() {
    const info = this.renderer.info;
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs ? info.programs.length : 0,
    };
  }

  _createRenderer() {
    const graphics = this._settings.values.graphics;

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: this._canvas,
        // MSAA on the default framebuffer only helps when post-processing is off;
        // it is requested at context creation and cannot be changed later, which
        // is why the setting is marked as requiring a reload.
        antialias: Boolean(graphics.antialias),
        alpha: false,
        stencil: false,
        depth: true,
        // A voxel world is opaque; not preserving the buffer lets the driver
        // discard it, which is measurably faster on tiled mobile GPUs.
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
        failIfMajorPerformanceCaveat: false,
      });
    } catch (error) {
      throw new Error(
        `WebGL could not be initialised: ${error instanceof Error ? error.message : error}`
      );
    }

    renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Surface shader compile failures instead of letting Three fail quietly and
    // leave an untextured (and historically magenta) surface on screen.
    // `ShaderManager.validateMaterial` catches this for the materials it probes;
    // this hook covers every other program, including ones added later.
    renderer.debug.checkShaderErrors = true;
    renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => {
      const name = program?.name || 'unknown program';
      const details = [
        gl.getProgramInfoLog(program),
        gl.getShaderInfoLog(vertexShader),
        gl.getShaderInfoLog(fragmentShader),
      ]
        .map((entry) => (entry || '').trim())
        .filter(Boolean)
        .join(' | ');
      const message = `Shader program "${name}" failed to compile: ${details || 'no driver log'}`;
      console.error(message);
      this._bus.emit(Events.SHADER_ERROR, { program: name, details, message });
    };

    renderer.shadowMap.enabled = Boolean(graphics.shadows);
    // `PCFSoftShadowMap` is deprecated in current Three and silently downgrades to
    // `PCFShadowMap`, so it is requested directly. Softness comes from the
    // shadow's own `radius`, which `LightingSystem` sets per quality level.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.autoClear = true;
    renderer.setClearColor(0x0b1220, 1);
    renderer.info.autoReset = true;

    return renderer;
  }

  _attachContextHandlers() {
    this._subscriptions.dom(
      this._canvas,
      'webglcontextlost',
      (event) => {
        // Without preventDefault the browser will not attempt a restore at all.
        event.preventDefault();
        this.contextLost = true;
        console.warn('[Renderer] WebGL context lost');
        this._bus.emit(Events.CONTEXT_LOST);
      },
      false
    );

    this._subscriptions.dom(
      this._canvas,
      'webglcontextrestored',
      () => {
        this.contextLost = false;
        console.info('[Renderer] WebGL context restored');
        // Three re-initialises its own state; everything *we* uploaded has to be
        // rebuilt, which the listeners of this event take care of.
        this.post.rebuild();
        this.applySettings(this._settings.values);
        this.resize();
        this._bus.emit(Events.CONTEXT_RESTORED);
      },
      false
    );

    this._subscriptions.dom(window, 'resize', this._onResize);
    this._subscriptions.dom(window, 'orientationchange', this._onResize);
    if (window.visualViewport) {
      // Mobile address bars change the visual viewport without firing `resize`.
      this._subscriptions.dom(window.visualViewport, 'resize', this._onResize);
    }
  }

  _onResize = () => {
    this.resize();
  };

  /**
   * Recomputes the canvas and drawing buffer size from the container.
   * Call after a layout change or a settings change.
   */
  resize() {
    if (this.contextLost) return;

    const display = this._settings.values.display;
    // The canvas is stretched to the viewport by CSS; read the *client* size so
    // dynamic mobile toolbars are accounted for automatically.
    const width = Math.max(1, this._canvas.clientWidth || window.innerWidth || 1);
    const height = Math.max(1, this._canvas.clientHeight || window.innerHeight || 1);

    this._cssWidth = width;
    this._cssHeight = height;

    const deviceRatio = Math.max(1, window.devicePixelRatio || 1);
    const cappedRatio = Math.min(deviceRatio, clamp(display.maxPixelRatio, 0.5, 4));
    const scale = clamp(display.resolutionScale, 0.3, 2) * this.dynamicScale;
    // Guard against a zero-sized buffer, which some drivers treat as an error.
    this._effectivePixelRatio = Math.max(0.1, cappedRatio * scale);

    this.renderer.setPixelRatio(this._effectivePixelRatio);
    this.renderer.setSize(width, height, false);

    if (this._camera.isPerspectiveCamera) {
      this._camera.aspect = width / height;
      this._camera.updateProjectionMatrix();
    }

    this.post.setSize(width, height, this._effectivePixelRatio);
  }

  /**
   * Applies renderer-level settings.
   * @param {Object} settings The whole settings tree.
   */
  applySettings(settings) {
    const graphics = settings.graphics;
    const renderer = this.renderer;

    renderer.shadowMap.enabled = Boolean(graphics.shadows);
    renderer.shadowMap.type =
      graphics.shadowQuality === 'low' ? THREE.BasicShadowMap : THREE.PCFShadowMap;
    // Changing the shadow map type invalidates every compiled program that reads
    // it, so Three needs to be told.
    renderer.shadowMap.needsUpdate = true;

    // Tone mapping is applied by `OutputPass` when the composer is active and by
    // the materials themselves when it is not; either way it reads this value.
    renderer.toneMapping = TONE_MAPPING[graphics.tonemapping] ?? THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;

    // Turning dynamic resolution off must restore the requested resolution
    // immediately rather than leaving the last automatic scale in place.
    if (!settings.display.dynamicResolution && this.dynamicScale !== 1) {
      this.dynamicScale = 1;
    }

    this.resize();
  }

  /** Rebuilds the post-processing chain after a settings change. */
  rebuildPostProcessing() {
    this.post.rebuild();
    this.post.setSize(this._cssWidth, this._cssHeight, this._effectivePixelRatio);
  }

  /**
   * Runs the dynamic resolution controller.
   *
   * @param {number} dt
   * @param {number} smoothedFrameTimeMs
   */
  updateDynamicResolution(dt, smoothedFrameTimeMs) {
    const display = this._settings.values.display;
    if (!display.dynamicResolution) {
      if (this.dynamicScale !== 1) {
        this.dynamicScale = 1;
        this.resize();
      }
      return;
    }

    // Target frame time: the FPS cap when set, otherwise 60 Hz.
    const targetFps = display.maxFps > 0 ? display.maxFps : 60;
    const targetMs = 1000 / targetFps;

    if (this._cooldownTimer > 0) {
      this._cooldownTimer -= dt;
      return;
    }

    const tooSlow = smoothedFrameTimeMs > targetMs * DYNAMIC.reduceThreshold;
    const plentyOfHeadroom = smoothedFrameTimeMs < targetMs * DYNAMIC.increaseThreshold;

    if (!tooSlow && !plentyOfHeadroom) {
      // Inside the dead band: forget any accumulated pressure.
      this._dynamicTimer = 0;
      return;
    }

    this._dynamicTimer += dt;
    if (this._dynamicTimer < DYNAMIC.reactionDelay) return;
    this._dynamicTimer = 0;

    const previous = this.dynamicScale;
    if (tooSlow) {
      this.dynamicScale = Math.max(DYNAMIC.minScale, this.dynamicScale - DYNAMIC.step);
    } else {
      this.dynamicScale = Math.min(DYNAMIC.maxScale, this.dynamicScale + DYNAMIC.step);
    }

    if (this.dynamicScale !== previous) {
      this._cooldownTimer = DYNAMIC.cooldown;
      this.resize();
    }
  }

  /**
   * Draws one frame.
   *
   * @param {number} dt
   * @param {{underwater?: number}} [state] Screen-space effect inputs.
   * @returns {boolean} False when the frame was skipped (context lost).
   */
  render(dt, state = {}) {
    if (this.contextLost) return false;

    this.post.updateUniforms(state);
    if (!this.post.render(dt)) {
      this.renderer.render(this._scene, this._camera);
    }
    return true;
  }

  /** Forces a shadow map refresh, e.g. after a large world edit. */
  invalidateShadows() {
    this.renderer.shadowMap.needsUpdate = true;
  }

  /**
   * Estimated GPU memory held by the renderer, for the debug overlay.
   * @returns {number} Bytes.
   */
  estimateMemory() {
    const info = this.renderer.info.memory;
    // A coarse estimate: geometries and textures dominate, and Three does not
    // expose real sizes. Reported as an order of magnitude, not a measurement.
    return info.geometries * 48 * 1024 + info.textures * 512 * 1024;
  }

  /** Disposes the renderer and every listener. */
  destroy() {
    this._subscriptions.dispose();
    this.post.dispose();
    try {
      this.renderer.dispose();
      // Explicitly drop the GL context so a reloaded game does not have to wait
      // for the browser to reclaim it.
      this.renderer.forceContextLoss();
    } catch (error) {
      console.warn('[Renderer] disposal reported:', error);
    }
  }
}

export default Renderer;
