/**
 * Per-block state that does not fit in a voxel.
 *
 * ## Why block entities exist
 *
 * A voxel is one byte: a block id and nothing else. That is deliberate — 32768
 * voxels per chunk in a `Uint16Array` is what makes streaming and meshing fast,
 * and the save format stores sparse edit pairs independently of the runtime id width.
 *
 * A chest holding 27 stacks cannot live in a byte. Neither can a furnace's burn
 * timer. So blocks that need real state get a *sparse companion record*, keyed by
 * chunk and voxel index, stored outside the voxel array.
 *
 * This mirrors `World._emissive`, which already keeps
 * `Map<chunkKey, Map<voxelIndex, record>>` for light sources and invalidates on
 * chunk unload. Following that shape means the lifecycle is already understood.
 *
 * ## Which blocks get one
 *
 * Only blocks registered in `BLOCK_ENTITY_TYPES`. Everything else has no record
 * at all, so the memory cost is proportional to the number of chests and furnaces
 * in the world rather than to its volume.
 *
 * ## Ticking
 *
 * A block entity opts into ticking with `needsTick`. The store keeps a separate
 * list of those, so the furnace tick iterates a handful of furnaces rather than
 * every container in the world. Loaded-chunk-only: an unloaded furnace does not
 * burn, which is why `FurnaceBlockEntity` reconciles elapsed time on load rather
 * than assuming it ticked continuously.
 *
 * Worker-safe: no DOM, no Three.js.
 */

/**
 * Base class. Subclasses add their own state and override the hooks.
 */
export class BlockEntity {
  /**
   * @param {Object} options
   * @param {number} options.x World coordinates of the block.
   * @param {number} options.y
   * @param {number} options.z
   * @param {number} options.blockId The block this entity belongs to.
   */
  constructor({ x, y, z, blockId }) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.blockId = blockId;

    /** Set by the store when the entity is discarded, so stale references stop. */
    this.removed = false;
  }

  /** Type key, matching the `BLOCK_ENTITY_TYPES` registration. */
  static get type() {
    return 'base';
  }

  get type() {
    return /** @type {typeof BlockEntity} */ (this.constructor).type;
  }

  /**
   * Whether this entity wants `tick` called.
   * Overridden to `true` by anything with a timer.
   */
  get needsTick() {
    return false;
  }

  /**
   * Whether the entity should be persisted.
   *
   * An empty chest still needs saving — it is a placed chest — but this hook lets
   * a future entity with purely derived state opt out.
   */
  get needsSave() {
    return true;
  }

  /**
   * Advances any timers.
   * @param {number} _step Seconds.
   * @param {import('../World.js').World} _world
   */
  tick(_step, _world) {}

  /**
   * Items to scatter when the block is broken.
   * @returns {import('../../items/ItemStack.js').ItemStack[]}
   */
  collectDrops() {
    return [];
  }

  /**
   * Saved state, excluding position and type which the store supplies.
   * @returns {Object}
   */
  toJSON() {
    return {};
  }

  /**
   * Restores saved state.
   * @param {Object} _data
   */
  fromJSON(_data) {}
}

/**
 * @type {Map<number, typeof BlockEntity>} Block id -> constructor.
 */
const BY_BLOCK = new Map();

/**
 * @type {Map<string, typeof BlockEntity>} Type key -> constructor.
 */
const BY_TYPE = new Map();

/**
 * Registers a block entity for one or more block ids.
 *
 * Several block ids can share one entity type: a lit and an unlit furnace are two
 * ids but one machine, and the entity must survive the block swapping between
 * them.
 *
 * @param {typeof BlockEntity} constructor
 * @param {number[]} blockIds
 */
export function registerBlockEntity(constructor, blockIds) {
  const type = constructor.type;
  if (!type || type === 'base') {
    throw new Error('A block entity must declare a static type');
  }
  const existing = BY_TYPE.get(type);
  if (existing && existing !== constructor) {
    throw new Error(`Duplicate block entity type "${type}"`);
  }
  BY_TYPE.set(type, constructor);

  for (const blockId of blockIds) {
    const clash = BY_BLOCK.get(blockId);
    if (clash && clash !== constructor) {
      throw new Error(
        `Block ${blockId} is already handled by block entity "${clash.type}"; ` +
          `"${type}" cannot also claim it`
      );
    }
    BY_BLOCK.set(blockId, constructor);
  }
}

/**
 * The entity constructor for a block id, or null when it needs none.
 * @param {number} blockId
 * @returns {typeof BlockEntity|null}
 */
export function blockEntityClassFor(blockId) {
  return BY_BLOCK.get(blockId) ?? null;
}

/**
 * The entity constructor for a saved type key.
 * @param {string} type
 * @returns {typeof BlockEntity|null}
 */
export function blockEntityClassForType(type) {
  return BY_TYPE.get(type) ?? null;
}

/**
 * Whether a block carries a block entity.
 * @param {number} blockId
 */
export function hasBlockEntity(blockId) {
  return BY_BLOCK.has(blockId);
}

/** Every block id that carries an entity, for tests and the audit. */
export function blockEntityBlockIds() {
  return [...BY_BLOCK.keys()];
}

export default BlockEntity;
