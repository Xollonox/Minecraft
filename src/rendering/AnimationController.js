/**
 * Keyframe animation: clip sampling, cross-fading and additive layers.
 *
 * ## Why this replaces the sine waves
 *
 * `MobRenderer` animated limbs with `Math.sin(walkPhase)` applied to anything
 * tagged `Limb.LEG`. That is cheap and it is why every creature in FinalV2 walks
 * the same way: a chicken, a cow and a skeleton all get the identical pendulum.
 * There was also no transition — a mob that stopped walking snapped its legs to
 * rest in one frame.
 *
 * A clip system fixes both. A gait becomes authored data per creature, and
 * `crossFade` gives every transition a real blend instead of a pop.
 *
 * ## The three things this does
 *
 *  1. **Sample** a clip at a time, producing a per-bone pose.
 *  2. **Blend** two poses by weight, which is what a cross-fade is.
 *  3. **Layer** an additive pose on top, which is how a head-track or a hurt
 *     flinch composes with whatever the body is already doing.
 *
 * Poses are `Map<boneName, {rotation, position}>` of *offsets from rest*, the
 * same contract `Skeleton.applyPose` consumes. Offsets rather than absolutes is
 * what makes additive layering just an addition.
 *
 * ## No Three.js
 *
 * Same reason as `SkeletalModel`: this is the part that is worth testing, so it
 * must run in Node.
 */

/** How a clip behaves past its duration. @enum {string} */
export const LoopMode = Object.freeze({
  /** Wrap to the start. Gaits. */
  LOOP: 'loop',
  /** Hold the last keyframe. Death. */
  CLAMP: 'clamp',
  /** Play forward then backward. Idle breathing. */
  PING_PONG: 'pingpong',
});

/** Channels a track can drive. */
export const CHANNELS = Object.freeze(['rotation', 'position']);

/**
 * @typedef {Object} Keyframe
 * @property {number} time Seconds from clip start.
 * @property {number[]} value `[x, y, z]`.
 */

/**
 * @typedef {Object} AnimationClip
 * @property {string} name
 * @property {number} duration Seconds. Must be > 0.
 * @property {string} [loop] A `LoopMode`, default LOOP.
 * @property {Record<string, {rotation?:Keyframe[], position?:Keyframe[]}>} tracks
 */

