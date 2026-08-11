/**
 * The world: block access, edits and the rules that follow from an edit.
 *
 * `World` is the boundary every other system talks to. Physics asks it whether a
 * position is solid, the raycaster asks it for block ids, interaction asks it to
 * place and break. It owns the edit store and the chunk manager, and it is the
 * only place that knows how a block change ripples outward:
 *
 *  - the owning chunk plus, for border blocks, up to three neighbours are
 *    re-meshed (ambient occlusion samples diagonals, so corners need all three);
 *  - a block that needs support pops off when its support disappears;
 *  - sand and gravel become falling entities when the block beneath them goes.
 *
 * Those cascades are queued and processed with a hard per-step budget, because
 * "remove one block at the bottom of a sand column" is exactly the input that
 * turns a naive recursive implementation into a stack overflow.
 */

import * as THREE from 'three';

import { BLOCK_TICKS, ENTITIES, PHYSICS, SEA_LEVEL, WORLD_HEIGHT } from '../config/GameConfig.js';
import { Events } from '../core/EventBus.js';
import { packChunkEdits, unpackChunkEdits } from '../core/SaveManager.js';
import { hash3 } from '../utils/MathUtils.js';
import {
  blockToChunkX,
  blockToChunkZ,
  blockToLocalX,
  blockToLocalZ,
  chunkKey,
  collectAffectedChunks,
  voxelIndex,
} from '../utils/CoordinateUtils.js';
import { Block } from './BlockTypes.js';
import {
  getBlockBehavior,
  hasRandomTickBehavior,
  needsScheduledBootstrap,
} from './BlockBehaviorRegistry.js';
import { BlockTickScheduler } from './BlockTickScheduler.js';
import { normaliseState, packBlockWord } from './BlockState.js';
import {
  BLOCK_COUNT,
  DEFAULT_STATE,
  DROP_ID,
  HARDNESS,
  IS_BREAKABLE,
  IS_COLLIDABLE,
  IS_GRAVITY,
  IS_LIQUID,
  IS_OPAQUE,
  IS_SOLID,
  LIGHT_ATTENUATION,
  LIGHT_LEVEL,
  NEEDS_SUPPORT,
  getBlock,
} from './BlockRegistry.js';
import { ChunkManager } from './ChunkManager.js';
import { createBlockLightSampleScratch, sampleWorldBlockLight } from './BlockLight.js';
import { createGenerator } from './DimensionGenerators.js';
import { createColumnSample, getBiomeName } from './BiomeGenerator.js';
import { BlockEntityStore } from './blockentity/BlockEntityStore.js';
import { hasBlockEntity } from './blockentity/BlockEntity.js';
import { Dimension, getDimension, isDimension } from './DimensionConfig.js';
import { extinguishPortal } from './NetherPortal.js';
// Imported for their registration side effect: each module registers itself with
// `BlockEntity`'s type table on load. Without these the world would create no
// chests or furnaces at all.
import './blockentity/ChestBlockEntity.js';
import './blockentity/FurnaceBlockEntity.js';
import './blockentity/ShulkerBoxBlockEntity.js';
// Stateful block packs register their deterministic tick hooks on import.
import './behaviors/AgricultureBehaviors.js';
import './behaviors/FluidBehaviors.js';
import './behaviors/FireBehaviors.js';
import './behaviors/NaturalDrops.js';
import './behaviors/RedstoneBehaviors.js';
import './behaviors/StructuralBehaviors.js';

/** Cascade checks processed per fixed step. */
const CASCADE_BUDGET_PER_STEP = 24;

