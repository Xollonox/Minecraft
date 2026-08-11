/**
 * Water surface UV animation constants and their safety invariant.
 *
 * ## Why this is its own module
 *
 * The water shader animates its texture by adding a growing offset to the
 * interpolated UV. That is only safe while the offset stays inside the padding
 * that surrounds the tile in the atlas. The original implementation fed the
 * offset an *unbounded* `time * rate`, so after about two seconds the sample
 * left its own cell, and after about sixteen seconds it reached one of the
 * atlas cells that has no tile painted into it. Those cells carry the "missing
 * tile" magenta, and `ClampToEdgeWrapping` then pinned the sample there
 * permanently — the pink water bug.
 *
 * Keeping the numbers here, in a module that depends on nothing but
 * `AtlasLayout`, means the invariant can be asserted by the Node self-test
 * without a GPU, a canvas or Three.js. `Materials` is untestable that way
 * because it imports Three.
 *
 * ## The invariant
 *
 * A tile's padding is a wrapped copy of the tile, so shifting a sample by
 * exactly `TILE_UV_PERIOD` lands on visually identical texels. The scroll can
 * therefore be reduced modulo a period that is a whole number of tile periods
 * in *both* axes, which keeps the animation seamless while bounding the offset
 * for the lifetime of the process.
 *
 * With `u = 0.35 s` and `v = 0.21 s` the axis ratio is exactly `5 / 3`, so the
 * offset returns to a whole number of tile periods after five tile periods of
 * horizontal travel (equivalently three vertical). `assertWaterUvInvariant`
 * checks this rather than trusting the comment.
 */

import { TILE_PADDING_UV, TILE_UV_PERIOD, tileUvRect } from '../world/AtlasLayout.js';
import { TILE_INDEX } from '../world/BlockTypes.js';

/** UV units of horizontal scroll per unit of `uUvScroll`. Mirrors the shader. */
export const WATER_SCROLL_U = 0.35;
/** UV units of vertical scroll per unit of `uUvScroll`. Mirrors the shader. */
export const WATER_SCROLL_V = 0.21;
/** How fast `uUvScroll` advances, in units per second. */
export const WATER_SCROLL_RATE = 0.045;

/**
 * Number of tile periods of horizontal travel after which both axes are
 * simultaneously back on a tile boundary. Derived from `WATER_SCROLL_U /
 * WATER_SCROLL_V === 5 / 3`.
 */
const SCROLL_ALIGN_TILES_U = 5;

/**
 * The value `uUvScroll` wraps at.
 *
 * Wrapping here as well as in the shader is not redundant: the shader fold
 * guarantees correctness for any input, while this keeps the uniform small so
 * that float32 precision stays sharp through an arbitrarily long session
 * instead of degrading as `time` grows.
 */
export const WATER_SCROLL_PERIOD = (SCROLL_ALIGN_TILES_U * TILE_UV_PERIOD) / WATER_SCROLL_U;

/** Atlas tile index used by the water block. */
export const WATER_TILE_INDEX = TILE_INDEX.water;

if (WATER_TILE_INDEX === undefined) {
  throw new Error('AtlasLayout has no "water" tile; the water shader cannot be bounded');
}

/**
 * Reduces an elapsed time to the bounded scroll value handed to the shader.
 *
 * @param {number} elapsedSeconds
 * @returns {number} A value in `[0, WATER_SCROLL_PERIOD)`.
 */
export function waterScrollForTime(elapsedSeconds) {
  if (!Number.isFinite(elapsedSeconds)) return 0;
  const scroll = (elapsedSeconds * WATER_SCROLL_RATE) % WATER_SCROLL_PERIOD;
  return scroll < 0 ? scroll + WATER_SCROLL_PERIOD : scroll;
}

/**
 * The largest offset either axis can reach once the shader has folded it.
 *
 * @returns {number} UV units.
 */
export function maxFoldedOffset() {
  return TILE_UV_PERIOD * 0.5;
}

/**
 * Uniform payload describing where the water tile lives and how far a sample
 * may stray from it.
 *
 * @returns {{rect: [number, number, number, number], guard: [number, number]}}
 */
export function waterUvUniforms() {
  return {
    rect: tileUvRect(WATER_TILE_INDEX),
    guard: [TILE_UV_PERIOD, TILE_PADDING_UV],
  };
}

/**
 * Verifies that the animation can never sample outside the water tile's padded
 * cell, and that the wrap is seamless in both axes.
 *
 * Called at module load so a bad edit fails immediately and loudly rather than
 * turning the ocean pink minutes into a session. Also called directly by the
 * self-test.
 *
 * @param {number} [tolerance] Allowed float slack when checking alignment.
 * @returns {string[]} Problems found; empty when the invariant holds.
 */
export function assertWaterUvInvariant(tolerance = 1e-9) {
  const problems = [];

  // 1. The wrap must be seamless: a full scroll period must equal a whole
  //    number of tile periods on both axes, or the animation visibly jumps.
  for (const [axis, factor] of [
    ['u', WATER_SCROLL_U],
    ['v', WATER_SCROLL_V],
  ]) {
    const tiles = (WATER_SCROLL_PERIOD * factor) / TILE_UV_PERIOD;
    if (Math.abs(tiles - Math.round(tiles)) > tolerance) {
      problems.push(
        `scroll wrap is not seamless on ${axis}: ${tiles} tile periods, expected a whole number`
      );
    }
  }

  // 2. The folded offset must fit inside the padding, or a sample reaches a
  //    neighbouring cell — possibly an unpainted, magenta one.
  const folded = maxFoldedOffset();
  if (folded > TILE_PADDING_UV + tolerance) {
    problems.push(
      `folded offset ${folded} exceeds the ${TILE_PADDING_UV} padding budget`
    );
  }

  // 3. The clamp bounds must keep every sample inside the padded cell.
  const [u0, v0, u1, v1] = tileUvRect(WATER_TILE_INDEX);
  const bounds = [
    ['u0', u0 - TILE_PADDING_UV],
    ['v0', v0 - TILE_PADDING_UV],
    ['u1', u1 + TILE_PADDING_UV],
    ['v1', v1 + TILE_PADDING_UV],
  ];
  for (const [name, value] of bounds) {
    if (value < 0 || value > 1) {
      problems.push(`clamp bound ${name} leaves the atlas: ${value}`);
    }
  }

  return problems;
}

const startupProblems = assertWaterUvInvariant();
if (startupProblems.length > 0) {
  throw new Error(`Water UV animation is unsafe: ${startupProblems.join('; ')}`);
}

export default waterUvUniforms;
