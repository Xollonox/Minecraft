/**
 * Runtime capability detection.
 *
 * The goal is to pick a *conservative but not insulting* starting preset. User
 * agent sniffing is used only as weak supporting evidence; the decision is
 * driven by measurable things: WebGL version and limits, core count, reported
 * device memory and screen size.
 */

import { clamp } from './MathUtils.js';

/**
 * @typedef {Object} DeviceCapabilities
 * @property {boolean} webglAvailable
 * @property {1|2|0} webglVersion
 * @property {string} renderer Unmasked GL renderer string when exposed.
 * @property {string} vendor
 * @property {number} maxTextureSize
 * @property {number} maxAnisotropy
 * @property {boolean} floatTextures
 * @property {boolean} highpFragment
 * @property {number} cores
 * @property {number} deviceMemoryGB Best-effort; 0 when unknown.
 * @property {number} devicePixelRatio
 * @property {number} screenWidth
 * @property {number} screenHeight
 * @property {boolean} touch
 * @property {boolean} coarsePointer
 * @property {boolean} mobile
 * @property {boolean} tablet
 * @property {boolean} ios
 * @property {boolean} android
 * @property {boolean} safari
 * @property {boolean} standalone
 * @property {boolean} reducedMotion
 * @property {boolean} pointerLockSupported
 * @property {boolean} fullscreenSupported
 * @property {boolean} gamepadSupported
 * @property {boolean} indexedDBSupported
 * @property {boolean} webAudioSupported
 * @property {boolean} vibrationSupported
 * @property {boolean} workersSupported
 * @property {number} performanceScore Heuristic 0..100.
 * @property {string} suggestedPreset
 */

let cached = null;

/**
 * Probes the environment once and caches the result.
 * @param {boolean} [force] Re-probe even when a cached result exists.
 * @returns {DeviceCapabilities}
 */
export function detectDevice(force = false) {
  if (cached && !force) return cached;

  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const ua = String(nav.userAgent || '');
  const platform = String(nav.platform || '');
  const maxTouchPoints = Number(nav.maxTouchPoints || 0);

  const touch =
    typeof window !== 'undefined' &&
    ('ontouchstart' in window || maxTouchPoints > 0 || (nav.msMaxTouchPoints || 0) > 0);

  const coarsePointer = safeMatchMedia('(any-pointer: coarse)');
  const noHover = safeMatchMedia('(any-hover: none)');
  const reducedMotion = safeMatchMedia('(prefers-reduced-motion: reduce)');

  const android = /android/i.test(ua);
  // iPadOS 13+ reports itself as Macintosh, so touch points are the real tell.
  const ios = /iphone|ipod|ipad/i.test(ua) || (platform === 'MacIntel' && maxTouchPoints > 1);
  const safari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua);

  const screenWidth = typeof window !== 'undefined' ? window.screen?.width || window.innerWidth : 0;
  const screenHeight =
    typeof window !== 'undefined' ? window.screen?.height || window.innerHeight : 0;
  const shortSide = Math.min(screenWidth, screenHeight) || 0;

  const mobileUA = /mobi|iphone|ipod|windows phone/i.test(ua);
  const tabletUA = /ipad|tablet|playbook|silk/i.test(ua) || (android && !/mobi/i.test(ua));
  const mobile = mobileUA || (touch && noHover && shortSide > 0 && shortSide < 500);
  const tablet = !mobile && (tabletUA || (touch && noHover && shortSide >= 500));

  const gl = probeWebGL();

  const cores = clamp(Number(nav.hardwareConcurrency || 0) || (mobile ? 4 : 4), 1, 32);
  const deviceMemoryGB = Number(nav.deviceMemory || 0);
  const devicePixelRatio =
    typeof window !== 'undefined' ? Math.max(1, window.devicePixelRatio || 1) : 1;

  /** @type {DeviceCapabilities} */
  const caps = {
    webglAvailable: gl.available,
    webglVersion: gl.version,
    renderer: gl.renderer,
    vendor: gl.vendor,
    maxTextureSize: gl.maxTextureSize,
    maxAnisotropy: gl.maxAnisotropy,
    floatTextures: gl.floatTextures,
    highpFragment: gl.highpFragment,
    cores,
    deviceMemoryGB,
    devicePixelRatio,
    screenWidth,
    screenHeight,
    touch: Boolean(touch),
    coarsePointer,
    mobile,
    tablet,
    ios,
    android,
    safari,
    standalone: safeMatchMedia('(display-mode: standalone)') || Boolean(nav.standalone),
    reducedMotion,
    pointerLockSupported:
      typeof document !== 'undefined' &&
      'pointerLockElement' in document &&
      typeof Element !== 'undefined' &&
      typeof Element.prototype.requestPointerLock === 'function',
    fullscreenSupported:
      typeof document !== 'undefined' &&
      (typeof document.documentElement.requestFullscreen === 'function' ||
        typeof document.documentElement.webkitRequestFullscreen === 'function'),
    gamepadSupported: typeof nav.getGamepads === 'function',
    indexedDBSupported: typeof indexedDB !== 'undefined' && indexedDB !== null,
    webAudioSupported:
      typeof window !== 'undefined' &&
      (typeof window.AudioContext === 'function' || typeof window.webkitAudioContext === 'function'),
    vibrationSupported: typeof nav.vibrate === 'function',
    workersSupported: typeof Worker === 'function',
    performanceScore: 0,
    suggestedPreset: 'medium',
  };

  caps.performanceScore = scoreDevice(caps);
  caps.suggestedPreset = presetForScore(caps.performanceScore);

  cached = caps;
  return caps;
}

