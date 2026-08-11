/**
 * Behaviours for multi-block structures, connected models and wall attachments.
 *
 * The renderer, raycaster and collision system all consume `BlockModels`; this
 * module owns the world-state part of those models: fence/pane connections,
 * paired door/bed integrity, support checks and redstone-driven open states.
 */

import { ItemStack } from '../../items/ItemStack.js';
import { registerBlockBehavior } from '../BlockBehaviorRegistry.js';
import {
  bedFacing,
  bedHead,
  connectionState,
  doorHingeRight,
  doorOpen,
  doorPowered,
  doorState,
  doorUpper,
  facingFromState,
  gateFacing,
  gateIsOpen,
  gatePowered,
  gateState,
  horizontalFacingVector,
  setDoorOpen,
  setDoorPowered,
  setGateOpen,
  setGatePowered,
  setTrapdoorOpen,
  setTrapdoorPowered,
  slabIsDouble,
  trapdoorFacing,
  trapdoorIsOpen,
  trapdoorIsUpper,
  trapdoorPowered,
} from '../BlockState.js';
import { Block } from '../BlockTypes.js';
import { receivedPower } from './RedstoneBehaviors.js';

const CONNECTION_CHANNEL = 'structural-connections';
const SUPPORT_CHANNEL = 'structural-support';
const DOOR_CHANNEL = 'structural-door';
const GATE_CHANNEL = 'structural-gate';
const TRAPDOOR_CHANNEL = 'structural-trapdoor';
const BED_CHANNEL = 'structural-bed';

function itemDrop(itemId, count = 1) {
  return [new ItemStack(itemId, count)];
}

function schedule(world, x, y, z, channel, delay = 1) {
  world.scheduleBlockTick(x, y, z, delay, channel);
}

function isFenceConnection(world, x, y, z) {
  const id = world.getBlock(x, y, z);
  return (
    id === Block.OAK_FENCE ||
    id === Block.OAK_FENCE_GATE ||
    id === Block.COBBLESTONE_WALL ||
    world.isSupportive(x, y, z)
  );
}

function isWallConnection(world, x, y, z) {
  const id = world.getBlock(x, y, z);
  return (
    id === Block.COBBLESTONE_WALL ||
    id === Block.OAK_FENCE_GATE ||
    id === Block.OAK_FENCE ||
    world.isSupportive(x, y, z)
  );
}

function isPaneConnection(world, x, y, z) {
  const id = world.getBlock(x, y, z);
  return id === Block.GLASS_PANE || id === Block.GLASS || world.isSupportive(x, y, z);
}

/** Computes the four cardinal connections for a fence, wall or pane. */
export function connectedBlockState(world, x, y, z, blockId = world.getBlock(x, y, z)) {
  const connects =
    blockId === Block.OAK_FENCE
      ? isFenceConnection
      : blockId === Block.COBBLESTONE_WALL
        ? isWallConnection
        : blockId === Block.GLASS_PANE
          ? isPaneConnection
          : null;
  if (!connects) return 0;
  return connectionState({
    south: connects(world, x, y, z + 1),
    west: connects(world, x - 1, y, z),
    north: connects(world, x, y, z - 1),
    east: connects(world, x + 1, y, z),
  });
}

function refreshConnections(world, x, y, z) {
  const blockId = world.getBlock(x, y, z);
  if (
    blockId !== Block.OAK_FENCE &&
    blockId !== Block.COBBLESTONE_WALL &&
    blockId !== Block.GLASS_PANE
  ) return;
  const desired = connectedBlockState(world, x, y, z, blockId);
  if (world.getBlockState(x, y, z) === desired) return;
  world.setBlockState(x, y, z, desired, {
    cause: CONNECTION_CHANNEL,
    cascade: false,
  });
}

function registerConnector(blockId) {
  registerBlockBehavior(blockId, {
    bootstrapDelay: 1,
    placed({ world, x, y, z }) {
      schedule(world, x, y, z, CONNECTION_CHANNEL);
    },
    neighbourChanged({ world, x, y, z }) {
      schedule(world, x, y, z, CONNECTION_CHANNEL);
    },
    scheduledTick({ world, x, y, z, channel }) {
      if (channel === CONNECTION_CHANNEL || channel === 'bootstrap') {
        refreshConnections(world, x, y, z);
      }
    },
  });
}

registerConnector(Block.OAK_FENCE);
registerConnector(Block.COBBLESTONE_WALL);
registerConnector(Block.GLASS_PANE);

