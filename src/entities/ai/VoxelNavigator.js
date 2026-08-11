/**
 * Bounded A* navigation over the voxel world.
 *
 * The navigator deliberately searches only a local region and returns immutable
 * block-centre waypoints. It understands one-block steps, short safe drops,
 * entity height, unloaded terrain and hazardous cells. Expensive global paths
 * are avoided: mobs replan short segments as the player and world change.
 *
 * Worker/renderer free, so every route rule is regression-testable in Node.
 */

import { WORLD_HEIGHT } from '../../config/GameConfig.js';
import { Block } from '../../world/BlockTypes.js';

const CARDINAL = Object.freeze([
  Object.freeze([1, 0]),
  Object.freeze([-1, 0]),
  Object.freeze([0, 1]),
  Object.freeze([0, -1]),
]);

/**
 * Diagonal steps, tried after the cardinals.
 *
 * Cardinal-only search is why FinalV2 mobs walked in visible staircases across
 * open ground: the path was optimal on a 4-connected grid and looked wrong on
 * screen. Diagonals cost sqrt(2) so the search still prefers a straight line,
 * and each one is gated on both adjacent cardinals being open, which is what
 * stops a mob slipping through the corner gap between two blocks.
 */
const DIAGONAL = Object.freeze([
  Object.freeze([1, 1]),
  Object.freeze([1, -1]),
  Object.freeze([-1, 1]),
  Object.freeze([-1, -1]),
]);

const SQRT2 = Math.SQRT2;

/** Cardinals first so the search prefers axis-aligned steps at equal cost. */
const CARDINAL_THEN_DIAGONAL = Object.freeze([...CARDINAL, ...DIAGONAL]);

/** Blocks a mob can walk through: doors, gates and trapdoors it can open. */
const DOOR_BLOCKS = Object.freeze(
  new Set([Block.OAK_DOOR, Block.OAK_FENCE_GATE, Block.OAK_TRAPDOOR])
);

/** Blocks a mob can climb vertically. */
const CLIMBABLE_BLOCKS = Object.freeze(new Set([Block.LADDER]));

const DEFAULT_OPTIONS = Object.freeze({
  // 384 nodes is roughly a 10-block radius once vertical moves are counted, so
  // FinalV2 mobs gave up on anything more complex than a single wall and fell
  // back to walking straight at the player. 2000 still completes well inside a
  // frame budget for the handful of mobs that replan on any given tick.
  maxNodes: 2000,
  maxDistance: 40,
  maxStepUp: 1,
  maxDrop: 3,
  entityHeight: 1.8,
  avoidHazards: true,
  canSwim: false,
  /** Route through doors and gates rather than treating them as walls. */
  canUseDoors: true,
  /** Route up and down ladders. */
  canClimb: true,
  /** Allow sqrt(2) diagonal steps. */
  allowDiagonal: true,
  /** Build height, so a dimension can override the Overworld default. */
  worldHeight: WORLD_HEIGHT,
  goalRadius: 0,
});

/** A tiny allocation-conscious binary min heap. */
class MinHeap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(node) {
    const items = this.items;
    let index = items.length;
    items.push(node);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (items[parent].f <= node.f) break;
      items[index] = items[parent];
      index = parent;
    }
    items[index] = node;
  }

  pop() {
    const items = this.items;
    if (items.length === 0) return null;
    const root = items[0];
    const tail = items.pop();
    if (items.length === 0) return root;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= items.length) break;
      const right = left + 1;
      let child = left;
      if (right < items.length && items[right].f < items[left].f) child = right;
      if (items[child].f >= tail.f) break;
      items[index] = items[child];
      index = child;
    }
    items[index] = tail;
    return root;
  }
}

function key(x, y, z) {
  return `${x},${y},${z}`;
}

function finiteInteger(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Math.floor(Number(value)) : fallback;
}

function isLoaded(world, x, y, z) {
  return typeof world.isLoaded !== 'function' || world.isLoaded(x, y, z);
}

function collidable(world, x, y, z, worldHeight = WORLD_HEIGHT) {
  if (y < 0) return true;
  if (y >= worldHeight) return false;
  return Boolean(world.isCollidable?.(x, y, z));
}

/** True when a door-like block sits at this cell and the mob may open it. */
function passableDoor(world, x, y, z, options) {
  return options.canUseDoors !== false && DOOR_BLOCKS.has(blockAt(world, x, y, z));
}

/** True when the cell holds a climbable block. */
function climbable(world, x, y, z, options) {
  return options.canClimb !== false && CLIMBABLE_BLOCKS.has(blockAt(world, x, y, z));
}