export class World {
  /**
   * @param {Object} options
   * @param {THREE.Scene} options.scene
   * @param {import('../core/EventBus.js').EventBus} options.bus
   * @param {import('../core/SettingsManager.js').SettingsManager} options.settings
   * @param {import('../core/ResourceManager.js').ResourceManager} options.resources
   * @param {import('../rendering/Materials.js').Materials} options.materials
   * @param {number} options.seed
   */
  constructor({ scene, bus, settings, resources, materials, seed }) {
    this.seed = seed >>> 0;
    this._bus = bus;
    this._settings = settings;
    this.dimension = getDimension(Dimension.OVERWORLD);
    this.minY = 0;
    this.maxY = this.dimension.height - 1;
    this.seaLevel = this.dimension.seaLevel;

    /**
     * Every edit the player has made this session, `chunkKey -> (voxelIndex ->
     * blockWord)` where `blockWord = state << 16 | blockId`.
     *
     * Owned here rather than by the chunks so that walking away from a build and
     * back again replays it exactly, and so saving does not depend on which
     * chunks happen to be resident.
     * @type {Map<string, Map<number, number>>}
     */
    this._edits = new Map();
    /** Chunk keys whose edits changed since the last successful save. */
    this._dirtyEditKeys = new Set();

    /**
     * Phase 4. Edits belonging to dimensions the player is not currently in,
     * keyed by dimension id.
     *
     * Travelling stashes the live edit map here and swaps in the destination's,
     * so a base built in the Nether is still standing when you come back, and
     * an Overworld chunk key can never collide with a Nether one.
     * @type {Map<string, Map<string, Map<number, number>>>}
     */
    this._editsByDimension = new Map();

    /**
     * A main-thread generator, used for queries that must work for columns no
     * chunk is loaded for: spawn search and the debug overlay's biome readout.
     * Generation for rendering always happens in the workers.
     */
    this.generator = createGenerator(this.dimension.id, this.seed);
    this._columnSample = createColumnSample();

    /** Canonical 20 Hz block simulation clock. */
    this.gameTick = 0;
    this._blockTickAccumulator = 0;
    this._blockTicks = new BlockTickScheduler();
    /** Loaded chunk keys participating in random ticks. */
    this._tickChunkKeys = new Set();
    this._sortedTickChunkKeys = [];
    this._tickChunkOrderDirty = true;

    this.chunks = new ChunkManager({
      scene,
      bus,
      settings,
      resources,
      materials,
      seed: this.seed,
      dimension: this.dimension.id,
    });
    this.chunks.editProvider = (chunkX, chunkZ) => this._editsFor(chunkX, chunkZ, false);
    this.chunks.onChunkDataReady = (key, chunk) => {
      this._tickChunkKeys.add(key);
      this._tickChunkOrderDirty = true;
      this._indexEmissiveBlocks(key, chunk);
      this._bootstrapChunkBehaviors(chunk);
      // Instantiate this chunk's saved chests and furnaces now that its voxels
      // exist, and let any machine reconcile the time it spent unloaded.
      this.blockEntities.loadChunk(chunk.chunkX, chunk.chunkZ);
    };

    /**
     * Index of light-emitting blocks, `chunkKey -> (voxelIndex -> light record)`.
     *
     * Maintained incrementally so the renderer can find the torches near the
     * camera without scanning the world every frame. Scanning a chunk once on
     * load costs about 30 microseconds; scanning every frame would not fit in the
     * budget at any render distance.
     * @type {Map<string, Map<number, {x: number, y: number, z: number, level: number}>>}
     */
    this._emissive = new Map();

    /**
     * Chests, furnaces and anything else whose state cannot fit in a voxel byte.
     *
     * Keyed exactly like `_emissive` above, and for the same reason: a chunk
     * unload has to be able to drop a whole chunk's records in one step.
     * @type {BlockEntityStore}
     */
    this.blockEntities = new BlockEntityStore({ world: this });

    this._unsubscribeChunkUnloaded = bus.on(Events.CHUNK_UNLOADED, (chunkX, chunkZ) => {
      const key = chunkKey(chunkX, chunkZ);
      this._tickChunkKeys.delete(key);
      this._tickChunkOrderDirty = true;
      this._emissive.delete(key);
      // Serialises before forgetting, so unloading is not destructive.
      this.blockEntities.unloadChunk(chunkX, chunkZ);
    });

    /** @type {Array<{x: number, y: number, z: number, depth: number}>} */
    this._cascadeQueue = [];
    this._cascadeCount = 0;

    /**
     * Called when a gravity-affected block should become a falling entity.
     * @type {((x: number, y: number, z: number, blockId: number) => boolean)|null}
     */
    this.onFallingBlock = null;
    /**
     * Called when a block should drop an item (survival-like mode).
     * @type {((x: number, y: number, z: number, blockId: number) => void)|null}
     */
    this.onBlockDrop = null;
    /**
     * Called when a block behaviour yields arbitrary item stacks.
     *
     * Crops are the first consumer: a mature wheat plant produces wheat plus
     * seeds, which cannot be represented by the legacy single-block-id drop
     * hook. Keeping this callback stack-based also gives leaves, gravel and
     * fortune-style loot a lossless path later.
     * @type {((x: number, y: number, z: number, stacks: import('../items/ItemStack.js').ItemStack[]) => void)|null}
     */
    this.onItemDrops = null;
    /**
     * Called with a broken container's contents so they can be scattered.
     *
     * Separate from `onBlockDrop` because that hook takes a single block id,
     * whereas a chest yields up to 27 arbitrary stacks.
     * @type {((x: number, y: number, z: number, stacks: import('../items/ItemStack.js').ItemStack[]) => void)|null}
     */
    this.onBlockEntityDrops = null;

    this._scratchAffected = [];
    this._scratchVector = new THREE.Vector3();
    /** Scratch buffer for `collectNearbyLights`. */
    this._lightCandidates = [];
    /** Reused bounded search storage for gameplay block-light queries. */
    this._blockLightSampleScratch = createBlockLightSampleScratch();
  }

  /** Streaming statistics. */
  get stats() {
    return this.chunks.stats;
  }

  /** Whether survival block interactions should create item entities. */
  get itemDropsEnabled() {
    return Boolean(this._settings.get('gameplay.dropItems'));
  }

  // -------------------------------------------------------------- block access

  /**
   * Reads a block by world coordinates.
   *
   * Returns air above and below the world, and air for unloaded chunks. Callers
   * that must distinguish "air" from "not loaded" should use `isLoaded()`.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {number} Block id.
   */
  getBlock(x, y, z) {
    if (y < 0 || y >= WORLD_HEIGHT) return Block.AIR;
    const chunk = this.chunks.getChunk(blockToChunkX(x), blockToChunkZ(z));
    if (!chunk || !chunk.blocks) return Block.AIR;
    return chunk.blocks[voxelIndex(blockToLocalX(x), y, blockToLocalZ(z))];
  }

  /**
   * Reads the state byte parallel to a block id.
   *
   * Unloaded/out-of-range positions return zero, matching every block's default
   * state and preserving the behaviour of worlds saved before states existed.
   */
  getBlockState(x, y, z) {
    if (y < 0 || y >= WORLD_HEIGHT) return 0;
    const chunk = this.chunks.getChunk(blockToChunkX(x), blockToChunkZ(z));
    if (!chunk?.states) return 0;
    return chunk.states[voxelIndex(blockToLocalX(x), y, blockToLocalZ(z))];
  }

