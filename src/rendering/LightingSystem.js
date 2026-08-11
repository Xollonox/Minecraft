/**
 * Sun, sky and shadow management.
 *
 * Owns the day/night cycle and derives every atmospheric value from it: sun and
 * moon directions, sun colour, hemisphere ambient, fog colour, cave ambient, and
 * the shadow camera. Those values are pushed into the voxel materials once per
 * frame and into `scene.fog` for the stock materials that entities use.
 *
 * ## Two light paths
 *
 * The scene holds a real `HemisphereLight` and `DirectionalLight`. Entities,
 * dropped items and the fallback material path are lit by them normally. The
 * custom voxel shader ignores their diffuse contribution — it computes sun and
 * sky itself so it can gate them by baked sky light — but it *does* read the
 * directional light's shadow map. So the directional light is simultaneously the
 * scene's sun and the voxel shader's shadow source, which keeps the two paths
 * consistent for free.
 *
 * ## Shadows
 *
 * One orthographic directional shadow map, re-centred on the player every frame
 * and snapped to a texel grid. Snapping is what stops the shadow edges from
 * crawling as you walk: without it the projection shifts by a fraction of a texel
 * every frame and every shadow boundary shimmers. Cascades are deliberately not
 * implemented — a single well-tuned map is stable, and the spec's priority is
 * stability over reach.
 */

import * as THREE from 'three';

import { SEA_LEVEL, TIME } from '../config/GameConfig.js';
import { SHADOW_MAP_SIZES } from '../config/GraphicsPresets.js';
import { clamp, clamp01, lerp, smoothstep } from '../utils/MathUtils.js';
import { Block } from '../world/BlockTypes.js';
import { MAX_POINT_LIGHTS } from './ShaderManager.js';
import { Materials } from './Materials.js';

/**
 * Key frames of the day. `t` is normalised time of day where 0 is midnight,
 * 0.25 sunrise, 0.5 noon and 0.75 sunset. Values are interpolated between
 * adjacent stops, which is what makes dawn and dusk continuous instead of a
 * hard switch.
 */
const SKY_KEYFRAMES = [
  {
    t: 0.0,
    zenith: [0.016, 0.024, 0.062],
    horizon: [0.04, 0.05, 0.1],
    sun: [0.06, 0.07, 0.12],
    glow: [0.08, 0.09, 0.16],
    fog: [0.05, 0.06, 0.11],
    skyAmbient: [0.055, 0.065, 0.11],
    groundAmbient: [0.022, 0.024, 0.034],
    starIntensity: 1,
  },
  {
    t: 0.21,
    zenith: [0.06, 0.09, 0.2],
    horizon: [0.32, 0.2, 0.22],
    sun: [0.5, 0.28, 0.2],
    glow: [0.72, 0.34, 0.2],
    fog: [0.26, 0.2, 0.24],
    skyAmbient: [0.16, 0.15, 0.2],
    groundAmbient: [0.06, 0.05, 0.055],
    starIntensity: 0.45,
  },
  {
    t: 0.28,
    zenith: [0.26, 0.44, 0.76],
    horizon: [0.94, 0.62, 0.42],
    sun: [1.0, 0.72, 0.44],
    glow: [1.0, 0.6, 0.32],
    fog: [0.74, 0.62, 0.58],
    skyAmbient: [0.34, 0.34, 0.4],
    groundAmbient: [0.14, 0.12, 0.1],
    starIntensity: 0.05,
  },
  {
    t: 0.5,
    zenith: [0.32, 0.55, 0.92],
    horizon: [0.68, 0.82, 0.97],
    sun: [1.0, 0.98, 0.93],
    glow: [1.0, 0.96, 0.86],
    fog: [0.66, 0.78, 0.93],
    skyAmbient: [0.46, 0.52, 0.62],
    groundAmbient: [0.2, 0.19, 0.16],
    starIntensity: 0,
  },
  {
    t: 0.72,
    zenith: [0.24, 0.4, 0.72],
    horizon: [0.96, 0.58, 0.36],
    sun: [1.0, 0.68, 0.4],
    glow: [1.0, 0.52, 0.26],
    fog: [0.76, 0.58, 0.5],
    skyAmbient: [0.32, 0.3, 0.34],
    groundAmbient: [0.13, 0.11, 0.09],
    starIntensity: 0.08,
  },
  {
    t: 0.79,
    zenith: [0.06, 0.08, 0.2],
    horizon: [0.3, 0.17, 0.2],
    sun: [0.4, 0.22, 0.18],
    glow: [0.56, 0.24, 0.18],
    fog: [0.22, 0.16, 0.2],
    skyAmbient: [0.14, 0.13, 0.18],
    groundAmbient: [0.055, 0.05, 0.05],
    starIntensity: 0.55,
  },
  {
    t: 1.0,
    zenith: [0.016, 0.024, 0.062],
    horizon: [0.04, 0.05, 0.1],
    sun: [0.06, 0.07, 0.12],
    glow: [0.08, 0.09, 0.16],
    fog: [0.05, 0.06, 0.11],
    skyAmbient: [0.055, 0.065, 0.11],
    groundAmbient: [0.022, 0.024, 0.034],
    starIntensity: 1,
  },
];

