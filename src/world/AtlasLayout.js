/**
 * Texture atlas geometry.
 *
 * This lives beside the world code rather than in `rendering/` because the
 * *mesher runs in a Web Worker* and must compute UVs without ever touching a
 * canvas. Keeping the layout in one pure module is what lets the worker and the
 * main-thread painter agree on where every tile is without passing a lookup
 * table across the boundary.
 *
 * Layout choices:
 *  - 16x16 pixel tiles: the pixel-art resolution the procedural textures target.
 *  - 8px of padding on every side, giving a 32px stride. Padding is filled by
 *    *wrapping* the tile (block textures tile seamlessly), so when a mip level
 *    or anisotropic tap reaches outside the tile it samples the same texture
 *    rather than the neighbouring one. This is what prevents the coloured seams
 *    that otherwise appear on distant blocks.
 *  - A 32x32 grid, so the atlas is 1024x1024: a power of two, which keeps mipmaps
 *    and WebGL1 fallbacks legal. The previous 16x16 grid was already close to its
 *    content ceiling once structural blocks, equipment and mobs were included.
 *    The expanded atlas leaves room for the Phase 1-3 content library while still
 *    costing only 4 MB as an uncompressed RGBA texture.
 *
 * Worker-safe.
 */

import { TILE_NAMES } from './BlockTypes.js';

/** Pixel size of the visible part of one tile. */
export const TILE_PIXELS = 16;
/** Padding pixels added on each side of a tile. */
export const TILE_PADDING = 8;
/** Distance between the top-left corners of adjacent tiles. */
export const TILE_STRIDE = TILE_PIXELS + TILE_PADDING * 2;
/** Tiles per atlas row. */
export const ATLAS_COLUMNS = 32;
/** Tiles per atlas column. */
export const ATLAS_ROWS = 32;
/** Atlas edge length in pixels. */
export const ATLAS_PIXELS = ATLAS_COLUMNS * TILE_STRIDE;

if (TILE_NAMES.length > ATLAS_COLUMNS * ATLAS_ROWS) {
  throw new Error(
    `Atlas holds ${ATLAS_COLUMNS * ATLAS_ROWS} tiles but ${TILE_NAMES.length} are declared`
  );
}

/**
 * Half-texel inset applied to every tile's UV rect.
 *
 * Sampling exactly on a texel boundary is undefined-ish across drivers: with
 * nearest filtering it can pick either neighbouring texel, producing a one-pixel
 * shimmer along block edges. Pulling the UVs in by a quarter of a texel makes
 * the choice unambiguous without visibly cropping the art.
 */
const INSET = 0.25 / ATLAS_PIXELS;

/**
 * Precomputed UV rects, flattened as `[u0, v0, u1, v1]` per tile.
 *
 * `v0` is the **top** edge of the tile in image space. The atlas texture is
 * created with `flipY = false`, so v increases downwards, matching canvas pixel
 * coordinates. The mesher maps a face's bottom edge to `v1` and its top edge to
 * `v0` so textures come out upright.
 *
 * @type {Float32Array}
 */
export const TILE_UVS = new Float32Array(ATLAS_COLUMNS * ATLAS_ROWS * 4);

for (let tile = 0; tile < ATLAS_COLUMNS * ATLAS_ROWS; tile++) {
  const column = tile % ATLAS_COLUMNS;
  const row = Math.floor(tile / ATLAS_COLUMNS);
  const x0 = column * TILE_STRIDE + TILE_PADDING;
  const y0 = row * TILE_STRIDE + TILE_PADDING;
  TILE_UVS[tile * 4] = x0 / ATLAS_PIXELS + INSET;
  TILE_UVS[tile * 4 + 1] = y0 / ATLAS_PIXELS + INSET;
  TILE_UVS[tile * 4 + 2] = (x0 + TILE_PIXELS) / ATLAS_PIXELS - INSET;
  TILE_UVS[tile * 4 + 3] = (y0 + TILE_PIXELS) / ATLAS_PIXELS - INSET;
}

/**
 * Visual period of a tile's content in UV space (`TILE_PIXELS / ATLAS_PIXELS`).
 *
 * Because every cell's padding is a *wrapped copy* of its own tile, shifting a
 * sample by exactly this much lands on visually identical texels. Any animated
 * UV offset must therefore be reduced modulo this value: that keeps the motion
 * seamless while bounding the offset, which is what stops a scrolling sample
 * from ever walking out of its own cell.
 */
export const TILE_UV_PERIOD = TILE_PIXELS / ATLAS_PIXELS;

/**
 * How far outside its content rect a sample may stray and still hit padding
 * belonging to the same tile (`TILE_PADDING / ATLAS_PIXELS`).
 *
 * This is the hard budget for animated UV offsets and for mip/anisotropic taps.
 * Exceeding it samples a neighbouring cell — and since the atlas has more cells
 * than declared tiles, "a neighbouring cell" can be an unpainted one.
 */
export const TILE_PADDING_UV = TILE_PADDING / ATLAS_PIXELS;

/**
 * UV rect of a tile as `[u0, v0, u1, v1]`, matching `TILE_UVS`.
 *
 * Handy for shaders that need to keep a computed sample inside one tile instead
 * of trusting an interpolated attribute.
 *
 * @param {number} tile
 * @returns {[number, number, number, number]}
 */
export function tileUvRect(tile) {
  const base = tile * 4;
  return [TILE_UVS[base], TILE_UVS[base + 1], TILE_UVS[base + 2], TILE_UVS[base + 3]];
}

/**
 * Pixel rect of a tile's content area, for the atlas painter.
 * @param {number} tile
 * @returns {{x: number, y: number, size: number}}
 */
export function tilePixelRect(tile) {
  const column = tile % ATLAS_COLUMNS;
  const row = Math.floor(tile / ATLAS_COLUMNS);
  return {
    x: column * TILE_STRIDE + TILE_PADDING,
    y: row * TILE_STRIDE + TILE_PADDING,
    size: TILE_PIXELS,
  };
}
