/**
 * Abstract input actions and their default physical bindings.
 *
 * Nothing in the engine outside of `core/InputManager.js` is allowed to read a
 * raw `KeyboardEvent.code`, a mouse button number or a gamepad index. Every
 * system asks the input manager about an *action*, which means keyboard, mouse,
 * touch and gamepad all feed one shared logical state and rebinding is a data
 * change rather than a code change.
 */

/** @enum {string} */
export const Action = Object.freeze({
  MOVE_FORWARD: 'MOVE_FORWARD',
  MOVE_BACKWARD: 'MOVE_BACKWARD',
  MOVE_LEFT: 'MOVE_LEFT',
  MOVE_RIGHT: 'MOVE_RIGHT',
  JUMP: 'JUMP',
  SPRINT: 'SPRINT',
  CROUCH: 'CROUCH',
  BREAK_BLOCK: 'BREAK_BLOCK',
  PLACE_BLOCK: 'PLACE_BLOCK',
  PICK_BLOCK: 'PICK_BLOCK',
  /** Throws one of the held item into the world. */
  DROP_ITEM: 'DROP_ITEM',
  /** Throws the whole held stack. */
  DROP_STACK: 'DROP_STACK',
  OPEN_INVENTORY: 'OPEN_INVENTORY',
  PAUSE: 'PAUSE',
  HOTBAR_NEXT: 'HOTBAR_NEXT',
  HOTBAR_PREVIOUS: 'HOTBAR_PREVIOUS',
  HOTBAR_1: 'HOTBAR_1',
  HOTBAR_2: 'HOTBAR_2',
  HOTBAR_3: 'HOTBAR_3',
  HOTBAR_4: 'HOTBAR_4',
  HOTBAR_5: 'HOTBAR_5',
  HOTBAR_6: 'HOTBAR_6',
  HOTBAR_7: 'HOTBAR_7',
  HOTBAR_8: 'HOTBAR_8',
  HOTBAR_9: 'HOTBAR_9',
  FLY_UP: 'FLY_UP',
  FLY_DOWN: 'FLY_DOWN',
  TOGGLE_FLY: 'TOGGLE_FLY',
  TOGGLE_DEBUG: 'TOGGLE_DEBUG',
  TOGGLE_FULLSCREEN: 'TOGGLE_FULLSCREEN',
  TOGGLE_PERSPECTIVE: 'TOGGLE_PERSPECTIVE',
  SAVE_NOW: 'SAVE_NOW',
});

/**
 * Actions driven by the mouse wheel rather than by a button.
 *
 * Declared as a table for the same reason the key and button bindings are: so the
 * controls reference and the "is every action reachable?" check can see the whole
 * picture. The wheel is a third input channel, and leaving it undocumented meant
 * hotbar scrolling was missing from the controls list and looked unbound.
 */
export const WHEEL_BINDINGS = Object.freeze({
  down: 'HOTBAR_NEXT',
  up: 'HOTBAR_PREVIOUS',
});

/** Actions whose slot index is derived from their name, for quick lookup. */
export const HOTBAR_ACTIONS = Object.freeze([
  Action.HOTBAR_1,
  Action.HOTBAR_2,
  Action.HOTBAR_3,
  Action.HOTBAR_4,
  Action.HOTBAR_5,
  Action.HOTBAR_6,
  Action.HOTBAR_7,
  Action.HOTBAR_8,
  Action.HOTBAR_9,
]);

/**
 * Input contexts. Only one is active at a time and each declares which actions
 * it forwards, which is how opening the inventory reliably stops movement
 * without every subsystem having to check a pile of booleans.
 *
 * @enum {string}
 */
export const InputContext = Object.freeze({
  LOADING: 'LOADING',
  MENU: 'MENU',
  GAMEPLAY: 'GAMEPLAY',
  INVENTORY: 'INVENTORY',
  PAUSED: 'PAUSED',
  SETTINGS: 'SETTINGS',
  CONSOLE: 'CONSOLE',
});

/**
 * Actions that remain live in each context. Anything not listed reads as
 * released, and switching context clears held state for the removed actions.
 */
