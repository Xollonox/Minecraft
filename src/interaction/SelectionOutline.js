/**
 * Block selection outline and break-progress overlay.
 *
 * ## Avoiding z-fighting
 *
 * The outline is a wireframe box drawn *exactly* on the surface of the targeted
 * block, which is the definition of coplanar geometry — the worst case for a depth
 * buffer. Three things fix it together:
 *
 *  1. the box is scaled up by a hair so it sits marginally outside the block;
 *  2. `polygonOffset` biases its depth values towards the camera in hardware,
 *     which is resolution-independent in a way that a fixed scale is not;
 *  3. `depthWrite` is off, so the outline never occludes anything itself.
 *
 * Using all three means the outline stays solid at any distance and any render
 * scale, instead of flickering when the depth precision runs out far away.
 *
 * ## Break progress
 *
 * A second, slightly larger box textured with a procedurally generated eight-stage
 * crack sheet. The stage is selected by offsetting the texture rather than by
 * swapping textures or materials, so changing the progress costs two float writes.
 */

import * as THREE from 'three';

import { mulberry32 } from '../utils/MathUtils.js';
import { getShapeBounds, getVoxelShape, hasCustomVoxelShape } from '../world/BlockModels.js';

/** Number of crack stages in the generated sheet. */
const CRACK_STAGES = 8;
/** Pixel size of one crack stage. */
const CRACK_TILE = 16;

export class SelectionOutline {
  /**
   * @param {Object} options
   * @param {THREE.Scene} options.scene
   * @param {import('../core/ResourceManager.js').ResourceManager} options.resources
   */
  constructor({ scene, resources }) {
    this._scene = scene;
    this._resources = resources;

    this.group = new THREE.Group();
    this.group.name = 'selection';
    this.group.matrixAutoUpdate = false;
    scene.add(this.group);

    // --- outline ---
    const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    this._edgesGeometry = new THREE.EdgesGeometry(boxGeometry);
    boxGeometry.dispose();

    this._outlineMaterial = new THREE.LineBasicMaterial({
      color: 0x0a0a0a,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      // Bias towards the camera so coplanar lines always win the depth test.
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
      fog: false,
      toneMapped: false,
    });

    this.outline = new THREE.LineSegments(this._edgesGeometry, this._outlineMaterial);
    this.outline.name = 'selection-outline';
    this.outline.frustumCulled = false;
    this.outline.renderOrder = 950;
    this.outline.visible = false;
    // The block is centred at its integer coordinate plus a half, and the box is
    // grown fractionally so it clears the block's own faces.
    this.outline.scale.setScalar(1.002);
    this.group.add(this.outline);

    // --- break overlay ---
    this._crackTexture = this._createCrackTexture();
    this._overlayGeometry = new THREE.BoxGeometry(1, 1, 1);
    this._overlayMaterial = new THREE.MeshBasicMaterial({
      map: this._crackTexture,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      fog: false,
      toneMapped: false,
      side: THREE.FrontSide,
    });

    this.overlay = new THREE.Mesh(this._overlayGeometry, this._overlayMaterial);
    this.overlay.name = 'break-overlay';
    this.overlay.frustumCulled = false;
    this.overlay.renderOrder = 951;
    this.overlay.visible = false;
    this.overlay.scale.setScalar(1.004);
    this.group.add(this.overlay);

    resources.acquireShared('selection:edges', () => this._edgesGeometry);
    resources.acquireShared('selection:outline-material', () => this._outlineMaterial);
    resources.acquireShared('selection:overlay-geometry', () => this._overlayGeometry);
    resources.acquireShared('selection:overlay-material', () => this._overlayMaterial);
    resources.acquireShared('selection:crack-texture', () => this._crackTexture);
  }

