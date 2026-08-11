/**
 * Sky dome, stars and clouds.
 *
 * ## Dome
 *
 * An inward-facing sphere of a fixed small radius that is re-centred on the
 * camera every frame, drawn first with depth testing *and* depth writing
 * disabled. That combination means the dome can never clip against the far plane
 * and never fights the terrain for depth: it paints the background, then
 * everything else draws over it. Changing the render distance therefore has no
 * effect on the sky at all, which removes a whole class of "sky disappears at
 * low render distance" bugs.
 *
 * The gradient, sun, moon and stars are all evaluated in `sky.frag.glsl` from
 * uniforms that `LightingSystem` interpolates, so a sunrise is continuous rather
 * than a cross-fade between baked skyboxes.
 *
 * ## Clouds
 *
 * One or two large horizontal planes with a procedurally generated, seamlessly
 * tiling cloud texture. The planes follow the camera in XZ (snapped to the
 * texture's world period so the clouds do not appear to slide with the player)
 * and scroll their UVs for wind. Two planes at slightly different heights and
 * speeds give parallax for the cost of one extra draw call — far cheaper and far
 * more stable than volumetric or instanced-box clouds.
 */

import * as THREE from 'three';

import { SEA_LEVEL } from '../config/GameConfig.js';
import { CLOUD_QUALITY, STAR_COUNTS } from '../config/GraphicsPresets.js';
import { mulberry32, clamp, smootherstep } from '../utils/MathUtils.js';

/** Radius of the dome in world units. Arbitrary: depth testing is off. */
const DOME_RADIUS = 10;
/** Height of the lower cloud layer. */
const CLOUD_BASE_HEIGHT = SEA_LEVEL + 62;
/** Vertical separation between cloud layers. */
const CLOUD_LAYER_GAP = 11;
/** World size covered by one repeat of the cloud texture. */
const CLOUD_WORLD_PERIOD = 512;
/** Edge length of the generated cloud texture. */
const CLOUD_TEXTURE_SIZE = 256;

