/**
 * Deterministic redstone-style power propagation.
 *
 * This is the foundation shared by switches, wire, torches, lamps and repeaters:
 * every reaction is queued on the world's canonical 20 Hz game clock, wire
 * attenuates from 15 to 0, repeaters isolate direction and delay, and torch/lamp
 * state changes are persisted as ordinary voxel edits.
 *
 * The public helpers are deliberately worker/DOM free so the signal rules can be
 * regression-tested without starting Three.js or a browser.
 */

import { ItemStack } from '../../items/ItemStack.js';
import { randomFromCoords3 } from '../../utils/MathUtils.js';
import { registerBlockBehavior } from '../BlockBehaviorRegistry.js';
import {
  buttonFacing,
  buttonPowered,
  horizontalFacingVector,
  powerLevel,
  powerState,
  pressurePlatePowered,
  repeaterDelay,
  repeaterFacing,
  repeaterPowered,
  repeaterState,
  setButtonPowered,
  setPressurePlatePowered,
  setRepeaterPowered,
  switchActive,
  switchState,
} from '../BlockState.js';
import { Block } from '../BlockTypes.js';

const NEIGHBOURS = Object.freeze([
  Object.freeze([1, 0, 0]),
  Object.freeze([-1, 0, 0]),
  Object.freeze([0, 1, 0]),
  Object.freeze([0, -1, 0]),
  Object.freeze([0, 0, 1]),
  Object.freeze([0, 0, -1]),
]);

/** True for blocks whose state participates in the signal network. */
export function isRedstoneComponent(blockId) {
  return (
    blockId === Block.REDSTONE_WIRE ||
    blockId === Block.LEVER ||
    blockId === Block.REDSTONE_TORCH ||
    blockId === Block.REDSTONE_TORCH_OFF ||
    blockId === Block.REDSTONE_LAMP ||
    blockId === Block.REDSTONE_LAMP_LIT ||
    blockId === Block.REPEATER ||
    blockId === Block.STONE_BUTTON ||
    blockId === Block.OAK_PRESSURE_PLATE ||
    blockId === Block.STONE_PRESSURE_PLATE
  );
}

/**
 * Signal emitted by one source toward one adjacent target.
 *
 * A repeater only powers its front. A redstone torch powers every side except
 * the supporting block below it, which prevents the torch from directly
 * powering the input it is inverting.
 */
export function powerOutputToward(world, x, y, z, targetX, targetY, targetZ) {
  const blockId = world.getBlock(x, y, z);
  const state = world.getBlockState(x, y, z);

  if (blockId === Block.REDSTONE_WIRE) return powerLevel(state);
  if (blockId === Block.LEVER) return switchActive(state) ? 15 : 0;
  if (blockId === Block.STONE_BUTTON) return buttonPowered(state) ? 15 : 0;
  if (blockId === Block.OAK_PRESSURE_PLATE || blockId === Block.STONE_PRESSURE_PLATE) {
    return pressurePlatePowered(state) ? 15 : 0;
  }
  if (blockId === Block.REDSTONE_TORCH) {
    return targetX === x && targetY === y - 1 && targetZ === z ? 0 : 15;
  }
  if (blockId === Block.REPEATER && repeaterPowered(state)) {
    const direction = horizontalFacingVector(repeaterFacing(state));
    return targetX === x + direction.x && targetY === y && targetZ === z + direction.z
      ? 15
      : 0;
  }
  return 0;
}

/** Strongest signal arriving at a position from its six face neighbours. */
export function receivedPower(world, x, y, z, options = {}) {
  const exclude = options.exclude ?? null;
  let strongest = 0;
  for (const [dx, dy, dz] of NEIGHBOURS) {
    const sourceX = x + dx;
    const sourceY = y + dy;
    const sourceZ = z + dz;
    if (
      exclude &&
      sourceX === exclude.x &&
      sourceY === exclude.y &&
      sourceZ === exclude.z
    ) {
      continue;
    }
    strongest = Math.max(
      strongest,
      powerOutputToward(world, sourceX, sourceY, sourceZ, x, y, z)
    );
    if (strongest === 15) break;
  }
  return strongest;
}

