/**
 * CPU side of instanced skeletal animation.
 *
 * ## Why a texture and not attributes
 *
 * Mobs render as one `InstancedMesh` per creature type, so the bone matrices for
 * every instance have to reach the vertex shader at once. A skeleton of 8 bones
 * needs 8 * 12 = 96 floats per instance; as instanced attributes that is 24
 * `vec4` slots, far beyond the 16 guaranteed vertex attributes. So the matrices
 * go into a float texture instead: one row per instance, three texels per bone
 * holding the rows of the affine 3x4.
 *
 * The bottom row of a bone matrix is always `[0, 0, 0, 1]` for the rigid
 * transforms a skeleton produces, so storing three rows instead of four costs
 * nothing and saves a quarter of the bandwidth.
 *
 * ## Why this file is renderer-free
 *
 * Everything here is plain `Float32Array` arithmetic, which means the packing,
 * the texture addressing and the identity fill are all testable in Node without
 * a GL context. The Three.js layer only uploads the buffer this module fills.
 */

/** Texels per bone: three rows of the affine 3x4. */
export const TEXELS_PER_BONE = 3;

/** RGBA. */
export const FLOATS_PER_TEXEL = 4;

/** 12 floats: a 3x4 affine matrix. */
export const FLOATS_PER_BONE = TEXELS_PER_BONE * FLOATS_PER_TEXEL;

/**
 * Texture width needed for a skeleton.
 * @param {number} boneCount
 * @returns {number}
 */
export function boneTextureWidth(boneCount) {
  if (!Number.isInteger(boneCount) || boneCount <= 0) {
    throw new Error(`boneTextureWidth needs a positive integer, got ${boneCount}`);
  }
  return boneCount * TEXELS_PER_BONE;
}

/**
 * UV of one bone texel's centre.
 *
 * Sampling texel centres rather than corners is what keeps `NEAREST` filtering
 * from straddling two texels and blending one bone's matrix into its neighbour's
 * — which presents as limbs subtly attached to the wrong joint.
 *
 * @param {number} boneIndex
 * @param {number} texel 0..2
 * @param {number} instanceRow
 * @param {number} width
 * @param {number} height
 * @returns {number[]} `[u, v]`
 */
export function boneTexelUv(boneIndex, texel, instanceRow, width, height) {
  const x = boneIndex * TEXELS_PER_BONE + texel;
  return [(x + 0.5) / width, (instanceRow + 0.5) / height];
}

/**
 * Writes one bone's world matrix as three rows.
 *
 * Input is column-major (matching `SkeletalModel.compose`), output is row-major
 * rows so the shader can reconstruct with three dot products.
 *
 * @param {Float32Array} world Bone world matrices, 16 floats each.
 * @param {number} boneIndex
 * @param {Float32Array} out
 * @param {number} offset Float offset into `out`.
 */
export function packBoneMatrix(world, boneIndex, out, offset) {
  const m = boneIndex * 16;
  // Row 0
  out[offset + 0] = world[m + 0];
  out[offset + 1] = world[m + 4];
  out[offset + 2] = world[m + 8];
  out[offset + 3] = world[m + 12];
  // Row 1
  out[offset + 4] = world[m + 1];
  out[offset + 5] = world[m + 5];
  out[offset + 6] = world[m + 9];
  out[offset + 7] = world[m + 13];
  // Row 2
  out[offset + 8] = world[m + 2];
  out[offset + 9] = world[m + 6];
  out[offset + 10] = world[m + 10];
  out[offset + 11] = world[m + 14];
  return out;
}

/** Writes an identity 3x4 at `offset`. */
export function packIdentity(out, offset) {
  for (let i = 0; i < FLOATS_PER_BONE; i++) out[offset + i] = 0;
  out[offset + 0] = 1;
  out[offset + 5] = 1;
  out[offset + 10] = 1;
  return out;
}

/**
 * Per-creature-type bone matrix storage backing one float texture.
 */
export class MobPoseBuffer {
  /**
   * @param {{boneCount:number, maxInstances:number}} options
   */
  constructor({ boneCount, maxInstances }) {
    if (!Number.isInteger(maxInstances) || maxInstances <= 0) {
      throw new Error(`MobPoseBuffer needs a positive maxInstances, got ${maxInstances}`);
    }
    this.boneCount = boneCount;
    this.maxInstances = maxInstances;
    this.width = boneTextureWidth(boneCount);
    this.height = maxInstances;

    /** Floats per instance row. */
    this.stride = this.width * FLOATS_PER_TEXEL;
    this.data = new Float32Array(this.stride * this.height);

    /** Set when any instance changed since the last upload. */
    this.dirty = true;

    // Identity everywhere, so an instance that is allocated but never written
    // renders in its rest pose instead of collapsing to a point at the origin.
    this.resetAll();
  }

  /** Fills every instance with identity matrices. */
  resetAll() {
    for (let row = 0; row < this.height; row++) this.writeIdentity(row);
    this.dirty = true;
    return this;
  }

  /** Fills one instance row with identity matrices. */
  writeIdentity(instanceRow) {
    const base = instanceRow * this.stride;
    for (let bone = 0; bone < this.boneCount; bone++) {
      packIdentity(this.data, base + bone * FLOATS_PER_BONE);
    }
    this.dirty = true;
    return this;
  }

  /**
   * Copies a posed skeleton's world matrices into one instance row.
   *
   * @param {number} instanceRow
   * @param {{world:Float32Array, boneCount:number}} skeleton
   */
  writeSkeleton(instanceRow, skeleton) {
    if (instanceRow < 0 || instanceRow >= this.height) return false;
    // A skeleton with a different bone count than the buffer was built for means
    // the wrong creature is being written into this type's texture. Silently
    // packing it would scramble the model, so refuse.
    if (skeleton.boneCount !== this.boneCount) return false;

    const base = instanceRow * this.stride;
    for (let bone = 0; bone < this.boneCount; bone++) {
      packBoneMatrix(skeleton.world, bone, this.data, base + bone * FLOATS_PER_BONE);
    }
    this.dirty = true;
    return true;
  }

  /** Reads back one bone's packed rows, for tests and debugging. */
  readBone(instanceRow, boneIndex) {
    const offset = instanceRow * this.stride + boneIndex * FLOATS_PER_BONE;
    return Array.from(this.data.subarray(offset, offset + FLOATS_PER_BONE));
  }

  /**
   * Transforms a point by a packed bone matrix.
   *
   * This is the exact arithmetic the vertex shader performs, which is what makes
   * the shader's behaviour assertable in Node.
   *
   * @param {number} instanceRow
   * @param {number} boneIndex
   * @param {number[]} point `[x, y, z]`
   * @returns {number[]} `[x, y, z]`
   */
  transformByBone(instanceRow, boneIndex, point) {
    const r = this.readBone(instanceRow, boneIndex);
    const [x, y, z] = point;
    return [
      r[0] * x + r[1] * y + r[2] * z + r[3],
      r[4] * x + r[5] * y + r[6] * z + r[7],
      r[8] * x + r[9] * y + r[10] * z + r[11],
    ];
  }

  getStats() {
    return {
      bones: this.boneCount,
      instances: this.maxInstances,
      texture: `${this.width}x${this.height}`,
      kilobytes: Math.round((this.data.byteLength / 1024) * 10) / 10,
    };
  }
}

export default MobPoseBuffer;