export const CONTEXT_ACTIONS = Object.freeze({
  [InputContext.LOADING]: Object.freeze([Action.TOGGLE_DEBUG]),
  [InputContext.MENU]: Object.freeze([Action.TOGGLE_FULLSCREEN, Action.TOGGLE_DEBUG]),
  [InputContext.GAMEPLAY]: Object.freeze(Object.values(Action)),
  [InputContext.INVENTORY]: Object.freeze([
    Action.OPEN_INVENTORY,
    Action.PAUSE,
    Action.TOGGLE_DEBUG,
    Action.TOGGLE_FULLSCREEN,
    ...HOTBAR_ACTIONS,
  ]),
  [InputContext.PAUSED]: Object.freeze([
    Action.PAUSE,
    Action.TOGGLE_DEBUG,
    Action.TOGGLE_FULLSCREEN,
  ]),
  [InputContext.SETTINGS]: Object.freeze([Action.TOGGLE_FULLSCREEN]),
  [InputContext.CONSOLE]: Object.freeze([]),
});

/**
 * Default keyboard bindings, keyed by `KeyboardEvent.code` so the layout works
 * on AZERTY/QWERTZ keyboards without remapping.
 * @type {Readonly<Record<string, string>>}
 */
export const DEFAULT_KEY_BINDINGS = Object.freeze({
  KeyW: Action.MOVE_FORWARD,
  ArrowUp: Action.MOVE_FORWARD,
  KeyS: Action.MOVE_BACKWARD,
  ArrowDown: Action.MOVE_BACKWARD,
  KeyA: Action.MOVE_LEFT,
  ArrowLeft: Action.MOVE_LEFT,
  KeyD: Action.MOVE_RIGHT,
  ArrowRight: Action.MOVE_RIGHT,
  Space: Action.JUMP,
  ShiftLeft: Action.SPRINT,
  ShiftRight: Action.SPRINT,
  ControlLeft: Action.CROUCH,
  ControlRight: Action.CROUCH,
  KeyC: Action.CROUCH,
  KeyE: Action.OPEN_INVENTORY,
  // Q drops, which is what players reach for. Pick-block keeps the middle mouse
  // button and the gamepad binding it already had, so nothing is lost by moving
  // it off the keyboard.
  KeyQ: Action.DROP_ITEM,
  KeyG: Action.DROP_STACK,
  KeyX: Action.PICK_BLOCK,
  KeyF: Action.TOGGLE_FLY,
  KeyR: Action.FLY_UP,
  // Fly down had no keyboard binding at all, so a keyboard player could ascend
  // but never descend — only a gamepad or the touch buttons could. Found by the
  // generated controls reference, which lists an action only when something is
  // actually bound to it.
  KeyZ: Action.FLY_DOWN,
  // `SAVE_NOW` existed as an action, a label and an edge-triggered entry but was
  // bound to nothing and consumed by nobody — entirely dead. It now has a key and
  // a handler, because a manual save shortcut is worth having and the pause menu
  // already had the button it needed.
  F2: Action.SAVE_NOW,
  KeyV: Action.TOGGLE_PERSPECTIVE,
  Escape: Action.PAUSE,
  F3: Action.TOGGLE_DEBUG,
  F11: Action.TOGGLE_FULLSCREEN,
  Digit1: Action.HOTBAR_1,
  Digit2: Action.HOTBAR_2,
  Digit3: Action.HOTBAR_3,
  Digit4: Action.HOTBAR_4,
  Digit5: Action.HOTBAR_5,
  Digit6: Action.HOTBAR_6,
  Digit7: Action.HOTBAR_7,
  Digit8: Action.HOTBAR_8,
  Digit9: Action.HOTBAR_9,
});

/**
 * Mouse button bindings keyed by `PointerEvent.button`.
 * @type {Readonly<Record<number, string>>}
 */
export const DEFAULT_MOUSE_BINDINGS = Object.freeze({
  0: Action.BREAK_BLOCK,
  1: Action.PICK_BLOCK,
  2: Action.PLACE_BLOCK,
});

/**
 * Standard-layout gamepad button bindings.
 * Indices follow the W3C "standard" gamepad mapping.
 * @type {Readonly<Record<number, string>>}
 */
