/**
 * Live Eye of Ender flight.
 *
 * The wayfinding eye used to be a notification backed by precomputed samples.
 * This renderer turns those deterministic samples into a real world-space
 * object with a glowing trail, hover pause and drop/shatter finish.
 */
import * as THREE from 'three';

const FLIGHT_SECONDS = 2.25;
const HOVER_SECONDS = 0.65;
const TRAIL_POINTS = 20;

export class EyeOfEnderRenderer {
  constructor({ scene }) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'eye-of-ender-flight';
    this.group.visible = false;
    scene.add(this.group);

    const eyeMaterial = new THREE.MeshStandardMaterial({
      color: 0x79e6b1,
      emissive: 0x1a8b68,
      emissiveIntensity: 1.7,
      roughness: 0.35,
      metalness: 0.08,
    });
    this.eye = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), eyeMaterial);
    this.eye.name = 'flying-eye-of-ender';
    this.eye.castShadow = true;
    this.group.add(this.eye);

    const pupil = new THREE.Mesh(
      new THREE.SphereGeometry(0.105, 10, 6),
      new THREE.MeshBasicMaterial({ color: 0x17152a })
    );
    pupil.position.z = 0.175;
    this.eye.add(pupil);

    this._trailPositions = new Float32Array(TRAIL_POINTS * 3);
    const trailGeometry = new THREE.BufferGeometry();
    trailGeometry.setAttribute('position', new THREE.BufferAttribute(this._trailPositions, 3));
    this.trail = new THREE.Points(
      trailGeometry,
      new THREE.PointsMaterial({
        color: 0x80ffd0,
        size: 0.11,
        transparent: true,
        opacity: 0.68,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      })
    );
    this.group.add(this.trail);

    this.active = false;
    this.elapsed = 0;
    this.samples = [];
    this.shatters = false;
    this.end = { x:0, y:0, z:0 };
    this._completion = null;
  }

  /** Starts one deterministic flight and returns false when data is malformed. */
  launch(result) {
    if (!result || !Array.isArray(result.samples) || result.samples.length < 2) return false;
    this.samples = result.samples.map((point) => ({
      x:Number(point.x) || 0, y:Number(point.y) || 0, z:Number(point.z) || 0,
    }));
    this.end = { ...this.samples[this.samples.length - 1] };
    this.shatters = result.shatters === true;
    this.elapsed = 0;
    this.active = true;
    this.group.visible = true;
    this.trail.material.opacity = 0.68;
    this.eye.scale.setScalar(1);
    this._completion = null;
    this._sample(0, this.eye.position);
    this._writeTrail(0);
    return true;
  }

  /** Advances flight; returns a one-shot completion record. */
  update(dt) {
    if (!this.active) return this.consumeCompletion();
    this.elapsed += Math.max(0, Number(dt) || 0);
    const flightT = Math.min(1, this.elapsed / FLIGHT_SECONDS);
    this._sample(flightT, this.eye.position);
    this.eye.rotation.y += dt * 4.5;
    this.eye.rotation.x = Math.sin(this.elapsed * 5) * 0.18;
    this._writeTrail(flightT);

    if (this.elapsed > FLIGHT_SECONDS) {
      const finishT = Math.min(1, (this.elapsed - FLIGHT_SECONDS) / HOVER_SECONDS);
      this.eye.position.y = this.end.y + Math.sin(finishT * Math.PI) * 0.45;
      this.trail.material.opacity = 0.68 * (1 - finishT);
      if (this.shatters) this.eye.scale.setScalar(Math.max(0.02, 1 - finishT));
      else this.eye.position.y = this.end.y - finishT * 1.15;
      if (finishT >= 1) this._finish();
    }
    return this.consumeCompletion();
  }

  _sample(t, out) {
    const scaled = Math.max(0, Math.min(1, t)) * (this.samples.length - 1);
    const index = Math.min(this.samples.length - 2, Math.floor(scaled));
    const blend = scaled - index;
    const a = this.samples[index];
    const b = this.samples[index + 1];
    out.set(
      a.x + (b.x - a.x) * blend,
      a.y + (b.y - a.y) * blend,
      a.z + (b.z - a.z) * blend
    );
  }

  _writeTrail(t) {
    const point = new THREE.Vector3();
    for (let index = 0; index < TRAIL_POINTS; index++) {
      const sampleT = Math.max(0, t - index * 0.018);
      this._sample(sampleT, point);
      const offset = index * 3;
      this._trailPositions[offset] = point.x;
      this._trailPositions[offset + 1] = point.y;
      this._trailPositions[offset + 2] = point.z;
    }
    this.trail.geometry.attributes.position.needsUpdate = true;
  }

  _finish() {
    this.active = false;
    this.group.visible = false;
    this._completion = { shatters:this.shatters, end:{ ...this.end } };
  }

  consumeCompletion() {
    const completion = this._completion;
    this._completion = null;
    return completion;
  }

  destroy() {
    this.scene?.remove(this.group);
    this.eye.geometry.dispose();
    this.eye.material.dispose();
    for (const child of this.eye.children) {
      child.geometry?.dispose();
      child.material?.dispose();
    }
    this.trail.geometry.dispose();
    this.trail.material.dispose();
    this.scene = null;
  }
}

export default EyeOfEnderRenderer;