/**
 * Desired wire strength. Direct components inject their full output; wire-to-
 * wire transmission loses one level per voxel.
 */
export function desiredWirePower(world, x, y, z) {
  let strongest = 0;
  for (const [dx, dy, dz] of NEIGHBOURS) {
    const sourceX = x + dx;
    const sourceY = y + dy;
    const sourceZ = z + dz;
    const sourceId = world.getBlock(sourceX, sourceY, sourceZ);
    if (sourceId === Block.REDSTONE_WIRE) {
      strongest = Math.max(strongest, Math.max(0, powerLevel(world.getBlockState(sourceX, sourceY, sourceZ)) - 1));
    } else {
      strongest = Math.max(
        strongest,
        powerOutputToward(world, sourceX, sourceY, sourceZ, x, y, z)
      );
    }
    if (strongest === 15) break;
  }
  return strongest;
}

/** Toggles a lever and returns its new active state. */
export function toggleLever(world, x, y, z) {
  if (world.getBlock(x, y, z) !== Block.LEVER) return null;
  const active = !switchActive(world.getBlockState(x, y, z));
  if (!world.setBlockState(x, y, z, switchState(active), {
    cause: 'lever-toggle',
    cascade: false,
  })) {
    return null;
  }
  return active;
}

/** Cycles a repeater through its one-to-four click delay settings. */
export function rotateRepeaterDelay(world, x, y, z) {
  if (world.getBlock(x, y, z) !== Block.REPEATER) return null;
  const state = world.getBlockState(x, y, z);
  const nextDelay = (repeaterDelay(state) % 4) + 1;
  const next = repeaterState(repeaterFacing(state), nextDelay, repeaterPowered(state));
  if (!world.setBlockState(x, y, z, next, {
    cause: 'repeater-delay',
    cascade: false,
  })) {
    return null;
  }
  return nextDelay;
}

/** Signal entering the back of a repeater. */
export function repeaterInputPower(world, x, y, z, state = world.getBlockState(x, y, z)) {
  const direction = horizontalFacingVector(repeaterFacing(state));
  const sourceX = x - direction.x;
  const sourceZ = z - direction.z;
  return powerOutputToward(world, sourceX, y, sourceZ, x, y, z);
}

function scheduleWire(world, x, y, z, delay = 1) {
  world.scheduleBlockTick(x, y, z, delay, 'redstone-wire');
}

function scheduleTorch(world, x, y, z, delay = 2) {
  world.scheduleBlockTick(x, y, z, delay, 'redstone-torch');
}

function scheduleLamp(world, x, y, z, delay = 1) {
  world.scheduleBlockTick(x, y, z, delay, 'redstone-lamp');
}

function scheduleRepeater(world, x, y, z, state = world.getBlockState(x, y, z)) {
  // One delay click equals two game ticks, matching the classic 0.1 s step.
  world.scheduleBlockTick(x, y, z, repeaterDelay(state) * 2, 'redstone-repeater');
}

function wireTick({ world, x, y, z }) {
  if (world.getBlock(x, y, z) !== Block.REDSTONE_WIRE) return;
  const desired = desiredWirePower(world, x, y, z);
  if (powerLevel(world.getBlockState(x, y, z)) === desired) return;
  world.setBlockState(x, y, z, powerState(desired), {
    cause: 'redstone-propagate',
    cascade: false,
  });
}

function torchTick({ world, x, y, z }) {
  const current = world.getBlock(x, y, z);
  if (current !== Block.REDSTONE_TORCH && current !== Block.REDSTONE_TORCH_OFF) return;
  const supportPowered = receivedPower(world, x, y - 1, z, {
    exclude: { x, y, z },
  }) > 0;
  const desired = supportPowered ? Block.REDSTONE_TORCH_OFF : Block.REDSTONE_TORCH;
  if (current !== desired) {
    world.setBlock(x, y, z, desired, {
      cause: 'redstone-torch',
      cascade: false,
    });
  }
}

