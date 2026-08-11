/**
 * A single chunk: voxel storage, lifecycle state and the player's edits.
 *
 * Storage is one `Uint16Array` of 32,768 entries — never one object per block.
 * At 16x16x128 that is 32 KB per chunk, so even a 20-chunk render distance
 * stays inside a few tens of megabytes.
 *
 * Deliberately free of Three.js: the chunk holds *references* to its meshes so
 * `ChunkManager` can find them, but creating and disposing GPU resources is the
 * manager's job. That keeps the data model testable in Node and keeps GPU
 * ownership in exactly one place.
 */

import { CHUNK_VOLUME, LAYER_NAMES, WORLD_HEIGHT } from '../config/GameConfig.js';
import { chunkKey, voxelIndex } from '../utils/CoordinateUtils.js';
import { Block } from './BlockTypes.js';
import { blockIdFromWord, normaliseState, packBlockWord, stateFromWord } from './BlockState.js';
import { encodeChunkSection, SECTION_SIZE } from './ChunkSection.js';

/**
 * Chunk lifecycle. Transitions are linear except for `DIRTY`, which any ready
 * chunk can re-enter when a block changes, and `DISPOSING`, which can be entered
 * from anywhere.
 *
 * ```
 * UNLOADED -> QUEUED -> GENERATING -> GENERATED -> MESHING -> READY -> VISIBLE
 *                                         ^                     |
 *                                         +------- DIRTY <------+
 * any state -> DISPOSING -> DISPOSED
 * ```
 * @enum {string}
 */
export const ChunkState = Object.freeze({
  UNLOADED: 'UNLOADED',
  QUEUED: 'QUEUED',
  GENERATING: 'GENERATING',
  GENERATED: 'GENERATED',
  MESHING: 'MESHING',
  READY: 'READY',
  VISIBLE: 'VISIBLE',
  DIRTY: 'DIRTY',
  DISPOSING: 'DISPOSING',
  DISPOSED: 'DISPOSED',
});

export class Chunk {
  /**
   * @param {number} chunkX
   * @param {number} chunkZ
   */
  constructor(chunkX, chunkZ) {
    this.chunkX = chunkX;
    this.chunkZ = chunkZ;
    this.key = chunkKey(chunkX, chunkZ);
    this.originX = chunkX * 16;
    this.originZ = chunkZ * 16;

    /** @type {string} */
    this.state = ChunkState.UNLOADED;

    /** @type {Uint16Array|null} Voxel ids; null until generated. */
    this.blocks = null;
    /** @type {Uint8Array|null} Per-voxel state bytes parallel to `blocks`. */
    this.states = null;
    /** @type {Int16Array|null} Per-column surface height. */
    this.heightMap = null;
    /** @type {Int16Array|null} Per-column biome id. */
    this.biomeMap = null;

    /**
     * Player edits, `voxelIndex -> (state << 16 | blockId)`.
     *
     * This is the only thing that gets persisted. Terrain is regenerated from
     * the seed on load and these are replayed on top, so an untouched world
     * costs nothing on disk.
     * @type {Map<number, number>}
     */
    this.edits = new Map();

    /**
     * Bumped whenever the voxel data changes.
     *
     * A mesh job carries the version it was started with; when the reply comes
     * back with an older version the result is discarded. This is what stops a
     * fast-clicking player from seeing a mesh that predates their last edit.
     */
    this.version = 0;

    /** Job ids for staleness checks. */
    this.generateJobId = -1;
    this.meshJobId = -1;

    /** @type {Record<string, any>} Layer name -> mesh (owned by ChunkManager). */
    this.meshes = Object.create(null);

    /** Highest non-air voxel, or -1 when the chunk is empty. */
    this.maxY = -1;
    /** Number of non-air voxels. */
    this.nonAirCount = 0;

    /** True when a re-mesh is needed but has not been requested yet. */
    this.needsRemesh = false;
    /** Monotonic timestamp of the last time the chunk was within render range. */
    this.lastSeen = 0;
    /**
     * When the current generate/mesh job was dispatched. `ChunkManager` uses this
     * to re-queue chunks whose worker died without replying.
     */
    this.jobStartedAt = 0;
    /** True when `edits` changed since the last successful save. */
    this.unsavedEdits = false;
  }