function attachmentHasSupport(world, x, y, z, state) {
  const direction = horizontalFacingVector(facingFromState(state));
  return world.isSupportive(x + direction.x, y, z + direction.z);
}

function breakUnsupported(world, x, y, z, expectedBlock) {
  if (world.getBlock(x, y, z) !== expectedBlock) return;
  world.breakBlock(x, y, z, {
    drop: world.itemDropsEnabled,
    context: { cause: 'lost-support' },
  });
}

registerBlockBehavior(Block.LADDER, {
  bootstrapDelay: 1,
  placed({ world, x, y, z }) {
    schedule(world, x, y, z, SUPPORT_CHANNEL);
  },
  neighbourChanged({ world, x, y, z }) {
    schedule(world, x, y, z, SUPPORT_CHANNEL);
  },
  scheduledTick({ world, x, y, z, state, channel }) {
    if (channel !== SUPPORT_CHANNEL && channel !== 'bootstrap') return;
    if (world.getBlock(x, y, z) !== Block.LADDER) return;
    if (!attachmentHasSupport(world, x, y, z, state)) {
      breakUnsupported(world, x, y, z, Block.LADDER);
    }
  },
});

function trapdoorTick({ world, x, y, z, state, channel }) {
  if (world.getBlock(x, y, z) !== Block.OAK_TRAPDOOR) return;
  if (channel === SUPPORT_CHANNEL || channel === 'bootstrap') {
    if (!attachmentHasSupport(world, x, y, z, state)) {
      breakUnsupported(world, x, y, z, Block.OAK_TRAPDOOR);
      return;
    }
  }
  if (channel !== TRAPDOOR_CHANNEL && channel !== 'bootstrap') return;
  const powered = receivedPower(world, x, y, z) > 0;
  const wasPowered = trapdoorPowered(state);
  if (powered === wasPowered) return;
  let next = setTrapdoorPowered(state, powered);
  next = setTrapdoorOpen(next, powered ? true : wasPowered ? false : trapdoorIsOpen(state));
  world.setBlockState(x, y, z, next, {
    cause: 'trapdoor-redstone',
    cascade: false,
  });
}

registerBlockBehavior(Block.OAK_TRAPDOOR, {
  bootstrapDelay: 1,
  placed({ world, x, y, z }) {
    schedule(world, x, y, z, SUPPORT_CHANNEL);
    schedule(world, x, y, z, TRAPDOOR_CHANNEL);
  },
  neighbourChanged({ world, x, y, z }) {
    schedule(world, x, y, z, SUPPORT_CHANNEL);
    schedule(world, x, y, z, TRAPDOOR_CHANNEL);
  },
  scheduledTick: trapdoorTick,
});

/** Toggles an oak trapdoor and returns the new open state, or null on mismatch. */
export function toggleTrapdoor(world, x, y, z) {
  if (world.getBlock(x, y, z) !== Block.OAK_TRAPDOOR) return null;
  const state = world.getBlockState(x, y, z);
  if (trapdoorPowered(state)) return trapdoorIsOpen(state);
  const open = !trapdoorIsOpen(state);
  world.setBlockState(x, y, z, setTrapdoorOpen(state, open), {
    cause: open ? 'trapdoor-open' : 'trapdoor-close',
    cascade: false,
  });
  return open;
}

function doorBase(world, x, y, z, state = world.getBlockState(x, y, z)) {
  return doorUpper(state) ? { x, y: y - 1, z } : { x, y, z };
}

function doorPairValid(world, x, y, z) {
  const lower = world.getBlock(x, y, z);
  const upper = world.getBlock(x, y + 1, z);
  if (lower !== Block.OAK_DOOR || upper !== Block.OAK_DOOR) return false;
  const lowerState = world.getBlockState(x, y, z);
  const upperState = world.getBlockState(x, y + 1, z);
  return (
    !doorUpper(lowerState) &&
    doorUpper(upperState) &&
    facingFromState(lowerState) === facingFromState(upperState) &&
    doorHingeRight(lowerState) === doorHingeRight(upperState) &&
    world.isSupportive(x, y - 1, z)
  );
}

function writeDoorState(world, x, y, z, lowerState, upperState, cause) {
  world.setBlockState(x, y, z, lowerState, { cause, cascade: false });
  world.setBlockState(x, y + 1, z, upperState, { cause, cascade: false });
}

