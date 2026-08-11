/**
 * A tiny synchronous publish/subscribe bus.
 *
 * Systems talk to each other through named events instead of holding direct
 * references, which keeps the module graph acyclic: the world does not need to
 * know that a HUD exists in order to report that a chunk finished loading.
 *
 * Listener lists are copied before dispatch so a handler may safely subscribe
 * or unsubscribe during its own event.
 */

/**
 * Canonical event names. Using constants rather than bare strings means a typo
 * is a `undefined` import error instead of a silently dead listener.
 */
export const Events = Object.freeze({
  // Engine lifecycle
  GAME_READY: 'game:ready',
  GAME_PAUSED: 'game:paused',
  GAME_RESUMED: 'game:resumed',
  GAME_DESTROYED: 'game:destroyed',
  CONTEXT_LOST: 'game:contextLost',
  CONTEXT_RESTORED: 'game:contextRestored',
  /** A GPU shader program failed to compile. `({program, details, message})` */
  SHADER_ERROR: 'game:shaderError',

  // Settings
  SETTINGS_CHANGED: 'settings:changed',
  SETTINGS_RESET: 'settings:reset',

  // Input
  INPUT_CONTEXT_CHANGED: 'input:contextChanged',
  GAMEPAD_CONNECTED: 'input:gamepadConnected',
  GAMEPAD_DISCONNECTED: 'input:gamepadDisconnected',
  POINTER_LOCK_CHANGED: 'input:pointerLockChanged',

  // World
  WORLD_LOAD_PROGRESS: 'world:loadProgress',
  WORLD_READY: 'world:ready',
  CHUNK_READY: 'world:chunkReady',
  CHUNK_UNLOADED: 'world:chunkUnloaded',
  /** Phase 4: fired after the world finishes moving to another dimension. */
  DIMENSION_CHANGED: 'world:dimensionChanged',
  BLOCK_CHANGED: 'world:blockChanged',

  // Player
  PLAYER_SPAWNED: 'player:spawned',
  PLAYER_MOVED_CHUNK: 'player:movedChunk',
  PLAYER_WATER_STATE: 'player:waterState',
  PLAYER_LANDED: 'player:landed',
  PLAYER_STEP: 'player:step',
  PLAYER_MODE_CHANGED: 'player:modeChanged',
  /** Health changed. `({health, maxHealth, previous, cause})` */
  PLAYER_HEALTH_CHANGED: 'player:healthChanged',
  /** Damage was applied. `({amount, cause, health, fatal})` */
  PLAYER_DAMAGED: 'player:damaged',
  /** Hunger, saturation or air changed. `({hunger, saturation, air})` */
  PLAYER_STATS_CHANGED: 'player:statsChanged',
  /** The player died. `({cause, message, position})` */
  PLAYER_DIED: 'player:died',
  /** The player respawned. `({position})` */
  PLAYER_RESPAWNED: 'player:respawned',
  /** XP changed. `({level, xp, xpToNext, fraction})` */
  PLAYER_XP_CHANGED: 'player:xpChanged',

  // Interaction
  BLOCK_BROKEN: 'interaction:blockBroken',
  BLOCK_PLACED: 'interaction:blockPlaced',
  BREAK_PROGRESS: 'interaction:breakProgress',
  TARGET_CHANGED: 'interaction:targetChanged',

  // Inventory
  /** An item entered the inventory. `({itemId, count, displayName})` */
  ITEM_PICKED_UP: 'inventory:itemPickedUp',
  /** A tool reached zero durability and was removed. `({itemId, slot})` */
  TOOL_BROKE: 'inventory:toolBroke',
  /** An equipped armour piece reached zero durability. `({itemId, slot, armourSlot})` */
  ARMOUR_BROKE: 'inventory:armourBroke',
  /** A raised shield stopped a hit. `({cause,amount,source,broken})` */
  SHIELD_BLOCKED: 'combat:shieldBlocked',
  /** A shield reached zero durability. `({itemId,slot})` */
  SHIELD_BROKE: 'inventory:shieldBroke',
  /** A melee attack landed. `({entity, damage, itemId, distance})` */
  ENTITY_ATTACKED: 'combat:entityAttacked',
  /** A living creature entered the world. `({mob,mobId,x,y,z})` */
  MOB_SPAWNED: 'mob:spawned',
  /** An arrow struck a block or entity. `({projectile,hit})` */
  PROJECTILE_HIT: 'combat:projectileHit',
  /** Two passive creatures produced a baby. `({parents,baby,mobId})` */
  MOB_BRED: 'mob:bred',
  /** A living creature took damage. `({mob,mobId,health,maxHealth})` */
  MOB_HURT: 'mob:hurt',
  /** A living creature died. `({mob,mobId,drops,killedByPlayer})` */
  MOB_DIED: 'mob:died',
  /** Soil was tilled into farmland. `({x, y, z})` */
  BLOCK_TILLED: 'interaction:blockTilled',
  HOTBAR_CHANGED: 'inventory:hotbarChanged',
  SLOT_SELECTED: 'inventory:slotSelected',
  INVENTORY_CHANGED: 'inventory:changed',

  // Saves
  SAVE_STARTED: 'save:started',
  SAVE_COMPLETED: 'save:completed',
  SAVE_FAILED: 'save:failed',

  // UI
  UI_SCREEN_CHANGED: 'ui:screenChanged',
  NOTIFY: 'ui:notify',

  // Audio
  PLAY_SOUND: 'audio:play',
});

