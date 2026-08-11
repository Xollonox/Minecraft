/** Dedicated articulated Ender Dragon, crystal and healing-beam renderer. */

import * as THREE from 'three';
import { Skeleton } from './SkeletalModel.js';
import { AnimationController } from './AnimationController.js';
import { MOB_SKELETONS } from '../entities/MobSkeletons.js';
import { DragonFlightState } from '../progression/EnderDragon.js';

export class EnderDragonRenderer {
  constructor({ scene, resources = null } = {}) {
    this.scene = scene;
    this.resources = resources;
    const rig = MOB_SKELETONS.ender_dragon;
    this.skeleton = new Skeleton(rig.skeleton);
    this.animator = new AnimationController(rig.clips, { initial:'idle' });
    this.group = new THREE.Group();
    this.group.name = 'ender-dragon-rig';
    this.group.visible = false;
    scene.add(this.group);

    this.material = new THREE.MeshStandardMaterial({
      name:'ender-dragon', color:0x19131f, roughness:.72, metalness:.08,
      emissive:0x14051c, emissiveIntensity:.28,
    });
    this.meshes = [];
    for (let boneIndex = 0; boneIndex < this.skeleton.bones.length; boneIndex++) {
      const bone = this.skeleton.bones[boneIndex];
      for (const part of bone.boxes ?? []) {
        const geometry = new THREE.BoxGeometry(...part.size);
        geometry.translate(...part.offset);
        const mesh = new THREE.Mesh(geometry, this.material);
        mesh.name = `dragon-${bone.name}`;
        mesh.matrixAutoUpdate = false;
        mesh.frustumCulled = false;
        mesh.userData.boneIndex = boneIndex;
        this.group.add(mesh);
        this.meshes.push(mesh);
      }
    }

    this.eyeMaterial = new THREE.MeshBasicMaterial({ color:0xe462ff });
    this.eyes = [-.42,.42].map((x) => {
      const geometry = new THREE.BoxGeometry(.24,.13,.08);
      geometry.translate(x, .2, 1.82);
      const mesh = new THREE.Mesh(geometry, this.eyeMaterial);
      mesh.name = 'dragon-eye';
      const headIndex = this.skeleton.indexOf.get('head');
      mesh.userData.boneIndex = headIndex;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      this.meshes.push(mesh);
      return mesh;
    });

    this.crystalMaterial = new THREE.MeshStandardMaterial({
      color:0xe6b2ff, emissive:0xa62ee8, emissiveIntensity:1.8,
      roughness:.18, metalness:.35,
    });
    this.crystals = Array.from({ length:10 }, (_, index) => {
      const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(.62, 0), this.crystalMaterial);
      crystal.name = `end-crystal-${index}`;
      crystal.visible = false;
      scene.add(crystal);
      const beamGeometry = new THREE.BufferGeometry();
      beamGeometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
      const beam = new THREE.Line(beamGeometry, new THREE.LineBasicMaterial({
        color:0xd86cff, transparent:true, opacity:.62, depthWrite:false,
      }));
      beam.name = `crystal-beam-${index}`;
      beam.visible = false;
      scene.add(beam);
      return { crystal, beam };
    });