/** Minimum ambient so a moonlit surface is never pure black. */
const NIGHT_FLOOR = 0.028;
/** Ambient inside unlit caves. */
const CAVE_AMBIENT_BASE = 0.03;
/** Search radius for emissive-block point lights, in blocks. */
const POINT_LIGHT_RANGE = 26;

export class LightingSystem {
  /**
   * @param {Object} options
   * @param {THREE.Scene} options.scene
   * @param {import('../core/SettingsManager.js').SettingsManager} options.settings
   * @param {import('./Materials.js').Materials} options.materials
   * @param {import('../world/World.js').World} options.world
   */
  constructor({ scene, settings, materials, world }) {
    this._scene = scene;
    this._settings = settings;
    this._materials = materials;
    this._world = world;

    /** Normalised time of day, 0..1. */
    this.timeOfDay = TIME.startTime;
    /** True when the cycle is frozen. */
    this.paused = false;

    // --- scene lights ---
    this.hemisphere = new THREE.HemisphereLight(0x9fc4ff, 0x4a4034, 1.1);
    this.hemisphere.name = 'sky-hemisphere';
    scene.add(this.hemisphere);

    this.sun = new THREE.DirectionalLight(0xffffff, 2.4);
    this.sun.name = 'sun';
    this.sun.castShadow = false;
    // The target is what gives the light a direction; keeping it in the scene
    // means Three updates its matrix for us.
    this.sunTarget = new THREE.Object3D();
    scene.add(this.sunTarget);
    this.sun.target = this.sunTarget;
    scene.add(this.sun);

    /** Warm bounce light so the unlit side of terrain is not flat. */
    this.moon = new THREE.DirectionalLight(0xaebcd8, 0.16);
    this.moon.name = 'moon';
    this.moon.castShadow = false;
    scene.add(this.moon);

    scene.fog = new THREE.Fog(0x9fc0e8, 40, 160);

    // --- derived state, reused every frame ---
    this.sunDirection = new THREE.Vector3(0.4, 0.9, 0.2).normalize();
    this.moonDirection = new THREE.Vector3(-0.4, -0.9, -0.2).normalize();
    this.sunColor = new THREE.Color(1, 1, 1);
    this.glowColor = new THREE.Color(1, 1, 1);
    this.zenithColor = new THREE.Color(0.3, 0.5, 0.9);
    this.horizonColor = new THREE.Color(0.7, 0.8, 0.95);
    this.fogColor = new THREE.Color(0.66, 0.78, 0.93);
    this.skyAmbient = new THREE.Color(0.46, 0.52, 0.62);
    this.groundAmbient = new THREE.Color(0.2, 0.19, 0.16);
    this.waterTint = new THREE.Color(0.72, 0.86, 1);
    this.starIntensity = 0;
    /** 0 at night, 1 at midday; useful for weather and audio. */
    this.daylight = 1;

    this._shadowsEnabled = false;
    this._shadowMapSize = 0;
    this._pointLights = [];
    this._lightingState = {
      sunDirection: this.sunDirection,
      sunColor: this.sunColor,
      skyAmbient: this.skyAmbient,
      groundAmbient: this.groundAmbient,
      horizonColor: this.horizonColor,
      fogColor: this.fogColor,
      fogNear: 40,
      fogFar: 160,
      fogStrength: 1,
      caveAmbient: CAVE_AMBIENT_BASE,
      brightness: 1,
      saturation: 1,
      waterTint: this.waterTint,
    };

    this._scratchColorA = new THREE.Color();
    this._submergedLiquid = Block.AIR;
    /**
     * 0 in clear weather, up to 1 in heavy rain. Darkens the sky and shortens
     * the fog, which is what actually sells rain — the particles alone read as
     * confetti without it.
     */
    this._weatherDarkening = 0;

    this.applySettings(settings.values.graphics);
  }

