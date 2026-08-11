/**
 * Deterministic scheduled block ticks.
 *
 * Fluids, redstone and delayed block reactions must run on game ticks rather
 * than render frames. This min-heap stores absolute due ticks, deduplicates by
 * position/channel and uses a monotonic sequence as a stable tie-breaker.
 *
 * Worker-safe and independent of the world implementation.
 */

function keyFor(x, y, z, channel) {
  return `${x},${y},${z}:${channel}`;
}

export class BlockTickScheduler {
  constructor() {
    /** @type {Array<Object>} */
    this._heap = [];
    /** @type {Map<string, Object>} */
    this._byKey = new Map();
    this._sequence = 0;
  }

  get size() {
    return this._byKey.size;
  }

  /**
   * Schedules or brings forward one tick.
   *
   * Later duplicate requests are ignored; an earlier request replaces the old
   * heap node lazily. Stale nodes are discarded when popped, which avoids an
   * O(n) heap search on every neighbour update.
   */
  schedule(currentTick, x, y, z, delayTicks = 1, channel = 'block', data = null) {
    const dueTick = Math.max(currentTick + 1, currentTick + Math.trunc(delayTicks || 1));
    const key = keyFor(x, y, z, channel);
    const existing = this._byKey.get(key);
    if (existing && existing.dueTick <= dueTick) return existing;

    const entry = {
      key,
      x: Math.trunc(x),
      y: Math.trunc(y),
      z: Math.trunc(z),
      channel,
      data,
      dueTick,
      sequence: this._sequence++,
    };
    this._byKey.set(key, entry);
    this._push(entry);
    return entry;
  }

  /** Cancels one position/channel. */
  cancel(x, y, z, channel = 'block') {
    return this._byKey.delete(keyFor(x, y, z, channel));
  }

  /** Cancels every channel at a position. */
  cancelPosition(x, y, z) {
    const prefix = `${x},${y},${z}:`;
    let removed = 0;
    for (const key of this._byKey.keys()) {
      if (!key.startsWith(prefix)) continue;
      this._byKey.delete(key);
      removed++;
    }
    return removed;
  }

  /**
   * Runs due ticks up to `budget` and returns the number delivered.
   * @param {number} currentTick
   * @param {(entry:Object) => void} callback
   * @param {number} budget
   */
  runDue(currentTick, callback, budget = 256) {
    let delivered = 0;
    while (this._heap.length > 0 && delivered < budget) {
      const entry = this._heap[0];
      if (entry.dueTick > currentTick) break;
      this._pop();
      // A newer entry with the same key superseded this lazy heap node.
      if (this._byKey.get(entry.key) !== entry) continue;
      this._byKey.delete(entry.key);
      delivered++;
      callback(entry);
    }
    return delivered;
  }

  clear() {
    this._heap.length = 0;
    this._byKey.clear();
  }

  _less(a, b) {
    return a.dueTick < b.dueTick || (a.dueTick === b.dueTick && a.sequence < b.sequence);
  }

  _push(entry) {
    const heap = this._heap;
    let index = heap.length;
    heap.push(entry);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this._less(heap[index], heap[parent])) break;
      [heap[index], heap[parent]] = [heap[parent], heap[index]];
      index = parent;
    }
  }

  _pop() {
    const heap = this._heap;
    const root = heap[0];
    const tail = heap.pop();
    if (heap.length === 0) return root;
    heap[0] = tail;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < heap.length && this._less(heap[left], heap[smallest])) smallest = left;
      if (right < heap.length && this._less(heap[right], heap[smallest])) smallest = right;
      if (smallest === index) break;
      [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
      index = smallest;
    }
    return root;
  }
}

export default BlockTickScheduler;