function doorTick({ world, x, y, z, state, channel }) {
  if (channel !== DOOR_CHANNEL && channel !== SUPPORT_CHANNEL && channel !== 'bootstrap') return;
  if (world.getBlock(x, y, z) !== Block.OAK_DOOR) return;
  const base = doorBase(world, x, y, z, state);
  if (!doorPairValid(world, base.x, base.y, base.z)) {
    breakUnsupported(world, x, y, z, Block.OAK_DOOR);
    return;
  }

  const lowerState = world.getBlockState(base.x, base.y, base.z);
  const upperState = world.getBlockState(base.x, base.y + 1, base.z);
  const powered =
    receivedPower(world, base.x, base.y, base.z) > 0 ||
    receivedPower(world, base.x, base.y + 1, base.z) > 0;
  const wasPowered = doorPowered(lowerState) || doorPowered(upperState);
  if (powered === wasPowered) return;
  const open = powered ? true : wasPowered ? false : doorOpen(lowerState);
  let nextLower = setDoorPowered(setDoorOpen(lowerState, open), powered);
  let nextUpper = setDoorPowered(setDoorOpen(upperState, open), powered);
  // Preserve the canonical upper bit even if a malformed save supplied one half.
  nextLower = doorState(facingFromState(nextLower), {
    open,
    powered,
    upper: false,
    hingeRight: doorHingeRight(nextLower),
  });
  nextUpper = doorState(facingFromState(nextUpper), {
    open,
    powered,
    upper: true,
    hingeRight: doorHingeRight(nextUpper),
  });
  writeDoorState(world, base.x, base.y, base.z, nextLower, nextUpper, 'door-redstone');
}

registerBlockBehavior(Block.OAK_DOOR, {
  bootstrapDelay: 1,
  placed({ world, x, y, z }) {
    schedule(world, x, y, z, DOOR_CHANNEL);
    schedule(world, x, y, z, SUPPORT_CHANNEL);
  },
  neighbourChanged({ world, x, y, z }) {
    schedule(world, x, y, z, DOOR_CHANNEL);
    schedule(world, x, y, z, SUPPORT_CHANNEL);
  },
  removed({ world, x, y, z, state }) {
    const otherY = doorUpper(state) ? y - 1 : y + 1;
    if (world.getBlock(x, otherY, z) === Block.OAK_DOOR) {
      world.setBlock(x, otherY, z, Block.AIR, {
        cause: 'door-pair-remove',
        cascade: false,
      });
    }
  },
  scheduledTick: doorTick,
  drops() {
    return itemDrop('oak_door');
  },
});

/** Toggles both halves of a door. Powered doors stay controlled by redstone. */
export function toggleDoor(world, x, y, z) {
  if (world.getBlock(x, y, z) !== Block.OAK_DOOR) return null;
  const base = doorBase(world, x, y, z);
  if (!doorPairValid(world, base.x, base.y, base.z)) return null;
  const lowerState = world.getBlockState(base.x, base.y, base.z);
  const upperState = world.getBlockState(base.x, base.y + 1, base.z);
  if (doorPowered(lowerState) || doorPowered(upperState)) return doorOpen(lowerState);
  const open = !doorOpen(lowerState);
  writeDoorState(
    world,
    base.x,
    base.y,
    base.z,
    setDoorOpen(lowerState, open),
    setDoorOpen(upperState, open),
    open ? 'door-open' : 'door-close'
  );
  return open;
}

function gateTick({ world, x, y, z, state, channel }) {
  if (channel !== GATE_CHANNEL && channel !== 'bootstrap') return;
  if (world.getBlock(x, y, z) !== Block.OAK_FENCE_GATE) return;
  const powered = receivedPower(world, x, y, z) > 0;
  const wasPowered = gatePowered(state);
  if (powered === wasPowered) return;
  const open = powered ? true : wasPowered ? false : gateIsOpen(state);
  const next = gateState(gateFacing(state), { open, powered });
  world.setBlockState(x, y, z, next, {
    cause: 'gate-redstone',
    cascade: false,
  });
}

registerBlockBehavior(Block.OAK_FENCE_GATE, {
  bootstrapDelay: 1,
  placed({ world, x, y, z }) {
    schedule(world, x, y, z, GATE_CHANNEL);
  },
  neighbourChanged({ world, x, y, z }) {
    schedule(world, x, y, z, GATE_CHANNEL);
  },
  scheduledTick: gateTick,
});