  /**
   * True when the chunk containing a position has voxel data.
   * Physics uses this to avoid letting the player fall through terrain that has
   * not streamed in yet.
   */
  isLoaded(x, z) {
    const chunk = this.chunks.getChunk(blockToChunkX(x), blockToChunkZ(z));
    return Boolean(chunk && chunk.blocks);
  }

  /** True when the block at this position collides with entities. */
  isCollidable(x, y, z) {
    // Below the world is treated as solid so nothing can fall out of it.
    if (y < 0) return true;
    if (y >= WORLD_HEIGHT) return false;
    return IS_COLLIDABLE[this.getBlock(x, y, z)] === 1;
  }

  /** True when the block at this position is a liquid. */
  isLiquid(x, y, z) {
    return IS_LIQUID[this.getBlock(x, y, z)] === 1;
  }

  /** True when the block at this position is a full opaque cube. */
  isOpaque(x, y, z) {
    return IS_OPAQUE[this.getBlock(x, y, z)] === 1;
  }

  /** True when the block can support an attached block such as a torch. */
  isSupportive(x, y, z) {
    return IS_SOLID[this.getBlock(x, y, z)] === 1;
  }

  /** Seconds to break the block at this position, or `Infinity`. */
  getHardness(x, y, z) {
    return HARDNESS[this.getBlock(x, y, z)];
  }

  /** Light emitted by the block at this position, 0..15. */
  getEmission(x, y, z) {
    return LIGHT_LEVEL[this.getBlock(x, y, z)];
  }

  /** Propagated block light at a loaded voxel, 0..15. */
  getBlockLight(x, y, z) {
    return sampleWorldBlockLight(
      (blockX, blockY, blockZ) => this.getBlock(blockX, blockY, blockZ),
      x,
      y,
      z,
      {
        isLoaded: (blockX, blockZ) => this.isLoaded(blockX, blockZ),
        scratch: this._blockLightSampleScratch,
      }
    );
  }

  /**
   * Climate sample for a column, valid even for unloaded chunks.
   * @param {number} x
   * @param {number} z
   */
  sampleColumn(x, z) {
    return this.generator.sampleColumn(Math.floor(x), Math.floor(z), this._columnSample);
  }

  /**
   * Biome name at a position, preferring loaded chunk data and falling back to
   * the generator.
   */
  getBiomeNameAt(x, z) {
    const chunk = this.chunks.getChunk(blockToChunkX(x), blockToChunkZ(z));
    if (chunk?.biomeMap) {
      const biome = chunk.getBiome(blockToLocalX(x), blockToLocalZ(z));
      if (biome >= 0) return getBiomeName(biome);
    }
    return getBiomeName(this.sampleColumn(x, z).biome);
  }

  /**
   * Highest solid block in a column, searching loaded data first.
   * @returns {number} Y of the highest non-air block, or -1.
   */
  getSurfaceY(x, z) {
    const chunk = this.chunks.getChunk(blockToChunkX(x), blockToChunkZ(z));
    if (chunk?.blocks) {
      const localX = blockToLocalX(x);
      const localZ = blockToLocalZ(z);
      for (let y = Math.min(chunk.maxY, WORLD_HEIGHT - 1); y >= 0; y--) {
        const id = chunk.blocks[voxelIndex(localX, y, localZ)];
        if (id !== Block.AIR && !IS_LIQUID[id]) return y;
      }
      return -1;
    }
    return this.generator.getSurfaceHeight(Math.floor(x), Math.floor(z));
  }

  // ------------------------------------------------------------------- editing

