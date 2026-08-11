/**
 * Reference-counted registry for GPU resources.
 *
 * Three.js will not free a texture, geometry or render target for you, and the
 * two failure modes are symmetrical:
 *
 *  - forget to dispose a chunk geometry and memory climbs until the tab dies;
 *  - dispose the shared texture atlas while a chunk still references it and
 *    every block in the world turns black.
 *
 * Both are solved by making ownership explicit. Long-lived shared resources
 * (the atlas, the block materials) are registered as *shared* and retained by
 * name; per-chunk resources are registered as *transient* and disposed the
 * moment their chunk unloads. `disposeAll()` is what `Game.destroy()` calls to
 * guarantee a clean teardown.
 */

export class ResourceManager {
  constructor() {
    /** @type {Map<string, {resource: any, refs: number}>} */
    this._shared = new Map();
    /** @type {Set<any>} */
    this._transient = new Set();
    this._disposedCount = 0;
    this._destroyed = false;
  }

  /** Number of distinct shared resources currently retained. */
  get sharedCount() {
    return this._shared.size;
  }

  /** Number of transient resources currently tracked. */
  get transientCount() {
    return this._transient.size;
  }

  /** Total resources this manager has disposed. */
  get disposedCount() {
    return this._disposedCount;
  }

  /**
   * Registers (or retains) a shared resource under a stable name.
   *
   * @template T
   * @param {string} name
   * @param {() => T} factory Called only when the name is not yet registered.
   * @returns {T}
   */
  acquireShared(name, factory) {
    const existing = this._shared.get(name);
    if (existing) {
      existing.refs++;
      return existing.resource;
    }
    const resource = factory();
    this._shared.set(name, { resource, refs: 1 });
    return resource;
  }

  /**
   * Looks up a shared resource without changing its reference count.
   * @param {string} name
   */
  peekShared(name) {
    return this._shared.get(name)?.resource;
  }

  /**
   * Releases one reference to a shared resource, disposing it at zero.
   * @param {string} name
   * @returns {boolean} True when the resource was actually disposed.
   */
  releaseShared(name) {
    const entry = this._shared.get(name);
    if (!entry) return false;
    entry.refs--;
    if (entry.refs > 0) return false;
    this._shared.delete(name);
    this._dispose(entry.resource);
    return true;
  }

  /**
   * Replaces a shared resource, disposing the previous one.
   * Used when a settings change forces a material or render target rebuild.
   *
   * @template T
   * @param {string} name
   * @param {T} resource
   * @returns {T}
   */
  replaceShared(name, resource) {
    const entry = this._shared.get(name);
    if (entry) {
      const refs = entry.refs;
      this._dispose(entry.resource);
      this._shared.set(name, { resource, refs });
    } else {
      this._shared.set(name, { resource, refs: 1 });
    }
    return resource;
  }

  /**
   * Tracks a resource whose lifetime is shorter than the game's.
   * @template T
   * @param {T} resource
   * @returns {T} The same resource, for chaining.
   */
  trackTransient(resource) {
    if (resource) this._transient.add(resource);
    return resource;
  }

  /**
   * Disposes a transient resource immediately and stops tracking it.
   * @param {any} resource
   */
  releaseTransient(resource) {
    if (!resource) return;
    this._transient.delete(resource);
    this._dispose(resource);
  }

  /** Disposes every transient resource, leaving shared ones alone. */
  disposeTransient() {
    for (const resource of this._transient) this._dispose(resource);
    this._transient.clear();
  }

  /**
   * Disposes everything. Transient resources go first so nothing still points
   * at a shared texture when it is freed.
   */
  disposeAll() {
    this.disposeTransient();
    for (const entry of this._shared.values()) this._dispose(entry.resource);
    this._shared.clear();
    this._destroyed = true;
  }

  /** Diagnostics for the debug overlay. */
  getStats() {
    return {
      shared: this._shared.size,
      transient: this._transient.size,
      disposed: this._disposedCount,
    };
  }

  /**
   * Calls `dispose()` where available, recursing into arrays and into the
   * `geometry`/`material` slots of a mesh-like object.
   */
  _dispose(resource) {
    if (!resource) return;
    try {
      if (Array.isArray(resource)) {
        for (const item of resource) this._dispose(item);
        return;
      }
      // Meshes hold references we own; the scene graph itself is not our job.
      if (resource.isMesh || resource.isPoints || resource.isLine) {
        if (resource.geometry) this._dispose(resource.geometry);
        return;
      }
      if (typeof resource.dispose === 'function') {
        resource.dispose();
        this._disposedCount++;
      }
    } catch (error) {
      console.warn('[ResourceManager] dispose threw:', error);
    }
  }
}

export default ResourceManager;
