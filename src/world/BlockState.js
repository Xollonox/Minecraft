/**
 * Compact per-voxel state helpers.
 *
 * Block identity is stored as an unsigned 16-bit runtime id. A parallel
 * one-byte `states` array stores properties that vary per placed block: crop
 * age, farmland moisture, fluid level, facing, redstone power, open/closed and
 * similar values. Keeping the two concerns separate supports up to 65,536
 * registered blocks while preserving 256 compact state combinations per block.
 *
 * A chunk edit map stores a 24-bit "block word":
 *
 *     bits 16..23 = state
 *     bits 0..15  = block id
 *
 * Persistence migrates the former 8+8 layout when old save entries are read.
 * This module is worker-safe.
 */

/** Mask for one byte. */
export const BYTE_MASK = 0xff;
/** Mask for a 16-bit runtime block id. */
export const BLOCK_ID_MASK = 0xffff;

/** Horizontal facings encoded in two bits. */
export const HorizontalFacing = Object.freeze({
  SOUTH: 0,
  WEST: 1,
  NORTH: 2,
  EAST: 3,
});

/** Common bit allocations used by stateful blocks. */
export const StateBits = Object.freeze({
  FACING_SHIFT: 0,
  FACING_MASK: 0x03,
  OPEN_BIT: 0x04,
  POWERED_BIT: 0x08,
  UPPER_BIT: 0x10,
  HINGE_BIT: 0x20,
  SLAB_DOUBLE_BIT: 0x20,

  CROP_AGE_SHIFT: 0,
  CROP_AGE_MASK: 0x07,

  FARMLAND_MOISTURE_SHIFT: 0,
  FARMLAND_MOISTURE_MASK: 0x07,

  FLUID_LEVEL_SHIFT: 0,
  FLUID_LEVEL_MASK: 0x07,
  FLUID_FALLING_BIT: 0x08,

  REDSTONE_POWER_SHIFT: 0,
  REDSTONE_POWER_MASK: 0x0f,

  SWITCH_ACTIVE_BIT: 0x01,

  REPEATER_FACING_SHIFT: 0,
  REPEATER_FACING_MASK: 0x03,
  REPEATER_DELAY_SHIFT: 2,
  REPEATER_DELAY_MASK: 0x0c,
  REPEATER_POWERED_BIT: 0x10,

  // Horizontal connection mask used independently by fences, walls and panes.
  CONNECT_SOUTH_BIT: 0x01,
  CONNECT_WEST_BIT: 0x02,
  CONNECT_NORTH_BIT: 0x04,
  CONNECT_EAST_BIT: 0x08,
});

/** Horizontal direction vectors indexed by `HorizontalFacing`. */
export const HORIZONTAL_FACING_VECTORS = Object.freeze([
  Object.freeze({ x: 0, z: 1 }),
  Object.freeze({ x: -1, z: 0 }),
  Object.freeze({ x: 0, z: -1 }),
  Object.freeze({ x: 1, z: 0 }),
]);

/** Packs a 16-bit block id and state byte into the value held by an edit map. */
export function packBlockWord(blockId, state = 0) {
  return (((state & BYTE_MASK) << 16) | (blockId & BLOCK_ID_MASK)) >>> 0;
}

/** Extracts the 16-bit block id from a current block word. */
export function blockIdFromWord(word) {
  return Number(word) & BLOCK_ID_MASK;
}

/** Extracts the state byte from a current block word. */
export function stateFromWord(word) {
  return (Number(word) >>> 16) & BYTE_MASK;
}

/** Clamps/coerces an arbitrary state value to one byte. */
export function normaliseState(state) {
  return Number.isFinite(Number(state)) ? Number(state) & BYTE_MASK : 0;
}

/** Reads a bit field from a state byte. */
export function getStateField(state, mask, shift = 0) {
  return ((normaliseState(state) & mask) >>> shift) >>> 0;
}

/** Replaces one bit field and preserves every unrelated property. */
export function setStateField(state, mask, shift, value) {
  const clean = normaliseState(state);
  return ((clean & ~mask) | ((Number(value) << shift) & mask)) & BYTE_MASK;
}

/** Sets or clears a single-bit flag. */
export function setStateFlag(state, bit, enabled) {
  return enabled ? (normaliseState(state) | bit) & BYTE_MASK : normaliseState(state) & ~bit;
}

/** True when a single-bit flag is present. */
export function hasStateFlag(state, bit) {
  return (normaliseState(state) & bit) !== 0;
}

