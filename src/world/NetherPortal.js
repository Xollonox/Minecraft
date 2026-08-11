/**
 * Nether portals: frame detection, lighting, linking and destination search.
 *
 * Everything here is pure world-mutation logic. It takes a `world`-shaped
 * object (`getBlock`, `setBlock`, and optionally `isLoaded`) rather than the
 * real `World`, so the self-test can drive a portal through an in-memory grid
 * without a renderer, a worker pool or a save file.
 *
 * Deliberate design notes:
 *
 * - Corners are not required. Minecraft accepts a frame with the four corner
 *   blocks missing and players build them that way constantly, so requiring
 *   them would reject portals that look correct.
 * - Both axes are tried on ignition. The player decides the orientation by how
 *   they build; the code should not care which one they picked.
 * - The 8:1 link is computed from `coordinateScale` in `DimensionConfig`, not
 *   hard-coded here, so the ratio has exactly one definition.
 */

import { WORLD_HEIGHT } from '../config/GameConfig.js';
import { Block } from './BlockTypes.js';
import { Dimension, convertCoordinates, getDimension } from './DimensionConfig.js';

/** Narrowest interior a portal may have, in blocks. */
export const PORTAL_MIN_WIDTH = 2;
/** Widest interior a portal may have. Stops a runaway scan across a cavern. */
export const PORTAL_MAX_WIDTH = 21;
/** Shortest interior a portal may have. */
export const PORTAL_MIN_HEIGHT = 3;
/** Tallest interior a portal may have. */
export const PORTAL_MAX_HEIGHT = 21;

/** Portal axis constants. A portal plane runs along one horizontal axis. */
export const PortalAxis = Object.freeze({ X: 'x', Z: 'z' });

/** Game ticks a player must stand in a portal before travelling (20 Hz). */
export const PORTAL_DWELL_TICKS = 40;
/** Ticks after arriving before the destination portal can fire again. */
export const PORTAL_COOLDOWN_TICKS = 60;
/** How far to look for an existing portal at the destination, in blocks. */
export const PORTAL_SEARCH_RADIUS = 48;

/** Interior width of a portal this code builds for the player. */
const BUILT_WIDTH = 2;
/** Interior height of a portal this code builds for the player. */
const BUILT_HEIGHT = 3;

/**
 * State encoding for the portal block: bit 0 holds the axis.
 * @param {string} axis
 */
export function portalState(axis) {
  return axis === PortalAxis.Z ? 1 : 0;
}

/**
 * Reads the axis back out of a portal block's state.
 * @param {number} state
 */
export function portalAxis(state) {
  return (state & 1) === 1 ? PortalAxis.Z : PortalAxis.X;
}

/** True for a block a portal plane may occupy. */
function isEmpty(world, x, y, z) {
  if (y < 0 || y >= WORLD_HEIGHT) return false;
  const id = world.getBlock(x, y, z);
  return id === Block.AIR || id === Block.FIRE || id === Block.NETHER_PORTAL;
}

/** True for a block that can form the frame. */
function isFrame(world, x, y, z) {
  if (y < 0 || y >= WORLD_HEIGHT) return false;
  return world.getBlock(x, y, z) === Block.OBSIDIAN;
}

/** Axis unit vector. */
function axisStep(axis) {
  return axis === PortalAxis.Z ? { dx: 0, dz: 1 } : { dx: 1, dz: 0 };
}

/**
 * Finds a complete portal frame containing the given cell.
 *
 * @param {Object} world
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {string} axis One of `PortalAxis`.
 * @returns {{axis: string, originX: number, originY: number, originZ: number,
 *   width: number, height: number}|null} The interior, or null.
 */
