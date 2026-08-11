/**
 * Palette-compressed 16x16x16 chunk-section codec.
 *
 * Runtime chunks still expose dense arrays because terrain generation and
 * meshing are fastest that way. This codec supplies the scalable storage layer
 * used by saves, caches and the future section-streaming path: block ids and
 * state bytes are combined into one stable block-state word, deduplicated into
 * a local palette, then the palette indexes are bit packed.
 *
 * Worker-safe: no DOM and no Three.js.
 */

import { Block } from './BlockTypes.js';
import { blockIdFromWord, packBlockWord, stateFromWord } from './BlockState.js';

export const SECTION_SIZE = 16;
export const SECTION_AREA = SECTION_SIZE * SECTION_SIZE;
export const SECTION_VOLUME = SECTION_AREA * SECTION_SIZE;

/** @returns {number} Local section index, x-fastest then z then y. */
export function sectionIndex(x, y, z) {
  return (x & 15) + ((z & 15) << 4) + ((y & 15) << 8);
}

/** Smallest number of bits capable of addressing `paletteSize` entries. */
export function bitsForPaletteSize(paletteSize) {
  if (!Number.isInteger(paletteSize) || paletteSize < 1 || paletteSize > SECTION_VOLUME) {
    throw new RangeError(`Invalid section palette size: ${paletteSize}`);
  }
  return Math.max(1, Math.ceil(Math.log2(paletteSize)));
}

function valueMask(bits) {
  if (!Number.isInteger(bits) || bits < 1 || bits > 16) {
    throw new RangeError(`Invalid packed section bit width: ${bits}`);
  }
  return bits === 16 ? 0xffff : (1 << bits) - 1;
}

/**
 * Packs unsigned palette indices into 32-bit words. Values may straddle words.
 * @param {ArrayLike<number>} indices
 * @param {number} bits
 */
export function packPaletteIndices(indices, bits) {
  const mask = valueMask(bits);
  const words = new Uint32Array(Math.ceil((indices.length * bits) / 32));

  for (let i = 0; i < indices.length; i++) {
    const value = Number(indices[i]);
    if (!Number.isInteger(value) || value < 0 || value > mask) {
      throw new RangeError(`Palette index ${value} cannot fit in ${bits} bits`);
    }

    const bitIndex = i * bits;
    const wordIndex = bitIndex >>> 5;
    const offset = bitIndex & 31;
    words[wordIndex] = (words[wordIndex] | ((value << offset) >>> 0)) >>> 0;

    const spill = offset + bits - 32;
    if (spill > 0) {
      words[wordIndex + 1] = (words[wordIndex + 1] | (value >>> (bits - spill))) >>> 0;
    }
  }

  return words;
}

/** Reads one palette index from a packed word array. */
export function unpackPaletteIndex(words, bits, index) {
  const mask = valueMask(bits);
  if (!Number.isInteger(index) || index < 0) throw new RangeError(`Invalid packed index: ${index}`);

  const bitIndex = index * bits;
  const wordIndex = bitIndex >>> 5;
  const offset = bitIndex & 31;
  if (wordIndex >= words.length) throw new RangeError(`Packed index ${index} is out of range`);

  let value = words[wordIndex] >>> offset;
  const spill = offset + bits - 32;
  if (spill > 0) {
    if (wordIndex + 1 >= words.length) throw new RangeError('Truncated packed section data');
    value |= (words[wordIndex + 1] << (bits - spill)) >>> 0;
  }
  return value & mask;
}

/**
 * Encodes one vertical section from dense chunk arrays.
 *
 * @param {Uint16Array} blocks Full dense chunk block array.
 * @param {Uint8Array|null} states Parallel block-state array.
 * @param {number} sectionY Zero-based vertical section index.
 */
