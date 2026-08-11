/**
 * Visible-face chunk mesher.
 *
 * One `BufferGeometry` per render layer per chunk — never one mesh per voxel.
 * A face is emitted only when the neighbouring voxel cannot hide it, which for
 * ordinary terrain removes well over 90% of the theoretical face count.
 *
 * ## Why a padded volume
 *
 * `mesh()` takes an 18x130x18 `Uint16Array` covering the chunk plus one block of
 * padding on every side. That single block of padding is exactly what correct
 * meshing needs: face culling reads the 6 face neighbours, ambient occlusion
 * reads the 8 corner-adjacent neighbours, and both must work for voxels sitting
 * on the chunk border. Handing the mesher a padded copy rather than a chunk plus
 * eight neighbour references means the whole job is one transferable buffer, so
 * it can run in a worker with zero shared state.
 *
 * ## Lighting model
 *
 * Sky light is computed per column: light starts at 15 above the world and is
 * reduced by each block's `lightAttenuation` on the way down. Because that is a
 * pure function of a single column, two neighbouring chunks always compute the
 * *same* value for their shared columns — there are no lighting seams at chunk
 * borders, which a flood-fill restricted to a padded region would inevitably
 * produce. Leaves and water attenuate partially, so canopies are dappled and
 * water dims with depth, while solid rock cuts the sky off entirely and leaves
 * caves genuinely dark.
 *
 * Ambient occlusion is the standard three-neighbour corner test, and per-vertex
 * light is the average of the non-opaque cells touching that vertex. Both are
 * baked into a normalised `Uint8` attribute (`alight`) as
 * `[ao, skyLight, blockLight, unused]`, which the voxel shader combines with the
 * sun colour. Block light is taken as the strongest emitter touching the vertex,
 * which makes a torch light the faces immediately around it; longer-range torch
 * light is handled by real point lights in `LightingSystem`.
 *
 * Worker-safe: no DOM, no Three.js.
 */

import {
  CHUNK_SIZE_X,
  CHUNK_SIZE_Z,
  FACE_NX,
  FACE_NY,
  FACE_NZ,
  FACE_PX,
  FACE_PY,
  FACE_PZ,
  LAYER_CUTOUT,
  LAYER_LIQUID,
  LAYER_NAMES,
  LAYER_OPAQUE,
  MAX_LIGHT,
  PADDED_SIZE_X,
  PADDED_SIZE_Z,
  WORLD_HEIGHT,
} from '../config/GameConfig.js';
import { randomFromCoords2 } from '../utils/MathUtils.js';
import { TILE_UVS } from './AtlasLayout.js';
import { Block } from './BlockTypes.js';
import { getVoxelShape } from './BlockModels.js';
import {
  extractPaddedBlockLight,
  LIGHT_VOLUME,
  propagateBlockLight,
  propagatePaddedBlockLight,
  LIGHT_VOLUME_SIZE_X,
  LIGHT_VOLUME_SIZE_Y,
  LIGHT_VOLUME_SIZE_Z,
} from './BlockLight.js';
import { fluidIsFalling, fluidLevel } from './BlockState.js';
import {
  CULL_SAME,
  FACE_TILES,
  STATE_FACE_TILES,
  STATE_RENDER_HEIGHT,
  IS_LIQUID,
  IS_OPAQUE,
  LIGHT_ATTENUATION,
  RENDER_LAYER,
  RENDER_SHAPE,
  SWAY_CLASS,
  Shape,
} from './BlockRegistry.js';

/** Corner positions per face, as offsets from the voxel's minimum corner. */
const FACE_CORNERS = [
  // +X
  [1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1],
  // -X
  [0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0],
  // +Y
  [0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0],
  // -Y
  [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1],
  // +Z
  [0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1],
  // -Z
  [1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0],
];

/**
 * In-plane axes per face, chosen so that corner 0 -> corner 1 travels along
 * `u` and corner 1 -> corner 2 travels along `v`. This lets one constant corner
 * sign table drive ambient occlusion for every face.
 */