export function toggleFenceGate(world, x, y, z) {
  if (world.getBlock(x, y, z) !== Block.OAK_FENCE_GATE) return null;
  const state = world.getBlockState(x, y, z);
  if (gatePowered(state)) return gateIsOpen(state);
  const open = !gateIsOpen(state);
  world.setBlockState(x, y, z, setGateOpen(state, open), {
    cause: open ? 'gate-open' : 'gate-close',
    cascade: false,
  });
  return open;
}

/** Resolves either half of a bed to canonical foot/head coordinates. */
export function resolveBed(world, x, y, z) {
  if (world.getBlock(x, y, z) !== Block.WHITE_BED) return null;
  const state = world.getBlockState(x, y, z);
  const facing = bedFacing(state);
  const direction = horizontalFacingVector(facing);
  const foot = bedHead(state)
    ? { x: x - direction.x, y, z: z - direction.z }
    : { x, y, z };
  const head = { x: foot.x + direction.x, y, z: foot.z + direction.z };
  if (
    world.getBlock(foot.x, foot.y, foot.z) !== Block.WHITE_BED ||
    world.getBlock(head.x, head.y, head.z) !== Block.WHITE_BED
  ) return null;
  return { foot, head, facing };
}

function bedValid(world, x, y, z) {
  const bed = resolveBed(world, x, y, z);
  if (!bed) return false;
  return (
    world.isSupportive(bed.foot.x, bed.foot.y - 1, bed.foot.z) &&
    world.isSupportive(bed.head.x, bed.head.y - 1, bed.head.z)
  );
}

registerBlockBehavior(Block.WHITE_BED, {
  bootstrapDelay: 1,
  placed({ world, x, y, z }) {
    schedule(world, x, y, z, BED_CHANNEL);
  },
  neighbourChanged({ world, x, y, z }) {
    schedule(world, x, y, z, BED_CHANNEL);
  },
  removed({ world, x, y, z, state }) {
    const facing = bedFacing(state);
    const direction = horizontalFacingVector(facing);
    const other = bedHead(state)
      ? { x: x - direction.x, y, z: z - direction.z }
      : { x: x + direction.x, y, z: z + direction.z };
    if (world.getBlock(other.x, other.y, other.z) === Block.WHITE_BED) {
      world.setBlock(other.x, other.y, other.z, Block.AIR, {
        cause: 'bed-pair-remove',
        cascade: false,
      });
    }
  },
  scheduledTick({ world, x, y, z, channel }) {
    if (channel !== BED_CHANNEL && channel !== 'bootstrap') return;
    if (world.getBlock(x, y, z) !== Block.WHITE_BED) return;
    if (!bedValid(world, x, y, z)) breakUnsupported(world, x, y, z, Block.WHITE_BED);
  },
  drops() {
    return itemDrop('white_bed');
  },
});

/** Finds a safe respawn location around a bed, preferring the foot end. */
export function bedSpawnPoint(world, x, y, z) {
  const bed = resolveBed(world, x, y, z);
  if (!bed) return null;
  const direction = horizontalFacingVector(bed.facing);
  const left = { x: -direction.z, z: direction.x };
  const candidates = [
    { x: bed.foot.x - direction.x, z: bed.foot.z - direction.z },
    { x: bed.foot.x + left.x, z: bed.foot.z + left.z },
    { x: bed.foot.x - left.x, z: bed.foot.z - left.z },
    { x: bed.head.x + left.x, z: bed.head.z + left.z },
    { x: bed.head.x - left.x, z: bed.head.z - left.z },
    { x: bed.head.x + direction.x, z: bed.head.z + direction.z },
  ];
  for (const candidate of candidates) {
    if (world.isSpawnClear(candidate.x, y + 1, candidate.z)) {
      return { x: candidate.x + 0.5, y: y + 1, z: candidate.z + 0.5 };
    }
  }
  // The bed itself is non-full-height; use its centre only as a final fallback.
  return { x: bed.foot.x + 0.5, y: y + 1, z: bed.foot.z + 0.5 };
}

function registerSlabDrops(blockId, itemId) {
  registerBlockBehavior(blockId, {
    drops({ state }) {
      return itemDrop(itemId, slabIsDouble(state) ? 2 : 1);
    },
  });
}
registerSlabDrops(Block.OAK_SLAB, 'oak_slab');
registerSlabDrops(Block.COBBLESTONE_SLAB, 'cobblestone_slab');

export default Object.freeze({
  bedSpawnPoint,
  connectedBlockState,
  resolveBed,
  toggleDoor,
  toggleFenceGate,
  toggleTrapdoor,
});