    const deathPositions = new Float32Array(96 * 3);
    this.deathBurst = new THREE.Points(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(deathPositions, 3)),
      new THREE.PointsMaterial({
        color:0xd97bff, size:.42, transparent:true, opacity:0,
        depthWrite:false, blending:THREE.AdditiveBlending,
      })
    );
    this.deathBurst.name = 'dragon-death-xp-burst';
    this.deathBurst.visible = false;
    scene.add(this.deathBurst);

    this.deathBeams = Array.from({ length:8 }, (_, index) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
      const beam = new THREE.Line(geometry, new THREE.LineBasicMaterial({
        color:index % 2 ? 0xffffff : 0xe6a2ff,
        transparent:true, opacity:0, depthWrite:false, blending:THREE.AdditiveBlending,
      }));
      beam.visible = false;
      beam.name = `dragon-death-beam-${index}`;
      scene.add(beam);
      return beam;
    });

    this._root = new THREE.Matrix4();
    this._rotation = new THREE.Matrix4();
    this._translation = new THREE.Matrix4();
    this._bone = new THREE.Matrix4();
    this._world = new THREE.Matrix4();
    this._time = 0;
  }

  update(fight, dt) {
    this._time += Math.max(0, dt || 0);
    if (!fight) {
      this.setVisible(false);
      return;
    }
    this.setVisible(true);
    const clip = fight.flightState === DragonFlightState.DEATH ? 'death'
      : fight.flightState === DragonFlightState.BREATH ? 'cast'
      : fight.flightState === DragonFlightState.FIREBALL ? 'cast'
      : fight.flightState === DragonFlightState.CHARGE ? 'attack'
      : fight.perched ? 'idle' : 'run';
    this.animator.crossFade(clip, .2);
    this.animator.update(dt);
    this.skeleton.applyPose(this.animator.getPose());

    this._translation.makeTranslation(fight.position.x, fight.position.y, fight.position.z);
    this._rotation.makeRotationY(fight.yaw);
    this._root.multiplyMatrices(this._translation, this._rotation);
    for (const mesh of this.meshes) {
      const index = mesh.userData.boneIndex;
      this._bone.fromArray(this.skeleton.world, index * 16);
      mesh.matrix.multiplyMatrices(this._root, this._bone);
      mesh.matrixWorldNeedsUpdate = true;
    }
    this.material.opacity = fight.flightState === DragonFlightState.DEATH
      ? Math.max(.12, 1 - fight.deathTime / 4) : 1;
    this.material.transparent = this.material.opacity < 1;
    this.material.emissiveIntensity = fight.flightState === DragonFlightState.DEATH
      ? 2 + Math.sin(this._time * 14) * .8 : .28;
    this._updateDeathEffect(fight);

    for (let index = 0; index < this.crystals.length; index++) {
      const view = this.crystals[index];
      const state = fight.crystals[index];
      const visible = Boolean(state?.alive);
      view.crystal.visible = visible;
      view.beam.visible = visible;
      if (!visible) continue;
      view.crystal.position.set(state.x, state.y, state.z);
      view.crystal.rotation.y += dt * 1.7;
      view.crystal.rotation.x = Math.sin(this._time * 1.4 + index) * .2;
      const positions = view.beam.geometry.getAttribute('position');
      positions.setXYZ(0, state.x, state.y, state.z);
      positions.setXYZ(1, fight.position.x, fight.position.y + 1.2, fight.position.z);
      positions.needsUpdate = true;
      view.beam.geometry.computeBoundingSphere();
    }
  }

  _updateDeathEffect(fight) {
    const dying = fight.flightState === DragonFlightState.DEATH;
    this.deathBurst.visible = dying;
    for (const beam of this.deathBeams) beam.visible = dying;
    if (!dying) return;
    const t = Math.min(1, fight.deathTime / 4);
    const positions = this.deathBurst.geometry.getAttribute('position');
    for (let index = 0; index < positions.count; index++) {
      const angle = index * 2.399963;
      const vertical = ((index % 17) / 16) * 2 - 1;
      const radial = Math.sqrt(Math.max(0, 1 - vertical * vertical));
      const distance = (1.5 + (index % 7) * .42) * (1 + t * 5);
      positions.setXYZ(index,
        fight.position.x + Math.cos(angle) * radial * distance,
        fight.position.y + vertical * distance + t * 5,
        fight.position.z + Math.sin(angle) * radial * distance
      );
    }
    positions.needsUpdate = true;
    this.deathBurst.material.opacity = Math.sin(Math.PI * t) * .9;
    this.deathBurst.material.size = .35 + t * .65;
    for (let index = 0; index < this.deathBeams.length; index++) {
      const beam = this.deathBeams[index];
      const angle = index / this.deathBeams.length * Math.PI * 2 + t * .7;
      const points = beam.geometry.getAttribute('position');
      points.setXYZ(0, fight.position.x, fight.position.y + 1.2, fight.position.z);
      points.setXYZ(1,
        fight.position.x + Math.cos(angle) * (12 + t * 34),
        fight.position.y + 18 + t * 42,
        fight.position.z + Math.sin(angle) * (12 + t * 34)
      );
      points.needsUpdate = true;
      beam.material.opacity = Math.sin(Math.PI * t) * .82;
    }
  }

  setVisible(visible) {
    this.group.visible = visible;
    for (const { crystal, beam } of this.crystals) {
      if (!visible) { crystal.visible = false; beam.visible = false; }
    }
    if (!visible) {
      this.deathBurst.visible = false;
      for (const beam of this.deathBeams) beam.visible = false;
    }
  }

  destroy() {
    this.scene.remove(this.group);
    for (const mesh of this.meshes) mesh.geometry.dispose();
    for (const { crystal, beam } of this.crystals) {
      this.scene.remove(crystal); this.scene.remove(beam);
      crystal.geometry.dispose(); beam.geometry.dispose(); beam.material.dispose();
    }
    this.scene.remove(this.deathBurst);
    this.deathBurst.geometry.dispose();
    this.deathBurst.material.dispose();
    for (const beam of this.deathBeams) {
      this.scene.remove(beam);
      beam.geometry.dispose();
      beam.material.dispose();
    }
    this.material.dispose();
    this.eyeMaterial.dispose();
    this.crystalMaterial.dispose();
    this.meshes = [];
  }
}

export default EnderDragonRenderer;