export function detectFrame(world, x, y, z, axis) {
  if (!isEmpty(world, x, y, z)) return null;
  const { dx, dz } = axisStep(axis);

  // Drop to the bottom of the empty column first, so the frame is measured
  // from a stable anchor no matter where in the opening the player ignited.
  let baseY = y;
  while (baseY > 0 && isEmpty(world, x, baseY - 1, z)) {
    baseY--;
    if (y - baseY > PORTAL_MAX_HEIGHT) return null;
  }
  if (!isFrame(world, x, baseY - 1, z)) return null;

  // Walk out along the axis to both walls.
  let left = 0;
  while (left < PORTAL_MAX_WIDTH && isEmpty(world, x - dx * (left + 1), baseY, z - dz * (left + 1))) {
    left++;
  }
  let right = 0;
  while (right < PORTAL_MAX_WIDTH && isEmpty(world, x + dx * (right + 1), baseY, z + dz * (right + 1))) {
    right++;
  }

  const width = left + right + 1;
  if (width < PORTAL_MIN_WIDTH || width > PORTAL_MAX_WIDTH) return null;

  const originX = x - dx * left;
  const originZ = z - dz * left;

  // Both side walls must be solid obsidian at the base row.
  if (!isFrame(world, originX - dx, baseY, originZ - dz)) return null;
  if (!isFrame(world, originX + dx * width, baseY, originZ + dz * width)) return null;

  // Rise while every cell across the interior is empty and both walls hold.
  let height = 0;
  while (height < PORTAL_MAX_HEIGHT) {
    const rowY = baseY + height;
    let rowOpen = true;
    for (let i = 0; i < width; i++) {
      if (!isEmpty(world, originX + dx * i, rowY, originZ + dz * i)) {
        rowOpen = false;
        break;
      }
    }
    if (!rowOpen) break;
    if (!isFrame(world, originX - dx, rowY, originZ - dz)) return null;
    if (!isFrame(world, originX + dx * width, rowY, originZ + dz * width)) return null;
    height++;
  }

  if (height < PORTAL_MIN_HEIGHT || height > PORTAL_MAX_HEIGHT) return null;

  // Floor and lintel must be closed across the full interior.
  for (let i = 0; i < width; i++) {
    if (!isFrame(world, originX + dx * i, baseY - 1, originZ + dz * i)) return null;
    if (!isFrame(world, originX + dx * i, baseY + height, originZ + dz * i)) return null;
  }

  return { axis, originX, originY: baseY, originZ, width, height };
}

/**
 * Detects a frame on either axis.
 * @returns {Object|null}
 */
export function findFrame(world, x, y, z) {
  return detectFrame(world, x, y, z, PortalAxis.X) ?? detectFrame(world, x, y, z, PortalAxis.Z);
}

/**
 * Fills a detected frame with portal blocks.
 * @returns {number} Blocks placed.
 */
export function fillFrame(world, frame) {
  const { dx, dz } = axisStep(frame.axis);
  const state = portalState(frame.axis);
  let placed = 0;
  for (let i = 0; i < frame.width; i++) {
    for (let j = 0; j < frame.height; j++) {
      const bx = frame.originX + dx * i;
      const by = frame.originY + j;
      const bz = frame.originZ + dz * i;
      if (world.getBlock(bx, by, bz) === Block.NETHER_PORTAL) continue;
      if (world.setBlock(bx, by, bz, Block.NETHER_PORTAL, {
        cause: 'portal-light',
        state,
        cascade: false,
      })) {
        placed++;
      }
    }
  }
  return placed;
}

/**
 * Attempts to light a portal at the position a player just struck.
 *
 * @returns {Object|null} The lit frame, or null when this is not a portal.
 */
export function lightPortal(world, x, y, z) {
  const frame = findFrame(world, x, y, z);
  if (!frame) return null;
  return fillFrame(world, frame) > 0 ? frame : null;
}

/**
 * Removes a portal plane once its frame is broken.
 *
 * Flood fills through connected portal blocks rather than assuming a rectangle,
 * because the frame that defined the rectangle may already be gone.
 *
 * @returns {number} Blocks cleared.
 */