const CLOUD_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorldPosition;
  void main() {
    vUv = uv;
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const CLOUD_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uCloudTexture;
  uniform vec2 uOffset;
  uniform float uUvScale;
  uniform vec3 uCloudColor;
  uniform vec3 uShadowColor;
  uniform vec3 uFogColor;
  uniform float uOpacity;
  uniform float uCoverage;
  uniform float uFadeDistance;
  uniform float uBrightness;

  varying vec2 vUv;
  varying vec3 vWorldPosition;

  void main() {
    // uUvScale makes one texture repeat cover a fixed number of world units
    // regardless of how large the cloud plane has been scaled.
    vec2 uvA = vUv * uUvScale + uOffset;
    // Two samples at different scales break up the obvious repeat of a single
    // tiling texture without needing a bigger texture.
    float densityA = texture2D(uCloudTexture, uvA).r;
    float densityB = texture2D(uCloudTexture, uvA * 0.47 + vec2(0.31, 0.62)).r;
    float density = densityA * 0.68 + densityB * 0.42;

    float alpha = smoothstep(uCoverage, uCoverage + 0.22, density);
    if (alpha <= 0.004) discard;

    // Thicker parts of the cloud are shaded underneath.
    float thickness = smoothstep(uCoverage + 0.05, uCoverage + 0.4, density);
    vec3 color = mix(uShadowColor, uCloudColor, thickness) * uBrightness;

    // Fade the plane out towards its edges so the rectangle is never visible.
    float distance = length(vWorldPosition.xz - cameraPosition.xz);
    float edgeFade = 1.0 - smoothstep(uFadeDistance * 0.55, uFadeDistance, distance);
    // Blend into the fog colour with distance so clouds meet the horizon.
    float horizonBlend = smoothstep(uFadeDistance * 0.25, uFadeDistance * 0.9, distance);
    color = mix(color, uFogColor, horizonBlend * 0.75);

    gl_FragColor = vec4(color, alpha * uOpacity * edgeFade);
  }
`;

export class SkySystem {
  /**
   * @param {Object} options
   * @param {THREE.Scene} options.scene
   * @param {import('../core/SettingsManager.js').SettingsManager} options.settings
   * @param {import('./ShaderManager.js').ShaderManager} options.shaderManager
   * @param {import('../core/ResourceManager.js').ResourceManager} options.resources
   */
  constructor({ scene, settings, shaderManager, resources }) {
    this._scene = scene;
    this._settings = settings;
    this._shaders = shaderManager;
    this._resources = resources;
    this._dimension = 'overworld';

    this.group = new THREE.Group();
    this.group.name = 'sky';
    scene.add(this.group);

    // --- dome ---
    this._domeGeometry = new THREE.SphereGeometry(DOME_RADIUS, 24, 16);
    this._domeMaterial = new THREE.ShaderMaterial({
      name: 'sky-dome',
      uniforms: {
        uZenithColor: { value: new THREE.Color(0.32, 0.55, 0.92) },
        uHorizonColor: { value: new THREE.Color(0.68, 0.82, 0.97) },
        uGroundColor: { value: new THREE.Color(0.3, 0.32, 0.34) },
        uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
        uMoonDirection: { value: new THREE.Vector3(0, -1, 0) },
        uSunColor: { value: new THREE.Color(1, 0.98, 0.93) },
        uSunGlowColor: { value: new THREE.Color(1, 0.96, 0.86) },
        uStarIntensity: { value: 0 },
        uStarDensity: { value: 160 },
        uHorizonSharpness: { value: 3.2 },
        uBrightness: { value: 1 },
      },
      vertexShader: shaderManager.sources.skyVertex,
      fragmentShader: shaderManager.sources.skyFragment,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: true,
    });

    /**
     * True when the dome shader compiled. On failure the dome is hidden and the
     * scene falls back to a flat background colour driven by the same horizon
     * value, so the sky is plain rather than black.
     */
    this.domeAvailable = shaderManager.validateMaterial(this._domeMaterial, {
      label: 'sky dome',
    }).ok;

    this.dome = new THREE.Mesh(this._domeGeometry, this._domeMaterial);
    this.dome.name = 'sky-dome';
    this.dome.frustumCulled = false;
    // Drawn before anything else; with depth testing off it becomes the
    // background layer.
    this.dome.renderOrder = -1000;
    this.dome.matrixAutoUpdate = false;
    this.dome.visible = this.domeAvailable;
    this.group.add(this.dome);

    if (!this.domeAvailable) {
      this._fallbackBackground = new THREE.Color(0x87b4e6);
      scene.background = this._fallbackBackground;
    }

    resources.acquireShared('sky:dome-geometry', () => this._domeGeometry);
    resources.acquireShared('sky:dome-material', () => this._domeMaterial);

    // --- clouds ---
    this._cloudTexture = this._createCloudTexture();
    this._cloudGeometry = new THREE.PlaneGeometry(1, 1, 1, 1);
    this._cloudGeometry.rotateX(-Math.PI / 2);
    /** @type {THREE.Mesh[]} */
    this.cloudLayers = [];
    this._cloudOffset = 0;
    this._buildCloudLayers();

    resources.acquireShared('sky:cloud-texture', () => this._cloudTexture);
    resources.acquireShared('sky:cloud-geometry', () => this._cloudGeometry);

    this.applySettings(settings.values.graphics);
  }

  /**
   * Generates a seamlessly tiling cloud density texture.
   *
   * Value noise on a wrapping lattice: because the lattice indices are taken
   * modulo the grid size, the result tiles exactly, which is what allows one
   * small texture to cover the sky without a visible seam.
   */
  _createCloudTexture() {
    const size = CLOUD_TEXTURE_SIZE;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    const image = context.createImageData(size, size);

    // Fixed seed: the cloud texture must be identical on every load.
    const random = mulberry32(0xc10d5eed);
    const octaves = [
      { grid: 4, amplitude: 0.5 },
      { grid: 8, amplitude: 0.28 },
      { grid: 16, amplitude: 0.14 },
      { grid: 32, amplitude: 0.08 },
    ];

    // Pre-generate a lattice per octave.
    const lattices = octaves.map((octave) => {
      const values = new Float32Array(octave.grid * octave.grid);
      for (let i = 0; i < values.length; i++) values[i] = random();
      return values;
    });

    const sampleLattice = (values, grid, x, y) => {
      const gx = x * grid;
      const gy = y * grid;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const fx = smootherstep(gx - x0);
      const fy = smootherstep(gy - y0);
      const wrap = (v) => ((v % grid) + grid) % grid;
      const i00 = wrap(y0) * grid + wrap(x0);
      const i10 = wrap(y0) * grid + wrap(x0 + 1);
      const i01 = wrap(y0 + 1) * grid + wrap(x0);
      const i11 = wrap(y0 + 1) * grid + wrap(x0 + 1);
      const top = values[i00] + (values[i10] - values[i00]) * fx;
      const bottom = values[i01] + (values[i11] - values[i01]) * fx;
      return top + (bottom - top) * fy;
    };

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;
        let density = 0;
        let normalisation = 0;
        for (let o = 0; o < octaves.length; o++) {
          density += sampleLattice(lattices[o], octaves[o].grid, u, v) * octaves[o].amplitude;
          normalisation += octaves[o].amplitude;
        }
        density /= normalisation;
        const value = Math.round(clamp(density, 0, 1) * 255);
        const index = (y * size + x) * 4;
        image.data[index] = value;
        image.data[index + 1] = value;
        image.data[index + 2] = value;
        image.data[index + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);

    const texture = new THREE.Texture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.colorSpace = THREE.NoColorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  _buildCloudLayers() {
    for (let layer = 0; layer < 2; layer++) {
      const material = new THREE.ShaderMaterial({
        name: `clouds-${layer}`,
        uniforms: {
          uCloudTexture: { value: this._cloudTexture },
          uOffset: { value: new THREE.Vector2() },
          uUvScale: { value: 1 },
          uCloudColor: { value: new THREE.Color(1, 1, 1) },
          uShadowColor: { value: new THREE.Color(0.62, 0.68, 0.78) },
          uFogColor: { value: new THREE.Color(0.66, 0.78, 0.93) },
          uOpacity: { value: layer === 0 ? 0.9 : 0.6 },
          uCoverage: { value: 0.5 },
          uFadeDistance: { value: 600 },
          uBrightness: { value: 1 },
        },
        vertexShader: CLOUD_VERTEX_SHADER,
        fragmentShader: CLOUD_FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        fog: false,
        toneMapped: true,
      });

      const mesh = new THREE.Mesh(this._cloudGeometry, material);
      mesh.name = `clouds-${layer}`;
      mesh.frustumCulled = false;
      mesh.renderOrder = -900 + layer;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      this.cloudLayers.push(mesh);
      this._resources.acquireShared(`sky:cloud-material-${layer}`, () => material);
    }
  }

  /**
   * Follows the camera and pushes the current atmosphere into the uniforms.
   *
   * @param {number} dt
   * @param {THREE.Vector3} cameraPosition
   * @param {import('./LightingSystem.js').LightingSystem} lighting
   */
  update(dt, cameraPosition, lighting) {
    if (!this.domeAvailable) {
      // Flat-colour fallback: blend zenith and horizon so the sky still changes
      // through the day even without the gradient shader.
      this._fallbackBackground
        .copy(lighting.horizonColor)
        .lerp(lighting.zenithColor, 0.55);
      this._updateClouds(dt, cameraPosition, lighting);
      return;
    }

    // --- dome ---
    this.dome.position.copy(cameraPosition);
    this.dome.updateMatrix();

    const uniforms = this._domeMaterial.uniforms;
    if (this._dimension === 'end') {
      uniforms.uZenithColor.value.setRGB(.025, .008, .045);
      uniforms.uHorizonColor.value.setRGB(.075, .025, .095);
      uniforms.uGroundColor.value.setRGB(.008, .004, .014);
    } else if (this._dimension === 'nether') {
      uniforms.uZenithColor.value.setRGB(.12, .018, .012);
      uniforms.uHorizonColor.value.setRGB(.26, .045, .018);
      uniforms.uGroundColor.value.setRGB(.06, .008, .004);
    } else {
      uniforms.uZenithColor.value.copy(lighting.zenithColor);
      uniforms.uHorizonColor.value.copy(lighting.horizonColor);
      uniforms.uGroundColor.value.copy(lighting.fogColor).multiplyScalar(0.85);
    }
    uniforms.uSunDirection.value.copy(lighting.sunDirection);
    uniforms.uMoonDirection.value.copy(lighting.moonDirection);
    uniforms.uSunColor.value.copy(lighting.sunColor);
    uniforms.uSunGlowColor.value.copy(lighting.glowColor);
    uniforms.uStarIntensity.value = this._starsEnabled
      ? (this._dimension === 'end' ? .82 : this._dimension === 'nether' ? 0 : lighting.starIntensity)
      : 0;
    uniforms.uBrightness.value = clamp(this._settings.get('graphics.brightness'), 0.5, 2);

    this._updateClouds(dt, cameraPosition, lighting);
  }

  /**
   * Positions and lights the cloud planes.
   *
   * Separate from `update` because the clouds are independent of the dome: if the
   * dome shader is unavailable the clouds still work, and vice versa.
   *
   * @param {number} dt
   * @param {THREE.Vector3} cameraPosition
   * @param {import('./LightingSystem.js').LightingSystem} lighting
   */
  _updateClouds(dt, cameraPosition, lighting) {
    if (this.cloudLayers.length === 0) return;
    if (!this._cloudsEnabled || this._dimension !== 'overworld') {
      for (const mesh of this.cloudLayers) mesh.visible = false;
      return;
    }

    this._cloudOffset += dt * this._cloudSpeed;
    const renderDistance = this._settings.get('graphics.renderDistance') * 16;
    // Rounded up to a whole number of texture periods so that when the plane
    // re-snaps to a new grid cell the pattern lines up exactly and no seam is
    // visible.
    const planeSize =
      Math.ceil(Math.max(600, renderDistance * 3.2) / CLOUD_WORLD_PERIOD) * CLOUD_WORLD_PERIOD;
    const uvScale = planeSize / CLOUD_WORLD_PERIOD;

    for (let layer = 0; layer < this.cloudLayers.length; layer++) {
      const mesh = this.cloudLayers[layer];
      mesh.visible = layer === 0 || this._cloudLayerCount > 1;
      if (!mesh.visible) continue;

      // Snap to the texture's world period so the pattern is pinned to the world
      // rather than sliding along with the player.
      const snappedX = Math.round(cameraPosition.x / CLOUD_WORLD_PERIOD) * CLOUD_WORLD_PERIOD;
      const snappedZ = Math.round(cameraPosition.z / CLOUD_WORLD_PERIOD) * CLOUD_WORLD_PERIOD;
      mesh.position.set(snappedX, CLOUD_BASE_HEIGHT + layer * CLOUD_LAYER_GAP, snappedZ);
      mesh.scale.set(planeSize, 1, planeSize);
      mesh.updateMatrix();

      const cloudUniforms = mesh.material.uniforms;
      cloudUniforms.uUvScale.value = uvScale;
      // Offset in texture periods, so the pattern stays locked to world space as
      // the plane re-snaps, plus a wind term per layer for parallax.
      cloudUniforms.uOffset.value.set(
        (snappedX - planeSize * 0.5) / CLOUD_WORLD_PERIOD +
          this._cloudOffset * (layer === 0 ? 1 : 0.62),
        (snappedZ - planeSize * 0.5) / CLOUD_WORLD_PERIOD + this._cloudOffset * 0.35
      );
      cloudUniforms.uCoverage.value = this._cloudCoverage;
      cloudUniforms.uFadeDistance.value = planeSize * 0.48;
      cloudUniforms.uFogColor.value.copy(lighting.fogColor);
      // Clouds are lit by the sky, so they darken with it.
      cloudUniforms.uCloudColor.value
        .copy(lighting.sunColor)
        .lerp(lighting.skyAmbient, 0.35)
        .multiplyScalar(0.55 + lighting.daylight * 0.75);
      cloudUniforms.uShadowColor.value
        .copy(lighting.skyAmbient)
        .multiplyScalar(0.9 + lighting.daylight * 0.5);
      cloudUniforms.uBrightness.value = clamp(this._settings.get('graphics.brightness'), 0.5, 2);
    }
  }

  /**
   * Applies graphics settings.
   * @param {Object} graphics The `graphics` settings group.
   */
  applySettings(graphics) {
    this._cloudsEnabled = Boolean(graphics.clouds);
    const quality = CLOUD_QUALITY[graphics.cloudQuality] ?? CLOUD_QUALITY.low;
    this._cloudLayerCount = quality.layers;
    this._cloudCoverage = quality.coverage;
    this._cloudSpeed = quality.speed;

    for (let layer = 0; layer < this.cloudLayers.length; layer++) {
      const mesh = this.cloudLayers[layer];
      mesh.visible = this._cloudsEnabled && (layer === 0 || quality.layers > 1);
    }

    const starCount = STAR_COUNTS[graphics.starQuality] ?? 0;
    this._starsEnabled = starCount > 0;
    // Star "count" maps to the hash grid density in the shader: a finer grid
    // yields more, smaller stars.
    this._domeMaterial.uniforms.uStarDensity.value = clamp(
      Math.round(Math.sqrt(Math.max(1, starCount)) * 5.4),
      40,
      420
    );

    // A lower-quality dome uses a softer horizon, which hides the low tessellation.
    this._domeMaterial.uniforms.uHorizonSharpness.value =
      graphics.starQuality === 'high' ? 3.4 : 2.6;
  }

  setDimension(dimensionId) {
    this._dimension = dimensionId === 'end' || dimensionId === 'nether' ? dimensionId : 'overworld';
  }

  /** Removes the sky from the scene. Shared resources are freed by the manager. */
  destroy() {
    for (let layer = 0; layer < this.cloudLayers.length; layer++) {
      this.group.remove(this.cloudLayers[layer]);
      this._resources.releaseShared(`sky:cloud-material-${layer}`);
    }
    this.cloudLayers.length = 0;
    this.group.remove(this.dome);
    if (this.group.parent) this.group.parent.remove(this.group);
    this._resources.releaseShared('sky:dome-geometry');
    this._resources.releaseShared('sky:dome-material');
    this._resources.releaseShared('sky:cloud-texture');
    this._resources.releaseShared('sky:cloud-geometry');
  }
}

export default SkySystem;
