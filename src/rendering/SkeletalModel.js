/**
 * Skeletal model definition and transform maths.
 *
 * ## Why this replaces the flat box list
 *
 * `MobTypes.js` describes every creature as a flat array of boxes, each tagged
 * with a `Limb` enum value. `MobRenderer` then hard-codes what each limb does:
 * legs swing on a sine wave, the head yaws toward the target, everything else is
 * static. That is why all seven mobs move identically — the animation is a
 * property of the renderer, not of the creature.
 *
 * A skeleton fixes this by making the hierarchy data. A bone has a parent, a
 * pivot and its own boxes; rotating the upper arm carries the forearm with it,
 * which is the thing a flat list fundamentally cannot express. A dragon wing, a
 * multi-segment tail and a quadruped gait all become authoring problems instead
 * of renderer problems.
 *
 * ## Deliberately Three.js-free
 *
 * This module does pure matrix maths on plain arrays and imports nothing. That is
 * not stylistic: it means the whole transform pipeline is exercised by the Node
 * self-test, which cannot import Three. `MobRenderer` converts the resulting
 * matrices into `THREE.Matrix4` at the boundary.
 *
 * ## Conventions
 *
 *  - Units are blocks. A player is 1.8 tall.
 *  - Origin is between the feet, +Y up, matching the entity transform.
 *  - Rotations are Euler XYZ in radians, applied about the bone's pivot.
 *  - Matrices are 16-element column-major `Float32Array`, the layout Three uses,
 *    so handing one to `Matrix4.fromArray` is a copy and not a conversion.
 */

/** Maximum bones per skeleton. Keeps per-mob matrix storage predictable. */
export const MAX_BONES = 64;

/** Maximum parent chain depth. Guards against pathological authoring. */
export const MAX_BONE_DEPTH = 8;

/**
 * @typedef {Object} BoneBox
 * @property {number[]} size `[width, height, depth]` in blocks.
 * @property {number[]} offset Box centre relative to the bone pivot.
 * @property {number} [shade] Brightness multiplier so parts read as separate.
 * @property {string} [texture] Texture region key.
 */

/**
 * @typedef {Object} BoneDefinition
 * @property {string} name Unique within the skeleton.
 * @property {string|null} [parent] Parent bone name, or null for a root.
 * @property {number[]} pivot Rotation origin relative to the parent's pivot.
 * @property {number[]} [rotation] Rest pose Euler XYZ, radians.
 * @property {BoneBox[]} [boxes] Geometry attached to this bone.
 * @property {boolean} [mirror] Mirror the boxes on X, for paired limbs.
 */

/**
 * Writes an identity matrix into `out`.
 * @param {Float32Array} out
 */
export function identity(out) {
  out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
  out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
  out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
  out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
  return out;
}

/**
 * Composes translation and an Euler XYZ rotation into a matrix.
 *
 * Written out longhand rather than by multiplying three rotation matrices: this
 * runs once per bone per mob per frame, and the expanded form avoids two matrix
 * multiplies and two temporaries in the hot path.
 *
 * @param {Float32Array} out Column-major 4x4.
 * @param {number[]} position `[x, y, z]`
 * @param {number[]} rotation Euler XYZ radians.
 * @param {number} [scale]
 */
export function compose(out, position, rotation, scale = 1) {
  const cx = Math.cos(rotation[0]);
  const sx = Math.sin(rotation[0]);
  const cy = Math.cos(rotation[1]);
  const sy = Math.sin(rotation[1]);
  const cz = Math.cos(rotation[2]);
  const sz = Math.sin(rotation[2]);

  // R = Rx * Ry * Rz, the order Three's 'XYZ' Euler uses.
  const m00 = cy * cz;
  const m01 = -cy * sz;
  const m02 = sy;
  const m10 = sx * sy * cz + cx * sz;
  const m11 = -sx * sy * sz + cx * cz;
  const m12 = -sx * cy;
  const m20 = -cx * sy * cz + sx * sz;
  const m21 = cx * sy * sz + sx * cz;
  const m22 = cx * cy;

  out[0] = m00 * scale; out[1] = m10 * scale; out[2] = m20 * scale; out[3] = 0;
  out[4] = m01 * scale; out[5] = m11 * scale; out[6] = m21 * scale; out[7] = 0;
  out[8] = m02 * scale; out[9] = m12 * scale; out[10] = m22 * scale; out[11] = 0;
  out[12] = position[0]; out[13] = position[1]; out[14] = position[2]; out[15] = 1;
  return out;
}

/**
 * `out = a * b`. Safe when `out` aliases `a` or `b`.
 * @param {Float32Array} out
 * @param {Float32Array} a
 * @param {Float32Array} b
 */