  /** True when voxel data is available for reading. */
  get hasData() {
    return this.blocks !== null;
  }

  /** True when at least one mesh has been uploaded. */
  get hasMesh() {
    for (const name of LAYER_NAMES) if (this.meshes[name]) return true;
    return false;
  }

  /** True when the chunk contains no blocks at all. */
  get isEmpty() {
    return this.nonAirCount === 0;
  }

  /**
   * Installs freshly generated voxel data and replays any stored edits.
   *
   * @param {Uint16Array} blocks
   * @param {Int16Array} heightMap
   * @param {Int16Array} biomeMap
   * @param {number} nonAirCount
   * @param {number} maxY
   * @param {Uint8Array|null} [states] Optional generated state bytes.
   */
  setGeneratedData(blocks, heightMap, biomeMap, nonAirCount, maxY, states = null) {
    if (blocks.length !== CHUNK_VOLUME) {
      throw new Error(`Chunk ${this.key} received ${blocks.length} voxels, expected ${CHUNK_VOLUME}`);
    }
    if (states !== null && states.length !== CHUNK_VOLUME) {
      throw new Error(`Chunk ${this.key} received ${states.length} states, expected ${CHUNK_VOLUME}`);
    }
    this.blocks = blocks;
    this.states = states ?? new Uint8Array(CHUNK_VOLUME);
    this.heightMap = heightMap;
    this.biomeMap = biomeMap;
    this.nonAirCount = nonAirCount;
    this.maxY = maxY;

    if (this.edits.size > 0) this._replayEdits();
    this.state = ChunkState.GENERATED;
  }

  /** Applies stored edits on top of generated terrain. */
  _replayEdits() {
    const blocks = this.blocks;
    const states = this.states;
    let nonAir = 0;
    let maxY = -1;
    for (const [index, word] of this.edits) {
      if (index < 0 || index >= CHUNK_VOLUME) continue;
      blocks[index] = blockIdFromWord(word);
      states[index] = stateFromWord(word);
    }
    // Edits can add or remove blocks, so the summary counters must be redone.
    for (let i = CHUNK_VOLUME - 1; i >= 0; i--) {
      if (blocks[i] !== Block.AIR) {
        nonAir++;
        if (maxY < 0) maxY = i >> 8;
      }
    }
    this.nonAirCount = nonAir;
    this.maxY = maxY;
  }

  /**
   * Reads a voxel by local coordinates.
   * @param {number} localX 0..15
   * @param {number} y 0..WORLD_HEIGHT-1
   * @param {number} localZ 0..15
   * @returns {number} Block id, or air when out of range or not yet generated.
   */
  getBlock(localX, y, localZ) {
    if (!this.blocks) return Block.AIR;
    if (y < 0 || y >= WORLD_HEIGHT) return Block.AIR;
    return this.blocks[voxelIndex(localX, y, localZ)];
  }

  /**
   * Reads a block state byte by local coordinates.
   * @returns {number} State byte, or zero when out of range/not generated.
   */
  getBlockState(localX, y, localZ) {
    if (!this.states) return 0;
    if (y < 0 || y >= WORLD_HEIGHT) return 0;
    return this.states[voxelIndex(localX, y, localZ)];
  }