  /**
   * The current lighting state, in the shape `Materials.applyLighting` consumes.
   *
   * Exposed so other renderers (entities, particles) can be lit consistently with
   * the terrain from a single source of truth rather than recomputing it.
   * @returns {Object}
   */
  get lightingState() {
    return this._lightingState;
  }

  /** Sets the time of day directly. */
  setTimeOfDay(value) {
    this.timeOfDay = ((value % 1) + 1) % 1;
  }

  /** True when the camera is submerged; switches to underwater fog. */
  setUnderwater(underwater) {
    this.setSubmergedLiquid(underwater ? Block.WATER : Block.AIR);
  }

  /** Selects the atmospheric profile for the liquid around the camera. */
  setSubmergedLiquid(blockId) {
    this._submergedLiquid = blockId === Block.WATER || blockId === Block.LAVA
      ? blockId
      : Block.AIR;
  }

  /**
   * How strongly the current weather should darken the world.
   * @param {number} amount 0 (clear) to 1 (heavy rain).
   */
  setWeatherInfluence(amount) {
    this._weatherDarkening = clamp01(amount);
  }

  /**
   * Advances the cycle and recomputes every derived value.
   *
   * @param {number} dt Seconds.
   * @param {THREE.Vector3} cameraPosition
   */
  update(dt, cameraPosition) {
    const gameplay = this._settings.values.gameplay;
    if (!this.paused && !gameplay.pauseDayCycle && gameplay.dayCycleSpeed > 0) {
      this.timeOfDay =
        (this.timeOfDay + (dt * gameplay.dayCycleSpeed) / TIME.secondsPerDay) % 1;
    }

    this._evaluateSky();
    this._updateSunDirection();
    this._updateSceneLights();
    this._updateShadowCamera(cameraPosition);
    this._updateFog(cameraPosition);
    this._updatePointLights(cameraPosition);

    this._materials.applyLighting(this._lightingState);
  }

  /** Interpolates the keyframe table at the current time of day. */
  _evaluateSky() {
    const t = this.timeOfDay;
    let next = 1;
    while (next < SKY_KEYFRAMES.length - 1 && SKY_KEYFRAMES[next].t < t) next++;
    const a = SKY_KEYFRAMES[next - 1];
    const b = SKY_KEYFRAMES[next];
    const span = b.t - a.t;
    const blend = span <= 0 ? 0 : clamp01((t - a.t) / span);
    // Smoothstep the blend so keyframe boundaries are not visible as a crease in
    // the colour ramp.
    const eased = blend * blend * (3 - 2 * blend);

    mixInto(this.zenithColor, a.zenith, b.zenith, eased);
    mixInto(this.horizonColor, a.horizon, b.horizon, eased);
    mixInto(this.sunColor, a.sun, b.sun, eased);
    mixInto(this.glowColor, a.glow, b.glow, eased);
    mixInto(this.fogColor, a.fog, b.fog, eased);
    mixInto(this.skyAmbient, a.skyAmbient, b.skyAmbient, eased);
    mixInto(this.groundAmbient, a.groundAmbient, b.groundAmbient, eased);
    this.starIntensity = lerp(a.starIntensity, b.starIntensity, eased);

    // Night floor: keep a sliver of ambient so shapes stay readable.
    this.skyAmbient.r = Math.max(this.skyAmbient.r, NIGHT_FLOOR);
    this.skyAmbient.g = Math.max(this.skyAmbient.g, NIGHT_FLOOR);
    this.skyAmbient.b = Math.max(this.skyAmbient.b, NIGHT_FLOOR * 1.3);

    // 0 at night, 1 during the day, ramping across dawn and dusk.
    this.daylight = t < 0.5 ? smoothstep(0.2, 0.32, t) : 1 - smoothstep(0.68, 0.8, t);
  }