/** Chooses the cardinal direction closest to an X/Z vector. */
export function horizontalFacingFromVector(x, z) {
  const nx = Number(x) || 0;
  const nz = Number(z) || 0;
  if (Math.abs(nx) > Math.abs(nz)) {
    return nx < 0 ? HorizontalFacing.WEST : HorizontalFacing.EAST;
  }
  return nz < 0 ? HorizontalFacing.NORTH : HorizontalFacing.SOUTH;
}

/** Returns the immutable unit vector for a horizontal facing. */
export function horizontalFacingVector(facing) {
  return HORIZONTAL_FACING_VECTORS[normaliseState(facing) & 0x03];
}

/** Reverses a horizontal facing. */
export function oppositeHorizontalFacing(facing) {
  return (normaliseState(facing) + 2) & 0x03;
}

/** Reads the generic horizontal-facing field used by directional blocks. */
export function facingFromState(state) {
  return getStateField(state, StateBits.FACING_MASK, StateBits.FACING_SHIFT);
}

/** Encodes a lower/upper slab. */
export function slabState(upper = false, double = false) {
  let state = upper ? StateBits.UPPER_BIT : 0;
  if (double) state |= StateBits.SLAB_DOUBLE_BIT;
  return state & BYTE_MASK;
}

/** True when a slab-like block occupies the upper half. */
export function slabIsUpper(state) {
  return hasStateFlag(state, StateBits.UPPER_BIT);
}

/** True when two matching slabs have merged into a full-height block. */
export function slabIsDouble(state) {
  return hasStateFlag(state, StateBits.SLAB_DOUBLE_BIT);
}

/** Generic upper-half alias used by model families. */
export const isUpperHalf = slabIsUpper;

/** Encodes a stair facing plus lower/upper half. */
export function stairState(facing, upper = false) {
  let state = normaliseState(facing) & StateBits.FACING_MASK;
  if (upper) state |= StateBits.UPPER_BIT;
  return state & BYTE_MASK;
}

export const stairFacing = facingFromState;
export const stairIsUpper = slabIsUpper;

/** Encodes a door half. */
export function doorState(
  facing,
  { open = false, powered = false, upper = false, hingeRight = false } = {}
) {
  let state = normaliseState(facing) & StateBits.FACING_MASK;
  if (open) state |= StateBits.OPEN_BIT;
  if (powered) state |= StateBits.POWERED_BIT;
  if (upper) state |= StateBits.UPPER_BIT;
  if (hingeRight) state |= StateBits.HINGE_BIT;
  return state & BYTE_MASK;
}

export function doorOpen(state) {
  return hasStateFlag(state, StateBits.OPEN_BIT);
}

export function doorUpper(state) {
  return hasStateFlag(state, StateBits.UPPER_BIT);
}

export function doorHingeRight(state) {
  return hasStateFlag(state, StateBits.HINGE_BIT);
}

export function doorPowered(state) {
  return hasStateFlag(state, StateBits.POWERED_BIT);
}

export function setDoorOpen(state, open) {
  return setStateFlag(state, StateBits.OPEN_BIT, open);
}

export function setDoorPowered(state, powered) {
  return setStateFlag(state, StateBits.POWERED_BIT, powered);
}

/** Trapdoor uses the same facing/open/upper bit layout as a door. */
export function trapdoorState(
  facing,
  { open = false, powered = false, upper = false } = {}
) {
  let state = normaliseState(facing) & StateBits.FACING_MASK;
  if (open) state |= StateBits.OPEN_BIT;
  if (powered) state |= StateBits.POWERED_BIT;
  if (upper) state |= StateBits.UPPER_BIT;
  return state & BYTE_MASK;
}

export const trapdoorFacing = facingFromState;
export const trapdoorIsUpper = slabIsUpper;

export function trapdoorOpen(state) {
  return hasStateFlag(state, StateBits.OPEN_BIT);
}

export const trapdoorIsOpen = trapdoorOpen;

export function trapdoorPowered(state) {
  return hasStateFlag(state, StateBits.POWERED_BIT);
}

export function setTrapdoorOpen(state, open) {
  return setStateFlag(state, StateBits.OPEN_BIT, open);
}

export function setTrapdoorPowered(state, powered) {
  return setStateFlag(state, StateBits.POWERED_BIT, powered);
}

