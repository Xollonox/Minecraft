/**
 * A binary min-heap priority queue with optional membership tracking.
 *
 * Chunk streaming pushes and pops thousands of entries per second while the
 * player moves, so the implementation avoids allocations in the hot path: the
 * heap is stored in two parallel arrays (values and priorities) and re-sifted
 * in place.
 *
 * @template T
 */
export class PriorityQueue {
  /**
   * @param {(value: T) => string|number} [keyOf] When provided, the queue
   *   tracks membership so `has()` is O(1) and duplicate pushes can be
   *   collapsed with `pushOrUpdate()`.
   */
  constructor(keyOf = null) {
    /** @type {T[]} */
    this._values = [];
    /** @type {number[]} */
    this._priorities = [];
    this._keyOf = keyOf;
    /** @type {Map<string|number, number>|null} key -> heap index */
    this._indexByKey = keyOf ? new Map() : null;
  }

  /** Number of queued entries. */
  get size() {
    return this._values.length;
  }

  /** True when the queue holds no entries. */
  get isEmpty() {
    return this._values.length === 0;
  }

  /** Removes every entry. */
  clear() {
    this._values.length = 0;
    this._priorities.length = 0;
    if (this._indexByKey) this._indexByKey.clear();
  }

  /**
   * True when an equal value (by key) is already queued.
   * Only available when a `keyOf` function was supplied.
   * @param {T} value
   */
  has(value) {
    if (!this._indexByKey) return false;
    return this._indexByKey.has(this._keyOf(value));
  }

  /** True when the given raw key is queued. */
  hasKey(key) {
    return this._indexByKey ? this._indexByKey.has(key) : false;
  }

  /**
   * Inserts a value with the given priority (lower pops first).
   * @param {T} value
   * @param {number} priority
   */
  push(value, priority) {
    const index = this._values.length;
    this._values.push(value);
    this._priorities.push(priority);
    if (this._indexByKey) this._indexByKey.set(this._keyOf(value), index);
    this._siftUp(index);
  }

  /**
   * Inserts the value, or lowers the priority of the existing equal entry.
   * Requires a `keyOf` function. Returns true when the queue changed.
   * @param {T} value
   * @param {number} priority
   */
  pushOrUpdate(value, priority) {
    if (!this._indexByKey) {
      this.push(value, priority);
      return true;
    }
    const key = this._keyOf(value);
    const existing = this._indexByKey.get(key);
    if (existing === undefined) {
      this.push(value, priority);
      return true;
    }
    if (priority < this._priorities[existing]) {
      this._priorities[existing] = priority;
      this._values[existing] = value;
      this._siftUp(existing);
      return true;
    }
    return false;
  }

  /** Returns the lowest-priority value without removing it, or `undefined`. */
  peek() {
    return this._values.length ? this._values[0] : undefined;
  }

  /** Priority of the head entry, or `Infinity` when empty. */
  peekPriority() {
    return this._priorities.length ? this._priorities[0] : Infinity;
  }

  /**
   * Removes and returns the lowest-priority value.
   * @returns {T|undefined}
   */
  pop() {
    const values = this._values;
    if (values.length === 0) return undefined;
    const priorities = this._priorities;
    const top = values[0];
    if (this._indexByKey) this._indexByKey.delete(this._keyOf(top));

    const lastValue = values.pop();
    const lastPriority = priorities.pop();
    if (values.length > 0) {
      values[0] = lastValue;
      priorities[0] = lastPriority;
      if (this._indexByKey) this._indexByKey.set(this._keyOf(lastValue), 0);
      this._siftDown(0);
    }
    return top;
  }

  /**
   * Drops every entry for which `predicate` returns true.
   * Used to cancel obsolete chunk work in bulk after a long teleport.
   * @param {(value: T, priority: number) => boolean} predicate
   * @returns {number} Number of removed entries.
   */
  prune(predicate) {
    const keptValues = [];
    const keptPriorities = [];
    let removed = 0;
    for (let i = 0; i < this._values.length; i++) {
      if (predicate(this._values[i], this._priorities[i])) {
        removed++;
      } else {
        keptValues.push(this._values[i]);
        keptPriorities.push(this._priorities[i]);
      }
    }
    if (removed === 0) return 0;
    this._values = keptValues;
    this._priorities = keptPriorities;
    if (this._indexByKey) {
      this._indexByKey.clear();
      for (let i = 0; i < this._values.length; i++) {
        this._indexByKey.set(this._keyOf(this._values[i]), i);
      }
    }
    this._heapify();
    return removed;
  }

  /** Iterates queued values without removing them (unordered). */
  forEach(callback) {
    for (let i = 0; i < this._values.length; i++) callback(this._values[i], this._priorities[i]);
  }

  _heapify() {
    for (let i = (this._values.length >> 1) - 1; i >= 0; i--) this._siftDown(i);
  }

  _swap(a, b) {
    const values = this._values;
    const priorities = this._priorities;
    const tmpValue = values[a];
    values[a] = values[b];
    values[b] = tmpValue;
    const tmpPriority = priorities[a];
    priorities[a] = priorities[b];
    priorities[b] = tmpPriority;
    if (this._indexByKey) {
      this._indexByKey.set(this._keyOf(values[a]), a);
      this._indexByKey.set(this._keyOf(values[b]), b);
    }
  }

  _siftUp(start) {
    let index = start;
    const priorities = this._priorities;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (priorities[index] >= priorities[parent]) break;
      this._swap(index, parent);
      index = parent;
    }
  }

  _siftDown(start) {
    let index = start;
    const priorities = this._priorities;
    const length = priorities.length;
    for (;;) {
      const left = index * 2 + 1;
      if (left >= length) break;
      const right = left + 1;
      let smallest = left;
      if (right < length && priorities[right] < priorities[left]) smallest = right;
      if (priorities[index] <= priorities[smallest]) break;
      this._swap(index, smallest);
      index = smallest;
    }
  }
}

export default PriorityQueue;
