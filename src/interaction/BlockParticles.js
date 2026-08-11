/**
 * Block break particles.
 *
 * One `THREE.Points` object with a preallocated buffer holds every particle in the
 * game. Spawning is a write into a free slot; there is no allocation, no geometry
 * creation and no draw call per burst. The buffer size comes from the particle
 * quality setting, so the whole system costs literally nothing when particles are
 * turned off.
 *
 * ## Textured from the atlas
 *
 * Each particle carries the UV rect of a small window inside the broken block's
 * atlas tile, and the fragment shader samples the atlas at
 * `windowOrigin + gl_PointCoord * windowSize`. So a broken stone block throws off
 * fragments of *stone texture* rather than flat coloured dots, for the cost of one
 * extra vertex attribute.
 */

import * as THREE from 'three';

import { PARTICLE_BUDGETS } from '../config/GraphicsPresets.js';
import { FACE_PY, PHYSICS } from '../config/GameConfig.js';
import { TILE_UVS } from '../world/AtlasLayout.js';
import { FACE_TILES } from '../world/BlockRegistry.js';
import { mulberry32 } from '../utils/MathUtils.js';

/** Seconds a particle lives. */
const LIFETIME = 0.85;
/** Fraction of the tile sampled per particle. */
const SAMPLE_WINDOW = 0.25;

const PARTICLE_VERTEX_SHADER = /* glsl */ `
  attribute vec4 aUvRect;   // xy = window origin, zw = window size
  attribute float aLife;    // remaining life, normalised 0..1
  attribute float aSize;

  uniform float uPointScale;

  varying vec4 vUvRect;
  varying float vLife;

  void main() {
    vUvRect = aUvRect;
    vLife = aLife;

    vec4 viewPosition = viewMatrix * modelMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    // Shrink as the particle ages, and scale with distance.
    float size = aSize * (0.45 + vLife * 0.55);
    gl_PointSize = clamp(uPointScale * size / max(-viewPosition.z, 0.5), 1.0, 24.0);
  }
`;

const PARTICLE_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uAtlas;
  uniform vec3 uTint;

  varying vec4 vUvRect;
  varying float vLife;

  void main() {
    if (vLife <= 0.0) discard;
    // Sample a small window of the block's own texture.
    vec2 uv = vUvRect.xy + gl_PointCoord * vUvRect.zw;
    vec4 texel = texture2D(uAtlas, uv);
    if (texel.a < 0.35) discard;
    gl_FragColor = vec4(texel.rgb * uTint, 1.0);
  }
