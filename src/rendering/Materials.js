/**
 * Shared materials for the four chunk render layers.
 *
 * There is exactly **one material per layer for the entire world**, not one per
 * chunk and certainly not one per block. Every chunk mesh points at the same four
 * material instances, which is what lets Three batch state changes and what makes
 * a settings change (fog colour, sun direction, water animation) a handful of
 * uniform writes rather than a walk over hundreds of meshes.
 *
 * That sharing is also why `ResourceManager` distinguishes shared from transient
 * resources: disposing a chunk must never dispose these.
 *
 * ## Fallback path
 *
 * The custom voxel shader is validated at build time (see `ShaderManager`). If
 * the GPU rejects it — ancient driver, no high-precision floats, an unexpected
 * GLSL dialect quirk — `Materials` swaps in stock `MeshLambertMaterial`s lit by
 * the scene's real hemisphere and directional lights. Baked ambient occlusion and
 * the custom fog are lost, but the world remains visible and fully playable,
 * which is the only outcome that matters.
 */

import * as THREE from 'three';

import { LAYER_NAMES } from '../config/GameConfig.js';
import { MAX_POINT_LIGHTS } from './ShaderManager.js';
import { WATER_SCROLL_PERIOD, waterScrollForTime, waterUvUniforms } from './WaterUv.js';
import { clamp } from '../utils/MathUtils.js';

/** Alpha threshold for the cutout layer. */
const CUTOUT_ALPHA_TEST = 0.5;

/** Water opacity per quality level. */
const WATER_OPACITY = { simple: 0.86, animated: 0.78, reflective: 0.74 };
/** Fresnel/specular strength per water quality level. */
const WATER_REFLECTIVITY = { simple: 0, animated: 0.35, reflective: 0.8 };
/** Vertex wave amplitude in blocks per water quality level. */
const WATER_WAVE_HEIGHT = { simple: 0, animated: 0.028, reflective: 0.04 };

/**
 * Colour of the stock water fallback, used when the water shader is rejected.
 *
 * Deliberately a literal blue/teal rather than the atlas texture: the fallback
 * exists precisely for the case where something about the texture or shader
 * pipeline is broken, so it must not depend on either. A flat tint can never be
 * magenta.
 */
const FALLBACK_WATER_COLOR = 0x2f7fb8;

export class Materials {
  /**
   * @param {Object} options
   * @param {import('./ShaderManager.js').ShaderManager} options.shaderManager
   * @param {import('./TextureAtlas.js').TextureAtlas} options.atlas
   * @param {import('../core/SettingsManager.js').SettingsManager} options.settings
   * @param {import('../core/ResourceManager.js').ResourceManager} options.resources
   */
  constructor({ shaderManager, atlas, settings, resources }) {
    this._shaders = shaderManager;
    this._atlas = atlas;
    this._settings = settings;
    this._resources = resources;

    /** @type {Record<string, THREE.Material>} */
    this._materials = Object.create(null);
    /** @type {THREE.ShaderMaterial[]} Voxel-family materials sharing uniforms. */
    this._voxelMaterials = [];
    /** @type {THREE.ShaderMaterial|null} */
    this._waterMaterial = null;

    this.usingFallback = false;
    /** True when the water shader was rejected and a stock material is in use. */
    this.usingWaterFallback = false;
    this._time = 0;

    /** Point light slots, reused every frame to avoid per-frame allocation. */
    this._pointLightData = Array.from({ length: MAX_POINT_LIGHTS }, () => new THREE.Vector4());
    this._pointLightCount = 0;
  }

