/**
 * Weather: a rain system plus the state machine that drives it.
 *
 * ## Why the rain is one static buffer
 *
 * Rain is a `THREE.Points` cloud whose positions are generated **once** into a
 * box the size of the player's immediate surroundings. Falling is done entirely
 * in the vertex shader: each droplet's Y is `startY - mod(time * speed + seed,
 * boxHeight)`, so the CPU never touches a single vertex per frame. The box
 * follows the camera, snapped to whole blocks, which is what keeps the droplet
 * pattern from visibly sliding along with the player.
 *
 * This is the difference between "rain" and "simulating world-sized weather
 * particles": the volume is a 40-block box around the camera, not the world, and
 * its cost is fixed regardless of render distance.
 *
 * ## Roof check
 *
 * A few times a second the column above the camera is scanned for an opaque
 * block. Under a roof, rain fades out and the rain sound is attenuated. The scan
 * is at most 128 voxel reads against already-resident chunk data.
 */

import * as THREE from 'three';

import { WEATHER_BUDGETS } from '../config/GraphicsPresets.js';
import { Events } from '../core/EventBus.js';
import { clamp, clamp01, damp, mulberry32 } from '../utils/MathUtils.js';

/** Edge length of the rain volume around the camera, in blocks. */
const RAIN_BOX_SIZE = 42;
/** Height of the rain volume, in blocks. */
const RAIN_BOX_HEIGHT = 26;
/** Seconds between roof checks. */
const ROOF_CHECK_INTERVAL = 0.3;

/** Player-facing copy per precipitation kind. */
const WEATHER_MESSAGES = Object.freeze({
  clear: 'The sky clears.',
  rain: 'It starts to rain.',
  thunder: 'A thunderstorm rolls in.',
  snow: 'Snow begins to fall.',
});
/** Seconds for weather intensity to ramp in or out. */
const INTENSITY_SMOOTHING = 0.05;

/** @enum {string} */
export const Weather = Object.freeze({
  CLEAR: 'clear',
  RAIN: 'rain',
});

/** Reused white for colour blending. */
const WHITE = new THREE.Color(1, 1, 1);

const RAIN_VERTEX_SHADER = /* glsl */ `
  attribute vec3 aRainSeed; // x: phase offset, y: fall speed, z: length scale

  uniform float uTime;
  uniform float uBoxHeight;
  uniform float uIntensity;
  uniform float uPointScale;
  uniform float uSnow;

  varying float vAlpha;
  varying float vStreak;

  void main() {
    vec3 offset = position;

    // Wrap the droplet through the box height; mod() makes the loop seamless.
    float speed = mix(aRainSeed.y, aRainSeed.y * 0.16, uSnow);
    float fall = mod(uTime * speed + aRainSeed.x, uBoxHeight);
    offset.y = position.y - fall;

    // A slight slant so rain reads as driven by wind rather than falling in a
    // perfect vertical line.
    offset.x += fall * mix(0.14, 0.025, uSnow) + sin(uTime * 0.8 + aRainSeed.x) * uSnow * 0.7;
    offset.z += fall * mix(0.06, 0.018, uSnow) + cos(uTime * 0.65 + aRainSeed.x) * uSnow * 0.55;

    vec4 worldPosition = modelMatrix * vec4(offset, 1.0);
    vec4 viewPosition = viewMatrix * worldPosition;

    // Fade droplets out near the edge of the volume so the box is invisible.
    float horizontalDistance = length(offset.xz);
    vAlpha = uIntensity * (1.0 - smoothstep(14.0, 21.0, horizontalDistance));
    vStreak = aRainSeed.z;

    gl_Position = projectionMatrix * viewPosition;
    // Perspective-correct size, clamped so close droplets are not enormous.
    gl_PointSize = clamp(uPointScale / max(-viewPosition.z, 1.0), 1.0, 7.0) * aRainSeed.z;
  }
`;

const RAIN_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uSnow;
  varying float vAlpha;
  varying float vStreak;

  void main() {
    if (vAlpha <= 0.01) discard;
    // Vertical streak inside the point sprite: bright core, soft ends.
    vec2 centred = gl_PointCoord - 0.5;
    float across = 1.0 - smoothstep(0.06, 0.3, abs(centred.x));
    float along = 1.0 - smoothstep(0.2, 0.5, abs(centred.y));
    float flake = 1.0 - smoothstep(0.18, 0.5, length(centred));
    float shape = mix(across * along, flake, uSnow);
    if (shape <= 0.01) discard;
    gl_FragColor = vec4(uColor, shape * vAlpha * 0.55);
  }