function lampTick({ world, x, y, z }) {
  const current = world.getBlock(x, y, z);
  if (current !== Block.REDSTONE_LAMP && current !== Block.REDSTONE_LAMP_LIT) return;
  const powered = receivedPower(world, x, y, z) > 0;
  if (powered && current === Block.REDSTONE_LAMP) {
    world.setBlock(x, y, z, Block.REDSTONE_LAMP_LIT, {
      cause: 'redstone-lamp-on',
      cascade: false,
    });
  } else if (!powered && current === Block.REDSTONE_LAMP_LIT) {
    world.setBlock(x, y, z, Block.REDSTONE_LAMP, {
      cause: 'redstone-lamp-off',
      cascade: false,
    });
  }
}

function repeaterTick({ world, x, y, z }) {
  if (world.getBlock(x, y, z) !== Block.REPEATER) return;
  const state = world.getBlockState(x, y, z);
  const shouldPower = repeaterInputPower(world, x, y, z, state) > 0;
  if (repeaterPowered(state) === shouldPower) return;
  world.setBlockState(x, y, z, setRepeaterPowered(state, shouldPower), {
    cause: 'redstone-repeater',
    cascade: false,
  });
}

registerBlockBehavior(Block.REDSTONE_ORE, {
  drops({ world, x, y, z, tick }) {
    const roll = randomFromCoords3(x, y, z, (world.seed ^ tick ^ 0x5ed5_70e) >>> 0);
    return [new ItemStack('redstone_dust', 4 + Math.floor(roll * 2))];
  },
});

registerBlockBehavior(Block.REDSTONE_WIRE, {
  bootstrapDelay: 1,
  placed({ world, x, y, z }) {
    scheduleWire(world, x, y, z);
  },
  neighbourChanged({ world, x, y, z }) {
    scheduleWire(world, x, y, z);
  },
  scheduledTick: wireTick,
});

registerBlockBehavior(Block.LEVER, {
  // A lever has no autonomous tick, but registering it lets the behaviour table
  // describe every signal component and leaves room for wall-mount variants.
});

function registerTorch(blockId) {
  registerBlockBehavior(blockId, {
    bootstrapDelay: 2,
    placed({ world, x, y, z }) {
      scheduleTorch(world, x, y, z);
    },
    neighbourChanged({ world, x, y, z }) {
      scheduleTorch(world, x, y, z);
    },
    scheduledTick: torchTick,
  });
}
registerTorch(Block.REDSTONE_TORCH);
registerTorch(Block.REDSTONE_TORCH_OFF);

function registerLamp(blockId) {
  registerBlockBehavior(blockId, {
    bootstrapDelay: 1,
    placed({ world, x, y, z }) {
      scheduleLamp(world, x, y, z);
    },
    neighbourChanged({ world, x, y, z }) {
      const powered = receivedPower(world, x, y, z) > 0;
      // Lamps turn on immediately but retain their glow for four ticks after the
      // last signal, avoiding one-frame flicker in fast clocks.
      scheduleLamp(world, x, y, z, powered ? 1 : 4);
    },
    scheduledTick: lampTick,
  });
}
registerLamp(Block.REDSTONE_LAMP);
registerLamp(Block.REDSTONE_LAMP_LIT);

registerBlockBehavior(Block.REPEATER, {
  bootstrapDelay: 1,
  placed({ world, x, y, z, state }) {
    scheduleRepeater(world, x, y, z, state);
  },
  neighbourChanged({ world, x, y, z, state }) {
    scheduleRepeater(world, x, y, z, state);
  },
  scheduledTick: repeaterTick,
});

const BUTTON_RELEASE_CHANNEL = 'redstone-button-release';
const BUTTON_SUPPORT_CHANNEL = 'redstone-button-support';
const PLATE_RELEASE_CHANNEL = 'redstone-pressure-plate';
/** Recent contact ticks are kept outside saves; a loaded powered plate resets. */
const PLATE_CONTACTS = new WeakMap();

function pressureContactMap(world) {
  let contacts = PLATE_CONTACTS.get(world);
  if (!contacts) {
    contacts = new Map();
    PLATE_CONTACTS.set(world, contacts);
  }
  return contacts;
}

function positionKey(x, y, z) {
  return `${x},${y},${z}`;
}

/**
 * Presses a stone button. Repeated presses while already powered do not extend
 * the pulse, matching the deterministic scheduled-tick model.
 */
