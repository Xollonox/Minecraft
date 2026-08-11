/**
 * Data-driven voxel models for non-cube blocks.
 *
 * Every model is expressed as immutable axis-aligned boxes in block-local
 * coordinates. Rendering, collision, targeting and placement all consume the
 * same source of truth, preventing the classic bug where a stair looks like a
 * stair but still collides and raycasts as a full cube.
 *
 * This module is worker-safe. Dynamic connection models are cached for all 16
 * cardinal masks at load time, so meshing and collision do not allocate.
 */

import { Block } from './BlockTypes.js';
import {
  HorizontalFacing,
  bedHead,
  buttonFacing,
  buttonPowered,
  connectionMask,
  connectsEast,
  connectsNorth,
  connectsSouth,
  connectsWest,
  doorHingeRight,
  doorOpen,
  doorUpper,
  facingFromState,
  gateFacing,
  gateIsOpen,
  pressurePlatePowered,
  slabIsDouble,
  slabIsUpper,
  stairFacing,
  stairIsUpper,
  trapdoorFacing,
  trapdoorIsOpen,
  trapdoorIsUpper,
} from './BlockState.js';

/** @typedef {Readonly<[number, number, number, number, number, number]>} VoxelBox */

const U = 1 / 16;
const box = (minX, minY, minZ, maxX, maxY, maxZ) =>
  Object.freeze([minX, minY, minZ, maxX, maxY, maxZ]);
const shape = (...boxes) => Object.freeze(boxes);
const freezeShape = (boxes) => Object.freeze(boxes.map((entry) => Object.freeze(entry)));

export const EMPTY_SHAPE = Object.freeze([]);
export const FULL_CUBE_SHAPE = shape(box(0, 0, 0, 1, 1, 1));

const BOTTOM_SLAB = shape(box(0, 0, 0, 1, 0.5, 1));
const TOP_SLAB = shape(box(0, 0.5, 0, 1, 1, 1));

const STAIR_BOTTOM = Object.freeze({
  [HorizontalFacing.SOUTH]: shape(
    box(0, 0, 0, 1, 0.5, 1),
    box(0, 0.5, 0.5, 1, 1, 1)
  ),
  [HorizontalFacing.WEST]: shape(
    box(0, 0, 0, 1, 0.5, 1),
    box(0, 0.5, 0, 0.5, 1, 1)
  ),
  [HorizontalFacing.NORTH]: shape(
    box(0, 0, 0, 1, 0.5, 1),
    box(0, 0.5, 0, 1, 1, 0.5)
  ),
  [HorizontalFacing.EAST]: shape(
    box(0, 0, 0, 1, 0.5, 1),
    box(0.5, 0.5, 0, 1, 1, 1)
  ),
});

const STAIR_TOP = Object.freeze({
  [HorizontalFacing.SOUTH]: shape(
    box(0, 0.5, 0, 1, 1, 1),
    box(0, 0, 0.5, 1, 0.5, 1)
  ),
  [HorizontalFacing.WEST]: shape(
    box(0, 0.5, 0, 1, 1, 1),
    box(0, 0, 0, 0.5, 0.5, 1)
  ),
  [HorizontalFacing.NORTH]: shape(
    box(0, 0.5, 0, 1, 1, 1),
    box(0, 0, 0, 1, 0.5, 0.5)
  ),
  [HorizontalFacing.EAST]: shape(
    box(0, 0.5, 0, 1, 1, 1),
    box(0.5, 0, 0, 1, 0.5, 1)
  ),
});

const TRAPDOOR_THICKNESS = 3 * U;
const TRAPDOOR_CLOSED_BOTTOM = shape(box(0, 0, 0, 1, TRAPDOOR_THICKNESS, 1));
const TRAPDOOR_CLOSED_TOP = shape(box(0, 1 - TRAPDOOR_THICKNESS, 0, 1, 1, 1));
const WALL_PANEL = Object.freeze({
  [HorizontalFacing.SOUTH]: shape(box(0, 0, 1 - TRAPDOOR_THICKNESS, 1, 1, 1)),
  [HorizontalFacing.WEST]: shape(box(0, 0, 0, TRAPDOOR_THICKNESS, 1, 1)),
  [HorizontalFacing.NORTH]: shape(box(0, 0, 0, 1, 1, TRAPDOOR_THICKNESS)),
  [HorizontalFacing.EAST]: shape(box(1 - TRAPDOOR_THICKNESS, 0, 0, 1, 1, 1)),
});