/** Smoothstep, used for cross-fade weighting so blends ease rather than ramp. */
export function smoothstep(t) {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/**
 * Maps an absolute time onto a clip's local time according to its loop mode.
 *
 * @param {number} time Seconds since the clip started.
 * @param {number} duration
 * @param {string} loop A `LoopMode`.
 * @returns {number} Local time in `[0, duration]`.
 */
export function wrapTime(time, duration, loop = LoopMode.LOOP) {
  if (!(duration > 0)) return 0;
  if (!Number.isFinite(time) || time <= 0) return 0;
  if (loop === LoopMode.CLAMP) return Math.min(time, duration);
  if (loop === LoopMode.PING_PONG) {
    const cycle = duration * 2;
    const phase = time % cycle;
    return phase <= duration ? phase : cycle - phase;
  }
  return time % duration;
}

/**
 * Samples one keyframe track.
 *
 * Linear interpolation, and a linear scan rather than a binary search: tracks
 * here are four to eight keyframes, where the scan wins on both cache behaviour
 * and code you can read.
 *
 * @param {Keyframe[]} keyframes Must be sorted by `time`.
 * @param {number} time Local clip time.
 * @param {number[]} [out] Reused output array.
 * @returns {number[]} `[x, y, z]`
 */
export function sampleTrack(keyframes, time, out = [0, 0, 0]) {
  out[0] = 0; out[1] = 0; out[2] = 0;
  if (!Array.isArray(keyframes) || keyframes.length === 0) return out;

  const first = keyframes[0];
  if (keyframes.length === 1 || time <= first.time) {
    out[0] = first.value[0]; out[1] = first.value[1]; out[2] = first.value[2];
    return out;
  }
  const last = keyframes[keyframes.length - 1];
  if (time >= last.time) {
    out[0] = last.value[0]; out[1] = last.value[1]; out[2] = last.value[2];
    return out;
  }

  for (let i = 1; i < keyframes.length; i++) {
    const b = keyframes[i];
    if (time > b.time) continue;
    const a = keyframes[i - 1];
    const span = b.time - a.time;
    // Coincident keyframes are legal (a hard cut); guard the divide.
    const t = span > 0 ? (time - a.time) / span : 1;
    out[0] = a.value[0] + (b.value[0] - a.value[0]) * t;
    out[1] = a.value[1] + (b.value[1] - a.value[1]) * t;
    out[2] = a.value[2] + (b.value[2] - a.value[2]) * t;
    return out;
  }
  return out;
}

/**
 * Samples a whole clip into a pose.
 *
 * @param {AnimationClip} clip
 * @param {number} time Seconds since the clip started.
 * @param {Map<string, {rotation:number[], position:number[]}>} [out] Reused.
 * @returns {Map<string, {rotation:number[], position:number[]}>}
 */
export function sampleClip(clip, time, out = new Map()) {
  out.clear();
  if (!clip?.tracks) return out;
  const local = wrapTime(time, clip.duration, clip.loop);

  for (const [bone, track] of Object.entries(clip.tracks)) {
    const entry = { rotation: [0, 0, 0], position: [0, 0, 0] };
    if (track.rotation) sampleTrack(track.rotation, local, entry.rotation);
    if (track.position) sampleTrack(track.position, local, entry.position);
    out.set(bone, entry);
  }
  return out;
}

/**
 * Linearly blends two poses.
 *
 * A bone present in only one pose blends against its rest value (zero offset),
 * which is exactly right: fading in a clip that only moves the head should not
 * disturb the legs.
 *
 * @param {Map} a Pose at weight `1 - weight`.
 * @param {Map} b Pose at weight `weight`.
 * @param {number} weight 0..1
 * @param {Map} [out]
 */
export function blendPoses(a, b, weight, out = new Map()) {
  const w = weight <= 0 ? 0 : weight >= 1 ? 1 : weight;
  const inverse = 1 - w;
  out.clear();

  const names = new Set([...a.keys(), ...b.keys()]);
  for (const name of names) {
    const ea = a.get(name);
    const eb = b.get(name);
    const ar = ea?.rotation ?? ZERO;
    const br = eb?.rotation ?? ZERO;
    const ap = ea?.position ?? ZERO;
    const bp = eb?.position ?? ZERO;
    out.set(name, {
      rotation: [
        ar[0] * inverse + br[0] * w,
        ar[1] * inverse + br[1] * w,
        ar[2] * inverse + br[2] * w,
      ],
      position: [
        ap[0] * inverse + bp[0] * w,
        ap[1] * inverse + bp[1] * w,
        ap[2] * inverse + bp[2] * w,
      ],
    });
  }
  return out;
}

const ZERO = Object.freeze([0, 0, 0]);

/**
 * Adds a weighted pose on top of a base pose, in place.
 *
 * Additive rather than blended because a layer should *modify* the body, not
 * replace it: a hurt flinch at weight 1 should still let the legs walk.
 *
 * @param {Map} base Mutated.
 * @param {Map} layer
 * @param {number} weight
 */
export function addPose(base, layer, weight) {
  const w = weight <= 0 ? 0 : weight >= 1 ? 1 : weight;
  if (w === 0) return base;
  for (const [name, entry] of layer) {
    const existing = base.get(name);
    if (!existing) {
      base.set(name, {
        rotation: [entry.rotation[0] * w, entry.rotation[1] * w, entry.rotation[2] * w],
        position: [entry.position[0] * w, entry.position[1] * w, entry.position[2] * w],
      });
      continue;
    }
    existing.rotation[0] += entry.rotation[0] * w;
    existing.rotation[1] += entry.rotation[1] * w;
    existing.rotation[2] += entry.rotation[2] * w;
    existing.position[0] += entry.position[0] * w;
    existing.position[1] += entry.position[1] * w;
    existing.position[2] += entry.position[2] * w;
  }
  return base;
}

/**
 * Validates a clip against a skeleton.
 *
 * The important check is the last one: a track naming a bone the skeleton does
 * not have is silently ignored at runtime, which presents as "the animation does
 * not play" with no error anywhere. Catching it in the self-test turns a
 * half-hour of confusion into a line of output.
 *
 * @param {AnimationClip} clip
 * @param {import('./SkeletalModel.js').Skeleton} [skeleton]
 * @returns {string[]} Problems; empty means valid.
 */
export function validateClip(clip, skeleton = null) {
  const problems = [];
  if (!clip || typeof clip !== 'object') return ['clip is not an object'];
  if (typeof clip.name !== 'string' || !clip.name) problems.push('clip needs a name');
  if (!(clip.duration > 0)) problems.push(`clip "${clip.name}" needs a positive duration`);
  if (clip.loop && !Object.values(LoopMode).includes(clip.loop)) {
    problems.push(`clip "${clip.name}" has unknown loop mode "${clip.loop}"`);
  }
  if (!clip.tracks || typeof clip.tracks !== 'object') {
    problems.push(`clip "${clip.name}" has no tracks`);
    return problems;
  }

  for (const [bone, track] of Object.entries(clip.tracks)) {
    if (skeleton && !skeleton.indexOf.has(bone)) {
      problems.push(`clip "${clip.name}" targets unknown bone "${bone}"`);
    }
    for (const channel of CHANNELS) {
      const keyframes = track[channel];
      if (keyframes === undefined) continue;
      if (!Array.isArray(keyframes) || keyframes.length === 0) {
        problems.push(`clip "${clip.name}" bone "${bone}" ${channel} track is empty`);
        continue;
      }
      let previous = -Infinity;
      for (const frame of keyframes) {
        if (!Number.isFinite(frame?.time)) {
          problems.push(`clip "${clip.name}" bone "${bone}" has a keyframe without a finite time`);
          break;
        }
        if (frame.time < previous) {
          problems.push(`clip "${clip.name}" bone "${bone}" ${channel} keyframes are not sorted`);
          break;
        }
        previous = frame.time;
        if (!Array.isArray(frame.value) || frame.value.length !== 3 || frame.value.some((v) => !Number.isFinite(v))) {
          problems.push(`clip "${clip.name}" bone "${bone}" has a non-finite keyframe value`);
          break;
        }
      }
      const last = keyframes[keyframes.length - 1];
      if (last && last.time > clip.duration + 1e-6) {
        problems.push(`clip "${clip.name}" bone "${bone}" ${channel} extends past the duration`);
      }
      // A looping clip whose first and last keyframes differ will visibly pop on
      // the wrap. Worth flagging while authoring, not worth failing over.
      if ((clip.loop ?? LoopMode.LOOP) === LoopMode.LOOP && keyframes.length > 1) {
        const first = keyframes[0];
        const drift = Math.max(
          Math.abs(first.value[0] - last.value[0]),
          Math.abs(first.value[1] - last.value[1]),
          Math.abs(first.value[2] - last.value[2])
        );
        if (drift > 1e-3 && Math.abs(last.time - clip.duration) < 1e-6) {
          problems.push(`clip "${clip.name}" bone "${bone}" ${channel} does not loop seamlessly`);
        }
      }
    }
  }
  return problems;
}

/**
 * Drives one creature's animation state.
 *
 * Holds a current clip, an optional outgoing clip being faded out, and a set of
 * additive layers. One instance per animated entity.
 */
export class AnimationController {
  /**
   * @param {Record<string, AnimationClip>} clips Keyed by clip name.
   * @param {Object} [options]
   * @param {string} [options.initial] Clip to start in.
   */
  constructor(clips, { initial = null } = {}) {
    this.clips = clips ?? {};
    this.current = initial && this.clips[initial] ? initial : Object.keys(this.clips)[0] ?? null;
    this.time = 0;
    this.speed = 1;

    /** Outgoing clip during a cross-fade. */
    this.previous = null;
    this.previousTime = 0;
    this.fadeElapsed = 0;
    this.fadeDuration = 0;

    /** @type {Map<string, {clip:string, time:number, weight:number, speed:number}>} */
    this.layers = new Map();

    this._poseA = new Map();
    this._poseB = new Map();
    this._poseLayer = new Map();
    this._result = new Map();
  }

  /** True while a cross-fade is in progress. */
  get isBlending() {
    return this.previous !== null && this.fadeElapsed < this.fadeDuration;
  }

  /**
   * Switches clips with a blend.
   *
   * Re-requesting the clip already playing is a no-op rather than a restart —
   * otherwise a state machine that calls `crossFade('walk')` every frame while
   * walking would freeze the gait on frame zero.
   *
   * @param {string} name
   * @param {number} [duration] Fade seconds.
   * @param {boolean} [restart] Force a restart even if already playing.
   * @returns {boolean} True when the clip changed.
   */
  crossFade(name, duration = 0.2, restart = false) {
    if (!this.clips[name]) return false;
    if (this.current === name && !restart) return false;

    if (this.current && duration > 0) {
      this.previous = this.current;
      this.previousTime = this.time;
      this.fadeElapsed = 0;
      this.fadeDuration = duration;
    } else {
      this.previous = null;
      this.fadeDuration = 0;
    }
    this.current = name;
    this.time = 0;
    return true;
  }

  /** Switches instantly, discarding any fade. */
  play(name) {
    return this.crossFade(name, 0, true);
  }

  /**
   * Adds or updates an additive layer.
   * @param {string} id Stable key, e.g. 'headTrack' or 'flinch'.
   * @param {string} clipName
   * @param {number} weight 0..1
   * @param {number} [speed]
   */
  setLayer(id, clipName, weight, speed = 1) {
    if (!this.clips[clipName]) return false;
    const existing = this.layers.get(id);
    if (existing && existing.clip === clipName) {
      existing.weight = weight;
      existing.speed = speed;
      return true;
    }
    this.layers.set(id, { clip: clipName, time: 0, weight, speed });
    return true;
  }

  /** Removes an additive layer. */
  clearLayer(id) {
    return this.layers.delete(id);
  }

  /**
   * Advances all clocks.
   * @param {number} dt Seconds.
   */
  update(dt) {
    // Clamped: a tab that was backgrounded for a minute should not fast-forward
    // a death animation through its clamp and back.
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    this.time += step * this.speed;
    if (this.previous) {
      this.previousTime += step * this.speed;
      this.fadeElapsed += step;
      if (this.fadeElapsed >= this.fadeDuration) {
        this.previous = null;
        this.fadeDuration = 0;
      }
    }
    for (const layer of this.layers.values()) layer.time += step * layer.speed;
  }

  /**
   * Produces the final pose for this frame.
   *
   * @returns {Map<string, {rotation:number[], position:number[]}>} Offsets from
   *   rest, ready for `Skeleton.applyPose`.
   */
  getPose() {
    const currentClip = this.current ? this.clips[this.current] : null;
    if (!currentClip) {
      this._result.clear();
      return this._result;
    }

    sampleClip(currentClip, this.time, this._poseA);

    if (this.isBlending && this.previous) {
      sampleClip(this.clips[this.previous], this.previousTime, this._poseB);
      const weight = smoothstep(this.fadeDuration > 0 ? this.fadeElapsed / this.fadeDuration : 1);
      // Blend *from* the outgoing pose *to* the incoming one.
      blendPoses(this._poseB, this._poseA, weight, this._result);
    } else {
      this._result.clear();
      for (const [name, entry] of this._poseA) {
        this._result.set(name, { rotation: [...entry.rotation], position: [...entry.position] });
      }
    }

    for (const layer of this.layers.values()) {
      if (layer.weight <= 0) continue;
      sampleClip(this.clips[layer.clip], layer.time, this._poseLayer);
      addPose(this._result, this._poseLayer, layer.weight);
    }
    return this._result;
  }

  /** Debug-overlay snapshot. */
  getStats() {
    return {
      clip: this.current,
      time: Number(this.time.toFixed(2)),
      blending: this.isBlending,
      layers: this.layers.size,
    };
  }
}

export default AnimationController;