const FACE_U = [
  [0, 0, -1],
  [0, 0, 1],
  [1, 0, 0],
  [1, 0, 0],
  [1, 0, 0],
  [-1, 0, 0],
];
const FACE_V = [
  [0, 1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
  [0, 1, 0],
  [0, 1, 0],
];

/** Signs of (u, v) for corners 0..3, matching `FACE_CORNERS` ordering. */
const CORNER_SIGNS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

/** Face normals, flattened. */
const FACE_NORMAL = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** Per-face flat shading multiplier, applied even when AO is disabled. */
const FACE_SHADE = [0.78, 0.78, 1, 0.55, 0.88, 0.88];

/** Ambient occlusion multipliers for the four occlusion levels. */
const AO_LEVELS = [0.44, 0.62, 0.81, 1];

/** Height of an open liquid surface, in blocks. */
const LIQUID_SURFACE_HEIGHT = 0.875;

/**
 * Half-width of a cross-shaped plant's quads, and how far the plant may be
 * nudged off centre.
 *
 * `PLANT_REACH + PLANT_JITTER` must stay below 0.5 or a jittered plant pokes
 * out of its own voxel and clips through the neighbouring block.
 */
const PLANT_REACH = 0.4;
const PLANT_JITTER = 0.09;

/**
 * A growable typed-array writer. The mesher instance is long-lived inside the
 * worker, so buffers are reused across chunks and only ever grow.
 */
class Growable {
  /**
   * @param {Float32ArrayConstructor|Uint8ArrayConstructor|Uint32ArrayConstructor} Type
   * @param {number} capacity
   */
  constructor(Type, capacity) {
    this.Type = Type;
    this.data = new Type(capacity);
    this.length = 0;
  }

  reset() {
    this.length = 0;
  }

  ensure(extra) {
    const required = this.length + extra;
    if (required <= this.data.length) return;
    let capacity = this.data.length * 2;
    while (capacity < required) capacity *= 2;
    const grown = new this.Type(capacity);
    grown.set(this.data.subarray(0, this.length));
    this.data = grown;
  }

  push(value) {
    this.ensure(1);
    this.data[this.length++] = value;
  }

  push2(a, b) {
    this.ensure(2);
    this.data[this.length++] = a;
    this.data[this.length++] = b;
  }

  push3(a, b, c) {
    this.ensure(3);
    this.data[this.length++] = a;
    this.data[this.length++] = b;
    this.data[this.length++] = c;
  }

  push4(a, b, c, d) {
    this.ensure(4);
    this.data[this.length++] = a;
    this.data[this.length++] = b;
    this.data[this.length++] = c;
    this.data[this.length++] = d;
  }

  /** Exact-size copy, suitable for transferring to the main thread. */
  toTyped() {
    return this.data.slice(0, this.length);
  }
}

/** One set of attribute writers for a render layer. */
class LayerBuffers {
  constructor() {
    this.positions = new Growable(Float32Array, 4096 * 3);
    this.normals = new Growable(Float32Array, 4096 * 3);
    this.uvs = new Growable(Float32Array, 4096 * 2);
    this.light = new Growable(Uint8Array, 4096 * 4);
    this.indices = new Growable(Uint32Array, 6144);
    this.vertexCount = 0;
  }

  reset() {
    this.positions.reset();
    this.normals.reset();
    this.uvs.reset();
    this.light.reset();
    this.indices.reset();
    this.vertexCount = 0;
  }

  get isEmpty() {
    return this.vertexCount === 0;
  }

  /** Packages the layer for structured-clone transfer. */
  extract() {
    return {
      positions: this.positions.toTyped(),
      normals: this.normals.toTyped(),
      uvs: this.uvs.toTyped(),
      light: this.light.toTyped(),
      indices: this.indices.toTyped(),
      vertexCount: this.vertexCount,
      triangleCount: this.indices.length / 3,
    };
  }
}

export class ChunkMesher {
  constructor() {
    /** @type {LayerBuffers[]} */
    this._layers = LAYER_NAMES.map(() => new LayerBuffers());
    /** Sky light per padded voxel, recomputed per chunk. */
    this._skyLight = new Uint8Array(PADDED_SIZE_X * PADDED_SIZE_Z * (WORLD_HEIGHT + 2));
    /** Propagated block light per padded voxel. */
    this._blockLight = new Uint8Array(PADDED_SIZE_X * PADDED_SIZE_Z * (WORLD_HEIGHT + 2));
    /** Reused flood-fill queues/buffers for local and cross-chunk lighting. */
    this._paddedLightQueue = new Int32Array(PADDED_SIZE_X * PADDED_SIZE_Z * (WORLD_HEIGHT + 2));
    this._paddedLightQueued = new Uint8Array(PADDED_SIZE_X * PADDED_SIZE_Z * (WORLD_HEIGHT + 2));
    this._largeBlockLight = new Uint8Array(LIGHT_VOLUME);
    this._largeLightQueue = new Int32Array(LIGHT_VOLUME);
    this._largeLightQueued = new Uint8Array(LIGHT_VOLUME);
    /** Scratch AO/light values for the four corners of the current face. */
    this._cornerAO = new Float32Array(4);
    this._cornerSky = new Float32Array(4);
    this._cornerBlock = new Float32Array(4);
    /** Zero-state fallback for old callers and state-free generated data. */
    this._zeroStates = new Uint8Array(PADDED_SIZE_X * PADDED_SIZE_Z * (WORLD_HEIGHT + 2));
  }

  /**
   * Builds the geometry for one chunk.
   *
   * @param {Uint16Array|Uint8Array} padded 18 x 130 x 18 voxel volume (see module docs).
   * @param {Uint8Array|Object|null} [paddedStates] Parallel state volume. For
   *   backwards compatibility an options object may be passed here.
   * @param {Object} [options]
   * @param {boolean} [options.ambientOcclusion] Bake corner occlusion.
   * @param {boolean} [options.smoothLighting] Average light across vertices.
   * @param {boolean} [options.liquidSurface] Lower open liquid surfaces.
   * @param {Uint16Array|null} [lightBlocks] Optional 3x3-chunk block-id volume.
   * @returns {{layers: Record<string, Object>, stats: Object}}
   */
  mesh(padded, paddedStates = null, options = {}, lightBlocks = null) {
    if (!(padded instanceof Uint16Array) && !(padded instanceof Uint8Array)) {
      throw new TypeError('ChunkMesher requires a Uint16Array block volume');
    }
    if (!(paddedStates instanceof Uint8Array)) {
      options = paddedStates ?? {};
      paddedStates = this._zeroStates;
    }
    const ambientOcclusion = options.ambientOcclusion !== false;
    const smoothLighting = options.smoothLighting !== false;
    const liquidSurface = options.liquidSurface !== false;

    for (const layer of this._layers) layer.reset();
    this._computeSkyLight(padded);
    this._computeBlockLight(padded, lightBlocks);

    let emittedFaces = 0;

    for (let y = 0; y < WORLD_HEIGHT; y++) {
      for (let localZ = 0; localZ < CHUNK_SIZE_Z; localZ++) {
        for (let localX = 0; localX < CHUNK_SIZE_X; localX++) {
          const paddedIndex = this._index(localX, y, localZ);
          const blockId = padded[paddedIndex];
          if (blockId === Block.AIR) continue;
          const state = paddedStates[paddedIndex];

          const shape = RENDER_SHAPE[blockId];
          if (shape === Shape.CROSS) {
            emittedFaces += this._emitCross(padded, blockId, state, localX, y, localZ);
            continue;
          }
          if (shape === Shape.POST) {
            emittedFaces += this._emitPost(padded, blockId, state, localX, y, localZ);
            continue;
          }
          if (shape === Shape.PLATE) {
            emittedFaces += this._emitPlate(padded, blockId, state, localX, y, localZ);
            continue;
          }
          if (shape === Shape.BOXES) {
            emittedFaces += this._emitBoxes(
              padded,
              paddedStates,
              blockId,
              state,
              localX,
              y,
              localZ,
              ambientOcclusion,
              smoothLighting
            );
            continue;
          }

          emittedFaces += this._emitCube(
            padded,
            paddedStates,
            blockId,
            state,
            localX,
            y,
            localZ,
            ambientOcclusion,
            smoothLighting,
            liquidSurface
          );
        }
      }
    }

    /** @type {Record<string, Object>} */
    const layers = {};
    let triangles = 0;
    let vertices = 0;
    for (let i = 0; i < this._layers.length; i++) {
      const layer = this._layers[i];
      if (layer.isEmpty) continue;
      const extracted = layer.extract();
      layers[LAYER_NAMES[i]] = extracted;
      triangles += extracted.triangleCount;
      vertices += extracted.vertexCount;
    }

    return {
      layers,
      stats: { faces: emittedFaces, triangles, vertices },
    };
  }

  /** Flat index into the padded volume. Local coordinates may be -1..size. */
  _index(localX, y, localZ) {
    return (
      localX + 1 + PADDED_SIZE_X * (localZ + 1 + PADDED_SIZE_Z * (y + 1))
    );
  }

  /**
   * Column-wise sky light.
   *
   * Walking each column top-down and subtracting `lightAttenuation` makes the
   * result a pure function of that column alone. That is what guarantees two
   * adjacent chunks agree on the light of their shared columns and therefore
   * never show a seam.
   */
  _computeSkyLight(padded) {
    const skyLight = this._skyLight;
    const topY = WORLD_HEIGHT; // padding row above the world: open sky

    for (let localZ = -1; localZ <= CHUNK_SIZE_Z; localZ++) {
      for (let localX = -1; localX <= CHUNK_SIZE_X; localX++) {
        let light = MAX_LIGHT;
        for (let y = topY; y >= -1; y--) {
          const index = this._index(localX, y, localZ);
          skyLight[index] = light;
          if (light === 0) continue;
          const attenuation = LIGHT_ATTENUATION[padded[index]];
          if (attenuation > 0) light = light > attenuation ? light - attenuation : 0;
        }
      }
    }
  }


  /** Builds propagated block light, preferring the full cross-chunk volume. */
  _computeBlockLight(padded, lightBlocks) {
    if (lightBlocks instanceof Uint16Array && lightBlocks.length === LIGHT_VOLUME) {
      propagateBlockLight(
        lightBlocks,
        LIGHT_VOLUME_SIZE_X,
        LIGHT_VOLUME_SIZE_Y,
        LIGHT_VOLUME_SIZE_Z,
        this._largeBlockLight,
        this._largeLightQueue,
        this._largeLightQueued
      );
      extractPaddedBlockLight(this._largeBlockLight, this._blockLight);
      return;
    }
    propagatePaddedBlockLight(
      padded,
      this._blockLight,
      this._paddedLightQueue,
      this._paddedLightQueued
    );
  }

  // ------------------------------------------------------------------- cubes

  _emitCube(
    padded,
    paddedStates,
    blockId,
    state,
    localX,
    y,
    localZ,
    ambientOcclusion,
    smoothLighting,
    liquidSurface
  ) {
    const layerIndex = RENDER_LAYER[blockId];
    const buffers = this._layers[layerIndex];
    const isLiquid = IS_LIQUID[blockId] === 1;
    const sway = SWAY_CLASS[blockId];

    // Open liquid surfaces sit slightly below the block boundary so the
    // waterline is visible from above and from the side.
    let surfaceHeight = 1;
    if (isLiquid && liquidSurface) {
      const aboveIndex = this._index(localX, y + 1, localZ);
      const above = padded[aboveIndex];
      if (!IS_LIQUID[above]) {
        // Sources and falling columns are nearly full. Horizontal flowing
        // liquid descends by one eighth per level, producing visible slopes
        // without changing collision or the compact state layout.
        const level = fluidLevel(state);
        surfaceHeight = fluidIsFalling(state)
          ? LIQUID_SURFACE_HEIGHT
          : Math.max(0.125, LIQUID_SURFACE_HEIGHT - level * 0.105);
      }
    }

    let emitted = 0;
    for (let face = 0; face < 6; face++) {
      const normal = FACE_NORMAL[face];
      const neighbourX = localX + normal[0];
      const neighbourY = y + normal[1];
      const neighbourZ = localZ + normal[2];

      // Faces at the very top and bottom of the world are never visible.
      if (neighbourY < -1 || neighbourY > WORLD_HEIGHT) continue;

      const neighbourIndex = this._index(neighbourX, neighbourY, neighbourZ);
      const neighbourId = padded[neighbourIndex];
      const neighbourState = paddedStates[neighbourIndex];

      // A flowing liquid can be lower than the liquid beside it. In that case
      // the shared face is not wholly internal: only the strip above the lower
      // neighbour is visible. Treating every same-liquid boundary as hidden
      // produced holes along waterfalls and stepped streams; drawing the whole
      // face produced stacked translucent quads below the waterline. `faceFloor`
      // lets the standard quad writer emit precisely the exposed strip.
      let faceFloor = 0;
      if (isLiquid && IS_LIQUID[neighbourId]) {
        if (face === FACE_PY || face === FACE_NY) continue;

        if (neighbourId === blockId) {
          const neighbourHeight = this._liquidSurfaceHeight(
            padded,
            paddedStates,
            neighbourX,
            neighbourY,
            neighbourZ,
            neighbourState,
            liquidSurface
          );
          if (neighbourHeight >= surfaceHeight - 1e-5) continue;
          faceFloor = neighbourHeight;
        }
      }

      if (!this._faceVisible(blockId, neighbourId, isLiquid)) continue;

      this._computeCornerLighting(
        padded,
        face,
        localX,
        y,
        localZ,
        neighbourIndex,
        ambientOcclusion,
        smoothLighting
      );

      this._pushQuad(
        buffers,
        face,
        localX,
        y,
        localZ,
        STATE_FACE_TILES[(blockId * 256 + state) * 6 + face],
        surfaceHeight,
        faceFloor,
        sway,
        blockId
      );
      emitted++;
    }
    return emitted;
  }

  /**
   * The complete face-culling policy.
   *
   * Duplicated from `BlockRegistry.shouldEmitFace` in flattened form because
   * this runs once per voxel per face and the registry version's extra lookups
   * measurably show up in the profile.
   */
  _faceVisible(blockId, neighbourId, isLiquid) {
    if (neighbourId === Block.AIR) return true;
    if (IS_OPAQUE[neighbourId]) return false;
    // Same-liquid culling is state-sensitive and handled by `_emitCube` above.
    if (blockId === neighbourId && CULL_SAME[blockId] && !isLiquid) return false;
    // A liquid does not draw a face against another liquid of any kind, so a
    // lake's interior is not a stack of quads.
    if (isLiquid && IS_LIQUID[neighbourId]) return true;
    // Solids flush against a liquid still draw (you see the lake bed), but a
    // liquid does not draw against a full solid cube it is pressed into.
    if (isLiquid && RENDER_SHAPE[neighbourId] === Shape.CUBE && !IS_OPAQUE[neighbourId]) {
      return true;
    }
    return true;
  }

  /**
   * Visual top height for one liquid voxel.
   *
   * Kept in one helper so the current block and its neighbours use identical
   * rules when deciding whether a shared side is exposed.
   */
  _liquidSurfaceHeight(
    padded,
    paddedStates,
    localX,
    y,
    localZ,
    state,
    liquidSurface
  ) {
    if (!liquidSurface) return 1;
    const blockId = padded[this._index(localX, y, localZ)];
    if (!IS_LIQUID[blockId]) return 0;
    const above = padded[this._index(localX, y + 1, localZ)];
    if (IS_LIQUID[above]) return 1;

    const level = fluidLevel(state ?? paddedStates[this._index(localX, y, localZ)]);
    return fluidIsFalling(state)
      ? LIQUID_SURFACE_HEIGHT
      : Math.max(0.125, LIQUID_SURFACE_HEIGHT - level * 0.105);
  }

  /**
   * Fills `_cornerAO`, `_cornerSky` and `_cornerBlock` for the current face.
   *
   * For each of the four corners the three cells touching that corner on the
   * *air* side are inspected: two edge neighbours and the diagonal. Occlusion
   * is the classic `side1 && side2 -> fully dark` rule; light is the average
   * over the cells that are not opaque, which is what produces smooth gradients
   * across a wall instead of per-face banding.
   */
  _computeCornerLighting(
    padded,
    face,
    localX,
    y,
    localZ,
    neighbourIndex,
    ambientOcclusion,
    smoothLighting
  ) {
    const skyLight = this._skyLight;
    const baseSky = skyLight[neighbourIndex];
    const baseBlock = this._blockLight[neighbourIndex];

    if (!ambientOcclusion && !smoothLighting) {
      for (let corner = 0; corner < 4; corner++) {
        this._cornerAO[corner] = 1;
        this._cornerSky[corner] = baseSky;
        this._cornerBlock[corner] = baseBlock;
      }
      return;
    }

    const u = FACE_U[face];
    const v = FACE_V[face];
    const normal = FACE_NORMAL[face];
    const nx = localX + normal[0];
    const ny = y + normal[1];
    const nz = localZ + normal[2];

    for (let corner = 0; corner < 4; corner++) {
      const su = CORNER_SIGNS[corner][0];
      const sv = CORNER_SIGNS[corner][1];

      const sideAX = nx + u[0] * su;
      const sideAY = ny + u[1] * su;
      const sideAZ = nz + u[2] * su;
      const sideBX = nx + v[0] * sv;
      const sideBY = ny + v[1] * sv;
      const sideBZ = nz + v[2] * sv;
      const cornerX = sideAX + v[0] * sv;
      const cornerY = sideAY + v[1] * sv;
      const cornerZ = sideAZ + v[2] * sv;

      const sideAIndex = this._safeIndex(sideAX, sideAY, sideAZ);
      const sideBIndex = this._safeIndex(sideBX, sideBY, sideBZ);
      const cornerIndex = this._safeIndex(cornerX, cornerY, cornerZ);

      const sideA = sideAIndex < 0 ? 0 : IS_OPAQUE[padded[sideAIndex]];
      const sideB = sideBIndex < 0 ? 0 : IS_OPAQUE[padded[sideBIndex]];
      const diagonal = cornerIndex < 0 ? 0 : IS_OPAQUE[padded[cornerIndex]];

      if (ambientOcclusion) {
        const level = sideA && sideB ? 0 : 3 - (sideA + sideB + diagonal);
        this._cornerAO[corner] = AO_LEVELS[level];
      } else {
        this._cornerAO[corner] = 1;
      }

      if (smoothLighting) {
        let skySum = baseSky;
        let blockMax = baseBlock;
        let samples = 1;
        if (!sideA && sideAIndex >= 0) {
          skySum += skyLight[sideAIndex];
          const emitted = this._blockLight[sideAIndex];
          if (emitted > blockMax) blockMax = emitted;
          samples++;
        }
        if (!sideB && sideBIndex >= 0) {
          skySum += skyLight[sideBIndex];
          const emitted = this._blockLight[sideBIndex];
          if (emitted > blockMax) blockMax = emitted;
          samples++;
        }
        // The diagonal only contributes when it is actually reachable, i.e. at
        // least one of the two edges is open. Otherwise light would leak
        // through a solid corner.
        if (!diagonal && cornerIndex >= 0 && (!sideA || !sideB)) {
          skySum += skyLight[cornerIndex];
          const emitted = this._blockLight[cornerIndex];
          if (emitted > blockMax) blockMax = emitted;
          samples++;
        }
        this._cornerSky[corner] = skySum / samples;
        this._cornerBlock[corner] = blockMax;
      } else {
        this._cornerSky[corner] = baseSky;
        this._cornerBlock[corner] = baseBlock;
      }
    }
  }

  /** Padded index, or -1 when the coordinates fall outside the padded volume. */
  _safeIndex(localX, y, localZ) {
    if (localX < -1 || localX > CHUNK_SIZE_X) return -1;
    if (localZ < -1 || localZ > CHUNK_SIZE_Z) return -1;
    if (y < -1 || y > WORLD_HEIGHT) return -1;
    return this._index(localX, y, localZ);
  }

  /**
   * Appends one quad.
   *
   * The triangle diagonal is chosen from the ambient occlusion values: splitting
   * a quad along the darker diagonal is what keeps a corner shadow looking like
   * a smooth gradient instead of a visible crease.
   */
  _pushQuad(
    buffers,
    face,
    localX,
    y,
    localZ,
    tile,
    surfaceHeight,
    surfaceFloor,
    sway,
    blockId
  ) {
    const corners = FACE_CORNERS[face];
    const normal = FACE_NORMAL[face];
    const shade = FACE_SHADE[face];
    const u0 = TILE_UVS[tile * 4];
    const v0 = TILE_UVS[tile * 4 + 1];
    const u1 = TILE_UVS[tile * 4 + 2];
    const v1 = TILE_UVS[tile * 4 + 3];

    const base = buffers.vertexCount;
    const ao = this._cornerAO;
    const sky = this._cornerSky;
    const blockLight = this._cornerBlock;

    // UV corner order matches FACE_CORNERS: bottom-left, bottom-right,
    // top-right, top-left. `v1` is the tile's bottom edge in image space.
    const uvs = [u0, v1, u1, v1, u1, v0, u0, v0];

    for (let corner = 0; corner < 4; corner++) {
      const offsetX = corners[corner * 3];
      let offsetY = corners[corner * 3 + 1];
      const offsetZ = corners[corner * 3 + 2];
      if (offsetY === 1 && surfaceHeight !== 1) offsetY = surfaceHeight;
      if (offsetY === 0 && surfaceFloor > 0 && face !== FACE_PY && face !== FACE_NY) {
        offsetY = surfaceFloor;
      }

      buffers.positions.push3(localX + offsetX, y + offsetY, localZ + offsetZ);
      buffers.normals.push3(normal[0], normal[1], normal[2]);
      buffers.uvs.push2(uvs[corner * 2], uvs[corner * 2 + 1]);
      buffers.light.push4(
        Math.round(ao[corner] * shade * 255),
        Math.round((sky[corner] / MAX_LIGHT) * 255),
        Math.round((blockLight[corner] / MAX_LIGHT) * 255),
        sway
      );
    }
    buffers.vertexCount += 4;

    // Flip the diagonal when it reduces the AO gradient across the quad.
    const flip = ao[0] + ao[2] < ao[1] + ao[3];
    if (flip) {
      buffers.indices.push3(base + 1, base + 2, base + 3);
      buffers.indices.push3(base + 1, base + 3, base + 0);
    } else {
      buffers.indices.push3(base + 0, base + 1, base + 2);
      buffers.indices.push3(base + 0, base + 2, base + 3);
    }

    void blockId;
  }

  // ------------------------------------------------------- multi-box models

  /** Emits slabs, stairs, trapdoors and other state-dependent cuboids. */
  _emitBoxes(
    padded,
    paddedStates,
    blockId,
    state,
    localX,
    y,
    localZ,
    ambientOcclusion,
    smoothLighting
  ) {
    const boxes = getVoxelShape(blockId, state);
    const buffers = this._layers[RENDER_LAYER[blockId]];
    const tileBase = (blockId * 256 + state) * 6;
    let emitted = 0;

    for (let boxIndex = 0; boxIndex < boxes.length; boxIndex++) {
      const current = boxes[boxIndex];
      for (let face = 0; face < 6; face++) {
        if (this._boxFaceFullyCovered(current, face, boxes, boxIndex)) continue;

        const boundary = this._boxFaceBoundary(current, face);
        if (boundary) {
          const normal = FACE_NORMAL[face];
          const neighbourX = localX + normal[0];
          const neighbourY = y + normal[1];
          const neighbourZ = localZ + normal[2];
          if (neighbourY < -1 || neighbourY > WORLD_HEIGHT) continue;
          const neighbourIndex = this._index(neighbourX, neighbourY, neighbourZ);
          const neighbourId = padded[neighbourIndex];
          if (IS_OPAQUE[neighbourId]) continue;
          this._computeCornerLighting(
            padded,
            face,
            localX,
            y,
            localZ,
            neighbourIndex,
            ambientOcclusion,
            smoothLighting
          );
        } else {
          const centreIndex = this._index(localX, y, localZ);
          const sky = this._skyLight[centreIndex];
          const emittedLight = this._blockLight[centreIndex];
          for (let corner = 0; corner < 4; corner++) {
            this._cornerAO[corner] = 1;
            this._cornerSky[corner] = sky;
            this._cornerBlock[corner] = emittedLight;
          }
        }

        this._pushBoxQuad(
          buffers,
          face,
          localX,
          y,
          localZ,
          current,
          STATE_FACE_TILES[tileBase + face],
          SWAY_CLASS[blockId]
        );
        emitted++;
      }
    }
    void paddedStates;
    return emitted;
  }

  /** True when the face lies on the voxel boundary and can be hidden by a neighbour. */
  _boxFaceBoundary(box, face) {
    switch (face) {
      case FACE_PX:
        return box[3] >= 1 - 1e-6;
      case FACE_NX:
        return box[0] <= 1e-6;
      case FACE_PY:
        return box[4] >= 1 - 1e-6;
      case FACE_NY:
        return box[1] <= 1e-6;
      case FACE_PZ:
        return box[5] >= 1 - 1e-6;
      case FACE_NZ:
        return box[2] <= 1e-6;
      default:
        return false;
    }
  }

  /**
   * Removes faces wholly buried by another cuboid in the same block model.
   * Partial overlap remains; the depth buffer hides the covered portion while
   * preserving the exposed remainder without a costly polygon-splitting pass.
   */
  _boxFaceFullyCovered(box, face, boxes, ownIndex) {
    const epsilon = 1e-6;
    for (let i = 0; i < boxes.length; i++) {
      if (i === ownIndex) continue;
      const other = boxes[i];
      if (face === FACE_PX && Math.abs(other[0] - box[3]) <= epsilon) {
        if (other[1] <= box[1] + epsilon && other[4] >= box[4] - epsilon &&
            other[2] <= box[2] + epsilon && other[5] >= box[5] - epsilon) return true;
      } else if (face === FACE_NX && Math.abs(other[3] - box[0]) <= epsilon) {
        if (other[1] <= box[1] + epsilon && other[4] >= box[4] - epsilon &&
            other[2] <= box[2] + epsilon && other[5] >= box[5] - epsilon) return true;
      } else if (face === FACE_PY && Math.abs(other[1] - box[4]) <= epsilon) {
        if (other[0] <= box[0] + epsilon && other[3] >= box[3] - epsilon &&
            other[2] <= box[2] + epsilon && other[5] >= box[5] - epsilon) return true;
      } else if (face === FACE_NY && Math.abs(other[4] - box[1]) <= epsilon) {
        if (other[0] <= box[0] + epsilon && other[3] >= box[3] - epsilon &&
            other[2] <= box[2] + epsilon && other[5] >= box[5] - epsilon) return true;
      } else if (face === FACE_PZ && Math.abs(other[2] - box[5]) <= epsilon) {
        if (other[0] <= box[0] + epsilon && other[3] >= box[3] - epsilon &&
            other[1] <= box[1] + epsilon && other[4] >= box[4] - epsilon) return true;
      } else if (face === FACE_NZ && Math.abs(other[5] - box[2]) <= epsilon) {
        if (other[0] <= box[0] + epsilon && other[3] >= box[3] - epsilon &&
            other[1] <= box[1] + epsilon && other[4] >= box[4] - epsilon) return true;
      }
    }
    return false;
  }

  /** Appends one arbitrarily sized cuboid face. */
  _pushBoxQuad(buffers, face, localX, y, localZ, box, tile, sway) {
    const corners = FACE_CORNERS[face];
    const normal = FACE_NORMAL[face];
    const shade = FACE_SHADE[face];
    const u0 = TILE_UVS[tile * 4];
    const v0 = TILE_UVS[tile * 4 + 1];
    const u1 = TILE_UVS[tile * 4 + 2];
    const v1 = TILE_UVS[tile * 4 + 3];
    const uvs = [u0, v1, u1, v1, u1, v0, u0, v0];
    const base = buffers.vertexCount;

    for (let corner = 0; corner < 4; corner++) {
      const selectorX = corners[corner * 3];
      const selectorY = corners[corner * 3 + 1];
      const selectorZ = corners[corner * 3 + 2];
      const px = selectorX ? box[3] : box[0];
      const py = selectorY ? box[4] : box[1];
      const pz = selectorZ ? box[5] : box[2];
      buffers.positions.push3(localX + px, y + py, localZ + pz);
      buffers.normals.push3(normal[0], normal[1], normal[2]);
      buffers.uvs.push2(uvs[corner * 2], uvs[corner * 2 + 1]);
      buffers.light.push4(
        Math.round(this._cornerAO[corner] * shade * 255),
        Math.round((this._cornerSky[corner] / MAX_LIGHT) * 255),
        Math.round((this._cornerBlock[corner] / MAX_LIGHT) * 255),
        sway
      );
    }
    buffers.vertexCount += 4;

    const ao = this._cornerAO;
    const flip = ao[0] + ao[2] < ao[1] + ao[3];
    if (flip) {
      buffers.indices.push3(base + 1, base + 2, base + 3);
      buffers.indices.push3(base + 1, base + 3, base + 0);
    } else {
      buffers.indices.push3(base + 0, base + 1, base + 2);
      buffers.indices.push3(base + 0, base + 2, base + 3);
    }
  }

  // ------------------------------------------------------------- cross plants

  /**
   * Two intersecting quads, each emitted twice (front and back facing) so the
   * plant is visible from every direction without needing a double-sided
   * material for the whole cutout layer.
   *
   * Position is jittered deterministically from the world-independent local
   * coordinates plus the block id, which breaks up the grid without needing the
   * chunk origin.
   */
  _emitCross(padded, blockId, state, localX, y, localZ) {
    const buffers = this._layers[LAYER_CUTOUT];
    const tile = STATE_FACE_TILES[(blockId * 256 + state) * 6 + FACE_PY];
    const u0 = TILE_UVS[tile * 4];
    const v0 = TILE_UVS[tile * 4 + 1];
    const u1 = TILE_UVS[tile * 4 + 2];
    const v1 = TILE_UVS[tile * 4 + 3];

    const index = this._index(localX, y, localZ);
    const sky = (this._skyLight[index] / MAX_LIGHT) * 255;
    const emitted = (this._blockLight[index] / MAX_LIGHT) * 255;
    const sway = SWAY_CLASS[blockId];

    const jitterX = (randomFromCoords2(localX * 31 + y, localZ * 17 + blockId, 0x9e37) - 0.5) * 2 * PLANT_JITTER;
    const jitterZ = (randomFromCoords2(localZ * 29 + y, localX * 13 + blockId, 0x85eb) - 0.5) * 2 * PLANT_JITTER;
    const naturalHeight = 0.86 + randomFromCoords2(localX, localZ + y, 0x27d4) * 0.14;
    const height = Math.min(naturalHeight, STATE_RENDER_HEIGHT[blockId * 256 + state]);

    const centreX = localX + 0.5 + jitterX;
    const centreZ = localZ + 0.5 + jitterZ;
    const reach = PLANT_REACH;

    // Two diagonal planes.
    const planes = [
      [centreX - reach, centreZ - reach, centreX + reach, centreZ + reach],
      [centreX + reach, centreZ - reach, centreX - reach, centreZ + reach],
    ];

    let faces = 0;
    for (let p = 0; p < planes.length; p++) {
      const [ax, az, bx, bz] = planes[p];
      // Normal is perpendicular to the plane, normalised in the XZ plane.
      const dx = bx - ax;
      const dz = bz - az;
      const inverseLength = 1 / Math.hypot(dx, dz);
      const nx = -dz * inverseLength;
      const nz = dx * inverseLength;

      for (let side = 0; side < 2; side++) {
        const sign = side === 0 ? 1 : -1;
        const base = buffers.vertexCount;

        // Winding is reversed for the back face so both sides face outwards.
        const first = side === 0 ? [ax, az] : [bx, bz];
        const second = side === 0 ? [bx, bz] : [ax, az];

        buffers.positions.push3(first[0], y, first[1]);
        buffers.positions.push3(second[0], y, second[1]);
        buffers.positions.push3(second[0], y + height, second[1]);
        buffers.positions.push3(first[0], y + height, first[1]);

        for (let corner = 0; corner < 4; corner++) {
          buffers.normals.push3(nx * sign, 0, nz * sign);
          buffers.light.push4(255, Math.round(sky), Math.round(emitted), sway);
        }

        buffers.uvs.push2(u0, v1);
        buffers.uvs.push2(u1, v1);
        buffers.uvs.push2(u1, v0);
        buffers.uvs.push2(u0, v0);

        buffers.indices.push3(base + 0, base + 1, base + 2);
        buffers.indices.push3(base + 0, base + 2, base + 3);
        buffers.vertexCount += 4;
        faces++;
      }
    }

    void padded;
    return faces;
  }

  /**
   * A paper-thin horizontal surface for redstone wire and repeaters.
   *
   * It sits one half-pixel above the supporting voxel, which avoids z-fighting
   * without making components look like full slabs. The atlas tile supplies all
   * connection/orientation detail.
   */
  _emitPlate(padded, blockId, state, localX, y, localZ) {
    const buffers = this._layers[RENDER_LAYER[blockId]];
    const index = this._index(localX, y, localZ);
    const sky = Math.round((this._skyLight[index] / MAX_LIGHT) * 255);
    const emitted = Math.round((this._blockLight[index] / MAX_LIGHT) * 255);
    const tile = STATE_FACE_TILES[(blockId * 256 + state) * 6 + FACE_PY];
    const u0 = TILE_UVS[tile * 4];
    const v0 = TILE_UVS[tile * 4 + 1];
    const u1 = TILE_UVS[tile * 4 + 2];
    const v1 = TILE_UVS[tile * 4 + 3];
    const plateY = y + 0.03125;
    const base = buffers.vertexCount;

    buffers.positions.push3(localX, plateY, localZ + 1);
    buffers.positions.push3(localX + 1, plateY, localZ + 1);
    buffers.positions.push3(localX + 1, plateY, localZ);
    buffers.positions.push3(localX, plateY, localZ);
    for (let corner = 0; corner < 4; corner++) {
      buffers.normals.push3(0, 1, 0);
      buffers.light.push4(255, sky, emitted, 0);
    }
    buffers.uvs.push2(u0, v1);
    buffers.uvs.push2(u1, v1);
    buffers.uvs.push2(u1, v0);
    buffers.uvs.push2(u0, v0);
    buffers.indices.push3(base + 0, base + 1, base + 2);
    buffers.indices.push3(base + 0, base + 2, base + 3);
    buffers.vertexCount += 4;

    void padded;
    return 1;
  }

  /**
   * A thin centred column, used for torches: four sides plus a cap.
   * Emitted as a shrunken cube so it reuses the standard quad path.
   */
  _emitPost(padded, blockId, state, localX, y, localZ) {
    const buffers = this._layers[LAYER_CUTOUT];
    const index = this._index(localX, y, localZ);
    const sky = Math.round((this._skyLight[index] / MAX_LIGHT) * 255);
    const emitted = Math.round((this._blockLight[index] / MAX_LIGHT) * 255);

    const half = 0.0625; // 1/16 of a block either side of centre
    const height = 0.625;
    const minX = localX + 0.5 - half;
    const maxX = localX + 0.5 + half;
    const minZ = localZ + 0.5 - half;
    const maxZ = localZ + 0.5 + half;
    const minY = y;
    const maxY = y + height;

    const tileSide = STATE_FACE_TILES[(blockId * 256 + state) * 6 + FACE_PX];
    const tileTop = STATE_FACE_TILES[(blockId * 256 + state) * 6 + FACE_PY];

    /** Emits one axis-aligned quad from four explicit corners. */
    const quad = (points, normal, tile, shade) => {
      const base = buffers.vertexCount;
      const u0 = TILE_UVS[tile * 4];
      const v0 = TILE_UVS[tile * 4 + 1];
      const u1 = TILE_UVS[tile * 4 + 2];
      const v1 = TILE_UVS[tile * 4 + 3];
      const uvs = [u0, v1, u1, v1, u1, v0, u0, v0];
      for (let corner = 0; corner < 4; corner++) {
        buffers.positions.push3(points[corner * 3], points[corner * 3 + 1], points[corner * 3 + 2]);
        buffers.normals.push3(normal[0], normal[1], normal[2]);
        buffers.uvs.push2(uvs[corner * 2], uvs[corner * 2 + 1]);
        buffers.light.push4(Math.round(shade * 255), sky, emitted, 0);
      }
      buffers.indices.push3(base + 0, base + 1, base + 2);
      buffers.indices.push3(base + 0, base + 2, base + 3);
      buffers.vertexCount += 4;
    };

    quad([maxX, minY, maxZ, maxX, minY, minZ, maxX, maxY, minZ, maxX, maxY, maxZ], FACE_NORMAL[FACE_PX], tileSide, FACE_SHADE[FACE_PX]);
    quad([minX, minY, minZ, minX, minY, maxZ, minX, maxY, maxZ, minX, maxY, minZ], FACE_NORMAL[FACE_NX], tileSide, FACE_SHADE[FACE_NX]);
    quad([minX, minY, maxZ, maxX, minY, maxZ, maxX, maxY, maxZ, minX, maxY, maxZ], FACE_NORMAL[FACE_PZ], tileSide, FACE_SHADE[FACE_PZ]);
    quad([maxX, minY, minZ, minX, minY, minZ, minX, maxY, minZ, maxX, maxY, minZ], FACE_NORMAL[FACE_NZ], tileSide, FACE_SHADE[FACE_NZ]);
    quad([minX, maxY, maxZ, maxX, maxY, maxZ, maxX, maxY, minZ, minX, maxY, minZ], FACE_NORMAL[FACE_PY], tileTop, FACE_SHADE[FACE_PY]);

    void padded;
    return 5;
  }
}

/** Layer index constants re-exported for callers that build meshes. */
export const MesherLayers = Object.freeze({
  OPAQUE: LAYER_OPAQUE,
  CUTOUT: LAYER_CUTOUT,
  LIQUID: LAYER_LIQUID,
});

export default ChunkMesher;