function blockAt(world, x, y, z) {
  return Number(world.getBlock?.(x, y, z)) || Block.AIR;
}

/** True when the feet cell is dangerous to enter. */
export function isNavigationHazard(world, x, y, z) {
  const feet = blockAt(world, x, y, z);
  const below = blockAt(world, x, y - 1, z);
  return feet === Block.LAVA || below === Block.LAVA || feet === Block.FIRE;
}

/**
 * True when an entity can stand with its feet at `(x,y,z)`.
 *
 * @param {Object} world
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {{entityHeight?:number,avoidHazards?:boolean,canSwim?:boolean}} options
 */
export function isWalkableNode(world, x, y, z, options = DEFAULT_OPTIONS) {
  const worldHeight = Number(options.worldHeight) || WORLD_HEIGHT;
  if (y <= 0 || y >= worldHeight) return false;
  if (!isLoaded(world, x, y, z)) return false;
  const cellsTall = Math.max(1, Math.ceil(Number(options.entityHeight) || 1.8));
  for (let offset = 0; offset < cellsTall; offset++) {
    // A closed door is collidable but is not an obstacle to a mob that can open
    // it. Without this, a villager standing inside its own house considers every
    // exit a wall and paths nowhere — the single most visible navigation bug.
    if (collidable(world, x, y + offset, z, worldHeight) && !passableDoor(world, x, y + offset, z, options)) {
      return false;
    }
  }

  const belowBlock = blockAt(world, x, y - 1, z);
  const supported = collidable(world, x, y - 1, z, worldHeight);
  const swimming = options.canSwim && (blockAt(world, x, y, z) === Block.WATER || belowBlock === Block.WATER);
  // A ladder supports an entity at any height on it, which is what makes
  // vertical routes through a mineshaft possible at all.
  const onLadder = climbable(world, x, y, z, options);
  if (!supported && !swimming && !onLadder) return false;
  if (options.avoidHazards !== false && isNavigationHazard(world, x, y, z)) return false;
  return true;
}

/** Finds the best standable Y near a requested coordinate. */
export function resolveWalkableY(world, x, preferredY, z, options = DEFAULT_OPTIONS) {
  const maxUp = Math.max(0, finiteInteger(options.maxStepUp, 1));
  const maxDown = Math.max(0, finiteInteger(options.maxDrop, 3));
  for (let delta = maxUp; delta >= -maxDown; delta--) {
    const y = preferredY + delta;
    if (isWalkableNode(world, x, y, z, options)) return y;
  }
  return null;
}

function heuristic(x, y, z, goal) {
  const dx = Math.abs(goal.x - x);
  const dz = Math.abs(goal.z - z);
  const straight = Math.max(dx, dz);
  const diagonal = Math.min(dx, dz);
  return straight + (SQRT2 - 1) * diagonal + Math.abs(goal.y - y) * 1.25;
}

function reconstruct(nodes, endKey) {
  const reversed = [];
  let cursor = endKey;
  while (cursor) {
    const node = nodes.get(cursor);
    if (!node) break;
    reversed.push(Object.freeze({ x: node.x + 0.5, y: node.y, z: node.z + 0.5 }));
    cursor = node.parent;
  }
  reversed.reverse();
  // The first point is the cell the mob already occupies.
  if (reversed.length > 1) reversed.shift();
  return Object.freeze(reversed);
}

/**
 * Finds a bounded local route. Returns an empty path when already at the goal,
 * and `null` when no route fits inside the budget.
 */
