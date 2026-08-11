/**
 * Template / connector structure assembly ("jigsaw").
 *
 * ## Why this exists
 *
 * Villages, desert temples, mineshafts, Nether fortresses and strongholds are
 * all the same problem: place a starting piece, then repeatedly attach further
 * pieces at declared connection points without overlapping anything already
 * placed. Writing that once means every later structure is data.
 *
 * This is the single most reused system in the remaining roadmap — Phase 2
 * villages, Phase 4 fortresses and Phase 5 strongholds all consume it — which is
 * why it is built before any of them.
 *
 * ## Determinism
 *
 * Assembly takes an injected `random` function and never touches `Math.random`.
 * The same seed and pools must always produce the same village, or a world stops
 * being reproducible and structures shift under saved chunks.
 *
 * World-free and renderer-free: assembly returns placements, and the caller
 * writes them into chunks.
 */

/** Facing directions, in clockwise order about +Y. */
export const Facing = Object.freeze({
  POSITIVE_X: 0,
  POSITIVE_Z: 1,
  NEGATIVE_X: 2,
  NEGATIVE_Z: 3,
});

/** Unit offset per facing. */
export const FACING_OFFSETS = Object.freeze([
  Object.freeze([1, 0, 0]),
  Object.freeze([0, 0, 1]),
  Object.freeze([-1, 0, 0]),
  Object.freeze([0, 0, -1]),
]);

/** The facing a connector must meet to join: the opposite one. */
export function oppositeFacing(facing) {
  return (facing + 2) % 4;
}

/** Normalises any integer into 0..3. */
export function normalizeFacing(facing) {
  return ((facing % 4) + 4) % 4;
}

/**
 * Validates a piece definition.
 * @param {Object} piece
 * @returns {string[]} Problems; empty means valid.
 */
export function validatePiece(piece) {
  const problems = [];
  if (!piece || typeof piece !== 'object') return ['piece is not an object'];
  const label = piece.name ?? '?';
  if (typeof piece.name !== 'string' || !piece.name) problems.push('piece is missing a name');

  const size = piece.size;
  if (!Array.isArray(size) || size.length !== 3 || size.some((v) => !Number.isInteger(v) || v <= 0)) {
    problems.push(`${label}: size must be three positive integers`);
    return problems;
  }

  for (const block of piece.blocks ?? []) {
    const inside =
      Number.isInteger(block.x) && block.x >= 0 && block.x < size[0] &&
      Number.isInteger(block.y) && block.y >= 0 && block.y < size[1] &&
      Number.isInteger(block.z) && block.z >= 0 && block.z < size[2];
    if (!inside) problems.push(`${label}: block at ${block.x},${block.y},${block.z} is outside the piece bounds`);
    if (!Number.isInteger(block.block)) problems.push(`${label}: block at ${block.x},${block.y},${block.z} has a non-integer block id`);
  }

  const names = new Set();
  for (const connector of piece.connectors ?? []) {
    if (typeof connector.name !== 'string' || !connector.name) {
      problems.push(`${label}: connector is missing a name`);
      continue;
    }
    if (names.has(connector.name)) problems.push(`${label}: duplicate connector "${connector.name}"`);
    names.add(connector.name);
    if (!Number.isInteger(connector.facing) || connector.facing < 0 || connector.facing > 3) {
      problems.push(`${label}: connector "${connector.name}" has an invalid facing`);
    }
    const at = connector.at;
    if (!Array.isArray(at) || at.length !== 3 || at.some((v) => !Number.isInteger(v))) {
      problems.push(`${label}: connector "${connector.name}" needs an integer position`);
    }
    if (typeof connector.target !== 'string' || !connector.target) {
      problems.push(`${label}: connector "${connector.name}" needs a target pool`);
    }
  }
  return problems;
}

/**
 * Rotates a coordinate inside a piece by quarter turns about +Y.
 *
 * @param {number[]} point `[x, y, z]`
 * @param {number[]} size `[x, y, z]` of the *unrotated* piece.
 * @param {number} turns 0..3
 * @returns {number[]}
 */
