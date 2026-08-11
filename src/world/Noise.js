/**
 * Deterministic gradient noise.
 *
 * Improved Perlin noise with a seeded permutation table, plus the fractal
 * combinators terrain generation needs (fBm, ridged, billowed) and a 2D domain
 * warp. Everything is a pure function of the seed, which is what makes the same
 * seed produce the same world on every device and in every worker.
 *
 * Worker-safe: no DOM, no Three.js.
 */

import { mulberry32 } from '../utils/MathUtils.js';

/** The 12 edge-midpoint gradients from Perlin's improved noise. */
const GRAD3 = new Int8Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

/** Quintic fade curve `6t^5 - 15t^4 + 10t^3`. */
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

export class PerlinNoise {
  /**
   * @param {number} seed 32-bit integer seed.
   */
  constructor(seed) {
    this.seed = seed >>> 0;
    /**
     * Doubled permutation table so lookups never need a modulo.
     * @type {Uint8Array}
     */
    this._perm = new Uint8Array(512);
    /** Precomputed `perm[i] % 12 * 3`, the gradient row offset. */
    this._gradIndex = new Uint8Array(512);

    const random = mulberry32(this.seed);
    const table = new Uint8Array(256);
    for (let i = 0; i < 256; i++) table[i] = i;
    // Fisher-Yates with the seeded PRNG.
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const tmp = table[i];
      table[i] = table[j];
      table[j] = tmp;
    }
    for (let i = 0; i < 512; i++) {
      const value = table[i & 255];
      this._perm[i] = value;
      this._gradIndex[i] = (value % 12) * 3;
    }
  }

  /**
   * 2D Perlin noise.
   * @param {number} x
   * @param {number} y
   * @returns {number} Value in roughly `[-1, 1]`.
   */
  noise2(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const X = xi & 255;
    const Y = yi & 255;

    const u = fade(xf);
    const v = fade(yf);

    const perm = this._perm;
    const gradIndex = this._gradIndex;

    const a = perm[X] + Y;
    const b = perm[X + 1] + Y;

    const g00 = gradIndex[a];
    const g10 = gradIndex[b];
    const g01 = gradIndex[a + 1];
    const g11 = gradIndex[b + 1];

    const n00 = GRAD3[g00] * xf + GRAD3[g00 + 1] * yf;
    const n10 = GRAD3[g10] * (xf - 1) + GRAD3[g10 + 1] * yf;
    const n01 = GRAD3[g01] * xf + GRAD3[g01 + 1] * (yf - 1);
    const n11 = GRAD3[g11] * (xf - 1) + GRAD3[g11 + 1] * (yf - 1);

    return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v);
  }

  /**
   * 3D Perlin noise.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {number} Value in roughly `[-1, 1]`.
   */
  noise3(x, y, z) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const xf = x - xi;
    const yf = y - yi;
    const zf = z - zi;
    const X = xi & 255;
    const Y = yi & 255;
    const Z = zi & 255;

    const u = fade(xf);
    const v = fade(yf);
    const w = fade(zf);

    const perm = this._perm;
    const gradIndex = this._gradIndex;

    const a = perm[X] + Y;
    const aa = perm[a] + Z;
    const ab = perm[a + 1] + Z;
    const b = perm[X + 1] + Y;
    const ba = perm[b] + Z;
    const bb = perm[b + 1] + Z;

    const n000 = grad3(gradIndex[aa], xf, yf, zf);
    const n100 = grad3(gradIndex[ba], xf - 1, yf, zf);
    const n010 = grad3(gradIndex[ab], xf, yf - 1, zf);
    const n110 = grad3(gradIndex[bb], xf - 1, yf - 1, zf);
    const n001 = grad3(gradIndex[aa + 1], xf, yf, zf - 1);
    const n101 = grad3(gradIndex[ba + 1], xf - 1, yf, zf - 1);
    const n011 = grad3(gradIndex[ab + 1], xf, yf - 1, zf - 1);
    const n111 = grad3(gradIndex[bb + 1], xf - 1, yf - 1, zf - 1);

    const x00 = lerp(n000, n100, u);
    const x10 = lerp(n010, n110, u);
    const x01 = lerp(n001, n101, u);
    const x11 = lerp(n011, n111, u);

    return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
  }

  /**
   * Fractal Brownian motion in 2D.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} octaves
   * @param {number} [frequency] Frequency of the first octave.
   * @param {number} [lacunarity] Frequency multiplier per octave.
   * @param {number} [gain] Amplitude multiplier per octave.
   * @returns {number} Normalised to roughly `[-1, 1]`.
   */
  fbm2(x, y, octaves, frequency = 1, lacunarity = 2, gain = 0.5) {
    let amplitude = 1;
    let total = 0;
    let normalisation = 0;
    let f = frequency;
    for (let i = 0; i < octaves; i++) {
      total += this.noise2(x * f, y * f) * amplitude;
      normalisation += amplitude;
      amplitude *= gain;
      f *= lacunarity;
    }
    return normalisation > 0 ? total / normalisation : 0;
  }

  /**
   * Fractal Brownian motion in 3D. Used for cave carving.
   * @returns {number} Normalised to roughly `[-1, 1]`.
   */
  fbm3(x, y, z, octaves, frequency = 1, lacunarity = 2, gain = 0.5) {
    let amplitude = 1;
    let total = 0;
    let normalisation = 0;
    let f = frequency;
    for (let i = 0; i < octaves; i++) {
      total += this.noise3(x * f, y * f, z * f) * amplitude;
      normalisation += amplitude;
      amplitude *= gain;
      f *= lacunarity;
    }
    return normalisation > 0 ? total / normalisation : 0;
  }

  /**
   * Ridged multifractal noise: `1 - |noise|`, sharpened per octave.
   * Produces mountain ridges and, in 3D, tunnel-shaped cave systems.
   *
   * @returns {number} Value in `[0, 1]`, peaking at ridge lines.
   */
  ridged2(x, y, octaves, frequency = 1, lacunarity = 2, gain = 0.5) {
    let amplitude = 1;
    let total = 0;
    let normalisation = 0;
    let f = frequency;
    for (let i = 0; i < octaves; i++) {
      const signal = 1 - Math.abs(this.noise2(x * f, y * f));
      total += signal * signal * amplitude;
      normalisation += amplitude;
      amplitude *= gain;
      f *= lacunarity;
    }
    return normalisation > 0 ? total / normalisation : 0;
  }

  /**
   * 3D ridged noise, used for spaghetti cave tunnels.
   * @returns {number} Value in `[0, 1]`.
   */
  ridged3(x, y, z, octaves, frequency = 1, lacunarity = 2, gain = 0.5) {
    let amplitude = 1;
    let total = 0;
    let normalisation = 0;
    let f = frequency;
    for (let i = 0; i < octaves; i++) {
      const signal = 1 - Math.abs(this.noise3(x * f, y * f, z * f));
      total += signal * signal * amplitude;
      normalisation += amplitude;
      amplitude *= gain;
      f *= lacunarity;
    }
    return normalisation > 0 ? total / normalisation : 0;
  }

  /**
   * Billowed noise: `|noise|`, which makes rounded blobs rather than ridges.
   * @returns {number} Value in `[0, 1]`.
   */
  billow2(x, y, octaves, frequency = 1, lacunarity = 2, gain = 0.5) {
    let amplitude = 1;
    let total = 0;
    let normalisation = 0;
    let f = frequency;
    for (let i = 0; i < octaves; i++) {
      total += Math.abs(this.noise2(x * f, y * f)) * amplitude;
      normalisation += amplitude;
      amplitude *= gain;
      f *= lacunarity;
    }
    return normalisation > 0 ? total / normalisation : 0;
  }
}

