// Throwaway harness: proves every atlas tile has a painter AND that every
// painter actually runs without throwing and writes pixels. Deleted before the
// project is packaged.

import { TILE_NAMES } from './src/world/BlockTypes.js';
import { NETHER_TILE_NAMES } from './src/world/NetherBlocks.js';
import { TILE_PAINTERS } from './src/rendering/__atlasprobe.js';

/** A faithful stand-in for the real TilePainter, recording what gets written. */
function makePainter(seed) {
  let s = seed >>> 0;
  const next = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const px = new Uint8Array(16 * 16 * 4);
  const byte = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const api = {
    writes: 0,
    oob: 0,
    next,
    int: (max) => Math.floor(next() * max),
    set(x, y, r, g, b, a = 255) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`non-finite coord ${x},${y}`);
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
        throw new Error(`non-finite colour ${r},${g},${b}`);
      }
      if (x < 0 || x > 15 || y < 0 || y > 15) { api.oob++; return api; }
      const i = ((y * 16) + x) * 4;
      px[i] = byte(r); px[i + 1] = byte(g); px[i + 2] = byte(b); px[i + 3] = byte(a);
      api.writes++;
      return api;
    },
    get(x, y) {
      if (x < 0 || x > 15 || y < 0 || y > 15) return [0, 0, 0, 0];
      const i = ((y * 16) + x) * 4;
      return [px[i], px[i + 1], px[i + 2], px[i + 3]];
    },
    fill(r, g, b, a = 255) {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) api.set(x, y, r, g, b, a);
      return api;
    },
    clear() { px.fill(0); return api; },
    grain(amount, chance = 1) {
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          if (next() > chance) continue;
          const d = ((next() * 2) - 1) * amount;
          const c = api.get(x, y);
          api.set(x, y, c[0] + d, c[1] + d, c[2] + d, c[3]);
        }
      }
      return api;
    },
    blobs(count, radius, colour, variance = 12) {
      for (let i = 0; i < count; i++) {
        const cx = next() * 16;
        const cy = next() * 16;
        for (let y = 0; y < 16; y++) {
          for (let x = 0; x < 16; x++) {
            if ((((x - cx) ** 2) + ((y - cy) ** 2)) > (radius * radius)) continue;
            const d = ((next() * 2) - 1) * variance;
            api.set(x, y, colour[0] + d, colour[1] + d, colour[2] + d);
          }
        }
      }
      return api;
    },
    hLine(y, fromX, toX, colour, alpha = 255) {
      for (let x = Math.min(fromX, toX); x <= Math.max(fromX, toX); x++) {
        api.set(x, y, colour[0], colour[1], colour[2], alpha);
      }
      return api;
    },
    vLine(x, fromY, toY, colour, alpha = 255) {
      for (let y = Math.min(fromY, toY); y <= Math.max(fromY, toY); y++) {
        api.set(x, y, colour[0], colour[1], colour[2], alpha);
      }
      return api;
    },
    range(min, max) { return min + (next() * (max - min)); },
    rect(x, y, width, height, colour, alpha = 255) {
      for (let dy = 0; dy < height; dy++) {
        for (let dx = 0; dx < width; dx++) {
          api.set(x + dx, y + dy, colour[0], colour[1], colour[2], alpha);
        }
      }
      return api;
    },
    shade(x, y, width, height, factor) {
      for (let dy = 0; dy < height; dy++) {
        for (let dx = 0; dx < width; dx++) {
          const [r, g, b, a] = api.get(x + dx, y + dy);
          if (a === 0) continue;
          api.set(x + dx, y + dy, r * factor, g * factor, b * factor, a);
        }
      }
      return api;
    },
  };
  return api;
}

const missing = [];
const failed = [];
const blank = [];

for (const name of TILE_NAMES) {
  const painter = TILE_PAINTERS[name];
  if (typeof painter !== 'function') { missing.push(name); continue; }
  const p = makePainter(0x9e3779b9 ^ (name.length * 2654435761));
  try {
    painter(p);
  } catch (error) {
    failed.push(`${name}: ${error.message}`);
    continue;
  }
  if (p.writes === 0) blank.push(name);
}

const netherMissing = NETHER_TILE_NAMES.filter((n) => typeof TILE_PAINTERS[n] !== 'function');

console.log(`tiles declared      : ${TILE_NAMES.length}`);
console.log(`painters registered : ${TILE_NAMES.filter((n) => typeof TILE_PAINTERS[n] === 'function').length}`);
console.log(`nether tiles        : ${NETHER_TILE_NAMES.length}, without a painter: ${netherMissing.length}`);
console.log(`missing painters    : ${missing.length}`);
for (const n of missing.slice(0, 25)) console.log(`   MISSING ${n}`);
console.log(`painters that threw : ${failed.length}`);
for (const f of failed.slice(0, 25)) console.log(`   THREW   ${f}`);
console.log(`painters drawing nothing: ${blank.length}`);
for (const b of blank.slice(0, 25)) console.log(`   BLANK   ${b}`);

const ok = missing.length === 0 && failed.length === 0 && blank.length === 0;
console.log(ok ? 'ATLAS PAINTER COVERAGE: COMPLETE' : 'ATLAS PAINTER COVERAGE: INCOMPLETE');
process.exit(ok ? 0 : 1);