export const DEFAULT_GAMEPAD_BUTTONS = Object.freeze({
  0: Action.JUMP, // A / Cross
  1: Action.CROUCH, // B / Circle
  2: Action.BREAK_BLOCK, // X / Square
  3: Action.PLACE_BLOCK, // Y / Triangle
  4: Action.HOTBAR_PREVIOUS, // LB
  5: Action.HOTBAR_NEXT, // RB
  6: Action.BREAK_BLOCK, // LT
  7: Action.PLACE_BLOCK, // RT
  8: Action.OPEN_INVENTORY, // Back / Select
  9: Action.PAUSE, // Start
  10: Action.SPRINT, // Left stick click
  11: Action.PICK_BLOCK, // Right stick click
  12: Action.FLY_UP, // D-pad up
  13: Action.FLY_DOWN, // D-pad down
  14: Action.HOTBAR_PREVIOUS, // D-pad left
  15: Action.HOTBAR_NEXT, // D-pad right
});

/** Gamepad axis indices for the standard mapping. */
export const GAMEPAD_AXES = Object.freeze({
  moveX: 0,
  moveY: 1,
  lookX: 2,
  lookY: 3,
});

/** Analog thresholds. */
export const GAMEPAD_TUNING = Object.freeze({
  buttonThreshold: 0.55,
  defaultStickDeadZone: 0.18,
  /** Look sensitivity in radians per second at full stick deflection. */
  lookRadiansPerSecond: 2.9,
});

/** Actions that fire once per press rather than being held. */
export const EDGE_TRIGGERED_ACTIONS = Object.freeze(
  new Set([
    Action.PICK_BLOCK,
    // Both drops are one-shot: holding the key must not empty the inventory.
    Action.DROP_ITEM,
    Action.DROP_STACK,
    Action.OPEN_INVENTORY,
    Action.PAUSE,
    Action.HOTBAR_NEXT,
    Action.HOTBAR_PREVIOUS,
    ...HOTBAR_ACTIONS,
    Action.TOGGLE_FLY,
    Action.TOGGLE_DEBUG,
    Action.TOGGLE_FULLSCREEN,
    Action.TOGGLE_PERSPECTIVE,
    Action.SAVE_NOW,
  ])
);

/**
 * Human-readable action names for the controls list in the settings menu.
 * @type {Readonly<Record<string,string>>}
 */
export const ACTION_LABELS = Object.freeze({
  [Action.MOVE_FORWARD]: 'Move forward',
  [Action.MOVE_BACKWARD]: 'Move backward',
  [Action.MOVE_LEFT]: 'Strafe left',
  [Action.MOVE_RIGHT]: 'Strafe right',
  [Action.JUMP]: 'Jump / swim up',
  [Action.SPRINT]: 'Sprint',
  [Action.CROUCH]: 'Crouch',
  [Action.BREAK_BLOCK]: 'Break block',
  [Action.PLACE_BLOCK]: 'Place block',
  [Action.PICK_BLOCK]: 'Pick block',
  [Action.DROP_ITEM]: 'Drop one item',
  [Action.DROP_STACK]: 'Drop whole stack',
  // Listed individually rather than as one "slots 1-9" row so the controls
  // reference can be generated straight from `Action` with no special cases, and
  // so every action is guaranteed to have a label.
  [Action.HOTBAR_1]: 'Hotbar slot 1',
  [Action.HOTBAR_2]: 'Hotbar slot 2',
  [Action.HOTBAR_3]: 'Hotbar slot 3',
  [Action.HOTBAR_4]: 'Hotbar slot 4',
  [Action.HOTBAR_5]: 'Hotbar slot 5',
  [Action.HOTBAR_6]: 'Hotbar slot 6',
  [Action.HOTBAR_7]: 'Hotbar slot 7',
  [Action.HOTBAR_8]: 'Hotbar slot 8',
  [Action.HOTBAR_9]: 'Hotbar slot 9',
  [Action.OPEN_INVENTORY]: 'Inventory',
  [Action.PAUSE]: 'Pause',
  [Action.HOTBAR_NEXT]: 'Next hotbar slot',
  [Action.HOTBAR_PREVIOUS]: 'Previous hotbar slot',
  [Action.FLY_UP]: 'Fly up',
  [Action.FLY_DOWN]: 'Fly down',
  [Action.TOGGLE_FLY]: 'Toggle fly',
  [Action.TOGGLE_DEBUG]: 'Debug overlay',
  [Action.TOGGLE_FULLSCREEN]: 'Fullscreen',
  [Action.TOGGLE_PERSPECTIVE]: 'Toggle perspective',
  [Action.SAVE_NOW]: 'Save now',
});

/** Returns the hotbar slot index (0-based) for a hotbar action, or -1. */
export function hotbarSlotForAction(action) {
  const index = HOTBAR_ACTIONS.indexOf(action);
  return index;
}