export function rotatePoint(point, size, turns) {
  const t = normalizeFacing(turns);
  let [x, y, z] = point;
  let [sx, , sz] = size;
  for (let i = 0; i < t; i++) {
    const nx = sz - 1 - z;
    const nz = x;
    x = nx;
    z = nz;
    const swap = sx;
    sx = sz;
    sz = swap;
  }
  return [x, y, z];
}

/** Size after rotation. */
export function rotateSize(size, turns) {
  return normalizeFacing(turns) % 2 === 0 ? [size[0], size[1], size[2]] : [size[2], size[1], size[0]];
}

/**
 * Rotates a whole piece.
 * @param {Object} piece
 * @param {number} turns
 * @returns {Object}
 */
export function rotatePiece(piece, turns) {
  const t = normalizeFacing(turns);
  if (t === 0) return piece;
  return {
    ...piece,
    size: rotateSize(piece.size, t),
    blocks: (piece.blocks ?? []).map((block) => {
      const [x, y, z] = rotatePoint([block.x, block.y, block.z], piece.size, t);
      return { ...block, x, y, z };
    }),
    connectors: (piece.connectors ?? []).map((connector) => {
      const [x, y, z] = rotatePoint(connector.at, piece.size, t);
      return { ...connector, at: [x, y, z], facing: normalizeFacing(connector.facing + t) };
    }),
  };
}

/** Axis-aligned bounds of a placement. */
export function placementBounds(origin, size) {
  return {
    minX: origin[0],
    minY: origin[1],
    minZ: origin[2],
    maxX: origin[0] + size[0] - 1,
    maxY: origin[1] + size[1] - 1,
    maxZ: origin[2] + size[2] - 1,
  };
}

/** True when two bounds share any voxel. */
export function boundsOverlap(a, b) {
  return (
    a.minX <= b.maxX && a.maxX >= b.minX &&
    a.minY <= b.maxY && a.maxY >= b.minY &&
    a.minZ <= b.maxZ && a.maxZ >= b.minZ
  );
}

/** True when `inner` fits entirely inside `outer`. */
export function boundsContain(outer, inner) {
  return (
    inner.minX >= outer.minX && inner.maxX <= outer.maxX &&
    inner.minY >= outer.minY && inner.maxY <= outer.maxY &&
    inner.minZ >= outer.minZ && inner.maxZ <= outer.maxZ
  );
}

/**
 * A weighted set of interchangeable pieces.
 */
export class StructurePool {
  /**
   * @param {string} name
   * @param {Array<{piece:Object, weight?:number}>} entries
   */
  constructor(name, entries) {
    this.name = name;
    this.entries = entries.map((entry) => ({ piece: entry.piece, weight: entry.weight ?? 1 }));
    this.totalWeight = this.entries.reduce((sum, entry) => sum + entry.weight, 0);
  }

  /**
   * Weighted pick.
   * @param {() => number} random
   */
  pick(random) {
    if (this.entries.length === 0) return null;
    let roll = random() * this.totalWeight;
    for (const entry of this.entries) {
      roll -= entry.weight;
      if (roll <= 0) return entry.piece;
    }
    return this.entries[this.entries.length - 1].piece;
  }

  /** Every piece, for exhaustive fallback when a random pick will not fit. */
  all() {
    return this.entries.map((entry) => entry.piece);
  }
}

/**
 * Assembles a structure from connected pieces.
 *
 * Breadth-first from the start piece so growth is even rather than one long
 * tendril, and so `maxPieces` yields a plausible settlement instead of a
 * corridor.
 *
 * @param {Object} options
 * @param {Object} options.start Starting piece.
 * @param {number[]} options.origin World position of the start piece.
 * @param {Map<string, StructurePool>} options.pools Keyed by pool name.
 * @param {() => number} options.random
 * @param {number} [options.maxPieces]
 * @param {Object} [options.bounds] Optional world bounds every piece must fit.
 * @param {number} [options.maxAttemptsPerConnector]
 * @returns {{placements:Array, openConnectors:Array, rejected:number}}
 */