  /**
   * Places the sun on a great circle tilted off the vertical.
   *
   * A tilt means the sun does not pass exactly overhead, so shadows have a
   * consistent direction through the day instead of flipping at noon — which is
   * both more natural and much kinder to shadow-map stability.
   */
  _updateSunDirection() {
    // angle 0 at midnight, π/2 at sunrise... choose so 0.25 -> sunrise in +X.
    const angle = (this.timeOfDay - 0.25) * Math.PI * 2;
    const tilt = 0.32;
    const x = Math.cos(angle);
    const y = Math.sin(angle);
    this.sunDirection.set(x, y, tilt * Math.cos(angle * 0.5) + 0.18).normalize();
    this.moonDirection.copy(this.sunDirection).multiplyScalar(-1);
  }

  _updateSceneLights() {
    const above = clamp01(this.sunDirection.y * 3 + 0.15) * (1 - this._weatherDarkening * 0.75);

    this.sun.color.copy(this.sunColor);
    this.sun.intensity = 2.6 * above;
    this.sun.visible = this.sun.intensity > 0.01;

    this.moon.color.setRGB(0.68, 0.74, 0.95);
    this.moon.intensity = 0.22 * (1 - above);
    this.moon.position.copy(this.moonDirection).multiplyScalar(120);
    this.moon.visible = this.moon.intensity > 0.01;

    this.hemisphere.color.copy(this.skyAmbient).multiplyScalar(2.2);
    this.hemisphere.groundColor.copy(this.groundAmbient).multiplyScalar(2.2);
    this.hemisphere.intensity = 1.15;

    // Water reads colder at night and warmer at golden hour.
    this._scratchColorA.copy(this.skyAmbient).multiplyScalar(1.4);
    this.waterTint.setRGB(
      lerp(0.5, 0.74, above) + this._scratchColorA.r * 0.2,
      lerp(0.62, 0.87, above) + this._scratchColorA.g * 0.15,
      lerp(0.82, 1.0, above) + this._scratchColorA.b * 0.1
    );
  }

  /**
   * Re-centres the shadow frustum on the player and snaps it to a texel grid.
   */
  _updateShadowCamera(cameraPosition) {
    if (!this._shadowsEnabled || !this.sun.castShadow) {
      // Still track the light position so entity lighting direction is right.
      this.sun.position.copy(cameraPosition).addScaledVector(this.sunDirection, 120);
      this.sunTarget.position.copy(cameraPosition);
      return;
    }

    const distance = clamp(this._settings.get('graphics.shadowDistance'), 16, 160);
    const extent = distance * 0.5;

    // Snap the shadow camera's focus to whole shadow-map texels. Sub-texel
    // movement is what makes shadow edges crawl while walking.
    const texelWorldSize = (extent * 2) / Math.max(1, this._shadowMapSize);
    const snappedX = Math.round(cameraPosition.x / texelWorldSize) * texelWorldSize;
    const snappedZ = Math.round(cameraPosition.z / texelWorldSize) * texelWorldSize;
    const snappedY = Math.round(cameraPosition.y / texelWorldSize) * texelWorldSize;

    this.sunTarget.position.set(snappedX, snappedY, snappedZ);
    this.sun.position
      .set(snappedX, snappedY, snappedZ)
      .addScaledVector(this.sunDirection, distance * 1.2);

    const shadowCamera = this.sun.shadow.camera;
    if (
      shadowCamera.left !== -extent ||
      shadowCamera.right !== extent ||
      shadowCamera.far !== distance * 2.6
    ) {
      shadowCamera.left = -extent;
      shadowCamera.right = extent;
      shadowCamera.top = extent;
      shadowCamera.bottom = -extent;
      shadowCamera.near = 0.5;
      shadowCamera.far = distance * 2.6;
      shadowCamera.updateProjectionMatrix();
    }
  }