export function multiply(out, a, b) {
  const a00 = a[0], a01 = a[4], a02 = a[8], a03 = a[12];
  const a10 = a[1], a11 = a[5], a12 = a[9], a13 = a[13];
  const a20 = a[2], a21 = a[6], a22 = a[10], a23 = a[14];
  const a30 = a[3], a31 = a[7], a32 = a[11], a33 = a[15];

  const b00 = b[0], b01 = b[4], b02 = b[8], b03 = b[12];
  const b10 = b[1], b11 = b[5], b12 = b[9], b13 = b[13];
  const b20 = b[2], b21 = b[6], b22 = b[10], b23 = b[14];
  const b30 = b[3], b31 = b[7], b32 = b[11], b33 = b[15];

  out[0] = a00 * b00 + a01 * b10 + a02 * b20 + a03 * b30;
  out[4] = a00 * b01 + a01 * b11 + a02 * b21 + a03 * b31;
  out[8] = a00 * b02 + a01 * b12 + a02 * b22 + a03 * b32;
  out[12] = a00 * b03 + a01 * b13 + a02 * b23 + a03 * b33;

  out[1] = a10 * b00 + a11 * b10 + a12 * b20 + a13 * b30;
  out[5] = a10 * b01 + a11 * b11 + a12 * b21 + a13 * b31;
  out[9] = a10 * b02 + a11 * b12 + a12 * b22 + a13 * b32;
  out[13] = a10 * b03 + a11 * b13 + a12 * b23 + a13 * b33;

  out[2] = a20 * b00 + a21 * b10 + a22 * b20 + a23 * b30;
  out[6] = a20 * b01 + a21 * b11 + a22 * b21 + a23 * b31;
  out[10] = a20 * b02 + a21 * b12 + a22 * b22 + a23 * b32;
  out[14] = a20 * b03 + a21 * b13 + a22 * b23 + a23 * b33;

  out[3] = a30 * b00 + a31 * b10 + a32 * b20 + a33 * b30;
  out[7] = a30 * b01 + a31 * b11 + a32 * b21 + a33 * b31;
  out[11] = a30 * b02 + a31 * b12 + a32 * b22 + a33 * b32;
  out[15] = a30 * b03 + a31 * b13 + a32 * b23 + a33 * b33;
  return out;
}

/**
 * Transforms a point by a matrix. Used by the self-test to verify that a child
 * bone actually follows its parent.
 * @returns {number[]} `[x, y, z]`
 */
