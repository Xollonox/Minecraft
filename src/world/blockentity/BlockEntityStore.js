/**
 * Owns every block entity in the loaded world.
 *
 * ## Keying
 *
 * `Map<chunkKey, Map<voxelIndex, entity>>`, exactly like `World._emissive`. The
 * two-level shape is what makes chunk unload an O(1) delete of a whole chunk's
 * entities instead of a scan, and it makes "save the entities for this chunk" a
 * direct lookup — which is how they are persisted, alongside that chunk's edits.
 *
 * ## Tick list
 *
 * Entities that want ticking are also held in a flat array. The furnace tick then
 * walks a handful of furnaces rather than every chest in the world. The array is
 * rebuilt on add/remove rather than filtered per tick, because adds are rare and
 * ticks are not.
 *
 * ## Unloading is not deleting
 *
 * When a chunk unloads its entities are dropped from memory, but they have already
 * been serialised into the pending-save map. Reloading the chunk restores them.
 * The distinction matters: `remove` (the block was broken) must destroy the record
 * permanently, whereas `unloadChunk` must not.
 */

import {
  blockToChunkX,
  blockToChunkZ,
  blockToLocalX,
  blockToLocalZ,
  chunkKey,
  voxelIndex,
} from '../../utils/CoordinateUtils.js';
import { blockEntityClassFor, blockEntityClassForType } from './BlockEntity.js';

export class BlockEntityStore {
  /**
   * @param {Object} options
   * @param {import('../World.js').World} options.world
   */
  constructor({ world }) {
    this._world = world;

    /** @type {Map<string, Map<number, import('./BlockEntity.js').BlockEntity>>} */
    this._byChunk = new Map();

    /** @type {import('./BlockEntity.js').BlockEntity[]} */
    this._ticking = [];

    /**
     * Serialised entities for chunks that are not currently loaded, plus the
     * loaded ones at save time. This is what gets written to storage.
     * @type {Map<string, Array<Object>>}
     */
    this._saved = new Map();

    /** Chunk keys whose entities changed since the last save. */
    this._dirtyChunks = new Set();
  }

  // ------------------------------------------------------------------ addressing

