/**
 * Small numeric helpers. Worker-safe (no DOM, no Three.js).
 */

/** Clamps `value` into the inclusive range `[min, max]`. */
export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/** Clamps `value` into `[0, 1]`. */
export function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Linear interpolation. */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Frame-rate independent exponential approach.
 * `smoothing` is the fraction of the remaining distance left after one second.
 */
export function damp(current, target, smoothing, dt) {
  return lerp(target, current, Math.pow(smoothing, dt));
}

/** Maps `value` from `[inMin, inMax]` to `[outMin, outMax]` without clamping. */
export function mapRange(value, inMin, inMax, outMin, outMax) {
  if (inMax === inMin) return outMin;
  return outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin);
}

/** Clamped inverse lerp. */
export function inverseLerp(a, b, value) {
  if (a === b) return 0;
  return clamp01((value - a) / (b - a));
}

/** Hermite smoothstep between two edges. */
export function smoothstep(edge0, edge1, x) {
  const t = inverseLerp(edge0, edge1, x);
  return t * t * (3 - 2 * t);
}

/** Quintic smootherstep, used for noise interpolation. */
export function smootherstep(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Shortest signed angular difference in radians. */
export function angleDelta(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Wraps a value into `[0, range)` for positive and negative inputs. */
export function wrap(value, range) {
  const r = value % range;
  return r < 0 ? r + range : r;
}

/**
 * Applies a radial dead zone to a 2D stick input and rescales the remainder so
 * the usable range stays continuous from 0 to 1.
 *
 * @param {number} x Raw axis value in `[-1, 1]`.
 * @param {number} y Raw axis value in `[-1, 1]`.
 * @param {number} deadZone Dead zone radius in `[0, 1)`.
 * @param {{x:number,y:number}} out Target object, mutated and returned.
 */
export function applyDeadZone(x, y, deadZone, out) {
  const magnitude = Math.hypot(x, y);
  if (magnitude <= deadZone || magnitude === 0) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  const scaled = Math.min(1, (magnitude - deadZone) / (1 - deadZone)) / magnitude;
  out.x = x * scaled;
  out.y = y * scaled;
  return out;
}

/**
 * Mulberry32: a small, fast, well-distributed 32-bit PRNG.
 * Deterministic for a given seed, which is what world generation needs.
 *
 * @param {number} seed Any 32-bit integer.
 * @returns {() => number} Function returning floats in `[0, 1)`.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer hash of one value; returns a 32-bit unsigned integer. */
export function hash1(x) {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Order-dependent integer hash of two coordinates plus a seed. */
export function hash2(x, y, seed = 0) {
  return hash1((Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ seed) >>> 0);
}

/** Order-dependent integer hash of three coordinates plus a seed. */
export function hash3(x, y, z, seed = 0) {
  return hash1(
    (Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x9e3779b1) ^ seed) >>> 0
  );
}

/** Deterministic float in `[0, 1)` derived from two integers and a seed. */
export function randomFromCoords2(x, y, seed = 0) {
  return hash2(x, y, seed) / 4294967296;
}

/** Deterministic float in `[0, 1)` derived from three integers and a seed. */
export function randomFromCoords3(x, y, z, seed = 0) {
  return hash3(x, y, z, seed) / 4294967296;
}

/**
 * Converts an arbitrary user-supplied string into a stable 32-bit seed.
 * Numeric strings are used directly so "12345" behaves as the number 12345.
 *
 * @param {string|number|null|undefined} input
 * @returns {number} A 32-bit unsigned integer seed.
 */
export function parseSeed(input) {
  if (input === null || input === undefined || input === '') {
    return (Math.random() * 0xffffffff) >>> 0;
  }
  if (typeof input === 'number' && Number.isFinite(input)) {
    return Math.abs(Math.trunc(input)) >>> 0;
  }
  const text = String(input).trim();
  if (/^-?\d+$/.test(text)) {
    const parsed = Number(text);
    if (Number.isSafeInteger(parsed)) return Math.abs(parsed) >>> 0;
  }
  // FNV-1a over the UTF-16 code units.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Rounds to a fixed number of decimals, returning a number (not a string). */
export function roundTo(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Formats a byte count for the debug overlay. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)}${units[unit]}`;
}

/**
 * Returns the compass direction name for a camera yaw in radians.
 *
 * The camera convention is `forward = (-sin(yaw), 0, -cos(yaw))`, so yaw 0
 * looks towards -Z (north) and increasing yaw turns towards -X (west).
 */
export function yawToFacing(yaw) {
  const normalized = wrap(yaw, Math.PI * 2);
  const octant = Math.round(normalized / (Math.PI / 4)) % 8;
  return ['north', 'north-west', 'west', 'south-west', 'south', 'south-east', 'east', 'north-east'][
    octant
  ];
}