export function assembleStructure({
  start,
  origin = [0, 0, 0],
  pools,
  random,
  maxPieces = 24,
  bounds = null,
  maxAttemptsPerConnector = 8,
}) {
  if (typeof random !== 'function') throw new Error('assembleStructure needs a random function');
  if (!start) throw new Error('assembleStructure needs a start piece');

  const placements = [];
  const queue = [];
  let rejected = 0;

  const startBounds = placementBounds(origin, start.size);
  if (bounds && !boundsContain(bounds, startBounds)) {
    return { placements: [], openConnectors: [], rejected: 1 };
  }

  const startPlacement = { piece: start, origin: [...origin], turns: 0, bounds: startBounds };
  placements.push(startPlacement);
  for (const connector of start.connectors ?? []) {
    queue.push({ placement: startPlacement, connector });
  }

  const openConnectors = [];

  while (queue.length > 0 && placements.length < maxPieces) {
    const { placement, connector } = queue.shift();
    const pool = pools.get(connector.target);
    if (!pool) {
      openConnectors.push({ placement, connector });
      continue;
    }

    // World position of the connector, and the cell just outside it where the
    // neighbouring piece's matching connector must land.
    const worldAt = [
      placement.origin[0] + connector.at[0],
      placement.origin[1] + connector.at[1],
      placement.origin[2] + connector.at[2],
    ];
    const offset = FACING_OFFSETS[connector.facing];
    const meetAt = [worldAt[0] + offset[0], worldAt[1] + offset[1], worldAt[2] + offset[2]];
    const required = oppositeFacing(connector.facing);

    let attached = false;
    const candidates = [];
    for (let attempt = 0; attempt < maxAttemptsPerConnector; attempt++) {
      const picked = pool.pick(random);
      if (picked) candidates.push(picked);
    }
    // Deterministic exhaustive fallback: if the random draws all failed to fit,
    // still try everything once before declaring the connector dead. Without
    // this a village silently loses buildings purely because of draw order.
    candidates.push(...pool.all());

    for (const candidate of candidates) {
      for (let turns = 0; turns < 4 && !attached; turns++) {
        const rotated = rotatePiece(candidate, turns);
        const match = (rotated.connectors ?? []).find((entry) => entry.facing === required);
        if (!match) continue;

        const candidateOrigin = [
          meetAt[0] - match.at[0],
          meetAt[1] - match.at[1],
          meetAt[2] - match.at[2],
        ];
        const candidateBounds = placementBounds(candidateOrigin, rotated.size);
        if (bounds && !boundsContain(bounds, candidateBounds)) continue;
        if (placements.some((existing) => boundsOverlap(existing.bounds, candidateBounds))) continue;

        const next = {
          piece: rotated,
          source: candidate.name,
          origin: candidateOrigin,
          turns,
          bounds: candidateBounds,
        };
        placements.push(next);
        attached = true;

        for (const child of rotated.connectors ?? []) {
          if (child === match) continue;
          queue.push({ placement: next, connector: child });
        }
      }
      if (attached) break;
    }

    if (!attached) {
      rejected++;
      openConnectors.push({ placement, connector });
    }
  }

  // Anything still queued when the piece budget ran out is an open edge.
  for (const pending of queue) openConnectors.push(pending);

  return { placements, openConnectors, rejected };
}

/**
 * Flattens placements into absolute block writes.
 *
 * Later placements win on conflict, which matches the assembly order and keeps
 * the result independent of how the caller iterates.
 *
 * @param {Array} placements
 * @returns {Array<{x:number, y:number, z:number, block:number}>}
 */
export function flattenPlacements(placements) {
  const cells = new Map();
  for (const placement of placements) {
    for (const block of placement.piece.blocks ?? []) {
      const x = placement.origin[0] + block.x;
      const y = placement.origin[1] + block.y;
      const z = placement.origin[2] + block.z;
      cells.set(`${x},${y},${z}`, { x, y, z, block: block.block });
    }
  }
  return [...cells.values()];
}

export default assembleStructure;