export function findVoxelPath(world, start, goal, suppliedOptions = {}) {
  if (!world || !start || !goal) return null;
  const options = { ...DEFAULT_OPTIONS, ...suppliedOptions };
  const startX = finiteInteger(start.x);
  const startZ = finiteInteger(start.z);
  const goalX = finiteInteger(goal.x);
  const goalZ = finiteInteger(goal.z);
  const startY = resolveWalkableY(world, startX, finiteInteger(start.y), startZ, options);
  const goalY = resolveWalkableY(world, goalX, finiteInteger(goal.y), goalZ, options);
  if (startY === null || goalY === null) return null;

  const dx = goalX - startX;
  const dz = goalZ - startZ;
  const maxDistance = Math.max(4, Number(options.maxDistance) || DEFAULT_OPTIONS.maxDistance);
  if (dx * dx + dz * dz > maxDistance * maxDistance) return null;

  const radius = Math.max(0, Number(options.goalRadius) || 0);
  if (Math.hypot(dx, dz) <= radius && Math.abs(goalY - startY) <= 1) return Object.freeze([]);

  const startKey = key(startX, startY, startZ);
  const goalNode = { x: goalX, y: goalY, z: goalZ };
  const open = new MinHeap();
  const nodes = new Map();
  const bestCost = new Map();
  const initial = {
    x: startX,
    y: startY,
    z: startZ,
    g: 0,
    f: heuristic(startX, startY, startZ, goalNode),
    parent: null,
    key: startKey,
  };
  open.push(initial);
  nodes.set(startKey, initial);
  bestCost.set(startKey, 0);

  const maxNodes = Math.max(16, finiteInteger(options.maxNodes, DEFAULT_OPTIONS.maxNodes));
  let visited = 0;
  let best = initial;
  let bestHeuristic = initial.f;

  while (open.size > 0 && visited < maxNodes) {
    const current = open.pop();
    if (!current) break;
    if (current.g !== bestCost.get(current.key)) continue;
    visited++;

    const h = heuristic(current.x, current.y, current.z, goalNode);
    if (h < bestHeuristic) {
      best = current;
      bestHeuristic = h;
    }
    if (
      Math.hypot(goalX - current.x, goalZ - current.z) <= radius &&
      Math.abs(goalY - current.y) <= 1
    ) {
      return reconstruct(nodes, current.key);
    }
    if (current.x === goalX && current.z === goalZ && current.y === goalY) {
      return reconstruct(nodes, current.key);
    }

    const moves = options.allowDiagonal === false ? CARDINAL : CARDINAL_THEN_DIAGONAL;
    for (const [stepX, stepZ] of moves) {
      const x = current.x + stepX;
      const z = current.z + stepZ;
      if ((x - startX) ** 2 + (z - startZ) ** 2 > maxDistance * maxDistance) continue;

      const isDiagonal = stepX !== 0 && stepZ !== 0;
      // Corner guard: a diagonal is only legal when both cardinals that make it
      // up are themselves walkable. Otherwise a mob squeezes through the seam
      // between two blocks placed corner-to-corner, which looks like clipping.
      if (isDiagonal) {
        const sideA = resolveWalkableY(world, current.x + stepX, current.y, current.z, options);
        const sideB = resolveWalkableY(world, current.x, current.y, current.z + stepZ, options);
        if (sideA === null || sideB === null) continue;
        if (Math.abs(sideA - current.y) > 0 || Math.abs(sideB - current.y) > 0) continue;
      }

      const y = resolveWalkableY(world, x, current.y, z, options);
      if (y === null) continue;
      const vertical = y - current.y;
      if (vertical > options.maxStepUp || vertical < -options.maxDrop) continue;
      // Diagonals may not also change height: a diagonal jump-up reads as a
      // teleport through the block corner.
      if (isDiagonal && vertical !== 0) continue;

      const base = isDiagonal ? SQRT2 : 1;
      const movementCost = base + Math.max(0, vertical) * 0.55 + Math.max(0, -vertical) * 0.12;
      const g = current.g + movementCost;
      const nodeKey = key(x, y, z);
      if (g >= (bestCost.get(nodeKey) ?? Infinity)) continue;
      const node = {
        x,
        y,
        z,
        g,
        f: g + heuristic(x, y, z, goalNode),
        parent: current.key,
        key: nodeKey,
      };
      bestCost.set(nodeKey, g);
      nodes.set(nodeKey, node);
      open.push(node);
    }
  }

  // A partial path is useful only when it made meaningful progress. It lets a
  // mob advance around the near side of a large obstruction and replan there.
  if (best !== initial && bestHeuristic + 1 < initial.f) return reconstruct(nodes, best.key);
  return null;
}

/** Picks the first waypoint that is not already reached. */
export function nextPathDirection(position, path, startIndex = 0, reach = 0.28) {
  if (!Array.isArray(path) || path.length === 0) {
    return { index: 0, x: 0, z: 0, reachedEnd: true };
  }
  let index = Math.max(0, Math.floor(startIndex));
  while (index < path.length) {
    const point = path[index];
    const dx = point.x - position.x;
    const dz = point.z - position.z;
    const distance = Math.hypot(dx, dz);
    if (distance > reach) {
      return {
        index,
        x: dx / distance,
        z: dz / distance,
        reachedEnd: false,
        waypoint: point,
      };
    }
    index++;
  }
  return { index, x: 0, z: 0, reachedEnd: true };
}

export default findVoxelPath;