const LADDER_THICKNESS = U;
const LADDER_SHAPES = Object.freeze({
  [HorizontalFacing.SOUTH]: shape(box(U, 0, 1 - LADDER_THICKNESS, 1 - U, 1, 1)),
  [HorizontalFacing.WEST]: shape(box(0, 0, U, LADDER_THICKNESS, 1, 1 - U)),
  [HorizontalFacing.NORTH]: shape(box(U, 0, 0, 1 - U, 1, LADDER_THICKNESS)),
  [HorizontalFacing.EAST]: shape(box(1 - LADDER_THICKNESS, 0, U, 1, 1, 1 - U)),
});

const BED_FOOT = shape(
  box(0, 3 * U, 0, 1, 9 * U, 1),
  box(U, 0, U, 3 * U, 3 * U, 3 * U),
  box(13 * U, 0, U, 15 * U, 3 * U, 3 * U)
);
const BED_HEAD = shape(
  box(0, 3 * U, 0, 1, 9 * U, 1),
  box(U, 0, 13 * U, 3 * U, 3 * U, 15 * U),
  box(13 * U, 0, 13 * U, 15 * U, 3 * U, 15 * U)
);

const BUTTON_SHAPES = Object.freeze({
  [HorizontalFacing.SOUTH]: Object.freeze([
    box(5 * U, 6 * U, 14 * U, 11 * U, 10 * U, 1),
    box(5.5 * U, 6.5 * U, 15 * U, 10.5 * U, 9.5 * U, 1),
  ]),
  [HorizontalFacing.WEST]: Object.freeze([
    box(0, 6 * U, 5 * U, 2 * U, 10 * U, 11 * U),
    box(0, 6.5 * U, 5.5 * U, U, 9.5 * U, 10.5 * U),
  ]),
  [HorizontalFacing.NORTH]: Object.freeze([
    box(5 * U, 6 * U, 0, 11 * U, 10 * U, 2 * U),
    box(5.5 * U, 6.5 * U, 0, 10.5 * U, 9.5 * U, U),
  ]),
  [HorizontalFacing.EAST]: Object.freeze([
    box(14 * U, 6 * U, 5 * U, 1, 10 * U, 11 * U),
    box(15 * U, 6.5 * U, 5.5 * U, 1, 9.5 * U, 10.5 * U),
  ]),
});

function activeButtonShape(state) {
  const pair = BUTTON_SHAPES[buttonFacing(state)];
  return buttonPowered(state) ? shape(pair[1]) : shape(pair[0]);
}

function pressurePlateShape(state) {
  const inset = U;
  const height = pressurePlatePowered(state) ? U / 2 : U;
  return shape(box(inset, 0, inset, 1 - inset, height, 1 - inset));
}

function fenceShape(mask, wall = false) {
  const boxes = [];
  if (wall) boxes.push([4 * U, 0, 4 * U, 12 * U, 1, 12 * U]);
  else boxes.push([6 * U, 0, 6 * U, 10 * U, 1, 10 * U]);

  const addArm = (direction) => {
    if (wall) {
      if (direction === 'south') boxes.push([5 * U, 3 * U, 8 * U, 11 * U, 13 * U, 1]);
      if (direction === 'north') boxes.push([5 * U, 3 * U, 0, 11 * U, 13 * U, 8 * U]);
      if (direction === 'east') boxes.push([8 * U, 3 * U, 5 * U, 1, 13 * U, 11 * U]);
      if (direction === 'west') boxes.push([0, 3 * U, 5 * U, 8 * U, 13 * U, 11 * U]);
      return;
    }
    const rails = [[6 * U, 9 * U], [12 * U, 15 * U]];
    for (const [minY, maxY] of rails) {
      if (direction === 'south') boxes.push([7 * U, minY, 8 * U, 9 * U, maxY, 1]);
      if (direction === 'north') boxes.push([7 * U, minY, 0, 9 * U, maxY, 8 * U]);
      if (direction === 'east') boxes.push([8 * U, minY, 7 * U, 1, maxY, 9 * U]);
      if (direction === 'west') boxes.push([0, minY, 7 * U, 8 * U, maxY, 9 * U]);
    }
  };

  if (connectsSouth(mask)) addArm('south');
  if (connectsWest(mask)) addArm('west');
  if (connectsNorth(mask)) addArm('north');
  if (connectsEast(mask)) addArm('east');
  return freezeShape(boxes);
}

