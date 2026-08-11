/**
 * Generates the raster PWA icons referenced by `public/manifest.webmanifest`.
 *
 * The project deliberately ships zero binary art in source control that we did
 * not create ourselves, so the PNGs are rasterised here from the same
 * isometric-cube design as `public/icons/icon.svg` using a tiny hand written
 * PNG encoder (Node's zlib is the only dependency).
 *
 * Run with: node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '../public/icons');

/** CRC32 table for PNG chunk checksums. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encodes RGBA pixel data as a PNG buffer. */
function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy
      ? rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
      : Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Signed area test used to rasterise the cube faces. */
function insidePolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i];
    const yi = poly[i + 1];
    const xj = poly[j];
    const yj = poly[j + 1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function renderIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const s = size / 512;
  const roundRadius = 72 * s;

  const faces = [
    { poly: [256, 96, 432, 192, 256, 288, 80, 192], color: [0x78, 0xcb, 0x55] },
    { poly: [80, 192, 256, 288, 256, 416, 80, 320], color: [0x7a, 0x5a, 0x3a] },
    { poly: [432, 192, 432, 320, 256, 416, 256, 288], color: [0x5d, 0x42, 0x29] },
  ].map((f) => ({ ...f, poly: f.poly.map((v) => v * s) }));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const cx = x + 0.5;
      const cy = y + 0.5;

      // rounded-rect mask
      const dx = Math.max(roundRadius - cx, cx - (size - roundRadius), 0);
      const dy = Math.max(roundRadius - cy, cy - (size - roundRadius), 0);
      if (dx * dx + dy * dy > roundRadius * roundRadius) {
        px[i + 3] = 0;
        continue;
      }

      let r = 0x12;
      let g = 0x16;
      let b = 0x1c;
      for (const face of faces) {
        if (insidePolygon(cx, cy, face.poly)) {
          [r, g, b] = face.color;
          break;
        }
      }
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  }
  return encodePNG(size, size, px);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [180, 512]) {
  const file = resolve(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, renderIcon(size));
  console.log('wrote', file);
}