  _updateFog(cameraPosition) {
    const graphics = this._settings.values.graphics;
    const range = Materials.computeFogRange(
      graphics.renderDistance,
      graphics.fogDensity,
      graphics.fog
    );

    const state = this._lightingState;

    if (this._submergedLiquid === Block.WATER) {
      // Underwater: a much tighter, blue-green fog. This is the primary visual
      // cue that the player is submerged and it doubles as a performance win.
      state.fogColor.setRGB(0.06, 0.22, 0.34).multiplyScalar(0.5 + this.daylight * 0.9);
      state.fogNear = 0.5;
      state.fogFar = 22;
      state.fogStrength = 1;
      state.caveAmbient = CAVE_AMBIENT_BASE + 0.02;
    } else if (this._submergedLiquid === Block.LAVA) {
      // Lava is intentionally almost opaque: the player gets a short, hot-red
      // sight line rather than the blue underwater profile.
      state.fogColor.setRGB(0.52, 0.11, 0.015);
      state.fogNear = 0.08;
      state.fogFar = 4.5;
      state.fogStrength = 1;
      state.caveAmbient = CAVE_AMBIENT_BASE + 0.08;
    } else {
      state.fogColor.copy(this.fogColor);
      if (this._weatherDarkening > 0) {
        // Rain desaturates the fog towards grey and pulls it much closer, which
        // is what makes a downpour feel enclosed.
        const grey = (state.fogColor.r + state.fogColor.g + state.fogColor.b) / 3;
        state.fogColor.lerp(
          this._scratchColorA.setRGB(grey * 0.72, grey * 0.75, grey * 0.8),
          this._weatherDarkening * 0.8
        );
      }
      state.fogNear = lerp(range.near, range.near * 0.35, this._weatherDarkening);
      state.fogFar = lerp(range.far, range.far * 0.55, this._weatherDarkening);
      state.fogStrength = range.strength;
      state.caveAmbient = CAVE_AMBIENT_BASE;
    }

    state.brightness = clamp(graphics.brightness, 0.5, 2);
    state.saturation = clamp(graphics.colorGrading, 0, 2) * (1 - this._weatherDarkening * 0.35);
    state.sunColor
      .copy(this.sunColor)
      .multiplyScalar(clamp01(this.sunDirection.y * 2.4 + 0.1) * (1 - this._weatherDarkening * 0.8));

    // Keep `scene.fog` in step for the stock materials used by entities.
    const fog = this._scene.fog;
    if (fog) {
      fog.color.copy(state.fogColor);
      fog.near = state.fogStrength > 0 ? state.fogNear : 10000;
      fog.far = state.fogStrength > 0 ? state.fogFar : 20000;
    }

    // Deep underground, dim the sky contribution further: at y=10 there is no
    // reason for the sky ambient term to be at surface strength.
    const depthFactor = clamp01((cameraPosition.y - 8) / (SEA_LEVEL - 8));
    state.skyAmbient.copy(this.skyAmbient).multiplyScalar(lerp(0.55, 1, depthFactor));
    state.groundAmbient.copy(this.groundAmbient);
  }

  /** Collects nearby emissive blocks and hands them to the materials. */
  _updatePointLights(cameraPosition) {
    if (!this._world) return;
    this._world.collectNearbyLights(
      cameraPosition,
      MAX_POINT_LIGHTS,
      POINT_LIGHT_RANGE,
      this._pointLights
    );
    this._materials.setPointLights(this._pointLights);
  }

  /**
   * Applies graphics settings: shadow enable, map size and filtering.
   * @param {Object} graphics The `graphics` settings group.
   */
  applySettings(graphics) {
    const wanted = Boolean(graphics.shadows);
    const size = SHADOW_MAP_SIZES[graphics.shadowQuality] ?? SHADOW_MAP_SIZES.medium;

    if (wanted !== this._shadowsEnabled || size !== this._shadowMapSize) {
      this._shadowsEnabled = wanted;
      this._shadowMapSize = size;

      // Disposing the old shadow map is essential: changing the size otherwise
      // leaks the previous render target on the GPU.
      if (this.sun.shadow.map) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null;
      }
      this.sun.castShadow = wanted;
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.bias = -0.0006;
      this.sun.shadow.normalBias = 0.045;
      this.sun.shadow.radius = graphics.shadowQuality === 'high' ? 2.5 : 1.5;
      this.sun.shadow.needsUpdate = true;
    }
  }

  /** Total shadow-map memory in bytes, for the debug overlay. */
  getShadowMemory() {
    if (!this._shadowsEnabled) return 0;
    return this._shadowMapSize * this._shadowMapSize * 4;
  }

  /** Removes lights from the scene and disposes the shadow map. */
  destroy() {
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null;
    }
    this._scene.remove(this.sun);
    this._scene.remove(this.sunTarget);
    this._scene.remove(this.moon);
    this._scene.remove(this.hemisphere);
    this._scene.fog = null;
    this._pointLights.length = 0;
  }
}

/** Interpolates two `[r, g, b]` triples into a `THREE.Color`. */
function mixInto(target, from, to, t) {
  target.setRGB(
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t
  );
  return target;
}

export default LightingSystem;