export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
    this._destroyed = false;
  }

  /**
   * Subscribes to an event.
   * @param {string} event
   * @param {Function} handler
   * @returns {() => void} Unsubscribe function.
   */
  on(event, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError(`EventBus.on("${event}") requires a function handler`);
    }
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(handler);
    return () => this.off(event, handler);
  }

  /**
   * Subscribes for exactly one dispatch.
   * @param {string} event
   * @param {Function} handler
   * @returns {() => void} Unsubscribe function.
   */
  once(event, handler) {
    const wrapped = (...args) => {
      this.off(event, wrapped);
      handler(...args);
    };
    return this.on(event, wrapped);
  }

  /**
   * Removes a subscription.
   * @param {string} event
   * @param {Function} handler
   */
  off(event, handler) {
    const set = this._listeners.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this._listeners.delete(event);
  }

  /**
   * Dispatches an event synchronously.
   *
   * A throwing listener is reported but does not prevent the remaining
   * listeners from running: one broken HUD widget must not stop the world from
   * streaming chunks.
   *
   * @param {string} event
   * @param {...any} args
   */
  emit(event, ...args) {
    if (this._destroyed) return;
    const set = this._listeners.get(event);
    if (!set || set.size === 0) return;
    // Copy so handlers may mutate the listener set during dispatch.
    const handlers = set.size === 1 ? [set.values().next().value] : Array.from(set);
    for (let i = 0; i < handlers.length; i++) {
      try {
        handlers[i](...args);
      } catch (error) {
        console.error(`[EventBus] listener for "${event}" threw:`, error);
      }
    }
  }

  /** Number of listeners for an event (or for everything when omitted). */
  listenerCount(event) {
    if (event === undefined) {
      let total = 0;
      for (const set of this._listeners.values()) total += set.size;
      return total;
    }
    return this._listeners.get(event)?.size ?? 0;
  }

  /** Removes every listener for one event, or all events when omitted. */
  removeAll(event) {
    if (event === undefined) this._listeners.clear();
    else this._listeners.delete(event);
  }

  /** Permanently disables the bus and drops all listeners. */
  destroy() {
    this._destroyed = true;
    this._listeners.clear();
  }
}

/**
 * Collects unsubscribe functions so a system can detach everything it
 * registered in one call. Every long-lived object in the engine owns one of
 * these; forgetting to unsubscribe is the classic voxel-engine memory leak.
 */
export class SubscriptionGroup {
  constructor() {
    /** @type {Array<() => void>} */
    this._disposers = [];
  }

  /**
   * Registers an event listener and remembers how to remove it.
   * @param {EventBus} bus
   * @param {string} event
   * @param {Function} handler
   */
  on(bus, event, handler) {
    this._disposers.push(bus.on(event, handler));
    return this;
  }

  /**
   * Adds a DOM listener with the same bookkeeping.
   * @param {EventTarget} target
   * @param {string} type
   * @param {EventListenerOrEventListenerObject} handler
   * @param {boolean|AddEventListenerOptions} [options]
   */
  dom(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this._disposers.push(() => target.removeEventListener(type, handler, options));
    return this;
  }

  /** Registers an arbitrary teardown callback. */
  add(disposer) {
    if (typeof disposer === 'function') this._disposers.push(disposer);
    return this;
  }

  /** Runs and clears every registered teardown callback. */
  dispose() {
    for (let i = this._disposers.length - 1; i >= 0; i--) {
      try {
        this._disposers[i]();
      } catch (error) {
        console.error('[SubscriptionGroup] disposer threw:', error);
      }
    }
    this._disposers.length = 0;
  }
}

export default EventBus;