export function transformPoint(matrix, point) {
  const [x, y, z] = point;
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

/**
 * Validates a bone list before it becomes a skeleton.
 *
 * Catches the three mistakes that are painful to debug visually: a missing
 * parent (bone silently sits at the origin), a cycle (infinite loop) and a
 * duplicate name (one bone shadows another and never animates).
 *
 * @param {BoneDefinition[]} bones
 * @returns {string[]} Problems found; empty means valid.
 */
export function validateBones(bones) {
  const problems = [];
  if (!Array.isArray(bones) || bones.length === 0) return ['bones must be a non-empty array'];
  if (bones.length > MAX_BONES) problems.push(`${bones.length} bones exceeds MAX_BONES ${MAX_BONES}`);

  const byName = new Map();
  for (const bone of bones) {
    if (!bone || typeof bone.name !== 'string' || bone.name.length === 0) {
      problems.push('every bone needs a non-empty name');
      continue;
    }
    if (byName.has(bone.name)) problems.push(`duplicate bone name "${bone.name}"`);
    byName.set(bone.name, bone);
    if (!Array.isArray(bone.pivot) || bone.pivot.length !== 3 || bone.pivot.some((v) => !Number.isFinite(v))) {
      problems.push(`bone "${bone.name}" needs a finite [x,y,z] pivot`);
    }
  }

  let rootCount = 0;
  for (const bone of bones) {
    if (!bone?.name) continue;
    if (bone.parent == null) { rootCount++; continue; }
    if (!byName.has(bone.parent)) {
      problems.push(`bone "${bone.name}" references unknown parent "${bone.parent}"`);
      continue;
    }
    // Walk to a root, bounded by the bone count so a cycle terminates.
    let cursor = bone;
    let depth = 0;
    const seen = new Set([bone.name]);
    while (cursor.parent != null) {
      cursor = byName.get(cursor.parent);
      if (!cursor) break;
      if (seen.has(cursor.name)) { problems.push(`bone cycle through "${bone.name}"`); break; }
      seen.add(cursor.name);
      if (++depth > MAX_BONE_DEPTH) { problems.push(`bone "${bone.name}" exceeds depth ${MAX_BONE_DEPTH}`); break; }
    }
  }
  if (rootCount === 0) problems.push('skeleton has no root bone');
  return problems;
}

/**
 * Topologically sorts bones so parents always precede children.
 *
 * Doing this once at build time is what lets `Skeleton.update` be a single
 * forward pass with no recursion and no per-frame ordering work.
 *
 * @param {BoneDefinition[]} bones
 * @returns {BoneDefinition[]}
 */
export function sortBones(bones) {
  const byName = new Map(bones.map((bone) => [bone.name, bone]));
  const sorted = [];
  const placed = new Set();

  const visit = (bone, guard) => {
    if (!bone || placed.has(bone.name) || guard > MAX_BONE_DEPTH) return;
    if (bone.parent != null && !placed.has(bone.parent)) visit(byName.get(bone.parent), guard + 1);
    if (placed.has(bone.name)) return;
    placed.add(bone.name);
    sorted.push(bone);
  };

  for (const bone of bones) visit(bone, 0);
  return sorted;
}

/**
 * A built skeleton: sorted bones plus the matrix storage they animate into.
 */
export class Skeleton {
  /**
   * @param {{name?:string, bones:BoneDefinition[], scale?:number}} definition
   * @throws {Error} When the bone list is invalid. Failing loudly at build time
   *   is right here — a malformed skeleton is an authoring bug, and rendering a
   *   silently broken creature is worse than not starting.
   */
  constructor(definition) {
    const problems = validateBones(definition?.bones);
    if (problems.length > 0) {
      throw new Error(`invalid skeleton "${definition?.name ?? 'unnamed'}": ${problems.join('; ')}`);
    }

    this.name = definition.name ?? 'unnamed';
    this.scale = Number.isFinite(definition.scale) ? definition.scale : 1;
    this.bones = sortBones(definition.bones);
    this.boneCount = this.bones.length;

    /** name -> index into the sorted list. */
    this.indexOf = new Map(this.bones.map((bone, index) => [bone.name, index]));
    /** Parent index per bone, -1 for roots. Precomputed for the forward pass. */
    this.parentIndex = this.bones.map((bone) =>
      bone.parent == null ? -1 : this.indexOf.get(bone.parent) ?? -1
    );
    /** Rest pose rotations, cloned so a pose never mutates the definition. */
    this.restRotation = this.bones.map((bone) =>
      Array.isArray(bone.rotation) ? [...bone.rotation] : [0, 0, 0]
    );

    /** Local matrix per bone. */
    this.local = new Float32Array(this.boneCount * 16);
    /** Parent-composed matrix per bone. */
    this.world = new Float32Array(this.boneCount * 16);

    this._scratchLocal = new Float32Array(16);
    this._scratchParent = new Float32Array(16);
    this._scratchOut = new Float32Array(16);

    this.resetPose();
  }

  /** Recomputes world matrices from the rest pose. */
  resetPose() {
    const pose = new Map();
    for (const bone of this.bones) pose.set(bone.name, { rotation: [0, 0, 0], position: [0, 0, 0] });
    this.applyPose(pose);
  }

  /**
   * Composes a pose into world matrices.
   *
   * @param {Map<string, {rotation?:number[], position?:number[]}>} pose
   *   Per-bone *offsets from the rest pose*, not absolute values. An empty pose
   *   therefore yields the rest pose, which is what makes a missing animation
   *   track a no-op rather than a collapsed model.
   */
  applyPose(pose) {
    for (let i = 0; i < this.boneCount; i++) {
      const bone = this.bones[i];
      const entry = pose?.get(bone.name);
      const rest = this.restRotation[i];

      const rotation = entry?.rotation
        ? [rest[0] + entry.rotation[0], rest[1] + entry.rotation[1], rest[2] + entry.rotation[2]]
        : rest;
      const position = entry?.position
        ? [bone.pivot[0] + entry.position[0], bone.pivot[1] + entry.position[1], bone.pivot[2] + entry.position[2]]
        : bone.pivot;

      compose(this._scratchLocal, position, rotation, 1);
      this.local.set(this._scratchLocal, i * 16);

      const parent = this.parentIndex[i];
      if (parent < 0) {
        this.world.set(this._scratchLocal, i * 16);
      } else {
        // Parents always precede children after sortBones, so the parent's world
        // matrix is already final by the time we read it.
        this._scratchParent.set(this.world.subarray(parent * 16, parent * 16 + 16));
        multiply(this._scratchOut, this._scratchParent, this._scratchLocal);
        this.world.set(this._scratchOut, i * 16);
      }
    }
    return this.world;
  }

  /**
   * A copy of one bone's world matrix.
   * @param {string} name
   * @returns {Float32Array|null}
   */
  getWorldMatrix(name) {
    const index = this.indexOf.get(name);
    if (index === undefined) return null;
    return this.world.slice(index * 16, index * 16 + 16);
  }

  /**
   * World-space position of a bone's pivot.
   * @param {string} name
   * @returns {number[]|null} `[x, y, z]`
   */
  getWorldPosition(name) {
    const index = this.indexOf.get(name);
    if (index === undefined) return null;
    const base = index * 16;
    return [this.world[base + 12], this.world[base + 13], this.world[base + 14]];
  }

  /** Total box count, for the renderer's instance budget. */
  get boxCount() {
    let total = 0;
    for (const bone of this.bones) total += bone.boxes?.length ?? 0;
    return total;
  }
}

/**
 * Builds a skeleton, returning null instead of throwing.
 *
 * Used at content-load time where one bad creature definition should disable
 * that creature rather than stop the game.
 *
 * @returns {Skeleton|null}
 */
export function tryCreateSkeleton(definition) {
  try {
    return new Skeleton(definition);
  } catch {
    return null;
  }
}

export default Skeleton;
