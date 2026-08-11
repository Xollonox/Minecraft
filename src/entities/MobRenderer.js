/**
 * Instanced renderer for living voxel creatures.
 *
 * Every mob type owns one merged geometry and one `InstancedMesh`; adding twenty
 * cows changes the instance count, not the draw-call count. Body boxes carry a
 * limb role and pivot, so walking/head animation happens in the vertex shader
 * without scene-graph nodes per creature.
 */

import * as THREE from 'three';

import { ENTITIES } from '../config/GameConfig.js';
import { TILE_UVS } from '../world/AtlasLayout.js';
import { TILE_INDEX } from '../world/BlockTypes.js';
import { MOB_DEFINITIONS } from './MobTypes.js';
import { MobAnimator } from './MobAnimator.js';
import { MOB_SKELETONS } from './MobSkeletons.js';
import { MobPoseBuffer } from '../rendering/MobPoseBuffer.js';

const MOB_VERTEX_SHADER = /* glsl */ `
  attribute float aShade;
  attribute float aBone;
  attribute float aInstanceRow;
  attribute vec4 aMobAnim; // hurt, alive, unused, unused

  uniform vec4 uTileRect;
  uniform sampler2D uBones;
  uniform vec2 uBoneTexSize;

  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;
  varying float vViewDepth;
  varying float vShade;
  varying float vHurt;

  vec4 boneRow(float bone, float row) {
    vec2 uv = vec2((bone * 3.0 + row + 0.5) / uBoneTexSize.x,
                    (aInstanceRow + 0.5) / uBoneTexSize.y);
    return texture2D(uBones, uv);
  }

  void main() {
    vec4 r0 = boneRow(aBone, 0.0);
    vec4 r1 = boneRow(aBone, 1.0);
    vec4 r2 = boneRow(aBone, 2.0);
    vec4 source = vec4(position, 1.0);
    vec3 localPosition = vec3(dot(r0, source), dot(r1, source), dot(r2, source));
    vec3 localNormal = normalize(vec3(dot(r0.xyz, normal), dot(r1.xyz, normal), dot(r2.xyz, normal)));

    vec4 worldPosition = modelMatrix * instanceMatrix * vec4(localPosition, 1.0);
    vWorldPosition = worldPosition.xyz;
    mat3 normalMatrixWorld = mat3(modelMatrix) * mat3(instanceMatrix);
    vWorldNormal = normalize(normalMatrixWorld * localNormal);
    vUv = mix(uTileRect.xy, uTileRect.zw, uv);
    vShade = aShade;
    vHurt = aMobAnim.x;

    vec4 viewPosition = viewMatrix * worldPosition;
    vViewDepth = -viewPosition.z;
    gl_Position = projectionMatrix * viewPosition;
  }
`;