export function encodeChunkSection(blocks, states = null, sectionY = 0) {
  if (!(blocks instanceof Uint16Array)) throw new TypeError('blocks must be a Uint16Array');
  if (states !== null && (!(states instanceof Uint8Array) || states.length !== blocks.length)) {
    throw new TypeError('states must be a parallel Uint8Array');
  }
  if (!Number.isInteger(sectionY) || sectionY < 0) throw new RangeError('sectionY must be non-negative');

  const baseY = sectionY * SECTION_SIZE;
  const required = (baseY + SECTION_SIZE) * SECTION_AREA;
  if (blocks.length < required) throw new RangeError(`Dense chunk does not contain section ${sectionY}`);

  const palette = [];
  const paletteLookup = new Map();
  const indices = new Uint16Array(SECTION_VOLUME);
  let nonAirCount = 0;

  for (let y = 0; y < SECTION_SIZE; y++) {
    const sourceY = baseY + y;
    for (let z = 0; z < SECTION_SIZE; z++) {
      for (let x = 0; x < SECTION_SIZE; x++) {
        const sourceIndex = x + z * SECTION_SIZE + sourceY * SECTION_AREA;
        const destinationIndex = sectionIndex(x, y, z);
        const blockId = blocks[sourceIndex];
        const state = states?.[sourceIndex] ?? 0;
        const word = packBlockWord(blockId, state) >>> 0;
        let paletteIndex = paletteLookup.get(word);
        if (paletteIndex === undefined) {
          paletteIndex = palette.length;
          paletteLookup.set(word, paletteIndex);
          palette.push(word);
        }
        indices[destinationIndex] = paletteIndex;
        if (blockId !== Block.AIR) nonAirCount++;
      }
    }
  }

  const bits = bitsForPaletteSize(palette.length);
  return Object.freeze({
    sectionY,
    bits,
    palette: Uint32Array.from(palette),
    data: packPaletteIndices(indices, bits),
    nonAirCount,
  });
}

/** Validates the structural invariants of a serialised section. */
export function validateChunkSection(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const { bits, palette, data, sectionY, nonAirCount } = payload;
  if (!Number.isInteger(sectionY) || sectionY < 0) return false;
  if (!(palette instanceof Uint32Array) || palette.length < 1 || palette.length > SECTION_VOLUME) {
    return false;
  }
  if (!Number.isInteger(bits) || bits !== bitsForPaletteSize(palette.length)) return false;
  if (!(data instanceof Uint32Array) || data.length !== Math.ceil((SECTION_VOLUME * bits) / 32)) {
    return false;
  }
  if (!Number.isInteger(nonAirCount) || nonAirCount < 0 || nonAirCount > SECTION_VOLUME) return false;

  try {
    for (let i = 0; i < SECTION_VOLUME; i++) {
      if (unpackPaletteIndex(data, bits, i) >= palette.length) return false;
    }
  } catch {
    return false;
  }
  return true;
}

/**
 * Decodes a section into full dense chunk arrays.
 *
 * @param {object} payload Value returned by `encodeChunkSection`.
 * @param {Uint16Array} blocks Destination full chunk block array.
 * @param {Uint8Array} states Destination parallel state array.
 */
export function decodeChunkSection(payload, blocks, states) {
  if (!validateChunkSection(payload)) throw new TypeError('Invalid chunk-section payload');
  if (!(blocks instanceof Uint16Array)) throw new TypeError('blocks must be a Uint16Array');
  if (!(states instanceof Uint8Array) || states.length !== blocks.length) {
    throw new TypeError('states must be a parallel Uint8Array');
  }

  const baseY = payload.sectionY * SECTION_SIZE;
  const required = (baseY + SECTION_SIZE) * SECTION_AREA;
  if (blocks.length < required) throw new RangeError(`Dense chunk does not contain section ${payload.sectionY}`);

  for (let y = 0; y < SECTION_SIZE; y++) {
    const destinationY = baseY + y;
    for (let z = 0; z < SECTION_SIZE; z++) {
      for (let x = 0; x < SECTION_SIZE; x++) {
        const localIndex = sectionIndex(x, y, z);
        const paletteIndex = unpackPaletteIndex(payload.data, payload.bits, localIndex);
        const word = payload.palette[paletteIndex];
        const destinationIndex = x + z * SECTION_SIZE + destinationY * SECTION_AREA;
        blocks[destinationIndex] = blockIdFromWord(word);
        states[destinationIndex] = stateFromWord(word);
      }
    }
  }
  return { blocks, states };
}

/** Approximate serialised payload size, excluding object/JSON overhead. */
export function chunkSectionByteLength(payload) {
  if (!validateChunkSection(payload)) throw new TypeError('Invalid chunk-section payload');
  return payload.palette.byteLength + payload.data.byteLength + 12;
}