/** Returns the cached capabilities, probing on first use. */
export function getDevice() {
  return cached || detectDevice();
}

function safeMatchMedia(query) {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false;
  } catch {
    return false;
  }
}

/**
 * Creates a throwaway WebGL context to read the driver limits, then releases it
 * immediately so we never hold two contexts at once on memory-tight devices.
 */
function probeWebGL() {
  const result = {
    available: false,
    version: 0,
    renderer: 'unknown',
    vendor: 'unknown',
    maxTextureSize: 2048,
    maxAnisotropy: 1,
    floatTextures: false,
    highpFragment: false,
  };
  if (typeof document === 'undefined') return result;

  let canvas = null;
  let gl = null;
  try {
    canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const attributes = { failIfMajorPerformanceCaveat: false, depth: false, antialias: false };
    gl = canvas.getContext('webgl2', attributes);
    if (gl) {
      result.version = 2;
    } else {
      gl = canvas.getContext('webgl', attributes) || canvas.getContext('experimental-webgl', attributes);
      if (gl) result.version = 1;
    }
    if (!gl) return result;

    result.available = true;
    result.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048;

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (debugInfo) {
      result.renderer = String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || 'unknown');
      result.vendor = String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || 'unknown');
    }

    const aniso =
      gl.getExtension('EXT_texture_filter_anisotropic') ||
      gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic') ||
      gl.getExtension('MOZ_EXT_texture_filter_anisotropic');
    if (aniso) {
      result.maxAnisotropy = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1;
    }

    result.floatTextures =
      result.version === 2
        ? Boolean(gl.getExtension('EXT_color_buffer_float'))
        : Boolean(gl.getExtension('OES_texture_float'));

    const highp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    result.highpFragment = Boolean(highp && highp.precision > 0);
  } catch {
    // Leave defaults; the caller reports "WebGL unavailable" to the user.
  } finally {
    try {
      const lose = gl && gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    } catch {
      /* ignore */
    }
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
  return result;
}

/**
 * Heuristic 0..100 performance score.
 *
 * Deliberately additive rather than a lookup table of device names: unknown
 * hardware lands in the middle instead of being punished.
 */
function scoreDevice(caps) {
  if (!caps.webglAvailable) return 0;

  let score = 34;
  score += caps.webglVersion === 2 ? 10 : 0;
  score += clamp((caps.cores - 2) * 4, -8, 20);
  if (caps.deviceMemoryGB > 0) score += clamp((caps.deviceMemoryGB - 3) * 5, -12, 16);
  score += caps.maxTextureSize >= 8192 ? 6 : caps.maxTextureSize >= 4096 ? 2 : -8;
  score += caps.maxAnisotropy >= 8 ? 4 : 0;
  score += caps.highpFragment ? 3 : -10;

  if (caps.mobile) score -= 16;
  else if (caps.tablet) score -= 8;

  // Very high DPR on a small panel means a lot of pixels for little GPU.
  const pixels = caps.screenWidth * caps.screenHeight * caps.devicePixelRatio ** 2;
  if (pixels > 8_000_000) score -= 8;
  if (pixels > 14_000_000) score -= 6;

  const renderer = caps.renderer.toLowerCase();
  if (/(rtx|radeon rx|geforce gtx 1[6-9]|apple m[1-9])/.test(renderer)) score += 16;
  else if (/(geforce|radeon|arc)/.test(renderer)) score += 8;
  else if (/(intel.*(hd|uhd) graphics|mali-4|adreno [1-4][0-9][0-9]\b|videocore)/.test(renderer)) {
    score -= 12;
  }

  return clamp(Math.round(score), 0, 100);
}

/** Maps a score to a preset id. */
function presetForScore(score) {
  if (score <= 0) return 'potato';
  if (score < 26) return 'potato';
  if (score < 42) return 'low';
  if (score < 60) return 'medium';
  if (score < 78) return 'high';
  return 'ultra';
}

/**
 * Suggests a worker count that leaves headroom for the render thread.
 * @param {DeviceCapabilities} caps
 * @param {number} presetMax Upper bound from the graphics preset.
 */
export function suggestedWorkerCount(caps, presetMax) {
  const budget = Math.max(1, Math.floor(caps.cores - 1));
  return clamp(Math.min(budget, presetMax), 1, 8);
}

export default detectDevice;
