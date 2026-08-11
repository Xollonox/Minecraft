/**
 * Generic free-list object pool.
 *
 * Item entities, particles and temporary vectors are created and destroyed
 * constantly; pooling them keeps the garbage collector out of the frame budget.
 *
 * @template T
 */
export class ObjectPool {
  /**
   * @param {() => T} factory Creates a fresh instance when the pool is empty.
   * @param {(item: T) => void} [reset] Called on release, before the item is
   *   returned to the free list.
   * @param {number} [maxSize] Upper bound on retained instances. Extra
   *   released items are dropped so a burst cannot pin memory forever.
   */
  constructor(factory, reset = null, maxSize = 512) {
    this._factory = factory;
    this._reset = reset;
    this._maxSize = maxSize;
    /** @type {T[]} */
    this._free = [];
    this._created = 0;
    this._live = 0;
  }

  /** Number of instances currently checked out. */
  get liveCount() {
    return this._live;
  }

  /** Number of pooled instances available for reuse. */
  get freeCount() {
    return this._free.length;
  }

  /** Total instances the pool has ever constructed. */
  get createdCount() {
    return this._created;
  }

  /**
   * Takes an instance from the pool, constructing one if necessary.
   * @returns {T}
   */
  acquire() {
    this._live++;
    const pooled = this._free.pop();
    if (pooled !== undefined) return pooled;
    this._created++;
    return this._factory();
  }

  /**
   * Returns an instance to the pool.
   * @param {T} item
   */
  release(item) {
    if (item === null || item === undefined) return;
    this._live = Math.max(0, this._live - 1);
    if (this._reset) this._reset(item);
    if (this._free.length < this._maxSize) this._free.push(item);
  }

  /**
   * Empties the free list, optionally running a disposer on each instance.
   * @param {(item: T) => void} [dispose]
   */
  drain(dispose = null) {
    if (dispose) for (const item of this._free) dispose(item);
    this._free.length = 0;
  }
}

/**
 * A fixed-size ring of preallocated scratch objects.
 *
 * Useful for short-lived temporaries inside a single function where an explicit
 * release call would be noise: `scratch.next()` hands out the objects in
 * rotation. The ring must be large enough that a value is never still in use
 * by the time it comes around again.
 *
 * @template T
 */
export class ScratchRing {
  /**
   * @param {() => T} factory
   * @param {number} [count]
   */
  constructor(factory, count = 8) {
    /** @type {T[]} */
    this._items = Array.from({ length: count }, factory);
    this._cursor = 0;
  }

  /** @returns {T} */
  next() {
    const item = this._items[this._cursor];
    this._cursor = (this._cursor + 1) % this._items.length;
    return item;
  }
}

export default ObjectPool;