  /**
   * Writes a block and runs every consequence of the change.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} blockId
   * @param {Object} [options]
   * @param {boolean} [options.recordEdit] Persist the change (default true).
   * @param {boolean} [options.cascade] Run support/gravity checks (default true).
   * @param {number} [options.state] Per-voxel state byte (default zero).
   * @param {string} [options.cause] Tag forwarded on the change event.
   * @returns {boolean} False when nothing changed or the chunk is not loaded.
   */
  setBlock(x, y, z, blockId, options = {}) {
    const { recordEdit = true, cascade = true, cause = 'player', state = 0 } = options;
    const nextState = normaliseState(state);
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    if (!Number.isInteger(blockId) || blockId < 0 || blockId >= BLOCK_COUNT) return false;

    const chunkX = blockToChunkX(x);
    const chunkZ = blockToChunkZ(z);
    const chunk = this.chunks.getChunk(chunkX, chunkZ);
    if (!chunk || !chunk.blocks) return false;

    const localX = blockToLocalX(x);
    const localZ = blockToLocalZ(z);
    const index = voxelIndex(localX, y, localZ);
    const previous = chunk.blocks[index];
    const previousState = chunk.states?.[index] ?? 0;
    if (previous === blockId && previousState === nextState) return false;

    if (recordEdit) {
      // The world owns the edit store; point the chunk at the same Map instance
      // so the record survives the chunk being unloaded and reloaded.
      const store = this._editsFor(chunkX, chunkZ, true);
      if (chunk.edits !== store) {
        for (const [editIndex, word] of chunk.edits) store.set(editIndex, word);
        chunk.edits = store;
      }
    }

    // `Chunk.setBlock` writes the voxel and, when recording, the edit entry into
    // the shared store above.
    if (!chunk.setBlock(localX, y, localZ, blockId, recordEdit, nextState)) return false;
    if (recordEdit) this._dirtyEditKeys.add(chunk.key);

    if (previous !== blockId) {
      this._updateEmissiveIndex(chunk.key, index, x, y, z, blockId);
      this._syncBlockEntity(x, y, z, previous, blockId);
      // Phase 4. Breaking any part of the obsidian frame collapses the plane it
      // held up. Without this a portal keeps working with no frame around it,
      // which is both wrong and impossible to turn off once lit.
      if (cause !== 'portal-light' && cause !== 'portal-build' && cause !== 'portal-break') {
        this._collapsePortals(x, y, z, previous, blockId);
      }
    }

    // Re-mesh the owning chunk and any neighbour whose geometry can see the
    // change. Diagonals are included because ambient occlusion reads them.
    const affected = collectAffectedChunks(chunkX, chunkZ, localX, localZ, this._scratchAffected);
    for (let i = 0; i < affected.length; i++) {
      this.chunks.markDirty(affected[i][0], affected[i][1]);
    }

    // Propagated block light reaches up to 15 voxels, so a source or opacity
    // change can alter the centre mesh of any immediate neighbour even when the
    // edited voxel itself is not on a chunk border. Remesh the 3x3 neighbourhood
    // only for light-relevant edits; ordinary block changes retain the cheaper
    // geometry/AO invalidation above.
    if (
      LIGHT_LEVEL[previous] !== LIGHT_LEVEL[blockId] ||
      LIGHT_ATTENUATION[previous] !== LIGHT_ATTENUATION[blockId]
    ) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          this.chunks.markDirty(chunkX + dx, chunkZ + dz);
        }
      }
    }

    const change = {
      x,
      y,
      z,
      previous,
      previousState,
      current: blockId,
      currentState: nextState,
      cause,
    };
    this._bus.emit(Events.BLOCK_CHANGED, change);
    this._dispatchBlockChange(change);

    if (cascade) {
      this._cascadeCount = 0;
      this._queueCascade(x, y + 1, z, 0);
      this._queueCascade(x, y, z, 0);
    }

    return true;
  }

  /**
   * Updates only a block's state byte while preserving its id.
   *
   * This still records an edit, emits `BLOCK_CHANGED` and remeshes affected
   * chunks, so callers cannot create a visual state that disappears on save.
   */
  setBlockState(x, y, z, state, options = {}) {
    const blockId = this.getBlock(x, y, z);
    if (blockId === Block.AIR && !this.isLoaded(x, z)) return false;
    return this.setBlock(x, y, z, blockId, { ...options, state });
  }

  /** Returns the packed id/state word at a position. */
  getBlockWord(x, y, z) {
    return packBlockWord(this.getBlock(x, y, z), this.getBlockState(x, y, z));
  }

  /**
   * Breaks a block, optionally dropping an item.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {{drop?: boolean,context?:Object}} [options]
   * @returns {number} The removed block id, or `Block.AIR` when nothing broke.
   */
  breakBlock(x, y, z, options = {}) {
    const blockId = this.getBlock(x, y, z);
    if (blockId === Block.AIR || !IS_BREAKABLE[blockId]) return Block.AIR;
    const state = this.getBlockState(x, y, z);
    const behaviour = getBlockBehavior(blockId);
    if (!this.setBlock(x, y, z, Block.AIR, { cause: 'break' })) return Block.AIR;

    if (options.drop) {
      const customDrops = behaviour?.drops
        ? this._callBehaviour(behaviour.drops, {
            world: this,
            x,
            y,
            z,
            blockId,
            state,
            tick: this.gameTick,
            context: options.context ?? null,
          })
        : undefined;

      // Returning an array, including an empty one, deliberately overrides the
      // ordinary block drop. `undefined` means "use the registry default".
      if (Array.isArray(customDrops)) {
        const stacks = customDrops.filter((stack) => stack && !stack.isEmpty);
        if (stacks.length > 0 && this.onItemDrops) {
          this.onItemDrops(x + 0.5, y + 0.5, z + 0.5, stacks);
        }
      } else if (this.onBlockDrop) {
        const dropId = DROP_ID[blockId];
        if (dropId !== Block.AIR) this.onBlockDrop(x + 0.5, y + 0.5, z + 0.5, dropId);
      }
    }
    return blockId;
  }

  /**
   * Places a block if the target position allows it.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} blockId
   * @param {{allowReplaceLiquid?: boolean,state?: number}} [options]
   * @returns {boolean}
   */
  placeBlock(x, y, z, blockId, options = {}) {
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    const existing = this.getBlock(x, y, z);
    const replaceable =
      existing === Block.AIR ||
      (options.allowReplaceLiquid !== false && IS_LIQUID[existing]) ||
      // Plants are trampled rather than blocking placement.
      (!IS_SOLID[existing] && NEEDS_SUPPORT[existing]);
    if (!replaceable) return false;

    const definition = getBlock(blockId);
    if (definition.needsSupport && !this.isSupportive(x, y - 1, z)) return false;

    return this.setBlock(x, y, z, blockId, {
      cause: 'place',
      state: options.state ?? DEFAULT_STATE[blockId],
    });
  }

  // ------------------------------------------------------ emissive block index

  /** Scans a freshly generated chunk for light-emitting blocks. */
  _indexEmissiveBlocks(key, chunk) {
    const blocks = chunk.blocks;
    if (!blocks) return;

    /** @type {Map<number, {x: number, y: number, z: number, level: number}>|null} */
    let found = null;
    for (let index = 0; index < blocks.length; index++) {
      const level = LIGHT_LEVEL[blocks[index]];
      if (level === 0) continue;
      if (!found) found = new Map();
      // Unpack `x | (z << 4) | (y << 8)`.
      found.set(index, {
        x: chunk.originX + (index & 15) + 0.5,
        y: (index >> 8) + 0.5,
        z: chunk.originZ + ((index >> 4) & 15) + 0.5,
        level,
      });
    }

    if (found) this._emissive.set(key, found);
    else this._emissive.delete(key);
  }

  /** Keeps the emissive index in step with a single block change. */
  /**
   * Creates or destroys the block entity for a changed voxel.
   *
   * Called from `setBlock` after the voxel is written. Contents of a destroyed
   * container are handed to `onBlockDrop` so they scatter, because the store has
   * no route to the entity manager and giving it one would tie world state to
   * rendering.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} previous Block id that was there.
   * @param {number} current Block id now there.
   */
  _syncBlockEntity(x, y, z, previous, current) {
    const hadEntity = hasBlockEntity(previous);
    const needsEntity = hasBlockEntity(current);
    if (!hadEntity && !needsEntity) return;

    if (hadEntity && !needsEntity) {
      const drops = this.blockEntities.remove(x, y, z);
      if (this.onBlockEntityDrops && drops.length > 0) {
        this.onBlockEntityDrops(x + 0.5, y + 0.5, z + 0.5, drops);
      }
      return;
    }

    // `create` keeps an existing entity when the type is unchanged, which is what
    // lets a furnace swap between its lit and unlit block ids without losing what
    // is inside it.
    this.blockEntities.create(x, y, z, current);
  }

  /**
   * The block entity at a position, or null.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {import('./blockentity/BlockEntity.js').BlockEntity|null}
   */
  getBlockEntity(x, y, z) {
    return this.blockEntities.get(x, y, z);
  }

  _updateEmissiveIndex(key, index, x, y, z, blockId) {
    const level = LIGHT_LEVEL[blockId];
    let chunkLights = this._emissive.get(key);

    if (level === 0) {
      if (!chunkLights) return;
      chunkLights.delete(index);
      if (chunkLights.size === 0) this._emissive.delete(key);
      return;
    }

    if (!chunkLights) {
      chunkLights = new Map();
      this._emissive.set(key, chunkLights);
    }
    chunkLights.set(index, { x: x + 0.5, y: y + 0.5, z: z + 0.5, level });
  }

  /**
   * Collects the emissive blocks nearest a position.
   *
   * Only chunks within the search radius are visited, and the result is a
   * partial selection sort into a caller-provided array — no allocation and no
   * full sort of every light in the world.
   *
   * @param {THREE.Vector3} position
   * @param {number} maxCount
   * @param {number} maxRange In blocks.
   * @param {Array<{x: number, y: number, z: number, range: number}>} out Reused.
   * @returns {Array<{x: number, y: number, z: number, range: number}>}
   */
  collectNearbyLights(position, maxCount, maxRange, out) {
    out.length = 0;
    if (this._emissive.size === 0) return out;

    const rangeSq = maxRange * maxRange;
    const chunkRadius = Math.ceil(maxRange / 16);
    const centreChunkX = blockToChunkX(Math.floor(position.x));
    const centreChunkZ = blockToChunkZ(Math.floor(position.z));

    /** @type {Array<{x: number, y: number, z: number, range: number, distanceSq: number}>} */
    const candidates = this._lightCandidates;
    candidates.length = 0;

    for (let dz = -chunkRadius; dz <= chunkRadius; dz++) {
      for (let dx = -chunkRadius; dx <= chunkRadius; dx++) {
        const lights = this._emissive.get(chunkKey(centreChunkX + dx, centreChunkZ + dz));
        if (!lights) continue;
        for (const light of lights.values()) {
          const deltaX = light.x - position.x;
          const deltaY = light.y - position.y;
          const deltaZ = light.z - position.z;
          const distanceSq = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
          if (distanceSq > rangeSq) continue;
          candidates.push({
            x: light.x,
            y: light.y,
            z: light.z,
            // Emission range scales with the block's light level.
            range: 2 + light.level * 0.9,
            distanceSq,
          });
        }
      }
    }

    candidates.sort((a, b) => a.distanceSq - b.distanceSq);
    const count = Math.min(candidates.length, maxCount);
    for (let i = 0; i < count; i++) out.push(candidates[i]);
    return out;
  }

  // ------------------------------------------------------------------ cascades

  /**
   * Queues a position for support and gravity evaluation.
   *
   * Queued rather than recursive: pulling the bottom block from a tall sand
   * column would otherwise recurse once per block, and a large cave-in would
   * blow the stack. The queue also lets the work be spread across frames.
   */
  _queueCascade(x, y, z, depth) {
    if (y < 0 || y >= WORLD_HEIGHT) return;
    if (this._cascadeCount >= ENTITIES.maxGravityCascade) return;
    if (this._cascadeQueue.length >= ENTITIES.maxGravityCascade * 2) return;
    this._cascadeCount++;
    this._cascadeQueue.push({ x, y, z, depth });
  }

  /** Processes a bounded slice of the cascade queue. */
  _processCascades() {
    let processed = 0;
    while (this._cascadeQueue.length > 0 && processed < CASCADE_BUDGET_PER_STEP) {
      const item = this._cascadeQueue.shift();
      processed++;
      this._evaluatePosition(item.x, item.y, item.z, item.depth);
    }
  }

  _evaluatePosition(x, y, z, depth) {
    const blockId = this.getBlock(x, y, z);
    if (blockId === Block.AIR) return;

    // A block that needs a floor loses it.
    if (NEEDS_SUPPORT[blockId] && !this.isSupportive(x, y - 1, z)) {
      this.setBlock(x, y, z, Block.AIR, { cause: 'support' });
      if (this.onBlockDrop && this._settings.get('gameplay.dropItems')) {
        const dropId = DROP_ID[blockId];
        if (dropId !== Block.AIR) this.onBlockDrop(x + 0.5, y + 0.5, z + 0.5, dropId);
      }
      this._queueCascade(x, y + 1, z, depth + 1);
      return;
    }

    // Sand and gravel fall.
    if (
      IS_GRAVITY[blockId] &&
      this._settings.get('gameplay.fallingBlocks') &&
      depth < 64 &&
      this._canFallInto(x, y - 1, z)
    ) {
      if (this.onFallingBlock && this.onFallingBlock(x, y, z, blockId)) {
        // The entity now owns the block; remove it from the grid.
        this.setBlock(x, y, z, Block.AIR, { cascade: false, cause: 'gravity' });
        this._queueCascade(x, y + 1, z, depth + 1);
      }
    }
  }

  /** True when a falling block may occupy this position. */
  _canFallInto(x, y, z) {
    if (y < 0) return false;
    const target = this.getBlock(x, y, z);
    return target === Block.AIR || IS_LIQUID[target];
  }

  /**
   * Settles a falling block back into the voxel grid.
   * @returns {boolean} False when the destination was taken in the meantime.
   */
  settleFallingBlock(x, y, z, blockId) {
    const blockX = Math.floor(x);
    const blockY = Math.floor(y);
    const blockZ = Math.floor(z);
    if (!this._canFallInto(blockX, blockY, blockZ)) {
      // Try one block up rather than deleting the player's sand.
      if (!this._canFallInto(blockX, blockY + 1, blockZ)) return false;
      return this.setBlock(blockX, blockY + 1, blockZ, blockId, { cause: 'gravity' });
    }
    return this.setBlock(blockX, blockY, blockZ, blockId, { cause: 'gravity' });
  }

  // -------------------------------------------------------------------- update

  /**
   * Per-frame world update.
   *
   * @param {number} dt
   * @param {THREE.Vector3} playerPosition
   * @param {THREE.Vector3} cameraForward
   */
  update(dt, playerPosition, cameraForward) {
    this.chunks.setCameraHeight(playerPosition.y);
    this.chunks.update(dt, playerPosition, cameraForward);
  }

  /**
   * Fixed-step update, where cascades and machines are advanced.
   * @param {number} [step] Seconds. Defaults to the fixed timestep.
   */
  fixedUpdate(step = PHYSICS.timeStep) {
    this._processCascades();
    // Furnaces run whether or not anyone is looking at them, which is why this
    // lives in the world tick rather than in the furnace UI.
    this.blockEntities.tick(step);

    this._blockTickAccumulator += step;
    const tickSeconds = 1 / BLOCK_TICKS.ticksPerSecond;
    let catchUp = 0;
    while (
      this._blockTickAccumulator >= tickSeconds &&
      catchUp < BLOCK_TICKS.maxCatchUpTicks
    ) {
      this._blockTickAccumulator -= tickSeconds;
      this._runGameTick();
      catchUp++;
    }
    if (catchUp === BLOCK_TICKS.maxCatchUpTicks) {
      // Do not replay minutes of plant/fluid simulation after a suspended tab.
      this._blockTickAccumulator = Math.min(this._blockTickAccumulator, tickSeconds);
    }
  }

  /** Schedules a deterministic block tick relative to the current game tick. */
  scheduleBlockTick(x, y, z, delayTicks = 1, channel = 'block', data = null) {
    if (y < 0 || y >= WORLD_HEIGHT) return null;
    return this._blockTicks.schedule(this.gameTick, x, y, z, delayTicks, channel, data);
  }

  /** Number of pending scheduled block reactions. */
  get scheduledBlockTickCount() {
    return this._blockTicks.size;
  }

  _runGameTick() {
    this.gameTick++;
    this._blockTicks.runDue(
      this.gameTick,
      (entry) => this._deliverScheduledTick(entry),
      BLOCK_TICKS.maxScheduledPerTick
    );
    this._runRandomTicks();
  }

  _deliverScheduledTick(entry) {
    if (!this.isLoaded(entry.x, entry.z)) return;
    const blockId = this.getBlock(entry.x, entry.y, entry.z);
    const behaviour = getBlockBehavior(blockId);
    if (!behaviour?.scheduledTick) return;
    this._callBehaviour(behaviour.scheduledTick, {
      world: this,
      x: entry.x,
      y: entry.y,
      z: entry.z,
      blockId,
      state: this.getBlockState(entry.x, entry.y, entry.z),
      tick: this.gameTick,
      channel: entry.channel,
      data: entry.data,
    });
  }

  _runRandomTicks() {
    if (this._tickChunkOrderDirty) {
      this._sortedTickChunkKeys = [...this._tickChunkKeys].sort();
      this._tickChunkOrderDirty = false;
    }

    for (const key of this._sortedTickChunkKeys) {
      const comma = key.indexOf(',');
      const chunkX = Number(key.slice(0, comma));
      const chunkZ = Number(key.slice(comma + 1));
      const chunk = this.chunks.getChunk(chunkX, chunkZ);
      if (!chunk?.blocks) continue;

      for (let sample = 0; sample < BLOCK_TICKS.randomTicksPerChunk; sample++) {
        const random = hash3(
          chunkX ^ Math.imul(sample + 1, 0x9e37),
          chunkZ ^ Math.imul(this.gameTick, 0x85eb),
          this.gameTick + sample,
          this.seed
        );
        const index = random % chunk.blocks.length;
        const blockId = chunk.blocks[index];
        if (!hasRandomTickBehavior(blockId)) continue;
        const x = chunk.originX + (index & 15);
        const y = index >> 8;
        const z = chunk.originZ + ((index >> 4) & 15);
        const behaviour = getBlockBehavior(blockId);
        this._callBehaviour(behaviour.randomTick, {
          world: this,
          x,
          y,
          z,
          blockId,
          state: chunk.states?.[index] ?? 0,
          tick: this.gameTick,
          random: random / 4294967296,
        });
      }
    }
  }

  /** Schedules stateful blocks that were loaded without an active tick queue. */
  _bootstrapChunkBehaviors(chunk) {
    if (!chunk?.blocks) return;
    for (let index = 0; index < chunk.blocks.length; index++) {
      const blockId = chunk.blocks[index];
      if (!needsScheduledBootstrap(blockId)) continue;
      const behaviour = getBlockBehavior(blockId);
      this.scheduleBlockTick(
        chunk.originX + (index & 15),
        index >> 8,
        chunk.originZ + ((index >> 4) & 15),
        behaviour.bootstrapDelay,
        'bootstrap'
      );
    }
  }

  _dispatchBlockChange(change) {
    const previousBehaviour = getBlockBehavior(change.previous);
    const currentBehaviour = getBlockBehavior(change.current);

    if (change.previous !== change.current) {
      this._blockTicks.cancelPosition(change.x, change.y, change.z);
      if (previousBehaviour?.removed) {
        this._callBehaviour(previousBehaviour.removed, {
          world: this,
          x: change.x,
          y: change.y,
          z: change.z,
          blockId: change.previous,
          state: change.previousState,
          change,
        });
      }
      if (currentBehaviour?.placed) {
        this._callBehaviour(currentBehaviour.placed, {
          world: this,
          x: change.x,
          y: change.y,
          z: change.z,
          blockId: change.current,
          state: change.currentState,
          change,
        });
      }
    }

    const neighbours = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    for (const [dx, dy, dz] of neighbours) {
      const x = change.x + dx;
      const y = change.y + dy;
      const z = change.z + dz;
      if (y < 0 || y >= WORLD_HEIGHT || !this.isLoaded(x, z)) continue;
      const blockId = this.getBlock(x, y, z);
      const behaviour = getBlockBehavior(blockId);
      if (!behaviour?.neighbourChanged) continue;
      this._callBehaviour(behaviour.neighbourChanged, {
        world: this,
        x,
        y,
        z,
        blockId,
        state: this.getBlockState(x, y, z),
        changedNeighbour: change,
      });
    }
  }

  _callBehaviour(callback, context) {
    try {
      return callback(context);
    } catch (error) {
      console.error('[World] block behaviour failed:', error);
      return undefined;
    }
  }

  /** Pauses chunk streaming. */
  setPaused(paused) {
    this.chunks.setPaused(paused);
  }

  // ---------------------------------------------------------------- persistence

  /**
   * Returns (and creates on demand) the edit map for a chunk.
   * @param {number} chunkX
   * @param {number} chunkZ
   * @param {boolean} create
   * @returns {Map<number, number>|null}
   */
  _editsFor(chunkX, chunkZ, create) {
    const key = chunkKey(chunkX, chunkZ);
    let edits = this._edits.get(key);
    if (!edits && create) {
      edits = new Map();
      this._edits.set(key, edits);
    }
    return edits || null;
  }

  /**
   * Installs edits loaded from a save, before or after chunks exist.
   * @param {Map<string, Uint32Array>} packed Keyed by `"cx,cz"`.
   */
  applyLoadedEdits(packed) {
    for (const [key, data] of packed) {
      const edits = unpackChunkEdits(data);
      if (edits.size === 0) continue;
      this._edits.set(key, edits);

      // If the chunk is already resident, replay immediately and re-mesh.
      const comma = key.indexOf(',');
      const chunkX = Number(key.slice(0, comma));
      const chunkZ = Number(key.slice(comma + 1));
      const chunk = this.chunks.getChunk(chunkX, chunkZ);
      if (chunk) {
        chunk.loadEdits(edits);
        if (chunk.hasData) {
          // The edits can be anywhere in the chunk, including its borders, so
          // the whole 3x3 neighbourhood is re-meshed rather than guessing.
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) this.chunks.markDirty(chunkX + dx, chunkZ + dz);
          }
        }
      }
    }
  }

  /**
   * Collects the edits that changed since the last save.
   *
   * @param {boolean} [everything] Return all edits rather than only the dirty
   *   ones. Used for the first save of a world and for export.
   * @returns {Map<string, Uint32Array>}
   */
  collectEditsForSave(everything = false) {
    const result = new Map();
    const keys = everything ? this._edits.keys() : this._dirtyEditKeys;
    for (const key of keys) {
      const edits = this._edits.get(key);
      if (!edits) continue;
      result.set(key, packChunkEdits(edits));
    }
    return result;
  }

  /** Marks all collected edits as persisted. Call after a successful save. */
  markEditsSaved() {
    this._dirtyEditKeys.clear();
    for (const chunk of this.chunks.chunks.values()) chunk.markEditsSaved();
  }

  /** True when there are unsaved edits. */
  get hasUnsavedChanges() {
    return this._dirtyEditKeys.size > 0;
  }

  /** Number of chunks the player has modified. */
  get editedChunkCount() {
    return this._edits.size;
  }

  // ------------------------------------------------------------------- spawning

  /**
   * Finds a safe spawn position.
   *
   * Prefers the generator's dry-land search, then walks upwards through any
   * blocks that are actually present so a spawn inside a tree or a boulder still
   * puts the player on top of it.
   *
   * @param {number} [preferredX]
   * @param {number} [preferredZ]
   * @returns {THREE.Vector3} Feet position.
   */
  findSpawnPosition(preferredX = 0, preferredZ = 0) {
    const candidate = this.generator.findSpawn(preferredX, preferredZ);
    const blockX = Math.floor(candidate.x);
    const blockZ = Math.floor(candidate.z);

    let y = Math.max(candidate.y, SEA_LEVEL + 1);
    // If the chunk is loaded, trust the real voxels over the height field.
    if (this.isLoaded(blockX, blockZ)) {
      const surface = this.getSurfaceY(blockX, blockZ);
      if (surface >= 0) y = surface + 1;
      // Climb out of anything solid (a tree trunk, a structure).
      let guard = 0;
      while (
        guard++ < WORLD_HEIGHT &&
        y < WORLD_HEIGHT - 3 &&
        (this.isCollidable(blockX, y, blockZ) || this.isCollidable(blockX, y + 1, blockZ))
      ) {
        y++;
      }
    }

    return this._scratchVector.set(candidate.x, Math.min(y, WORLD_HEIGHT - 3), candidate.z).clone();
  }

  /**
   * True when a standing position is free of collisions.
   * @param {number} x
   * @param {number} y Feet height.
   * @param {number} z
   */
  isSpawnClear(x, y, z) {
    const blockX = Math.floor(x);
    const blockZ = Math.floor(z);
    return (
      !this.isCollidable(blockX, Math.floor(y), blockZ) &&
      !this.isCollidable(blockX, Math.floor(y) + 1, blockZ)
    );
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Rebuilds all chunk meshes, for settings that are baked into geometry.
   */
  rebuildAllMeshes() {
    this.chunks.rebuildAllMeshes();
  }

  /** Re-applies shared materials to existing meshes (after a shader rebuild). */
  refreshMaterials() {
    this.chunks.refreshMaterials();
  }

  /** Loading progress of the chunks immediately around the player, 0..1. */
  getLoadProgress() {
    return this.chunks.getLoadProgress();
  }

  /**
   * Moves the whole world to another dimension.
   *
   * Chunk coordinates repeat across dimensions, so nothing keyed by chunk can
   * survive the move: edits are stashed per dimension, and light, block ticks
   * and block entities are rebuilt from the incoming chunks. The alternative --
   * keeping caches and hoping they are overwritten -- leaves Overworld chests
   * and torch light bleeding into the Nether.
   *
   * @param {string} dimensionId One of `Dimension.*`.
   * @returns {boolean} True when the world actually moved.
   */
  switchDimension(dimensionId) {
    if (!isDimension(dimensionId)) return false;
    if (dimensionId === this.dimension.id) return false;

    const previousId = this.dimension.id;

    // Park the current dimension's edits and adopt the destination's.
    this._editsByDimension.set(previousId, this._edits);
    this._edits = this._editsByDimension.get(dimensionId) ?? new Map();
    this._editsByDimension.delete(dimensionId);
    this._dirtyEditKeys.clear();

    this.dimension = getDimension(dimensionId);
    this.maxY = this.dimension.height - 1;
    this.seaLevel = this.dimension.seaLevel;
    this.generator = createGenerator(dimensionId, this.seed);

    // Per-chunk caches. Every resident chunk is about to be discarded.
    this._emissive.clear();
    this._blockTicks.clear();
    this._tickChunkKeys.clear();
    this._sortedTickChunkKeys.length = 0;
    this._tickChunkOrderDirty = true;
    this._cascadeQueue.length = 0;
    this._lightCandidates.length = 0;

    // Chests and furnaces are serialised per chunk by the store itself, so
    // tearing it down and rebuilding is the honest way to leave a dimension.
    this.blockEntities.destroy();
    this.blockEntities = new BlockEntityStore({ world: this });

    this.chunks.switchDimension(dimensionId);

    this._bus.emit(Events.DIMENSION_CHANGED, {
      from: previousId,
      to: dimensionId,
      definition: this.dimension,
    });
    return true;
  }

  /**
   * Tears down portal planes that just lost their frame.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} previous Block that was there before.
   * @param {number} next Block that is there now.
   * @private
   */
  _collapsePortals(x, y, z, previous, next) {
    if (next !== Block.AIR) return;

    // Mining the shimmer itself takes the whole plane with it.
    if (previous === Block.NETHER_PORTAL) {
      extinguishPortal(this, x, y, z);
      return;
    }

    if (previous !== Block.OBSIDIAN) return;

    // The six faces around the broken frame block. Only obsidian removal gets
    // this far, so the cost of the literal is irrelevant.
    const offsets = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];

    for (let i = 0; i < offsets.length; i++) {
      const [dx, dy, dz] = offsets[i];
      if (this.getBlock(x + dx, y + dy, z + dz) === Block.NETHER_PORTAL) {
        extinguishPortal(this, x + dx, y + dy, z + dz);
      }
    }
  }

  /** The dimension the world is currently simulating. */
  get dimensionId() {
    return this.dimension.id;
  }

  /** Tears down the world and every GPU resource it owns. */
  destroy() {
    this._unsubscribeChunkUnloaded?.();
    this._unsubscribeChunkUnloaded = null;
    this.chunks.destroy();
    this._edits.clear();
    this._dirtyEditKeys.clear();
    this._emissive.clear();
    this._blockTicks.clear();
    this._tickChunkKeys.clear();
    this._sortedTickChunkKeys.length = 0;
    this._cascadeQueue.length = 0;
    this._lightCandidates.length = 0;
    this.blockEntities.destroy();
    this.onFallingBlock = null;
    this.onBlockDrop = null;
    this.onItemDrops = null;
    this.onBlockEntityDrops = null;
  }
}

export default World;