  /**
   * Generates the crack sheet: `CRACK_STAGES` frames stacked vertically, each
   * adding more fracture lines than the last.
   *
   * Building it cumulatively (each stage keeps the previous stage's cracks and
   * adds to them) is what makes the animation read as a single crack spreading
   * rather than a flicker of unrelated patterns.
   */
  _createCrackTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = CRACK_TILE;
    canvas.height = CRACK_TILE * CRACK_STAGES;
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);

    // Fixed seed so the crack pattern is identical every session.
    const random = mulberry32(0x0c4ac41f);
    /** @type {Array<Array<[number, number]>>} Accumulated crack pixels per stage. */
    const accumulated = [];
    /** @type {Array<[number, number]>} */
    let pixels = [];

    for (let stage = 0; stage < CRACK_STAGES; stage++) {
      // Each stage grows one or two new fracture lines from a random seed point.
      const branches = stage === 0 ? 1 : 2;
      for (let branch = 0; branch < branches; branch++) {
        let x = Math.floor(random() * CRACK_TILE);
        let y = Math.floor(random() * CRACK_TILE);
        const length = 3 + Math.floor(random() * (3 + stage * 2));
        // Bias each crack along one dominant direction so it looks like a split.
        const horizontal = random() > 0.5;
        for (let i = 0; i < length; i++) {
          pixels.push([x, y]);
          if (horizontal) {
            x += random() > 0.2 ? 1 : 0;
            y += random() > 0.55 ? 1 : random() > 0.5 ? -1 : 0;
          } else {
            y += random() > 0.2 ? 1 : 0;
            x += random() > 0.55 ? 1 : random() > 0.5 ? -1 : 0;
          }
          x = (x + CRACK_TILE) % CRACK_TILE;
          y = (y + CRACK_TILE) % CRACK_TILE;
        }
      }
      accumulated.push(pixels.slice());
      pixels = accumulated[accumulated.length - 1];
    }

    // Paint each stage.
    for (let stage = 0; stage < CRACK_STAGES; stage++) {
      const offsetY = stage * CRACK_TILE;
      const image = context.createImageData(CRACK_TILE, CRACK_TILE);
      for (const [x, y] of accumulated[stage]) {
        const index = (y * CRACK_TILE + x) * 4;
        image.data[index] = 12;
        image.data[index + 1] = 12;
        image.data[index + 2] = 14;
        image.data[index + 3] = 235;
      }
      context.putImageData(image, 0, offsetY);
    }

    const texture = new THREE.Texture(canvas);
    texture.flipY = false;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    // Show one stage at a time; `offset.y` selects which.
    texture.repeat.set(1, 1 / CRACK_STAGES);
    texture.needsUpdate = true;
    return texture;
  }

  /**
   * Positions the outline over a target and sets the break stage.
   *
   * @param {import('./BlockRaycaster.js').RaycastHit|null} target
   * @param {number} breakProgress 0..1; 0 hides the crack overlay.
   */
  update(target, breakProgress = 0) {
    if (!target || !target.hit) {
      this.outline.visible = false;
      this.overlay.visible = false;
      return;
    }

    let minX = 0;
    let minY = 0;
    let minZ = 0;
    let maxX = 1;
    let maxY = 1;
    let maxZ = 1;
    if (hasCustomVoxelShape(target.blockId)) {
      const bounds = getShapeBounds(getVoxelShape(target.blockId, target.blockState ?? 0));
      if (bounds) ({ minX, minY, minZ, maxX, maxY, maxZ } = bounds);
    }

    const centreX = target.blockX + (minX + maxX) * 0.5;
    const centreY = target.blockY + (minY + maxY) * 0.5;
    const centreZ = target.blockZ + (minZ + maxZ) * 0.5;
    const sizeX = maxX - minX;
    const sizeY = maxY - minY;
    const sizeZ = maxZ - minZ;

    this.outline.position.set(centreX, centreY, centreZ);
    this.outline.scale.set(sizeX * 1.002, sizeY * 1.002, sizeZ * 1.002);
    this.outline.visible = true;

    if (breakProgress > 0.001) {
      const stage = Math.min(CRACK_STAGES - 1, Math.floor(breakProgress * CRACK_STAGES));
      this._crackTexture.offset.y = stage / CRACK_STAGES;
      this.overlay.position.set(centreX, centreY, centreZ);
      this.overlay.scale.set(sizeX * 1.004, sizeY * 1.004, sizeZ * 1.004);
      this.overlay.visible = true;
    } else {
      this.overlay.visible = false;
    }
  }

  /** Hides both meshes. */
  hide() {
    this.outline.visible = false;
    this.overlay.visible = false;
  }

  /** Removes the meshes and releases the shared resources. */
  destroy() {
    this.group.remove(this.outline);
    this.group.remove(this.overlay);
    if (this.group.parent) this.group.parent.remove(this.group);
    this._resources.releaseShared('selection:edges');
    this._resources.releaseShared('selection:outline-material');
    this._resources.releaseShared('selection:overlay-geometry');
    this._resources.releaseShared('selection:overlay-material');
    this._resources.releaseShared('selection:crack-texture');
  }
}

export default SelectionOutline;
