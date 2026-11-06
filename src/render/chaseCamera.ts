import * as THREE from 'three';
import type { TerrainField } from '../world/terrainField';

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

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly field: TerrainField,
  ) {}

  update(dt: number, target: THREE.Object3D, velocity: THREE.Vector3): void {
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

    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
    const fov = 60 + Math.min(speed, 50) * 0.25;
    this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-2 * dt));
    this.camera.updateProjectionMatrix();
  }
}