`;

export class BlockParticles {
  /**
   * @param {Object} options
   * @param {THREE.Scene} options.scene
   * @param {import('../core/SettingsManager.js').SettingsManager} options.settings
   * @param {import('../core/ResourceManager.js').ResourceManager} options.resources
   * @param {THREE.Texture} options.atlasTexture
   */
  constructor({ scene, settings, resources, atlasTexture }) {
    this._scene = scene;
    this._settings = settings;
    this._resources = resources;
    this._atlasTexture = atlasTexture;
    this._random = mulberry32(0x9e3779b9);

    this._capacity = 0;
    this._activeCount = 0;
    /** @type {THREE.Points|null} */
    this._points = null;
    /** @type {THREE.BufferGeometry|null} */
    this._geometry = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._material = null;

    // CPU-side simulation state, parallel arrays indexed by particle slot.
    this._positions = null;
    this._velocities = null;
    this._lives = null;
    this._lifeAttribute = null;
    this._uvRects = null;
    this._sizes = null;

    this.applySettings(settings.values.graphics);
  }

  /** Number of live particles, for the debug overlay. */
  get activeCount() {
    return this._activeCount;
  }

  /** Allocated capacity. */
  get capacity() {
    return this._capacity;
  }

  /**
   * Spawns a burst of particles from a broken block.
   *
   * @param {number} blockX
   * @param {number} blockY
   * @param {number} blockZ
   * @param {number} blockId
   * @param {number} [amount] Requested particle count; clamped to free capacity.
   */
  spawnBreak(blockX, blockY, blockZ, blockId, amount = 12) {
    if (this._capacity === 0) return;

    const tile = FACE_TILES[blockId * 6 + FACE_PY];
    const u0 = TILE_UVS[tile * 4];
    const v0 = TILE_UVS[tile * 4 + 1];
    const u1 = TILE_UVS[tile * 4 + 2];
    const v1 = TILE_UVS[tile * 4 + 3];
    const windowWidth = (u1 - u0) * SAMPLE_WINDOW;
    const windowHeight = (v1 - v0) * SAMPLE_WINDOW;

    const random = this._random;
    const requested = Math.min(amount, this._capacity - this._activeCount);

    for (let i = 0; i < requested; i++) {
      const slot = this._activeCount++;

      const base = slot * 3;
      this._positions[base] = blockX + 0.15 + random() * 0.7;
      this._positions[base + 1] = blockY + 0.15 + random() * 0.7;
      this._positions[base + 2] = blockZ + 0.15 + random() * 0.7;

      // Outward and upward: a small explosion rather than a fountain.
      this._velocities[base] = (random() - 0.5) * 3.4;
      this._velocities[base + 1] = 1.4 + random() * 3.2;
      this._velocities[base + 2] = (random() - 0.5) * 3.4;

      this._lives[slot] = LIFETIME * (0.7 + random() * 0.5);

      const rectBase = slot * 4;
      // Pick a random window inside the tile so no two particles look alike.
      this._uvRects[rectBase] = u0 + random() * (u1 - u0 - windowWidth);
      this._uvRects[rectBase + 1] = v0 + random() * (v1 - v0 - windowHeight);
      this._uvRects[rectBase + 2] = windowWidth;
      this._uvRects[rectBase + 3] = windowHeight;

      this._sizes[slot] = 0.5 + random() * 0.7;
    }

    if (requested > 0) this._markDirty();
  }

  /**
   * Advances the simulation.
   *
   * Dead particles are removed by swapping the last live particle into their slot,
   * which keeps the live range contiguous at the front of the buffer so
   * `setDrawRange` can skip everything else with no gaps.
   *
   * @param {number} dt
   * @param {import('../world/World.js').World} world Used for ground collision.
   */
  update(dt, world) {
    if (this._capacity === 0 || this._activeCount === 0) return;

    const positions = this._positions;
    const velocities = this._velocities;
    const lives = this._lives;

    for (let slot = 0; slot < this._activeCount; ) {
      lives[slot] -= dt;
      if (lives[slot] <= 0) {
        this._recycle(slot);
        continue;
      }

      const base = slot * 3;
      velocities[base + 1] -= PHYSICS.gravity * 0.55 * dt;

      const nextX = positions[base] + velocities[base] * dt;
      const nextY = positions[base + 1] + velocities[base + 1] * dt;
      const nextZ = positions[base + 2] + velocities[base + 2] * dt;

      // Cheap collision: a single point test. Particles are decorative, so a
      // point-versus-voxel test is the right cost/benefit trade.
      if (world.isCollidable(Math.floor(nextX), Math.floor(nextY), Math.floor(nextZ))) {
        // Bounce with heavy damping and stop sliding quickly.
        velocities[base] *= 0.4;
        velocities[base + 1] = Math.abs(velocities[base + 1]) * 0.28;
        velocities[base + 2] *= 0.4;
        lives[slot] = Math.min(lives[slot], 0.28);
      } else {
        positions[base] = nextX;
        positions[base + 1] = nextY;
        positions[base + 2] = nextZ;
      }

      this._lifeAttribute[slot] = Math.min(1, lives[slot] / LIFETIME);
      slot++;
    }

    this._markDirty();
  }

  /** Swaps the last live particle into `slot` and shrinks the live range. */
  _recycle(slot) {
    const last = this._activeCount - 1;
    if (slot !== last) {
      for (let axis = 0; axis < 3; axis++) {
        this._positions[slot * 3 + axis] = this._positions[last * 3 + axis];
        this._velocities[slot * 3 + axis] = this._velocities[last * 3 + axis];
      }
      for (let component = 0; component < 4; component++) {
        this._uvRects[slot * 4 + component] = this._uvRects[last * 4 + component];
      }
      this._lives[slot] = this._lives[last];
      this._lifeAttribute[slot] = this._lifeAttribute[last];
      this._sizes[slot] = this._sizes[last];
    }
    this._activeCount--;
  }

  _markDirty() {
    if (!this._geometry) return;
    this._geometry.attributes.position.needsUpdate = true;
    this._geometry.attributes.aUvRect.needsUpdate = true;
    this._geometry.attributes.aLife.needsUpdate = true;
    this._geometry.attributes.aSize.needsUpdate = true;
    this._geometry.setDrawRange(0, this._activeCount);
    if (this._points) this._points.visible = this._activeCount > 0;
  }

  /**
   * Applies the particle quality setting, reallocating the buffer when the budget
   * changes.
   * @param {Object} graphics The `graphics` settings group.
   */
  applySettings(graphics) {
    const budget = PARTICLE_BUDGETS[graphics.particles] ?? 0;
    if (budget === this._capacity) return;
    this._allocate(budget);
  }

  _allocate(capacity) {
    this._dispose();
    this._capacity = capacity;
    this._activeCount = 0;
    if (capacity === 0) return;

    this._positions = new Float32Array(capacity * 3);
    this._velocities = new Float32Array(capacity * 3);
    this._lives = new Float32Array(capacity);
    this._lifeAttribute = new Float32Array(capacity);
    this._uvRects = new Float32Array(capacity * 4);
    this._sizes = new Float32Array(capacity);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this._positions, 3));
    geometry.setAttribute('aUvRect', new THREE.BufferAttribute(this._uvRects, 4));
    geometry.setAttribute('aLife', new THREE.BufferAttribute(this._lifeAttribute, 1));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this._sizes, 1));
    geometry.setDrawRange(0, 0);
    // Particles move in world space, so a fixed generous bound avoids Three
    // recomputing it (and avoids it culling live particles).
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const material = new THREE.ShaderMaterial({
      name: 'block-particles',
      uniforms: {
        uAtlas: { value: this._atlasTexture },
        uPointScale: { value: 260 },
        uTint: { value: new THREE.Color(1, 1, 1) },
      },
      vertexShader: PARTICLE_VERTEX_SHADER,
      fragmentShader: PARTICLE_FRAGMENT_SHADER,
      transparent: false,
      depthWrite: true,
      depthTest: true,
      fog: false,
      toneMapped: true,
    });

    const points = new THREE.Points(geometry, material);
    points.name = 'block-particles';
    points.frustumCulled = false;
    points.visible = false;
    points.renderOrder = 400;

    this._scene.add(points);
    this._geometry = geometry;
    this._material = material;
    this._points = points;

    this._resources.replaceShared('particles:geometry', geometry);
    this._resources.replaceShared('particles:material', material);
  }

  /**
   * Tints the particles by the current light level so a burst in a dark cave is
   * not brighter than its surroundings.
   * @param {THREE.Color} colour
   */
  setTint(colour) {
    if (this._material) this._material.uniforms.uTint.value.copy(colour);
  }

  _dispose() {
    if (this._points) {
      this._scene.remove(this._points);
      this._points = null;
    }
    if (this._geometry) {
      this._resources.releaseShared('particles:geometry');
      this._geometry = null;
    }
    if (this._material) {
      this._resources.releaseShared('particles:material');
      this._material = null;
    }
    this._positions = null;
    this._velocities = null;
    this._lives = null;
    this._lifeAttribute = null;
    this._uvRects = null;
    this._sizes = null;
    this._capacity = 0;
    this._activeCount = 0;
  }

  /** Removes every particle and releases the buffers. */
  destroy() {
    this._dispose();
  }
}

export default BlockParticles;