export function extinguishPortal(world, x, y, z) {
  if (world.getBlock(x, y, z) !== Block.NETHER_PORTAL) return 0;

  const limit = PORTAL_MAX_WIDTH * PORTAL_MAX_HEIGHT;
  const seen = new Set();
  const queue = [[x, y, z]];
  let cleared = 0;

  while (queue.length > 0 && cleared < limit) {
    const [cx, cy, cz] = queue.pop();
    const key = `${cx},${cy},${cz}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (world.getBlock(cx, cy, cz) !== Block.NETHER_PORTAL) continue;

    if (world.setBlock(cx, cy, cz, Block.AIR, { cause: 'portal-break', cascade: false })) {
      cleared++;
    }

    queue.push([cx + 1, cy, cz], [cx - 1, cy, cz]);
    queue.push([cx, cy + 1, cz], [cx, cy - 1, cz]);
    queue.push([cx, cy, cz + 1], [cx, cy, cz - 1]);
  }

  return cleared;
}

/** The dimension a portal in `fromId` leads to. */
export function linkedDimension(fromId) {
  return fromId === Dimension.NETHER ? Dimension.OVERWORLD : Dimension.NETHER;
}

/**
 * Where a portal at `position` comes out in the linked dimension.
 *
 * Overworld to Nether divides by eight, Nether to Overworld multiplies by
 * eight, which is what makes the Nether useful for travel. Height is preserved
 * and clamped into the destination's build range.
 */
export function linkedPosition(position, fromId, toId) {
  const converted = convertCoordinates(position, fromId, toId);
  const definition = getDimension(toId);
  const ceiling = definition.hasCeiling ? definition.height - 4 : definition.height - 2;
  const y = Math.max(4, Math.min(ceiling, Math.round(position.y)));
  return { x: converted.x, y, z: converted.z };
}

/**
 * Looks for an existing portal near a destination.
 *
 * Searches nearest-first in expanding shells so a player who returns through
 * the same portal arrives back at their own build rather than a fresh one.
 *
 * @returns {{x: number, y: number, z: number}|null}
 */
export function findExistingPortal(world, target, radius = PORTAL_SEARCH_RADIUS) {
  const maxY = Math.min(WORLD_HEIGHT - 2, target.y + 32);
  const minY = Math.max(1, target.y - 32);

  for (let r = 0; r <= radius; r += 2) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        // Only the shell, so results come out roughly nearest-first.
        if (r > 0 && Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
        const x = target.x + dx;
        const z = target.z + dz;
        if (world.isLoaded && !world.isLoaded(x, z)) continue;
        for (let y = maxY; y >= minY; y--) {
          if (world.getBlock(x, y, z) === Block.NETHER_PORTAL) return { x, y, z };
        }
      }
    }
  }
  return null;
}

/**
 * Finds a floor to stand a new portal on.
 *
 * Prefers the highest solid surface with headroom below the requested height,
 * which in the Nether means a cavern floor rather than the lava sea or the
 * bedrock roof.
 */
export function findPortalFloor(world, x, y, z, dimensionId = Dimension.OVERWORLD) {
  const definition = getDimension(dimensionId);
  const ceiling = definition.hasCeiling ? definition.height - 4 : definition.height - 2;
  const start = Math.max(4, Math.min(ceiling - BUILT_HEIGHT - 2, Math.round(y)));

  // Search outward in height from the ideal spot: down first, then up.
  for (let offset = 0; offset < 48; offset++) {
    for (const candidate of offset === 0 ? [start] : [start - offset, start + offset]) {
      if (candidate < 4 || candidate > ceiling - BUILT_HEIGHT - 2) continue;
      const below = world.getBlock(x, candidate - 1, z);
      if (below === Block.AIR || below === Block.LAVA || below === Block.WATER) continue;
      if (below === Block.NETHER_PORTAL) continue;

      let clear = true;
      for (let h = 0; h < BUILT_HEIGHT + 1; h++) {
        if (world.getBlock(x, candidate + h, z) !== Block.AIR) {
          clear = false;
          break;
        }
      }
      if (clear) return candidate;
    }
  }
  return null;
}

/**
 * Builds a portal at the destination when no existing one was found.
 *
 * Carves the pocket first. Arriving inside solid rock, which is the default
 * outcome in the Nether, is the single most common way a portal implementation
 * kills the player on arrival.
 *
 * @returns {{frame: Object, x: number, y: number, z: number}|null}
 */
export function buildPortal(world, target, dimensionId, axis = PortalAxis.X) {
  const { dx, dz } = axisStep(axis);
  const floorY = findPortalFloor(world, target.x, target.y, target.z, dimensionId)
    ?? Math.max(4, Math.round(target.y));

  // Clear a pocket one block bigger than the frame on every side.
  for (let i = -2; i <= BUILT_WIDTH + 1; i++) {
    for (let j = -1; j <= BUILT_HEIGHT + 1; j++) {
      for (let k = -1; k <= 1; k++) {
        const bx = target.x + dx * i + (dx === 0 ? k : 0);
        const by = floorY + j;
        const bz = target.z + dz * i + (dz === 0 ? k : 0);
        if (by < 1 || by >= WORLD_HEIGHT) continue;
        if (world.getBlock(bx, by, bz) === Block.BEDROCK) continue;
        world.setBlock(bx, by, bz, Block.AIR, { cause: 'portal-carve', cascade: false });
      }
    }
  }

  // Frame: floor, lintel and both walls.
  for (let i = -1; i <= BUILT_WIDTH; i++) {
    const bx = target.x + dx * i;
    const bz = target.z + dz * i;
    world.setBlock(bx, floorY - 1, bz, Block.OBSIDIAN, { cause: 'portal-build', cascade: false });
    world.setBlock(bx, floorY + BUILT_HEIGHT, bz, Block.OBSIDIAN, {
      cause: 'portal-build',
      cascade: false,
    });
  }
  for (let j = 0; j < BUILT_HEIGHT; j++) {
    world.setBlock(target.x - dx, floorY + j, target.z - dz, Block.OBSIDIAN, {
      cause: 'portal-build',
      cascade: false,
    });
    world.setBlock(target.x + dx * BUILT_WIDTH, floorY + j, target.z + dz * BUILT_WIDTH, Block.OBSIDIAN, {
      cause: 'portal-build',
      cascade: false,
    });
  }

  // A standing platform, so the player does not arrive over a void or lava.
  for (let i = -1; i <= BUILT_WIDTH; i++) {
    for (let k = -1; k <= 1; k++) {
      const bx = target.x + dx * i + (dx === 0 ? k : 0);
      const bz = target.z + dz * i + (dz === 0 ? k : 0);
      if (world.getBlock(bx, floorY - 1, bz) === Block.AIR) {
        world.setBlock(bx, floorY - 1, bz, Block.OBSIDIAN, {
          cause: 'portal-build',
          cascade: false,
        });
      }
    }
  }

  const frame = detectFrame(world, target.x, floorY, target.z, axis);
  if (!frame) return null;
  fillFrame(world, frame);
  return { frame, x: target.x, y: floorY, z: target.z };
}

/**
 * Resolves where a traveller should arrive, building a portal if needed.
 *
 * @returns {{x: number, y: number, z: number, created: boolean}|null}
 */
export function resolveDestination(world, position, fromId, toId) {
  const target = linkedPosition(position, fromId, toId);

  const existing = findExistingPortal(world, target);
  if (existing) {
    return { x: existing.x + 0.5, y: existing.y, z: existing.z + 0.5, created: false };
  }

  const built = buildPortal(world, target, toId);
  if (!built) return null;
  return { x: built.x + 0.5, y: built.y, z: built.z + 0.5, created: true };
}

/**
 * Per-entity portal timing.
 *
 * Travel needs a dwell time (so brushing a portal does not teleport you) and a
 * cooldown (so you do not bounce straight back on arrival). Keeping both in one
 * small object means the same rules apply to the player and, later, to mobs.
 */
export class PortalTracker {
  constructor({ dwellTicks = PORTAL_DWELL_TICKS, cooldownTicks = PORTAL_COOLDOWN_TICKS } = {}) {
    this.dwellTicks = dwellTicks;
    this.cooldownTicks = cooldownTicks;
    this.charge = 0;
    this.cooldown = 0;
  }

  /** Called on arrival so the destination portal does not fire immediately. */
  startCooldown() {
    this.cooldown = this.cooldownTicks;
    this.charge = 0;
  }

  /** Fraction of the dwell time elapsed, for the screen warp effect. */
  get progress() {
    return this.dwellTicks === 0 ? 1 : Math.min(1, this.charge / this.dwellTicks);
  }

  /**
   * Advances one game tick.
   * @param {boolean} inside Whether the entity is standing in a portal.
   * @returns {boolean} True on the single tick travel should happen.
   */
  tick(inside) {
    if (this.cooldown > 0) {
      // Standing in the portal holds the cooldown open, so a player who lingers
      // on arrival is not thrown back the moment it expires.
      this.cooldown--;
      if (inside) this.cooldown = Math.max(this.cooldown, 1);
      return false;
    }

    if (!inside) {
      this.charge = 0;
      return false;
    }

    this.charge++;
    if (this.charge >= this.dwellTicks) {
      this.charge = 0;
      return true;
    }
    return false;
  }
}

export default {
  PortalAxis,
  detectFrame,
  findFrame,
  fillFrame,
  lightPortal,
  extinguishPortal,
  linkedDimension,
  linkedPosition,
  findExistingPortal,
  findPortalFloor,
  buildPortal,
  resolveDestination,
  PortalTracker,
};
