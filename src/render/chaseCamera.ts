import { createNoise2D } from 'simplex-noise';
import * as THREE from 'three';
import type { TerrainField } from '../world/terrainField';

/** Screen shake: trauma (0..1) decays over time; shake strength is trauma². */
const SHAKE = {
  decay: 1.4,
  /** Max positional jitter (m) and roll (rad) at full trauma. */
  offset: 0.35,
  roll: 0.07,
  frequency: 22,
};
/** Landing dip: a damped spring pulling the camera back to rest. */
const KICK = { stiffness: 90, damping: 14 };

const _fwd = new THREE.Vector3();
const _velDir = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();

/** Smoothed third-person camera that trails the car and stays above the snow. */
export class ChaseCamera {
  private readonly dir = new THREE.Vector3(0, 0, -1);
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private initialized = false;
  private trauma = 0;
  private time = 0;
  private kickY = 0;
  private kickVel = 0;
  private readonly noise = createNoise2D();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly field: TerrainField,
  ) {}

  /** Starts fresh (next update snaps behind the car instead of swooping in). */
  reset(): void {
    this.initialized = false;
    this.trauma = 0;
    this.kickY = 0;
    this.kickVel = 0;
  }

  /** Adds screen shake (0..1); repeated hits stack up to the cap. */
  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Dips the camera down (m/s of downward kick), e.g. on landing. */
  kick(amount: number): void {
    this.kickVel -= amount;
  }

  update(dt: number, target: THREE.Object3D, velocity: THREE.Vector3): void {
    this.time += dt;
    _fwd.set(0, 0, -1).applyQuaternion(target.quaternion).setY(0);
    _velDir.copy(velocity).setY(0);
    const speed = _velDir.length();

    // Follow the direction of travel when moving forward (nicer through slides and jumps),
    // otherwise the car's nose. Keep the last heading if the car points straight up/down.
    if (_fwd.lengthSq() > 0.01) {
      _fwd.normalize();
      _desired.copy(_fwd);
      if (speed > 4 && _velDir.dot(_fwd) > 0) _desired.lerp(_velDir.normalize(), 0.6).normalize();
      if (!this.initialized) this.dir.copy(_desired);
      this.dir.lerp(_desired, 1 - Math.exp(-3 * dt)).normalize();
    }

    const distance = 7.5 + speed * 0.06;
    const height = 2.6 + speed * 0.02;
    _desired.copy(target.position).addScaledVector(this.dir, -distance);
    _desired.y += height;
    _look.copy(target.position).addScaledVector(this.dir, 2);
    _look.y += 0.9;

    if (!this.initialized) {
      this.pos.copy(_desired);
      this.look.copy(_look);
      this.initialized = true;
    }
    this.pos.lerp(_desired, 1 - Math.exp(-8 * dt));
    this.look.lerp(_look, 1 - Math.exp(-14 * dt));
    const ground = this.field.height(this.pos.x, this.pos.z) + 1.2;
    if (this.pos.y < ground) this.pos.y = ground;

    this.kickVel += (-this.kickY * KICK.stiffness - this.kickVel * KICK.damping) * dt;
    this.kickY += this.kickVel * dt;

    const shake = this.trauma * this.trauma;
    this.trauma = Math.max(0, this.trauma - SHAKE.decay * dt);
    const n = (seed: number) => this.noise(this.time * SHAKE.frequency, seed);
    this.camera.position.copy(this.pos);
    this.camera.position.y += this.kickY;
    this.camera.position.x += n(1) * shake * SHAKE.offset;
    this.camera.position.y += n(2) * shake * SHAKE.offset;
    this.camera.position.z += n(3) * shake * SHAKE.offset;
    this.camera.lookAt(this.look);
    this.camera.rotateZ(n(4) * shake * SHAKE.roll);
    // Wider view at speed sells the velocity.
    const fov = 60 + Math.min(speed, 55) * 0.32;
    this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-2 * dt));
    this.camera.updateProjectionMatrix();
  }
}