function paneShape(mask) {
  const boxes = [[7 * U, 0, 7 * U, 9 * U, 1, 9 * U]];
  if (connectsSouth(mask)) boxes.push([7 * U, 0, 8 * U, 9 * U, 1, 1]);
  if (connectsNorth(mask)) boxes.push([7 * U, 0, 0, 9 * U, 1, 8 * U]);
  if (connectsEast(mask)) boxes.push([8 * U, 0, 7 * U, 1, 1, 9 * U]);
  if (connectsWest(mask)) boxes.push([0, 0, 7 * U, 8 * U, 1, 9 * U]);
  return freezeShape(boxes);
}

const FENCE_SHAPES = Object.freeze(Array.from({ length: 16 }, (_, mask) => fenceShape(mask, false)));
const WALL_SHAPES = Object.freeze(Array.from({ length: 16 }, (_, mask) => fenceShape(mask, true)));
const PANE_SHAPES = Object.freeze(Array.from({ length: 16 }, (_, mask) => paneShape(mask)));

function gateShape(state) {
  const facing = gateFacing(state);
  const open = gateIsOpen(state);
  const alongX = facing === HorizontalFacing.SOUTH || facing === HorizontalFacing.NORTH;
  const boxes = [];
  if (alongX) {
    boxes.push([0, 0, 6 * U, 2 * U, 1, 10 * U]);
    boxes.push([14 * U, 0, 6 * U, 1, 1, 10 * U]);
    if (!open) {
      boxes.push([2 * U, 5 * U, 7 * U, 14 * U, 8 * U, 9 * U]);
      boxes.push([2 * U, 11 * U, 7 * U, 14 * U, 14 * U, 9 * U]);
    }
  } else {
    boxes.push([6 * U, 0, 0, 10 * U, 1, 2 * U]);
    boxes.push([6 * U, 0, 14 * U, 10 * U, 1, 1]);
    if (!open) {
      boxes.push([7 * U, 5 * U, 2 * U, 9 * U, 8 * U, 14 * U]);
      boxes.push([7 * U, 11 * U, 2 * U, 9 * U, 14 * U, 14 * U]);
    }
  }
  return freezeShape(boxes);
}

function doorShape(state) {
  let facing = facingFromState(state);
  if (doorOpen(state)) {
    facing = (facing + (doorHingeRight(state) ? 1 : 3)) & 0x03;
  }
  return WALL_PANEL[facing];
}

/** True when a block uses the multi-box model path. */
export function hasCustomVoxelShape(blockId) {
  return (
    blockId === Block.OAK_SLAB ||
    blockId === Block.COBBLESTONE_SLAB ||
    blockId === Block.OAK_STAIRS ||
    blockId === Block.COBBLESTONE_STAIRS ||
    blockId === Block.OAK_TRAPDOOR ||
    blockId === Block.LADDER ||
    blockId === Block.OAK_FENCE ||
    blockId === Block.COBBLESTONE_WALL ||
    blockId === Block.OAK_FENCE_GATE ||
    blockId === Block.OAK_DOOR ||
    blockId === Block.GLASS_PANE ||
    blockId === Block.WHITE_BED ||
    blockId === Block.STONE_BUTTON ||
    blockId === Block.OAK_PRESSURE_PLATE ||
    blockId === Block.STONE_PRESSURE_PLATE
  );
}

/** Boxes used by rendering and selection. */
export function getVoxelShape(blockId, state = 0) {
  if (blockId === Block.OAK_SLAB || blockId === Block.COBBLESTONE_SLAB) {
    if (slabIsDouble(state)) return FULL_CUBE_SHAPE;
    return slabIsUpper(state) ? TOP_SLAB : BOTTOM_SLAB;
  }
  if (blockId === Block.OAK_STAIRS || blockId === Block.COBBLESTONE_STAIRS) {
    const facing = stairFacing(state);
    return stairIsUpper(state) ? STAIR_TOP[facing] : STAIR_BOTTOM[facing];
  }
  if (blockId === Block.OAK_TRAPDOOR) {
    if (trapdoorIsOpen(state)) return WALL_PANEL[trapdoorFacing(state)];
    return trapdoorIsUpper(state) ? TRAPDOOR_CLOSED_TOP : TRAPDOOR_CLOSED_BOTTOM;
  }
  if (blockId === Block.LADDER) return LADDER_SHAPES[trapdoorFacing(state)];
  if (blockId === Block.OAK_FENCE) return FENCE_SHAPES[connectionMask(state)];
  if (blockId === Block.COBBLESTONE_WALL) return WALL_SHAPES[connectionMask(state)];
  if (blockId === Block.OAK_FENCE_GATE) return gateShape(state);
  if (blockId === Block.OAK_DOOR) return doorShape(state);
  if (blockId === Block.GLASS_PANE) return PANE_SHAPES[connectionMask(state)];
  if (blockId === Block.WHITE_BED) return bedHead(state) ? BED_HEAD : BED_FOOT;
  if (blockId === Block.STONE_BUTTON) return activeButtonShape(state);
  if (blockId === Block.OAK_PRESSURE_PLATE || blockId === Block.STONE_PRESSURE_PLATE) {
    return pressurePlateShape(state);
  }
  return FULL_CUBE_SHAPE;
}