`;

export class WeatherRenderer {
  /**
   * @param {Object} options
   * @param {THREE.Scene} options.scene
   * @param {import('../core/SettingsManager.js').SettingsManager} options.settings
   * @param {import('../core/EventBus.js').EventBus} options.bus
   * @param {import('../world/World.js').World} options.world
   * @param {import('./LightingSystem.js').LightingSystem} options.lighting
   * @param {import('../core/ResourceManager.js').ResourceManager} options.resources
   * @param {number} options.seed
   */
  constructor({ scene, settings, bus, world, lighting, resources, seed }) {
    this._scene = scene;
    this._settings = settings;
    this._bus = bus;
    this._world = world;
    this._lighting = lighting;
    this._resources = resources;
    // Salted from the world seed so a given world always has the same droplet
    // distribution, which keeps the look reproducible.
    this._random = mulberry32(((seed >>> 0) ^ 0x7a19cd3f) >>> 0);

    /** Current weather. */
    this.weather = Weather.CLEAR;
    /** Requested intensity, 0..1. */
    this._targetIntensity = 0;
    /** Smoothed intensity actually rendered. */
    this.intensity = 0;
    /** 0 when fully sheltered, 1 when fully exposed to the sky. */
    this.exposure = 1;

    this._roofTimer = 0;
    this._droplets = 0;
    /** @type {THREE.Points|null} */
    this._rain = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._rainMaterial = null;
    /** @type {THREE.BufferGeometry|null} */
    this._rainGeometry = null;
    this._time = 0;
    this._lightning = 0;
    this._flashLight = new THREE.PointLight(0xdde9ff, 0, 120, 1.2);
    this._flashLight.name = 'weather-lightning-flash';
    scene.add(this._flashLight);

    this.applySettings(settings.values.graphics);
  }

  /** True when rain is currently audible/visible. */
  get isRaining() {
    return this.weather === Weather.RAIN && this.intensity > 0.02;
  }

  /** Effective rain loudness for the audio mixer, 0..1. */
  get audibleIntensity() {
    return this.intensity * (0.25 + this.exposure * 0.75);
  }

  /**
   * Requests a weather state.
   * @param {string} weather One of `Weather`.
   * @param {number} [intensity] 0..1; defaults to a moderate shower.
   */
  setWeather(weather, intensity = 0.75, kind = null) {
    const next = weather === Weather.RAIN ? Weather.RAIN : Weather.CLEAR;
    const changed = next !== this.weather || (kind !== null && kind !== this.precipitation);
    this.weather = next;
    /**
     * The specific precipitation reported by `WeatherSystem` — 'rain', 'snow',
     * 'thunder' or 'clear'. The droplet field is still a rain field this phase;
     * this records what it *represents* so the HUD and the notification can be
     * honest about it, and so the snow and lightning renderers in Phase 2 have
     * the state already threaded through.
     */
    this.precipitation = kind ?? (next === Weather.RAIN ? 'rain' : 'clear');
    this._targetIntensity = next === Weather.RAIN ? clamp01(intensity) : 0;
    if (changed) this._bus.emit(Events.NOTIFY, {
      level: 'info',
      message: WEATHER_MESSAGES[this.precipitation] ?? 'The weather changes.',
      id: 'weather',
      duration: 2500,
    });
  }

  /** Toggles between clear and rain. */
  toggleRain() {
    this.setWeather(this.weather === Weather.RAIN ? Weather.CLEAR : Weather.RAIN);
  }

  /**
   * Advances the weather.
   *
   * @param {number} dt
   * @param {THREE.Vector3} cameraPosition
   */
  update(dt, cameraPosition) {
    this._time += dt;
    this.intensity = damp(this.intensity, this._targetIntensity, INTENSITY_SMOOTHING, dt);
    if (this.intensity < 0.005) this.intensity = 0;

    this._roofTimer += dt;
    if (this._roofTimer >= ROOF_CHECK_INTERVAL) {
      this._roofTimer = 0;
      this.exposure = this._checkSkyExposure(cameraPosition);
    }

    // Rain darkens the world through the lighting system; the particles alone
    // would look like confetti.
    this._lighting.setWeatherInfluence(this.intensity * (0.35 + this.exposure * 0.65));
    this._lightning = Math.max(0, this._lightning - dt * 3.8);
    this._flashLight.intensity = this._lightning * 7;
    this._flashLight.position.set(cameraPosition.x, cameraPosition.y + 18, cameraPosition.z);

    if (!this._rain) return;

    const visible = this.intensity > 0.01 && this._droplets > 0;
    this._rain.visible = visible;
    if (!visible) return;

    // Snap to whole blocks: sub-block movement would make the droplet pattern
    // appear to drift sideways with the player.
    this._rain.position.set(
      Math.round(cameraPosition.x),
      Math.round(cameraPosition.y) + RAIN_BOX_HEIGHT * 0.5,
      Math.round(cameraPosition.z)
    );
    this._rain.updateMatrix();

    const uniforms = this._rainMaterial.uniforms;
    uniforms.uTime.value = this._time;
    uniforms.uIntensity.value = this.intensity * (0.15 + this.exposure * 0.85);
    uniforms.uSnow.value = this.precipitation === 'snow' ? 1 : 0;
    uniforms.uColor.value
      .copy(this._lighting.skyAmbient)
      .lerp(WHITE, 0.45)
      .multiplyScalar(0.6 + this._lighting.daylight * 0.6);
    if (this.precipitation === 'snow') uniforms.uColor.value.lerp(WHITE, 0.8);
  }

  /** Starts the short local sky flash associated with a simulated strike. */
  triggerLightning() {
    this._lightning = 1;
  }

  /**
   * Scans upward for a roof.
   * @returns {number} 1 when open to the sky, 0 when fully covered.
   */
  _checkSkyExposure(cameraPosition) {
    const blockX = Math.floor(cameraPosition.x);
    const blockZ = Math.floor(cameraPosition.z);
    const startY = Math.floor(cameraPosition.y) + 1;
    if (!this._world.isLoaded(blockX, blockZ)) return 1;

    const worldHeight = this._world.dimension?.height ?? 128;
    for (let y = startY; y < worldHeight; y++) {
      if (this._world.isOpaque(blockX, y, blockZ)) {
        // Covered. A very high roof still lets a little rain in visually, which
        // avoids rain snapping off under a single overhanging block.
        return y - startY > 24 ? 0.35 : 0;
      }
    }
    return 1;
  }

  /**
   * Applies graphics settings, rebuilding the droplet buffer when the budget
   * changes.
   * @param {Object} graphics The `graphics` settings group.
   */
  applySettings(graphics) {
    const budget = WEATHER_BUDGETS[graphics.weatherQuality] ?? 0;
    if (budget === this._droplets) return;
    this._droplets = budget;
    this._buildRain(budget);
  }

  _buildRain(count) {
    this._disposeRain();
    if (count <= 0) return;

    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 3);
    const half = RAIN_BOX_SIZE * 0.5;

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (this._random() - 0.5) * RAIN_BOX_SIZE;
      positions[i * 3 + 1] = this._random() * RAIN_BOX_HEIGHT;
      positions[i * 3 + 2] = (this._random() - 0.5) * RAIN_BOX_SIZE;
      // Phase offset spreads the droplets through the fall cycle.
      seeds[i * 3] = this._random() * RAIN_BOX_HEIGHT;
      // Fall speed in blocks per second.
      seeds[i * 3 + 1] = 16 + this._random() * 12;
      // Size variation.
      seeds[i * 3 + 2] = 0.6 + this._random() * 0.7;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aRainSeed', new THREE.BufferAttribute(seeds, 3));
    // The vertex shader moves droplets, so a static bounding sphere covering the
    // whole volume is required or Three would cull them incorrectly.
    geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(0, 0, 0),
      Math.hypot(half, RAIN_BOX_HEIGHT, half)
    );

    const material = new THREE.ShaderMaterial({
      name: 'rain',
      uniforms: {
        uTime: { value: 0 },
        uBoxHeight: { value: RAIN_BOX_HEIGHT },
        uIntensity: { value: 0 },
        uPointScale: { value: 220 },
        uSnow: { value: 0 },
        uColor: { value: new THREE.Color(0.78, 0.85, 0.95) },
      },
      vertexShader: RAIN_VERTEX_SHADER,
      fragmentShader: RAIN_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
      toneMapped: false,
    });

    const points = new THREE.Points(geometry, material);
    points.name = 'rain';
    points.frustumCulled = false;
    points.matrixAutoUpdate = false;
    points.renderOrder = 900;
    points.visible = false;

    this._scene.add(points);
    this._rain = points;
    this._rainGeometry = geometry;
    this._rainMaterial = material;

    this._resources.replaceShared('weather:rain-geometry', geometry);
    this._resources.replaceShared('weather:rain-material', material);
  }

  _disposeRain() {
    if (this._rain) {
      this._scene.remove(this._rain);
      this._rain = null;
    }
    if (this._rainGeometry) {
      this._resources.releaseShared('weather:rain-geometry');
      this._rainGeometry = null;
    }
    if (this._rainMaterial) {
      this._resources.releaseShared('weather:rain-material');
      this._rainMaterial = null;
    }
  }

  /** Number of droplets currently allocated, for the debug overlay. */
  get dropletCount() {
    return this._rain && this._rain.visible ? this._droplets : 0;
  }

  /** Removes the rain and clears the lighting influence. */
  destroy() {
    this._disposeRain();
    this._scene.remove(this._flashLight);
    this._lighting.setWeatherInfluence(0);
  }
}

export default WeatherRenderer;