  /**
   * Writes a voxel and records it as a player edit.
   *
   * @param {number} localX
   * @param {number} y
   * @param {number} localZ
   * @param {number} blockId
   * @param {boolean} [recordEdit] Set false for generator-driven writes.
   * @param {number} [state] Per-voxel state byte.
   * @returns {boolean} False when neither id nor state changed.
   */
  setBlock(localX, y, localZ, blockId, recordEdit = true, state = 0) {
    if (!this.blocks) return false;
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    const index = voxelIndex(localX, y, localZ);
    const previous = this.blocks[index];
    const previousState = this.states[index];
    const nextState = normaliseState(state);
    if (previous === blockId && previousState === nextState) return false;

    this.blocks[index] = blockId;
    this.states[index] = nextState;
    this.version++;

    if (previous === Block.AIR && blockId !== Block.AIR) {
      this.nonAirCount++;
      if (y > this.maxY) this.maxY = y;
    } else if (previous !== Block.AIR && blockId === Block.AIR) {
      this.nonAirCount--;
      if (y === this.maxY) this.maxY = this._findMaxY();
    }

    if (recordEdit) {
      this.edits.set(index, packBlockWord(blockId, nextState));
      this.unsavedEdits = true;
    }
    this.needsRemesh = true;
    return true;
  }

  /**
   * Changes only the state byte of an existing block.
   * @returns {boolean} False when the state was already equal.
   */
  setBlockState(localX, y, localZ, state, recordEdit = true) {
    if (!this.blocks || !this.states) return false;
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    const index = voxelIndex(localX, y, localZ);
    return this.setBlock(localX, y, localZ, this.blocks[index], recordEdit, state);
  }

  /** Recomputes the highest non-air voxel. */
  _findMaxY() {
    const blocks = this.blocks;
    for (let i = CHUNK_VOLUME - 1; i >= 0; i--) {
      if (blocks[i] !== Block.AIR) return i >> 8;
    }
    return -1;
  }

  /** Number of 16-block vertical storage sections in this chunk. */
  get sectionCount() {
    return Math.ceil(WORLD_HEIGHT / SECTION_SIZE);
  }

  /**
   * Creates a palette-compressed snapshot of one vertical section.
   *
   * Dense runtime arrays remain authoritative; this snapshot is intended for
   * save/cache transport and debug tooling, so callers cannot mutate the chunk
   * through it.
   */
  encodeSection(sectionY) {
    if (!this.blocks || !this.states) return null;
    if (!Number.isInteger(sectionY) || sectionY < 0 || sectionY >= this.sectionCount) return null;
    return encodeChunkSection(this.blocks, this.states, sectionY);
  }

  /** Surface height of a local column, or -1 when unknown. */
  getSurfaceHeight(localX, localZ) {
    if (!this.heightMap) return -1;
    return this.heightMap[localX + localZ * 16];
  }

  /** Biome id of a local column, or -1 when unknown. */
  getBiome(localX, localZ) {
    if (!this.biomeMap) return -1;
    return this.biomeMap[localX + localZ * 16];
  }

  /**
   * Loads persisted edits before generation, so `setGeneratedData` can replay
   * them the moment terrain arrives.
   * @param {Map<number, number>} edits
   */
  loadEdits(edits) {
    this.edits = edits;
    this.unsavedEdits = false;
    if (this.blocks) {
      this._replayEdits();
      this.version++;
      this.needsRemesh = true;
    }
  }

  /** Marks the chunk's edits as persisted. */
  markEditsSaved() {
    this.unsavedEdits = false;
  }

  /**
   * Releases voxel data and clears mesh references.
   *
   * GPU disposal is the manager's job; this only drops the chunk's own
   * references so nothing keeps a 32 KB array or a geometry alive.
   *
   * The edit map reference is reset locally — `World._edits` retains the
   * canonical Map, so walking away and back replays the build exactly.
   * A fresh Chunk created for this key will be re-linked via `loadEdits` /
   * `_editsFor`.
   */
  release() {
    this.state = ChunkState.DISPOSED;
    this.blocks = null;
    this.states = null;
    this.heightMap = null;
    this.biomeMap = null;
    this.edits = new Map();
    for (const name of LAYER_NAMES) this.meshes[name] = null;
    this.generateJobId = -1;
    this.meshJobId = -1;
  }
}

export default Chunk;