/**
 * Collision boxes. Ladders, buttons and pressure plates are selectable/rendered
 * but do not impede movement; their gameplay is handled by contact logic.
 */
export function getCollisionShape(blockId, state = 0) {
  if (
    blockId === Block.LADDER ||
    blockId === Block.STONE_BUTTON ||
    blockId === Block.OAK_PRESSURE_PLATE ||
    blockId === Block.STONE_PRESSURE_PLATE
  ) return EMPTY_SHAPE;
  return getVoxelShape(blockId, state);
}

/** Union bounds of a shape, useful for outlines and diagnostics. */
export function getShapeBounds(boxes) {
  if (!boxes || boxes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const current of boxes) {
    minX = Math.min(minX, current[0]);
    minY = Math.min(minY, current[1]);
    minZ = Math.min(minZ, current[2]);
    maxX = Math.max(maxX, current[3]);
    maxY = Math.max(maxY, current[4]);
    maxZ = Math.max(maxZ, current[5]);
  }
  return Object.freeze({ minX, minY, minZ, maxX, maxY, maxZ });
}

/** True when two open AABBs overlap. */
export function aabbIntersectsBox(
  minX,
  minY,
  minZ,
  maxX,
  maxY,
  maxZ,
  blockX,
  blockY,
  blockZ,
  voxelBox
) {
  return (
    minX < blockX + voxelBox[3] &&
    maxX > blockX + voxelBox[0] &&
    minY < blockY + voxelBox[4] &&
    maxY > blockY + voxelBox[1] &&
    minZ < blockZ + voxelBox[5] &&
    maxZ > blockZ + voxelBox[2]
  );
}

/**
 * Nearest ray intersection with a shape in world space.
 * Returns `null` when the ray misses, otherwise distance plus an outward normal.
 */
export function rayIntersectVoxelShape(
  origin,
  direction,
  blockX,
  blockY,
  blockZ,
  boxes,
  maxDistance = Infinity
) {
  let best = null;
  for (const current of boxes) {
    const hit = rayIntersectBox(
      origin,
      direction,
      blockX + current[0],
      blockY + current[1],
      blockZ + current[2],
      blockX + current[3],
      blockY + current[4],
      blockZ + current[5]
    );
    if (!hit || hit.distance < -1e-7 || hit.distance > maxDistance) continue;
    if (!best || hit.distance < best.distance) best = hit;
  }
  return best;
}

function rayIntersectBox(origin, direction, minX, minY, minZ, maxX, maxY, maxZ) {
  let near = -Infinity;
  let far = Infinity;
  let nearNormalX = 0;
  let nearNormalY = 0;
  let nearNormalZ = 0;

  const axes = [
    [origin.x, direction.x, minX, maxX, -1, 0, 0],
    [origin.y, direction.y, minY, maxY, 0, -1, 0],
    [origin.z, direction.z, minZ, maxZ, 0, 0, -1],
  ];

  for (const [o, d, min, max, nx, ny, nz] of axes) {
    if (Math.abs(d) < 1e-10) {
      if (o < min || o > max) return null;
      continue;
    }
    let t1 = (min - o) / d;
    let t2 = (max - o) / d;
    let sign = 1;
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      sign = -1;
    }
    if (t1 > near) {
      near = t1;
      nearNormalX = nx * sign;
      nearNormalY = ny * sign;
      nearNormalZ = nz * sign;
    }
    far = Math.min(far, t2);
    if (near > far) return null;
  }

  if (far < 0) return null;
  const distance = Math.max(0, near);
  return { distance, normalX: nearNormalX, normalY: nearNormalY, normalZ: nearNormalZ };
}

export default Object.freeze({
  EMPTY_SHAPE,
  FULL_CUBE_SHAPE,
  hasCustomVoxelShape,
  getVoxelShape,
  getCollisionShape,
  getShapeBounds,
  aabbIntersectsBox,
  rayIntersectVoxelShape,
});
