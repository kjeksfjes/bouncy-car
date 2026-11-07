import { createNoise2D } from 'simplex-noise';
import * as THREE from 'three';
import type { TerrainField } from '../world/terrainField';

/**
 * Feel values for the helicopter shot. Distance, height and orbit speed each drift
 * slowly and independently (low-frequency noise), so the shot keeps changing.
 */
const HELI = {
  /**
   * Horizontal distance from the car (m): close passes to wide shots. The drift is
   * skewed by `distanceSkew` so it mostly stays near, and only now and then pulls far
   * out. Kept well inside the fog (ends 250 m from the camera), or the car fades.
   */
  distanceMin: 18,
  distanceMax: 120,
  distanceSkew: 2.2,
  /** Height above the car (m): low dramatic angles to near-overhead. */
  heightMin: 5,
  heightMax: 40,
  /** Orbit speed wanders between ±this (rad/s), so it also changes direction. */
  orbitSpeed: 0.3,
  /** How fast distance, height and orbit drift (noise frequency, 1/s). */
  drift: 0.045,
  /** How quickly the helicopter catches up (1/s): low = lazy, floaty following. */
  follow: 1.6,
  /** How quickly the lens re-aims at the car (1/s). */
  aim: 3.5,
  /** Seconds of the car's velocity to fly ahead to, so the car drives into frame. */
  lead: 0.7,
  /** Telephoto field of view (degrees) at the reference distance; farther shots zoom in a bit. */
  fov: 30,
  fovDistance: 32,
  /** Minimum height above the snow (m). */
  clearance: 8,
  /** Beyond this distance from the car the shot cuts to a fresh position (m); above distanceMax. */
  cutDistance: 160,
  /** Hover wobble amplitude (m) and speed. */
  wobble: 0.5,
  wobbleSpeed: 0.35,
};

const _desired = new THREE.Vector3();
const _lead = new THREE.Vector3();

/** TV-style helicopter camera: hovers off to the side, drifts in distance, height and angle, lags and wobbles. */
export class HeliCamera {
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private angle = Math.PI * 0.35;
  private time = 0;
  /** Offset into the drift noise; jumps on every cut so each shot is framed differently. */
  private shot = Math.random() * 1000;
  private initialized = false;
  private readonly noise = createNoise2D();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly field: TerrainField,
  ) {}

  /** Starts the shot fresh (next update cuts straight to position). */
  reset(): void {
    this.initialized = false;
  }

  update(dt: number, target: THREE.Object3D, velocity: THREE.Vector3): void {
    const H = HELI;
    this.time += dt;
    const drift = (seed: number) => 0.5 + 0.5 * this.noise((this.time + this.shot) * H.drift, seed); // 0..1
    this.angle += (drift(30) * 2 - 1) * H.orbitSpeed * dt;

    _lead.copy(velocity).setY(0).multiplyScalar(H.lead);
    // Where the helicopter wants to be with the current framing (re-read after a cut).
    const place = () => {
      const distance = THREE.MathUtils.lerp(H.distanceMin, H.distanceMax, drift(10) ** H.distanceSkew);
      const height = THREE.MathUtils.lerp(H.heightMin, H.heightMax, drift(20));
      _desired.set(Math.sin(this.angle) * distance, height, Math.cos(this.angle) * distance).add(target.position).add(_lead);
    };
    place();

    if (!this.initialized || this.pos.distanceTo(target.position) > H.cutDistance) {
      // Cut: a new side of the car and a new framing.
      if (this.initialized) {
        this.angle += Math.PI * (0.5 + Math.random() * 0.5);
        this.shot = Math.random() * 1000;
      }
      place();
      this.pos.copy(_desired);
      this.look.copy(target.position);
      this.initialized = true;
    }
    this.pos.lerp(_desired, 1 - Math.exp(-H.follow * dt));
    const ground = this.field.height(this.pos.x, this.pos.z) + H.clearance;
    if (this.pos.y < ground) this.pos.y = ground;
    this.look.lerp(target.position, 1 - Math.exp(-H.aim * dt));

    const n = (seed: number) => this.noise(this.time * H.wobbleSpeed, seed) * H.wobble;
    this.camera.position.set(this.pos.x + n(1), this.pos.y + n(2), this.pos.z + n(3));
    this.camera.lookAt(this.look);
    // Zoom partly compensates for distance: the car stays readable, but you still feel it.
    const fov = H.fov * Math.sqrt(H.fovDistance / Math.max(1, this.pos.distanceTo(target.position)));
    this.camera.fov += (THREE.MathUtils.clamp(fov, 18, 45) - this.camera.fov) * (1 - Math.exp(-4 * dt));
    this.camera.updateProjectionMatrix();
  }
}