  /**
   * Creates every material. Safe to call again after a context restore.
   * @returns {boolean} False when the custom shader path was rejected.
   */
  build() {
    this.dispose();

    const graphics = this._settings.values.graphics;
    const shadowsWanted = Boolean(graphics.shadows);

    const probe = this._createVoxelMaterial('opaque');
    const validation = this._shaders.validateMaterial(probe, { shadows: shadowsWanted });

    if (!validation.ok) {
      probe.dispose();
      this.usingFallback = true;
      this._buildFallbackMaterials();
      return false;
    }

    this.usingFallback = false;
    this._materials.opaque = probe;
    this._voxelMaterials.push(probe);

    this._materials.cutout = this._registerVoxel('cutout');
    this._materials.translucent = this._registerVoxel('translucent');

    // Water is validated separately: it is a different program, and a failure
    // there should cost the animated surface rather than the whole world.
    const water = this._createWaterMaterial();
    const waterCheck = this._shaders.validateMaterial(water, {
      shadows: shadowsWanted,
      label: 'water',
    });
    if (waterCheck.ok) {
      this._waterMaterial = water;
      this._materials.liquid = water;
      this.usingWaterFallback = false;
    } else {
      water.dispose();
      this._waterMaterial = null;
      this._materials.liquid = this._createFallbackWater();
      this.usingWaterFallback = true;
    }

    for (const name of LAYER_NAMES) {
      this._resources.replaceShared(`material:${name}`, this._materials[name]);
    }

    this.applySettings(graphics);

    const waterProblems = this.verifyWaterMaterial();
    if (waterProblems.length > 0) {
      // Loud but non-fatal: the surface is still drawn, and shouting in the
      // console beats shipping a silently mis-configured material.
      console.error(`Water material is misconfigured: ${waterProblems.join('; ')}`);
    }

    return true;
  }

  /**
   * Runtime assertion that the liquid layer is ready to draw water correctly.
   *
   * Checks the things that historically produced a wrong-looking surface: a
   * missing uniform, a null atlas, a lost transparency flag, and an unbounded
   * UV scroll. Returns problems rather than throwing so a misconfiguration
   * degrades the surface instead of killing the session.
   *
   * @returns {string[]} Empty when the liquid material is sound.
   */
  verifyWaterMaterial() {
    const problems = [];
    const material = this._materials.liquid;

    if (!material) {
      problems.push('no liquid material was created');
      return problems;
    }
    if (!material.transparent) problems.push('liquid material is not transparent');

    if (this.usingWaterFallback) {
      // The fallback must not depend on the atlas, or it can reproduce the
      // artefact it exists to avoid.
      if (material.map) problems.push('fallback water must not sample the atlas');
      if (!material.color) problems.push('fallback water has no tint');
      return problems;
    }

    const required = [
      'uAtlas',
      'uTime',
      'uOpacity',
      'uReflectivity',
      'uWaveHeight',
      'uWaveSpeed',
      'uUvScroll',
      'uWaterTileRect',
      'uWaterUvGuard',
      'uSunDirection',
      'uSunColor',
      'uSkyAmbient',
      'uHorizonColor',
      'uWaterTint',
      'uCaveAmbient',
      'uFogColor',
      'uFogNear',
      'uFogFar',
      'uFogStrength',
      'uBrightness',
    ];
    for (const name of required) {
      if (!material.uniforms || material.uniforms[name] === undefined) {
        problems.push(`missing uniform ${name}`);
      }
    }

    if (material.uniforms?.uAtlas?.value == null) {
      problems.push('uAtlas has no texture');
    }

    const scroll = material.uniforms?.uUvScroll?.value;
    if (typeof scroll === 'number' && Math.abs(scroll) > WATER_SCROLL_PERIOD) {
      problems.push(`uUvScroll ${scroll} is outside its wrap period`);
    }

    const guard = material.uniforms?.uWaterUvGuard?.value;
    if (guard && guard.x * 0.5 > guard.y + 1e-9) {
      problems.push('folded UV offset can exceed the atlas padding budget');
    }

    return problems;
  }

  /**
   * Snapshot of the water path for the debug overlay.
   * @returns {{shader: boolean, scroll: number, healthy: boolean}}
   */
  get waterDiagnostics() {
    return {
      shader: !this.usingWaterFallback && !this.usingFallback,
      scroll: this._waterMaterial ? this._waterMaterial.uniforms.uUvScroll.value : 0,
      healthy: this.verifyWaterMaterial().length === 0,
    };
  }

  _registerVoxel(layerName) {
    const material = this._createVoxelMaterial(layerName);
    this._voxelMaterials.push(material);
    return material;
  }

  /**
   * The material for a render layer.
   * @param {string} layerName One of `LAYER_NAMES`.
   * @returns {THREE.Material}
   */
  forLayer(layerName) {
    return this._materials[layerName] || this._materials.opaque;
  }

  // ------------------------------------------------------------------ creation