/** Fence gates preserve a powered latch for future redstone integration. */
export function gateState(facing, { open = false, powered = false } = {}) {
  let state = normaliseState(facing) & StateBits.FACING_MASK;
  if (open) state |= StateBits.OPEN_BIT;
  if (powered) state |= StateBits.POWERED_BIT;
  return state & BYTE_MASK;
}

export function gateOpen(state) {
  return hasStateFlag(state, StateBits.OPEN_BIT);
}

export function gatePowered(state) {
  return hasStateFlag(state, StateBits.POWERED_BIT);
}

export function setGateOpen(state, open) {
  return setStateFlag(state, StateBits.OPEN_BIT, open);
}

export function setGatePowered(state, powered) {
  return setStateFlag(state, StateBits.POWERED_BIT, powered);
}

/** Bed state: facing + head/foot + occupied. */
export function bedState(facing, { head = false, occupied = false } = {}) {
  let state = normaliseState(facing) & StateBits.FACING_MASK;
  if (head) state |= StateBits.OPEN_BIT;
  if (occupied) state |= StateBits.POWERED_BIT;
  return state & BYTE_MASK;
}

export function bedHead(state) {
  return hasStateFlag(state, StateBits.OPEN_BIT);
}

export function bedOccupied(state) {
  return hasStateFlag(state, StateBits.POWERED_BIT);
}

export function setBedOccupied(state, occupied) {
  return setStateFlag(state, StateBits.POWERED_BIT, occupied);
}

/** Directional button state. */
export function buttonState(facing, powered = false) {
  let state = normaliseState(facing) & StateBits.FACING_MASK;
  if (powered) state |= StateBits.POWERED_BIT;
  return state & BYTE_MASK;
}

export function buttonPowered(state) {
  return hasStateFlag(state, StateBits.POWERED_BIT);
}

export function setButtonPowered(state, powered) {
  return setStateFlag(state, StateBits.POWERED_BIT, powered);
}

/** Pressure plates need only an on/off bit. */
export function pressurePlateState(powered = false) {
  return powered ? StateBits.POWERED_BIT : 0;
}

export function pressurePlatePowered(state) {
  return hasStateFlag(state, StateBits.POWERED_BIT);
}

export function setPressurePlatePowered(state, powered) {
  return setStateFlag(state, StateBits.POWERED_BIT, powered);
}

/**
 * Packs cardinal connection flags for fence/wall/pane models.
 *
 * State is per block type, so these four low bits can overlap the facing field
 * used by doors and stairs without consuming additional storage.
 */
export function connectionState({ south = false, west = false, north = false, east = false } = {}) {
  return (
    (south ? StateBits.CONNECT_SOUTH_BIT : 0) |
    (west ? StateBits.CONNECT_WEST_BIT : 0) |
    (north ? StateBits.CONNECT_NORTH_BIT : 0) |
    (east ? StateBits.CONNECT_EAST_BIT : 0)
  ) & BYTE_MASK;
}

export function connectionMask(state) {
  return normaliseState(state) & 0x0f;
}

export function connectsSouth(state) {
  return hasStateFlag(state, StateBits.CONNECT_SOUTH_BIT);
}

export function connectsWest(state) {
  return hasStateFlag(state, StateBits.CONNECT_WEST_BIT);
}

export function connectsNorth(state) {
  return hasStateFlag(state, StateBits.CONNECT_NORTH_BIT);
}

export function connectsEast(state) {
  return hasStateFlag(state, StateBits.CONNECT_EAST_BIT);
}

/** Gate helpers share the generic facing/open bit layout. */
export const gateFacing = facingFromState;
export const gateIsOpen = gateOpen;

/** Bed facing shares the generic horizontal-facing field. */
export const bedFacing = facingFromState;

/** Button facing shares the generic horizontal-facing field. */
export const buttonFacing = facingFromState;

/** Encodes crop age in the shared 0..7 age field. */
export function cropState(age) {
  return Math.max(0, Math.min(7, Math.trunc(Number(age) || 0)));
}

/** Reads crop age from a state byte. */
export function cropAge(state) {
  return getStateField(state, StateBits.CROP_AGE_MASK, StateBits.CROP_AGE_SHIFT);
}

/** Encodes farmland moisture in the shared 0..7 field. */
export function farmlandState(moisture) {
  return Math.max(0, Math.min(7, Math.trunc(Number(moisture) || 0)));
}

