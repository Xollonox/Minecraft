/**
 * Shader source registry and compile-time validation.
 *
 * GLSL is imported with Vite's `?raw` suffix, so the shaders live in real `.glsl`
 * files (syntax highlighting, no template-literal escaping) with no plugin and no
 * runtime fetch — they are inlined into the bundle at build time.
 *
 * ## Why validation exists
 *
 * A custom `ShaderMaterial` that fails to compile does not throw in Three.js: it
 * logs to the console and renders black. On a voxel world that means the entire
 * terrain silently disappears, which is the worst possible failure mode. So
 * before trusting a material we compile it against a probe scene that reproduces
 * the real define set (shadow-casting light present or not) while temporarily
 * capturing `console.error`. If Three reports a shader error we know immediately
 * and `Materials` falls back to a stock `MeshLambertMaterial` path, which loses
 * the custom lighting but keeps the world visible and playable.
 *
 * This is the only reliable detection route available: `WebGLProgram` stopped
 * exposing `diagnostics` and does not throw.
 */

import * as THREE from 'three';

import voxelVertexSource from './shaders/voxel.vert.glsl?raw';
import voxelFragmentSource from './shaders/voxel.frag.glsl?raw';
import waterVertexSource from './shaders/water.vert.glsl?raw';
import waterFragmentSource from './shaders/water.frag.glsl?raw';
import skyVertexSource from './shaders/sky.vert.glsl?raw';
import skyFragmentSource from './shaders/sky.frag.glsl?raw';

/**
 * Maximum simultaneous emissive-block point lights in the voxel shader.
 *
 * Eight is a deliberate ceiling: the loop is unrolled by the driver, and every
 * extra slot costs instructions on every terrain fragment on every device, not
 * just on the ones that actually have torches nearby.
 */
export const MAX_POINT_LIGHTS = 8;

export class ShaderManager {
  /**
   * @param {THREE.WebGLRenderer} renderer
   */
  constructor(renderer) {
    this._renderer = renderer;
    /** @type {string|null} */
    this.lastError = null;
    /** @type {THREE.BufferGeometry|null} */
    this._probeGeometry = null;
    /** @type {THREE.Scene|null} */
    this._probeScene = null;
    /** @type {THREE.Camera|null} */
    this._probeCamera = null;
    /** @type {THREE.WebGLRenderTarget|null} Tiny target the probe draws into. */
    this._probeTarget = null;
  }

  /** Raw shader sources, keyed by name. */
  get sources() {
    return {
      voxelVertex: voxelVertexSource,
      voxelFragment: voxelFragmentSource,
      waterVertex: waterVertexSource,
      waterFragment: waterFragmentSource,
      skyVertex: skyVertexSource,
      skyFragment: skyFragmentSource,
    };
  }

  /** Defines shared by every voxel-family shader. */
  getCommonDefines() {
    return {
      MAX_POINT_LIGHTS: String(MAX_POINT_LIGHTS),
    };
  }

  /**
   * Compiles *and renders* a material, reporting whether the GPU accepted it.
   *
   * Rendering is essential rather than paranoid: `WebGLRenderer.compile()` links
   * the program but Three defers `checkShaderErrors` to the program's first use
   * (`getUniforms()`), so a broken shader compiles "successfully" and only reports
   * itself on the first real draw. The probe therefore renders one triangle into a
   * 4x4 render target, which forces the uniform lookup and surfaces the error
   * while we are still watching the console.
   *
   * @param {THREE.Material} material
   * @param {{shadows?: boolean, label?: string}} [options]
   * @returns {{ok: boolean, error: string|null}}
   */
  validateMaterial(material, options = {}) {
    const { shadows = false } = options;
    const renderer = this._renderer;
    if (!renderer) return { ok: true, error: null };

    const scene = this._ensureProbeScene(shadows);
    const mesh = scene.userData.probeMesh;
    const previousMaterial = mesh.material;
    mesh.material = material;

    const captured = [];
    const originalError = console.error;
    const originalWarn = console.warn;
    console.error = (...args) => {
      captured.push(args.map(stringifyArg).join(' '));
    };
    console.warn = (...args) => {
      const text = args.map(stringifyArg).join(' ');
      // Only shader problems matter here; unrelated warnings pass through.
      if (/shader|glsl|program|error/i.test(text)) captured.push(text);
      else originalWarn.apply(console, args);
    };

    let thrown = null;
    const previousTarget = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(this._probeTarget);
      renderer.render(scene, this._probeCamera);
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    } finally {
      try {
        renderer.setRenderTarget(previousTarget);
      } catch {
        /* restoring the target must not mask the real error */
      }
      console.error = originalError;
      console.warn = originalWarn;
      mesh.material = previousMaterial;
    }

    const shaderErrors = captured.filter((text) =>
      /shader error|program error|failed to compile|invalid|error:/i.test(text)
    );

    if (thrown || shaderErrors.length > 0) {
      this.lastError = thrown || shaderErrors[0];
      // Surface the real message once, so a developer can still see it.
      originalError.call(
        console,
        `[ShaderManager] "${options.label || material.name || 'material'}" failed validation:`,
        this.lastError
      );
      return { ok: false, error: this.lastError };
    }

    return { ok: true, error: null };
  }

  /**
   * Builds (once) a minimal scene whose defines match real terrain rendering:
   * a mesh with position/normal/uv/`alight`, and a shadow-casting directional
   * light when shadows are enabled.
   */
  _ensureProbeScene(shadows) {
    if (!this._probeScene) {
      this._probeGeometry = new THREE.BufferGeometry();
      this._probeGeometry.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]), 3)
      );
      this._probeGeometry.setAttribute(
        'normal',
        new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3)
      );
      this._probeGeometry.setAttribute(
        'uv',
        new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1]), 2)
      );
      this._probeGeometry.setAttribute(
        'alight',
        new THREE.BufferAttribute(new Uint8Array([255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0]), 4, true)
      );
      this._probeGeometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));

      this._probeScene = new THREE.Scene();
      const mesh = new THREE.Mesh(this._probeGeometry, new THREE.MeshBasicMaterial());
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this._probeScene.add(mesh);
      this._probeScene.userData.probeMesh = mesh;

      const light = new THREE.DirectionalLight(0xffffff, 1);
      light.position.set(10, 20, 10);
      this._probeScene.userData.probeLight = light;

      this._probeCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
      this._probeCamera.position.set(0, 0, 3);

      // 4x4 is enough: the point is to execute the program, not to look at it.
      this._probeTarget = new THREE.WebGLRenderTarget(4, 4, {
        depthBuffer: true,
        stencilBuffer: false,
      });
    }

    const light = this._probeScene.userData.probeLight;
    light.castShadow = shadows;
    if (shadows && !light.parent) this._probeScene.add(light);
    else if (!shadows && light.parent) this._probeScene.remove(light);

    return this._probeScene;
  }

  /** Releases the probe geometry and render target. */
  destroy() {
    this._probeGeometry?.dispose();
    this._probeGeometry = null;
    this._probeTarget?.dispose();
    this._probeTarget = null;
    if (this._probeScene) {
      const mesh = this._probeScene.userData.probeMesh;
      if (mesh?.material?.dispose) mesh.material.dispose();
      this._probeScene.clear();
    }
    this._probeScene = null;
    this._probeCamera = null;
  }
}

function stringifyArg(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return String(value);
  } catch {
    return '[unprintable]';
  }
}

export default ShaderManager;