function grad3(gi, x, y, z) {
  return GRAD3[gi] * x + GRAD3[gi + 1] * y + GRAD3[gi + 2] * z;
}

/**
 * A named bundle of Perlin instances derived from one world seed.
 *
 * Each field gets its own permutation table (seed + a distinct salt) so the
 * layers are statistically independent. Sharing one table between "temperature"
 * and "elevation" is what makes procedural worlds look subtly correlated and
 * repetitive.
 */
export class NoiseSet {
  /**
   * @param {number} seed
   * @param {string[]} fieldNames
   */
  constructor(seed, fieldNames) {
    this.seed = seed >>> 0;
    /** @type {Record<string, PerlinNoise>} */
    this.fields = {};
    for (let i = 0; i < fieldNames.length; i++) {
      // Large odd multiplier keeps consecutive salts far apart in the PRNG.
      const salt = (this.seed + Math.imul(i + 1, 0x9e3779b1)) >>> 0;
      this.fields[fieldNames[i]] = new PerlinNoise(salt);
    }
  }

  /**
   * @param {string} name
   * @returns {PerlinNoise}
   */
  get(name) {
    const field = this.fields[name];
    if (!field) throw new Error(`NoiseSet has no field "${name}"`);
    return field;
  }
}

/**
 * Applies a 2D domain warp: offsets the sample position by a low-frequency
 * noise lookup. This breaks up the grid-aligned look Perlin noise otherwise has
 * along biome and coastline boundaries.
 *
 * @param {PerlinNoise} noise
 * @param {number} x
 * @param {number} y
 * @param {number} frequency
 * @param {number} amplitude
 * @param {{x:number,y:number}} out Mutated and returned.
 */
export function domainWarp2(noise, x, y, frequency, amplitude, out) {
  const wx = noise.noise2(x * frequency, y * frequency);
  const wy = noise.noise2(x * frequency + 5.2, y * frequency + 1.3);
  out.x = x + wx * amplitude;
  out.y = y + wy * amplitude;
  return out;
}

export default PerlinNoise;