/** Reads farmland moisture from a state byte. */
export function farmlandMoisture(state) {
  return getStateField(state, StateBits.FARMLAND_MOISTURE_MASK, StateBits.FARMLAND_MOISTURE_SHIFT);
}

/** Encodes a fluid level (0 source, 1..7 flowing) and falling flag. */
export function fluidState(level = 0, falling = false) {
  const clamped = Math.max(0, Math.min(7, Math.trunc(Number(level) || 0)));
  return clamped | (falling ? StateBits.FLUID_FALLING_BIT : 0);
}

/** Reads a fluid's 0..7 level. */
export function fluidLevel(state) {
  return getStateField(state, StateBits.FLUID_LEVEL_MASK, StateBits.FLUID_LEVEL_SHIFT);
}

/** True when a fluid column is falling from above. */
export function fluidIsFalling(state) {
  return hasStateFlag(state, StateBits.FLUID_FALLING_BIT);
}

/** Encodes a simple on/off switch such as a lever. */
export function switchState(active) {
  return active ? StateBits.SWITCH_ACTIVE_BIT : 0;
}

/** True when a simple switch is active. */
export function switchActive(state) {
  return hasStateFlag(state, StateBits.SWITCH_ACTIVE_BIT);
}

/** Encodes a repeater facing, delay (1..4) and powered latch. */
export function repeaterState(facing, delay = 1, powered = false) {
  const direction = normaliseState(facing) & 0x03;
  const encodedDelay = Math.max(0, Math.min(3, Math.trunc(Number(delay) || 1) - 1));
  let state = direction | (encodedDelay << StateBits.REPEATER_DELAY_SHIFT);
  if (powered) state |= StateBits.REPEATER_POWERED_BIT;
  return state & BYTE_MASK;
}

export function repeaterFacing(state) {
  return getStateField(state, StateBits.REPEATER_FACING_MASK, StateBits.REPEATER_FACING_SHIFT);
}

export function repeaterDelay(state) {
  return getStateField(state, StateBits.REPEATER_DELAY_MASK, StateBits.REPEATER_DELAY_SHIFT) + 1;
}

export function repeaterPowered(state) {
  return hasStateFlag(state, StateBits.REPEATER_POWERED_BIT);
}

export function setRepeaterPowered(state, powered) {
  return setStateFlag(state, StateBits.REPEATER_POWERED_BIT, powered);
}

/** Encodes redstone-like power in the shared 0..15 field. */
export function powerState(power) {
  return Math.max(0, Math.min(15, Math.trunc(Number(power) || 0)));
}

/** Reads redstone-like power in the shared 0..15 field. */
export function powerLevel(state) {
  return getStateField(state, StateBits.REDSTONE_POWER_MASK, StateBits.REDSTONE_POWER_SHIFT);
}

export default Object.freeze({
  packBlockWord,
  blockIdFromWord,
  stateFromWord,
  normaliseState,
  getStateField,
  setStateField,
  setStateFlag,
  hasStateFlag,
  horizontalFacingFromVector,
  horizontalFacingVector,
  oppositeHorizontalFacing,
  facingFromState,
  slabState,
  slabIsUpper,
  slabIsDouble,
  isUpperHalf,
  stairState,
  stairFacing,
  stairIsUpper,
  doorState,
  doorOpen,
  doorUpper,
  doorHingeRight,
  doorPowered,
  setDoorOpen,
  setDoorPowered,
  trapdoorState,
  trapdoorFacing,
  trapdoorIsUpper,
  trapdoorOpen,
  trapdoorIsOpen,
  trapdoorPowered,
  setTrapdoorOpen,
  setTrapdoorPowered,
  gateState,
  gateOpen,
  gatePowered,
  setGateOpen,
  setGatePowered,
  bedState,
  bedHead,
  bedOccupied,
  setBedOccupied,
  buttonState,
  buttonPowered,
  setButtonPowered,
  pressurePlateState,
  pressurePlatePowered,
  setPressurePlatePowered,
  connectionState,
  connectionMask,
  connectsSouth,
  connectsWest,
  connectsNorth,
  connectsEast,
  gateFacing,
  gateIsOpen,
  bedFacing,
  buttonFacing,
  cropState,
  cropAge,
  farmlandState,
  farmlandMoisture,
  fluidState,
  fluidLevel,
  fluidIsFalling,
  switchState,
  switchActive,
  repeaterState,
  repeaterFacing,
  repeaterDelay,
  repeaterPowered,
  setRepeaterPowered,
  powerState,
  powerLevel,
});