  /**
   * @param {number} x
   * @param {number} z
   * @returns {string}
   */
  _keyFor(x, z) {
    return chunkKey(blockToChunkX(x), blockToChunkZ(z));
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {number}
   */
  _indexFor(x, y, z) {
    return voxelIndex(blockToLocalX(x), y, blockToLocalZ(z));
  }

  // -------------------------------------------------------------------- accessors

  /**
   * The entity at a position, or null.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {import('./BlockEntity.js').BlockEntity|null}
   */
  get(x, y, z) {
    const chunk = this._byChunk.get(this._keyFor(x, z));
    if (!chunk) return null;
    return chunk.get(this._indexFor(x, y, z)) ?? null;
  }

  /** Total loaded entities. */
  get count() {
    let total = 0;
    for (const chunk of this._byChunk.values()) total += chunk.size;
    return total;
  }

  /** Number of ticking entities. */
  get tickingCount() {
    return this._ticking.length;
  }

  // --------------------------------------------------------------------- mutation

  /**
   * Creates the entity a block needs, if it needs one.
   *
   * Called from `World.setBlock` after a placement. Idempotent for the
   * furnace/lit-furnace swap: the two ids share a type, so an existing entity is
   * kept rather than replaced, which is what stops a burning furnace losing its
   * contents when its block id changes.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} blockId
   * @returns {import('./BlockEntity.js').BlockEntity|null}
   */
  create(x, y, z, blockId) {
    const Constructor = blockEntityClassFor(blockId);
    if (!Constructor) return null;

    const existing = this.get(x, y, z);
    if (existing) {
      if (existing.type === Constructor.type) {
        // Same machine, different block id (a furnace lighting up).
        existing.blockId = blockId;
        return existing;
      }
      // A genuinely different block replaced it; the old record is meaningless.
      this.remove(x, y, z);
    }

    const entity = new Constructor({ x, y, z, blockId });
    this._insert(x, y, z, entity);
    return entity;
  }

  _insert(x, y, z, entity) {
    const key = this._keyFor(x, z);
    let chunk = this._byChunk.get(key);
    if (!chunk) {
      chunk = new Map();
      this._byChunk.set(key, chunk);
    }
    chunk.set(this._indexFor(x, y, z), entity);
    if (entity.needsTick) this._ticking.push(entity);
    this._dirtyChunks.add(key);
  }

  /**
   * Destroys the entity at a position and returns its drops.
   *
   * Called from `World.setBlock` when a block that had an entity is replaced. The
   * drops are returned rather than spawned here because the store has no access to
   * the entity manager, and giving it one would couple world state to rendering.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {import('../../items/ItemStack.js').ItemStack[]} Contents to scatter.
   */
  remove(x, y, z) {
    const key = this._keyFor(x, z);
    const chunk = this._byChunk.get(key);
    if (!chunk) return [];
    const index = this._indexFor(x, y, z);
    const entity = chunk.get(index);
    if (!entity) return [];

    const drops = entity.collectDrops();
    entity.removed = true;
    chunk.delete(index);
    if (chunk.size === 0) this._byChunk.delete(key);
    this._removeFromTicking(entity);

    // Permanent: also drop it from the saved snapshot, or a reload would
    // resurrect a chest that was broken.
    this._pruneSaved(key, index);
    this._dirtyChunks.add(key);

    return drops;
  }

  _removeFromTicking(entity) {
    const at = this._ticking.indexOf(entity);
    if (at >= 0) this._ticking.splice(at, 1);
  }

  _pruneSaved(key, index) {
    const list = this._saved.get(key);
    if (!list) return;
    const filtered = list.filter((entry) => entry.i !== index);
    if (filtered.length === 0) this._saved.delete(key);
    else this._saved.set(key, filtered);
  }

  /** Marks a chunk's entities as needing a save. */
  markDirty(x, z) {
    this._dirtyChunks.add(this._keyFor(x, z));
  }

  // ------------------------------------------------------------------------ tick

  /**
   * Advances every ticking entity.
   * @param {number} step Seconds.
   */
  tick(step) {
    if (this._ticking.length === 0) return;
    const beforeSnapshots = new Map();
    for (let i = 0; i < this._ticking.length; i++) {
      const entity = this._ticking[i];
      if (entity.removed) continue;
      if (typeof entity.toJSON === 'function') {
        try { beforeSnapshots.set(entity, JSON.stringify(entity.toJSON())); } catch { beforeSnapshots.set(entity, null); }
      }
      entity.tick(step, this._world);
    }
    for (const entity of this._ticking) {
      if (entity.removed) continue;
      const key = this._keyFor(entity.x, entity.z);
      if (this._dirtyChunks.has(key)) continue;
      const before = beforeSnapshots.get(entity);
      if (before !== null) {
        let after = null;
        try { after = JSON.stringify(entity.toJSON()); } catch { after = null; }
        if (before !== after) this._dirtyChunks.add(key);
      } else {
        this._dirtyChunks.add(key);
      }
    }
  }

  // ------------------------------------------------------------- chunk lifecycle

  /**
   * Instantiates the saved entities for a chunk that has just loaded.
   * @param {number} chunkX
   * @param {number} chunkZ
   */
  loadChunk(chunkX, chunkZ) {
    const key = chunkKey(chunkX, chunkZ);
    if (this._byChunk.has(key)) return;
    const list = this._saved.get(key);
    if (!list || list.length === 0) return;

    for (const entry of list) {
      const Constructor = blockEntityClassForType(entry.t);
      // A save written by a build that had a block entity this one does not is
      // skipped rather than fatal.
      if (!Constructor) continue;

      const entity = new Constructor({
        x: entry.x,
        y: entry.y,
        z: entry.z,
        blockId: entry.b,
      });
      entity.fromJSON(entry.d ?? {});
      this._insert(entry.x, entry.y, entry.z, entity);

      // Let a machine reconcile the time it spent unloaded.
      if (typeof entity.catchUp === 'function') entity.catchUp(this._world);
    }
  }

  /**
   * Serialises and forgets a chunk's entities.
   *
   * Serialising *before* dropping them is what makes unload non-destructive.
   * @param {number} chunkX
   * @param {number} chunkZ
   */
  unloadChunk(chunkX, chunkZ) {
    const key = chunkKey(chunkX, chunkZ);
    const chunk = this._byChunk.get(key);
    if (!chunk) return;

    this._snapshotChunk(key, chunk);
    for (const entity of chunk.values()) this._removeFromTicking(entity);
    this._byChunk.delete(key);
  }

  /**
   * Writes a loaded chunk's entities into the saved snapshot.
   * @param {string} key
   * @param {Map<number, import('./BlockEntity.js').BlockEntity>} chunk
   */
  _snapshotChunk(key, chunk) {
    /** @type {Array<Object>} */
    const list = [];
    for (const [index, entity] of chunk) {
      if (!entity.needsSave) continue;
      list.push({
        i: index,
        t: entity.type,
        x: entity.x,
        y: entity.y,
        z: entity.z,
        b: entity.blockId,
        d: entity.toJSON(),
      });
    }
    if (list.length === 0) this._saved.delete(key);
    else this._saved.set(key, list);
  }

  // -------------------------------------------------------------- serialisation

  /**
   * Every chunk's entities, ready to store.
   *
   * @param {boolean} [everything] When false, only chunks changed since the last
   *   save are returned, which is what keeps autosave cheap.
   * @returns {Map<string, Array<Object>>}
   */
  collectForSave(everything = false) {
    // Refresh the snapshot from the live entities first, so the saved data is
    // never staler than what is in memory.
    for (const [key, chunk] of this._byChunk) {
      if (!everything && !this._dirtyChunks.has(key)) continue;
      this._snapshotChunk(key, chunk);
    }

    if (everything) return new Map(this._saved);

    /** @type {Map<string, Array<Object>>} */
    const dirty = new Map();
    for (const key of this._dirtyChunks) {
      // An empty array is meaningful: it tells the store to delete that chunk's
      // record, which is how a broken chest stops coming back.
      dirty.set(key, this._saved.get(key) ?? []);
    }
    return dirty;
  }

  /** Clears the dirty set after a successful save. */
  markSaved() {
    this._dirtyChunks.clear();
  }

  /** Whether anything needs saving. */
  get hasUnsavedChanges() {
    return this._dirtyChunks.size > 0;
  }

  /**
   * Restores the saved snapshot at world load.
   *
   * Entities are not instantiated here — `loadChunk` does that as chunks stream
   * in, so a world with a thousand chests does not build a thousand containers
   * before the first frame.
   *
   * @param {Map<string, Array<Object>>|null} data
   */
  applyLoaded(data) {
    this._saved.clear();
    this._dirtyChunks.clear();
    if (!data) return;
    for (const [key, list] of data) {
      if (Array.isArray(list) && list.length > 0) this._saved.set(key, list);
    }
  }

  /** Drops everything, for a world teardown. */
  destroy() {
    this._byChunk.clear();
    this._ticking.length = 0;
    this._saved.clear();
    this._dirtyChunks.clear();
  }

  /** Stats for the debug overlay. */
  getStats() {
    return {
      loaded: this.count,
      ticking: this._ticking.length,
      savedChunks: this._saved.size,
      dirtyChunks: this._dirtyChunks.size,
    };
  }
}

export default BlockEntityStore;