const MOB_FRAGMENT_SHADER = /* glsl */ `
  #include <common>

  uniform sampler2D uAtlas;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform vec3 uSkyAmbient;
  uniform vec3 uGroundAmbient;
  uniform float uCaveAmbient;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uFogStrength;
  uniform float uBrightness;

  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;
  varying float vViewDepth;
  varying float vShade;
  varying float vHurt;

  void main() {
    vec4 texel = texture2D(uAtlas, vUv);
    if (texel.a < 0.4) discard;

    vec3 normal = normalize(vWorldNormal);
    float hemisphere = normal.y * 0.5 + 0.5;
    vec3 ambient = mix(uGroundAmbient, uSkyAmbient, hemisphere);
    float ndotl = max(dot(normal, uSunDirection), 0.0);
    vec3 lighting = ambient + uSunColor * ndotl * 0.82 + vec3(uCaveAmbient);

    // Sky rim light pops silhouettes out of dark backdrops, the way creatures
    // separate from the fog in modern Minecraft shader packs.
    vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
    float rim = pow(1.0 - max(dot(normal, viewDirection), 0.0), 3.0);
    lighting += uSkyAmbient * (rim * 0.4);

    vec3 base = texel.rgb * vShade;
    base = mix(base, vec3(1.0, 0.16, 0.12), clamp(vHurt, 0.0, 0.72));
    vec3 color = base * lighting * uBrightness;
    float fog = smoothstep(uFogNear, uFogFar, vViewDepth) * uFogStrength;
    color = mix(color, uFogColor, fog);

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Merges a skeleton's bone-local boxes and records one bone index per vertex. */
function buildMobGeometry(rig) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const bones = [];
  const shades = [];
  const indices = [];
  let vertexBase = 0;

  for (let boneIndex = 0; boneIndex < rig.skeleton.bones.length; boneIndex++) {
    const bone = rig.skeleton.bones[boneIndex];
    for (const part of bone.boxes ?? []) {
    const geometry = new THREE.BoxGeometry(part.size[0], part.size[1], part.size[2]);
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');

    for (let vertex = 0; vertex < position.count; vertex++) {
      positions.push(
        position.getX(vertex) + part.offset[0],
        position.getY(vertex) + part.offset[1],
        position.getZ(vertex) + part.offset[2]
      );
      normals.push(normal.getX(vertex), normal.getY(vertex), normal.getZ(vertex));
      uvs.push(uv.getX(vertex), uv.getY(vertex));
      bones.push(boneIndex);
      shades.push(part.shade ?? 1);
    }

    const sourceIndices = geometry.index;
    if (sourceIndices) {
      for (let index = 0; index < sourceIndices.count; index++) {
        indices.push(vertexBase + sourceIndices.getX(index));
      }
    } else {
      for (let index = 0; index < position.count; index++) indices.push(vertexBase + index);
    }
    vertexBase += position.count;
    geometry.dispose();
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('aBone', new THREE.Float32BufferAttribute(bones, 1));
  geometry.setAttribute('aShade', new THREE.Float32BufferAttribute(shades, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const animation = new THREE.InstancedBufferAttribute(
    new Float32Array(ENTITIES.maxMobs * 4),
    4
  );
  animation.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aMobAnim', animation);
  const rows = new THREE.InstancedBufferAttribute(new Float32Array(ENTITIES.maxMobs), 1);
  for (let i = 0; i < ENTITIES.maxMobs; i++) rows.setX(i, i);
  geometry.setAttribute('aInstanceRow', rows);
  return geometry;
}

function createMaterial(atlasTexture, tile, poseTexture, poseBuffer) {
  const base = tile * 4;
  return new THREE.ShaderMaterial({
    name: `mob-${tile}`,
    uniforms: {
      uAtlas: { value: atlasTexture },
      uTileRect: {
        value: new THREE.Vector4(
          TILE_UVS[base],
          TILE_UVS[base + 1],
          TILE_UVS[base + 2],
          TILE_UVS[base + 3]
        ),
      },
      uSunDirection: { value: new THREE.Vector3(0.4, 0.85, 0.3).normalize() },
      uSunColor: { value: new THREE.Color(1, 0.97, 0.9) },
      uSkyAmbient: { value: new THREE.Color(0.42, 0.5, 0.62) },
      uGroundAmbient: { value: new THREE.Color(0.2, 0.19, 0.16) },
      uCaveAmbient: { value: 0.035 },
      uFogColor: { value: new THREE.Color(0.62, 0.74, 0.9) },
      uFogNear: { value: 40 },
      uFogFar: { value: 160 },
      uFogStrength: { value: 1 },
      uBrightness: { value: 1 },
      uBones: { value: poseTexture },
      uBoneTexSize: { value: new THREE.Vector2(poseBuffer.width, poseBuffer.height) },
    },
    vertexShader: MOB_VERTEX_SHADER,
    fragmentShader: MOB_FRAGMENT_SHADER,
    fog: false,
    toneMapped: true,
  });
}

export class MobRenderer {
  constructor({ scene, atlasTexture, resources }) {
    this._scene = scene;
    this._resources = resources;
    this._entries = new Map();
    this._matrix = new THREE.Matrix4();
    this._position = new THREE.Vector3();
    this._quaternion = new THREE.Quaternion();
    this._scale = new THREE.Vector3(1, 1, 1);
    this._shadowScale = new THREE.Vector3(1, 1, 1);
    this._shadowQuaternion = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(-Math.PI / 2, 0, 0)
    );
    this._shadowMatrix = new THREE.Matrix4();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._animators = new Map();
    this._animatorKeys = new WeakMap();
    this._nextAnimatorKey = 1;
    this._lastSync = null;

    // One translucent instance pool grounds every rig against the voxel terrain.
    // It adds a single draw call instead of a separate shadow mesh per creature.
    this._shadowGeometry = new THREE.CircleGeometry(1, 20);
    this._shadowMaterial = new THREE.MeshBasicMaterial({
      name:'mob-contact-shadows',
      color:0x000000,
      transparent:true,
      opacity:.2,
      depthWrite:false,
      polygonOffset:true,
      polygonOffsetFactor:-1,
    });
    this.shadowMesh = new THREE.InstancedMesh(
      this._shadowGeometry,
      this._shadowMaterial,
      ENTITIES.maxMobs
    );
    this.shadowMesh.name = 'mob-contact-shadows';
    this.shadowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shadowMesh.count = 0;
    this.shadowMesh.visible = false;
    this.shadowMesh.frustumCulled = false;
    scene.add(this.shadowMesh);
    resources.trackTransient(this._shadowGeometry);
    resources.trackTransient(this._shadowMaterial);

    for (const definition of MOB_DEFINITIONS) {
      const tile = TILE_INDEX[definition.tileName];
      if (tile === undefined) throw new Error(`Mob ${definition.id} has no atlas tile ${definition.tileName}`);
      const rig = MOB_SKELETONS[definition.id];
      if (!rig) throw new Error(`Mob ${definition.id} has no skeletal rig`);
      const geometry = buildMobGeometry(rig);
      const poseBuffer = new MobPoseBuffer({ boneCount: rig.skeleton.bones.length, maxInstances: ENTITIES.maxMobs });
      const poseTexture = new THREE.DataTexture(
        poseBuffer.data,
        poseBuffer.width,
        poseBuffer.height,
        THREE.RGBAFormat,
        THREE.FloatType
      );
      poseTexture.name = `mob-bones-${definition.id}`;
      poseTexture.minFilter = THREE.NearestFilter;
      poseTexture.magFilter = THREE.NearestFilter;
      poseTexture.generateMipmaps = false;
      poseTexture.needsUpdate = true;
      const material = createMaterial(atlasTexture, tile, poseTexture, poseBuffer);
      const mesh = new THREE.InstancedMesh(geometry, material, ENTITIES.maxMobs);
      mesh.name = `mobs-${definition.id}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      resources.trackTransient(geometry);
      resources.trackTransient(material);
      this._entries.set(definition.id, { definition, geometry, material, mesh, poseBuffer, poseTexture });
    }
  }

  sync(mobs) {
    /** @type {Map<string, number>} */
    const counts = new Map();
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    const dt = this._lastSync === null ? 0 : Math.min(0.25, Math.max(0, now - this._lastSync));
    this._lastSync = now;
    const liveAnimatorKeys = new Set();
    let shadowCount = 0;
    for (const [id, entry] of this._entries) {
      counts.set(id, 0);
    }

    for (const mob of mobs) {
      if (!mob.alive || !mob.mobId) continue;
      const entry = this._entries.get(mob.mobId);
      if (!entry) continue;
      const index = counts.get(mob.mobId) ?? 0;
      if (index >= ENTITIES.maxMobs) continue;

      const deathProgress = mob.isDead
        ? 1 - Math.max(0, Math.min(1, mob.deathTimer / 0.65))
        : 0;
      this._position.set(mob.x, mob.y, mob.z);
      this._euler.set(0, mob.facing, -deathProgress * Math.PI * 0.48, 'YXZ');
      this._quaternion.setFromEuler(this._euler);
      this._scale.setScalar(mob.ageScale ?? 1);
      this._matrix.compose(this._position, this._quaternion, this._scale);
      entry.mesh.setMatrixAt(index, this._matrix);

      if (shadowCount < ENTITIES.maxMobs && !mob.inLiquid) {
        const radius = Math.max(.2, (mob.halfSize ?? .35) * 1.18 * (mob.ageScale ?? 1));
        this._position.set(mob.x, mob.y + .018, mob.z);
        this._shadowScale.set(radius, radius, radius);
        this._shadowMatrix.compose(this._position, this._shadowQuaternion, this._shadowScale);
        this.shadowMesh.setMatrixAt(shadowCount++, this._shadowMatrix);
      }

      let objectKey = this._animatorKeys.get(mob);
      if (objectKey === undefined) {
        objectKey = this._nextAnimatorKey++;
        this._animatorKeys.set(mob, objectKey);
      }
      const animatorKey = `${mob.mobId}:${mob.uuid ?? objectKey}`;
      liveAnimatorKeys.add(animatorKey);
      let animator = this._animators.get(animatorKey);
      if (!animator || animator.mobId !== mob.mobId) {
        animator = new MobAnimator(mob.mobId);
        this._animators.set(animatorKey, animator);
      }
      animator.update(dt, {
        speed: Math.hypot(mob.velocityX ?? 0, mob.velocityZ ?? 0),
        isDead: mob.isDead,
        attacking: mob.justAttacked || mob.attackCooldown > 0,
        casting: entry.definition.ranged && mob.attackCooldown > 0,
        onGround: mob.onGround,
        hurt: mob.justHurt || mob.hurtFlash > 0,
        headYaw: mob.headYaw,
      });
      entry.poseBuffer.writeSkeleton(index, animator.skeleton);

      const animation = entry.geometry.getAttribute('aMobAnim');
      animation.setXYZW(
        index,
        Math.min(1, mob.hurtFlash / 0.28),
        mob.isDead ? 0 : 1,
        0,
        0
      );
      counts.set(mob.mobId, index + 1);
    }

    for (const [id, entry] of this._entries) {
      const count = counts.get(id) ?? 0;
      entry.mesh.count = count;
      entry.mesh.visible = count > 0;
      if (count > 0) {
        entry.mesh.instanceMatrix.needsUpdate = true;
        entry.geometry.getAttribute('aMobAnim').needsUpdate = true;
        entry.poseTexture.needsUpdate = entry.poseBuffer.dirty;
        entry.poseBuffer.dirty = false;
      }
    }
    for (const key of this._animators.keys()) {
      if (!liveAnimatorKeys.has(key)) this._animators.delete(key);
    }
    this.shadowMesh.count = shadowCount;
    this.shadowMesh.visible = shadowCount > 0;
    if (shadowCount > 0) this.shadowMesh.instanceMatrix.needsUpdate = true;
  }

  applyLighting(state) {
    for (const { material } of this._entries.values()) {
      const uniforms = material.uniforms;
      uniforms.uSunDirection.value.copy(state.sunDirection);
      uniforms.uSunColor.value.copy(state.sunColor);
      uniforms.uSkyAmbient.value.copy(state.skyAmbient);
      uniforms.uGroundAmbient.value.copy(state.groundAmbient);
      uniforms.uCaveAmbient.value = state.caveAmbient;
      uniforms.uFogColor.value.copy(state.fogColor);
      uniforms.uFogNear.value = state.fogNear;
      uniforms.uFogFar.value = state.fogFar;
      uniforms.uFogStrength.value = state.fogStrength;
      uniforms.uBrightness.value = state.brightness;
    }
  }

  clear() {
    for (const { mesh } of this._entries.values()) {
      mesh.count = 0;
      mesh.visible = false;
    }
    this.shadowMesh.count = 0;
    this.shadowMesh.visible = false;
  }

  destroy() {
    this.clear();
    for (const { mesh, geometry, material, poseTexture } of this._entries.values()) {
      this._scene.remove(mesh);
      this._resources.releaseTransient(geometry);
      this._resources.releaseTransient(material);
      mesh.dispose();
      poseTexture.dispose();
    }
    this._entries.clear();
    this._animators.clear();
    this._scene.remove(this.shadowMesh);
    this._resources.releaseTransient(this._shadowGeometry);
    this._resources.releaseTransient(this._shadowMaterial);
    this.shadowMesh.dispose();
  }
}

export default MobRenderer;