export function pressButton(world, x, y, z) {
  if (world.getBlock(x, y, z) !== Block.STONE_BUTTON) return null;
  const state = world.getBlockState(x, y, z);
  if (buttonPowered(state)) return true;
  if (!world.setBlockState(x, y, z, setButtonPowered(state, true), {
    cause: 'button-press',
    cascade: false,
  })) return null;
  world.scheduleBlockTick(x, y, z, 20, BUTTON_RELEASE_CHANNEL);
  return true;
}

/**
 * Marks an entity contact with a pressure plate.
 *
 * Wooden plates accept every entity kind; stone plates ignore item entities.
 * The caller may refresh contact every fixed step. A scheduled release checks
 * the last contact tick, so plates cannot become stuck on after an entity moves.
 */
export function touchPressurePlate(world, x, y, z, entityKind = 'living') {
  const blockId = world.getBlock(x, y, z);
  if (blockId !== Block.OAK_PRESSURE_PLATE && blockId !== Block.STONE_PRESSURE_PLATE) {
    return false;
  }
  if (blockId === Block.STONE_PRESSURE_PLATE && entityKind === 'item') return false;

  const key = positionKey(x, y, z);
  pressureContactMap(world).set(key, world.gameTick);
  const state = world.getBlockState(x, y, z);
  if (!pressurePlatePowered(state)) {
    world.setBlockState(x, y, z, setPressurePlatePowered(state, true), {
      cause: 'pressure-plate-on',
      cascade: false,
    });
  }
  world.scheduleBlockTick(x, y, z, 4, PLATE_RELEASE_CHANNEL);
  return true;
}

function buttonHasSupport(world, x, y, z, state) {
  const direction = horizontalFacingVector(buttonFacing(state));
  return world.isSupportive(x + direction.x, y, z + direction.z);
}

function buttonTick({ world, x, y, z, state, channel }) {
  if (world.getBlock(x, y, z) !== Block.STONE_BUTTON) return;
  if (channel === BUTTON_SUPPORT_CHANNEL || channel === 'bootstrap') {
    if (!buttonHasSupport(world, x, y, z, state)) {
      world.breakBlock(x, y, z, {
        drop: world.itemDropsEnabled,
        context: { cause: 'lost-support' },
      });
      return;
    }
  }
  if (channel !== BUTTON_RELEASE_CHANNEL && channel !== 'bootstrap') return;
  if (!buttonPowered(state)) return;
  world.setBlockState(x, y, z, setButtonPowered(state, false), {
    cause: 'button-release',
    cascade: false,
  });
}

function pressurePlateTick({ world, x, y, z, state, channel }) {
  if (channel !== PLATE_RELEASE_CHANNEL && channel !== 'bootstrap') return;
  const blockId = world.getBlock(x, y, z);
  if (blockId !== Block.OAK_PRESSURE_PLATE && blockId !== Block.STONE_PRESSURE_PLATE) return;
  const contacts = pressureContactMap(world);
  const key = positionKey(x, y, z);
  const lastContact = contacts.get(key);
  if (lastContact !== undefined && world.gameTick - lastContact <= 2) {
    world.scheduleBlockTick(x, y, z, 4, PLATE_RELEASE_CHANNEL);
    return;
  }
  contacts.delete(key);
  if (!pressurePlatePowered(state)) return;
  world.setBlockState(x, y, z, setPressurePlatePowered(state, false), {
    cause: 'pressure-plate-off',
    cascade: false,
  });
}

registerBlockBehavior(Block.STONE_BUTTON, {
  bootstrapDelay: 1,
  placed({ world, x, y, z }) {
    world.scheduleBlockTick(x, y, z, 1, BUTTON_SUPPORT_CHANNEL);
  },
  neighbourChanged({ world, x, y, z }) {
    world.scheduleBlockTick(x, y, z, 1, BUTTON_SUPPORT_CHANNEL);
  },
  scheduledTick: buttonTick,
});

function registerPressurePlate(blockId) {
  registerBlockBehavior(blockId, {
    bootstrapDelay: 1,
    scheduledTick: pressurePlateTick,
  });
}
registerPressurePlate(Block.OAK_PRESSURE_PLATE);
registerPressurePlate(Block.STONE_PRESSURE_PLATE);