  _createVoxelMaterial(layerName) {
    const isCutout = layerName === 'cutout';
    const isTranslucent = layerName === 'translucent';

    // `UniformsLib.lights` must be present and `lights: true` set, or Three will
    // not populate the shadow-map uniforms that `voxel.frag.glsl` reads.
    const uniforms = Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.lights), {
      uAtlas: { value: this._atlas.texture },
      uAlphaTest: { value: isCutout ? CUTOUT_ALPHA_TEST : 0.0 },
      uOpacity: { value: 1 },
      uTime: { value: 0 },
      uLeafSway: { value: 0 },
      uGrassSway: { value: 0 },

      uSunDirection: { value: new THREE.Vector3(0.4, 0.85, 0.3).normalize() },
      uSunColor: { value: new THREE.Color(1, 0.97, 0.9) },
      uSkyAmbient: { value: new THREE.Color(0.42, 0.5, 0.62) },
      uGroundAmbient: { value: new THREE.Color(0.2, 0.19, 0.16) },
      uCaveAmbient: { value: 0.035 },
      uBlockLightBoost: { value: 1.15 },
      uBlockLightColor: { value: new THREE.Color(1, 0.72, 0.4) },

      uFogColor: { value: new THREE.Color(0.62, 0.74, 0.9) },
      uFogNear: { value: 40 },
      uFogFar: { value: 160 },
      uFogStrength: { value: 1 },

      uBrightness: { value: 1 },
      uSaturation: { value: 1 },

      uPointLightCount: { value: 0 },
      uPointLights: { value: this._pointLightData },
      uPointLightColor: { value: new THREE.Color(1, 0.68, 0.36) },
    });

    const material = new THREE.ShaderMaterial({
      name: `voxel-${layerName}`,
      uniforms,
      defines: this._shaders.getCommonDefines(),
      vertexShader: this._shaders.sources.voxelVertex,
      fragmentShader: this._shaders.sources.voxelFragment,
      lights: true,
      fog: false, // fog is computed in the shader against our own uniforms
      transparent: isTranslucent,
      depthWrite: true,
      depthTest: true,
      side: THREE.FrontSide,
      toneMapped: true,
    });

    // Glass needs blending; foliage discards instead, which keeps it sortable and
    // able to write depth.
    if (isTranslucent) {
      material.blending = THREE.NormalBlending;
      material.premultipliedAlpha = false;
    }

    return material;
  }

  _createWaterMaterial() {
    const { rect, guard } = waterUvUniforms();
    const uniforms = {
      uAtlas: { value: this._atlas.texture },
      uTime: { value: 0 },
      uOpacity: { value: WATER_OPACITY.animated },
      uReflectivity: { value: WATER_REFLECTIVITY.animated },
      uWaveHeight: { value: WATER_WAVE_HEIGHT.animated },
      uWaveSpeed: { value: 1.1 },
      uUvScroll: { value: 0 },

      // Bounds the animated sample to the water tile's padded cell. Without
      // these the scroll walks into unpainted atlas cells and the surface turns
      // magenta; see `WaterUv.js`.
      uWaterTileRect: { value: new THREE.Vector4(rect[0], rect[1], rect[2], rect[3]) },
      uWaterUvGuard: { value: new THREE.Vector2(guard[0], guard[1]) },

      uSunDirection: { value: new THREE.Vector3(0.4, 0.85, 0.3).normalize() },
      uSunColor: { value: new THREE.Color(1, 0.97, 0.9) },
      uSkyAmbient: { value: new THREE.Color(0.42, 0.5, 0.62) },
      uHorizonColor: { value: new THREE.Color(0.7, 0.82, 0.95) },
      uWaterTint: { value: new THREE.Color(0.72, 0.86, 1.0) },
      uCaveAmbient: { value: 0.035 },

      uFogColor: { value: new THREE.Color(0.62, 0.74, 0.9) },
      uFogNear: { value: 40 },
      uFogFar: { value: 160 },
      uFogStrength: { value: 1 },
      uBrightness: { value: 1 },
    };

    return new THREE.ShaderMaterial({
      name: 'voxel-water',
      uniforms,
      vertexShader: this._shaders.sources.waterVertex,
      fragmentShader: this._shaders.sources.waterFragment,
      transparent: true,
      // Depth writing keeps a lake surface stable rather than letting the shell's
      // own faces fight each other; the trade-off is no water-behind-water
      // blending, which is invisible at voxel scale.
      depthWrite: true,
      depthTest: true,
      // Double sided so the surface is still there when seen from underneath.
      side: THREE.DoubleSide,
      toneMapped: true,
    });
  }

  /**
   * Stock translucent material used when only the water shader is rejected.
   *
   * Uses a flat blue/teal tint and no texture map on purpose. The fallback is
   * the last line of defence when the shader or texture pipeline has failed, so
   * depending on the atlas here would risk reproducing the very artefact it is
   * meant to prevent. `MeshStandardMaterial` so it still responds to the
   * scene's real lights.
   */
  _createFallbackWater() {
    return new THREE.MeshStandardMaterial({
      name: 'fallback-liquid',
      color: new THREE.Color(FALLBACK_WATER_COLOR),
      transparent: true,
      opacity: WATER_OPACITY.animated,
      depthWrite: true,
      side: THREE.DoubleSide,
      roughness: 0.24,
      metalness: 0.02,
    });
  }

  /**
   * Stock-material fallback used when the custom shader will not compile.
   * Lit by the scene's real lights instead of the baked attributes.
   */
  _buildFallbackMaterials() {
    const atlas = this._atlas.texture;

    this._materials.opaque = new THREE.MeshLambertMaterial({
      name: 'fallback-opaque',
      map: atlas,
    });
    this._materials.cutout = new THREE.MeshLambertMaterial({
      name: 'fallback-cutout',
      map: atlas,
      transparent: false,
      alphaTest: CUTOUT_ALPHA_TEST,
    });
    this._materials.translucent = new THREE.MeshLambertMaterial({
      name: 'fallback-translucent',
      map: atlas,
      transparent: true,
      depthWrite: true,
    });
    this._materials.liquid = new THREE.MeshLambertMaterial({
      name: 'fallback-liquid',
      map: atlas,
      transparent: true,
      opacity: 0.8,
      depthWrite: true,
      side: THREE.DoubleSide,
    });

    for (const name of LAYER_NAMES) {
      this._resources.replaceShared(`material:${name}`, this._materials[name]);
    }
  }

  // -------------------------------------------------------------------- update

  /**
   * Advances animation uniforms.
   * @param {number} dt Seconds.
   */
  update(dt) {
    this._time += dt;
    if (this.usingFallback) return;

    for (const material of this._voxelMaterials) {
      material.uniforms.uTime.value = this._time;
    }
    if (this._waterMaterial) {
      this._waterMaterial.uniforms.uTime.value = this._time;
      const animate = this._settings.get('graphics.waterAnimation');
      // Wrapped, not `this._time * rate`. An unbounded scroll walks the sample
      // out of the water tile and into unpainted (magenta) atlas cells, and it
      // also bleeds float32 precision as the session lengthens.
      this._waterMaterial.uniforms.uUvScroll.value = animate
        ? waterScrollForTime(this._time)
        : 0;
    }
  }

  /**
   * Pushes the current lighting and atmosphere into every material.
   *
   * Called once per frame by `LightingSystem`; a single object rather than a
   * dozen setters so adding an atmospheric term does not ripple through call
   * sites.
   *
   * @param {Object} state
   * @param {THREE.Vector3} state.sunDirection Unit vector *towards* the sun.
   * @param {THREE.Color} state.sunColor
   * @param {THREE.Color} state.skyAmbient
   * @param {THREE.Color} state.groundAmbient
   * @param {THREE.Color} state.horizonColor
   * @param {THREE.Color} state.fogColor
   * @param {number} state.fogNear
   * @param {number} state.fogFar
   * @param {number} state.fogStrength
   * @param {number} state.caveAmbient
   * @param {number} state.brightness
   * @param {number} state.saturation
   * @param {THREE.Color} state.waterTint
   */
  applyLighting(state) {
    if (this.usingFallback) return;

    for (const material of this._voxelMaterials) {
      const uniforms = material.uniforms;
      uniforms.uSunDirection.value.copy(state.sunDirection);
      uniforms.uSunColor.value.copy(state.sunColor);
      uniforms.uSkyAmbient.value.copy(state.skyAmbient);
      uniforms.uGroundAmbient.value.copy(state.groundAmbient);
      uniforms.uCaveAmbient.value = state.caveAmbient;
      uniforms.uFogColor.value.copy(state.fogColor);
      uniforms.uFogNear.value = state.fogNear;
      uniforms.uFogFar.value = state.fogFar;
      uniforms.uFogStrength.value = state.fogStrength;
      uniforms.uBrightness.value = state.brightness;
      uniforms.uSaturation.value = state.saturation;
    }

    if (this._waterMaterial) {
      const uniforms = this._waterMaterial.uniforms;
      uniforms.uSunDirection.value.copy(state.sunDirection);
      uniforms.uSunColor.value.copy(state.sunColor);
      uniforms.uSkyAmbient.value.copy(state.skyAmbient);
      uniforms.uHorizonColor.value.copy(state.horizonColor);
      uniforms.uWaterTint.value.copy(state.waterTint);
      uniforms.uCaveAmbient.value = state.caveAmbient;
      uniforms.uFogColor.value.copy(state.fogColor);
      uniforms.uFogNear.value = state.fogNear;
      uniforms.uFogFar.value = state.fogFar;
      uniforms.uFogStrength.value = state.fogStrength;
      uniforms.uBrightness.value = state.brightness;
    }
  }

  /**
   * Sets the emissive-block point lights.
   *
   * @param {Array<{x: number, y: number, z: number, range: number}>} lights
   *   Already sorted nearest-first and truncated by the caller.
   */
  setPointLights(lights) {
    const count = Math.min(lights.length, MAX_POINT_LIGHTS);
    this._pointLightCount = count;
    for (let i = 0; i < count; i++) {
      const light = lights[i];
      // `w` stores the reciprocal range so the shader can attenuate with a
      // multiply instead of a divide.
      this._pointLightData[i].set(light.x, light.y, light.z, 1 / Math.max(0.001, light.range));
    }
    for (let i = count; i < MAX_POINT_LIGHTS; i++) {
      this._pointLightData[i].set(0, -1000, 0, 1);
    }
    if (this.usingFallback) return;
    for (const material of this._voxelMaterials) {
      material.uniforms.uPointLightCount.value = count;
    }
  }

  /**
   * Applies graphics settings that affect materials.
   * @param {Object} graphics The `graphics` settings group.
   */
  applySettings(graphics) {
    this._atlas.applySettings(graphics);

    if (this.usingFallback) {
      this._materials.liquid.opacity = WATER_OPACITY[graphics.waterQuality] ?? 0.8;
      return;
    }

    const leafSway = graphics.leavesAnimation ? 0.045 : 0;
    const grassSway = graphics.grassAnimation ? 0.075 : 0;
    for (const material of this._voxelMaterials) {
      material.uniforms.uLeafSway.value = leafSway;
      material.uniforms.uGrassSway.value = grassSway;
    }

    if (!this._waterMaterial) {
      // Water fell back to a stock material; only opacity is adjustable.
      const liquid = this._materials.liquid;
      if (liquid) liquid.opacity = WATER_OPACITY[graphics.waterQuality] ?? WATER_OPACITY.animated;
    }

    if (this._waterMaterial) {
      const quality = graphics.waterQuality;
      const uniforms = this._waterMaterial.uniforms;
      uniforms.uOpacity.value = WATER_OPACITY[quality] ?? WATER_OPACITY.animated;
      uniforms.uReflectivity.value = WATER_REFLECTIVITY[quality] ?? WATER_REFLECTIVITY.animated;
      uniforms.uWaveHeight.value = graphics.waterAnimation
        ? (WATER_WAVE_HEIGHT[quality] ?? WATER_WAVE_HEIGHT.animated)
        : 0;
    }
  }

  /**
   * Adjusts fog to match render distance so the far plane is always hidden.
   * @param {number} renderDistanceChunks
   * @param {number} density Multiplier from the settings.
   * @param {boolean} enabled
   * @returns {{near: number, far: number, strength: number}}
   */
  static computeFogRange(renderDistanceChunks, density, enabled) {
    const reach = renderDistanceChunks * 16;
    // Fog must finish just inside the last loaded ring, otherwise the player sees
    // chunks pop in against a clear sky.
    const far = Math.max(48, reach * 0.94);
    // Higher density pulls the fog start closer to the camera.
    const near = clamp(far * (1 - 0.5 * clamp(density, 0, 2)), 8, far - 8);
    return { near, far, strength: enabled ? 1 : 0 };
  }

  /** Disposes every material this instance owns. */
  dispose() {
    for (const name of LAYER_NAMES) {
      const material = this._materials[name];
      if (material) material.dispose();
      this._materials[name] = null;
    }
    this._voxelMaterials.length = 0;
    this._waterMaterial = null;
  }
}

export default Materials;
