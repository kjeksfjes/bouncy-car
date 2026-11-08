import * as THREE from 'three';
import type { CarConfig } from './carConfig';

/**
 * The underbody, from the underside drawing (ref/1970s-muscle-car/back-underside.png, stretched
 * to the car's proportions; see views.json), with liberties where the drawing is off or where
 * parts would collide (the tank is narrowed so the exhaust passes beside it, the front rails sit
 * inside the steered wheels' sweep). Heights above the drawing's ground line; the floor's
 * underside is at the rocker (0.33).
 */

export interface UnderbodyMaterials {
  steel: THREE.Material;
  alloy: THREE.Material;
}

type Part = [THREE.BufferGeometry, THREE.Material];

/** Underside of the floor between the wheels (the rocker height there). */
const FLOOR = 0.33;

/**
 * Static parts as one dentable piece (car-local geometries): frame rails along the sills with
 * front and rear rails kicking in from them, crossmembers, stamped floor ribs, the front
 * crossmember, oil pan, bellhousing and gearbox, the ribbed fuel tank with its straps, and the
 * rear spring hangers.
 */
export function underbodyParts(cfg: CarConfig, mat: UnderbodyMaterials): Part[] {
  const gy = cfg.blueprint.groundY;
  const parts: Part[] = [];
  /** A box from (x0, z0) to (x1, z1) in plan, centred at height h. */
  const beam = (x0: number, z0: number, x1: number, z1: number, h: number, width: number, height: number, m = mat.steel) => {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const length = Math.hypot(dx, dz);
    const geo = new THREE.BoxGeometry(width, height, length, 1, 1, Math.max(1, Math.round(length / 0.25)))
      .rotateY(Math.atan2(dx, dz))
      .translate((x0 + x1) / 2, h + gy, (z0 + z1) / 2);
    parts.push([geo, m]);
  };
  const block = (x: number, h: number, z: number, w: number, ht: number, d: number, m: THREE.Material) =>
    parts.push([new THREE.BoxGeometry(w, ht, d).translate(x, h + gy, z), m]);

  for (const side of [-1, 1]) {
    // Sill rails, and the rails kicking in toward the middle at both ends of the floor.
    beam(side * 0.76, -0.95, side * 0.76, 0.85, FLOOR - 0.035, 0.08, 0.07);
    beam(side * 0.76, -0.95, side * 0.45, -1.15, FLOOR - 0.035, 0.08, 0.07);
    beam(side * 0.45, -1.15, side * 0.45, -2.2, FLOOR - 0.04, 0.08, 0.07);
    beam(side * 0.76, 0.85, side * 0.56, 1.0, FLOOR - 0.035, 0.08, 0.07);
    // Over the rear axle the rails ride up into the floor, clear of the axle tube.
    beam(side * 0.56, 1.0, side * 0.56, 2.35, FLOOR - 0.02, 0.08, 0.07);
    // Spring hangers under the rear rails.
    for (const z of [0.95, 2.26]) block(side * 0.56, FLOOR - 0.08, z, 0.05, 0.07, 0.06, mat.steel);
    // Stamped ribs along the front and rear floor panels.
    for (const x of [0.33, 0.5]) {
      beam(side * x, -0.54, side * x, -0.26, FLOOR - 0.005, 0.025, 0.012);
      beam(side * x, 0.16, side * x, 0.52, FLOOR - 0.005, 0.025, 0.012);
    }
  }
  // Crossmembers, thin enough to clear the driveshaft and exhaust beneath them.
  for (const z of [-0.81, -0.16, 0.04, 0.63]) beam(-0.76, z, 0.76, z, FLOOR - 0.0125, 0.05, 0.025);
  // Front crossmember ahead of the oil pan, between the A-arms' front pivots.
  beam(-0.45, -1.68, 0.45, -1.68, FLOOR - 0.045, 0.06, 0.07);

  // Oil pan under the block (its top hides up in the engine bay): a shallow front and a deeper
  // sump well at the back, in dark steel like the rest of the underside. Then the bellhousing and
  // gearbox half sunk into the floor, as if in a tunnel.
  block(0, 0.34, -1.4, 0.32, 0.1, 0.22, mat.steel);
  parts.push([new THREE.CylinderGeometry(0.14, 0.12, 0.2, 6).rotateY(Math.PI / 6).scale(1, 0.75, 1.1).translate(0, 0.33 + gy, -1.17), mat.steel]);
  parts.push([new THREE.CylinderGeometry(0.09, 0.12, 0.24, 10).rotateX(Math.PI / 2).translate(0, FLOOR + gy, -0.97), mat.alloy]);
  parts.push([new THREE.CylinderGeometry(0.075, 0.085, 0.3, 8).rotateX(Math.PI / 2).translate(0, FLOOR + gy, -0.7), mat.alloy]);
  // The front U-joint at the gearbox's tail.
  block(0, DRIVESHAFT.h, DRIVESHAFT.from, 0.06, 0.06, 0.05, mat.steel);

  // Fuel tank behind the rear axle, with ribs pressed across its bottom and two straps. Shallow
  // and dark: it hangs below the tail panel's lower edge, so it shows from behind.
  const tank = { x: 0.34, z0: 1.55, z1: 2.3, top: 0.325, bottom: 0.275 };
  block(0, (tank.top + tank.bottom) / 2, (tank.z0 + tank.z1) / 2, tank.x * 2, tank.top - tank.bottom, tank.z1 - tank.z0, mat.steel);
  for (let z = tank.z0 + 0.12; z < tank.z1 - 0.06; z += 0.12) beam(-tank.x + 0.04, z, tank.x - 0.04, z, tank.bottom - 0.004, 0.02, 0.01, mat.steel);
  for (const z of [1.75, 2.1]) beam(-tank.x - 0.01, z, tank.x + 0.01, z, tank.bottom - 0.006, 0.04, 0.008);
  return parts;
}

/** The driveshaft's front end (at the gearbox's tail): height and z. */
const DRIVESHAFT = { h: 0.265, from: -0.53 };

/**
 * Suspension parts that follow the wheels each frame: the live rear axle (a tube between the
 * rear hubs with the differential in its middle, so it tilts when one side compresses), the
 * driveshaft from the gearbox to the differential's pinion, and the front lower A-arms swinging
 * to each front hub's height. Plain meshes on the car root: they don't dent or fly off.
 *
 * Under hard compression the axle rises through the floor, which has no kick-up; that only
 * happens on the ground, where the underside is out of sight (airborne or upside down, the
 * wheels hang at full droop).
 */
export class Linkage {
  private readonly axle = new THREE.Group();
  private readonly shaft: THREE.Mesh;
  private readonly arms: THREE.Group[] = [];
  private readonly gy: number;
  private readonly W: CarConfig['wheels'];
  /** The pinion's U-joint, axle-local: where the driveshaft meets the differential. */
  private readonly pinion = new THREE.Vector3(0, 0, -0.19);
  private readonly shaftFrom: THREE.Vector3;

  constructor(cfg: CarConfig, mat: UnderbodyMaterials, root: THREE.Object3D) {
    this.gy = cfg.blueprint.groundY;
    this.W = cfg.wheels;
    const W = this.W;
    // Axle tube along X between the hubs, differential (squashed so it clears the floor) with
    // its pinion nose pointing forward; built around the axle's middle.
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, W.halfTrack * 2 - 0.1, 8).rotateZ(Math.PI / 2), mat.steel);
    const pumpkin = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6).scale(1, 0.85, 1), mat.alloy);
    const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.1, 8).rotateX(Math.PI / 2).translate(0, 0, -0.1), mat.alloy);
    const joint = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.05).translate(0, 0, -0.165), mat.steel);
    this.axle.add(tube, pumpkin, nose, joint);
    // Driveshaft: a unit-length cylinder along Y, stretched between its ends each frame.
    this.shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1, 8), mat.steel);
    this.shaftFrom = new THREE.Vector3(0, DRIVESHAFT.h + this.gy, DRIVESHAFT.from);
    root.add(this.axle, this.shaft);
    // Front lower A-arms: two links from inner pivots on the subframe to the lower ball joint,
    // in a group that swings about its inner pivot axis (along Z).
    for (const side of [-1, 1]) {
      const arm = new THREE.Group();
      arm.position.set(side * ARM.innerX, ARM.h + this.gy, W.frontZ);
      const reach = (W.halfTrack - 0.1 - ARM.innerX) * side;
      for (const dz of [-0.15, 0.13]) {
        const length = Math.hypot(reach, dz);
        const link = new THREE.Mesh(
          new THREE.BoxGeometry(0.04, 0.03, length).rotateY(Math.atan2(reach, -dz)).translate(reach / 2, 0, dz / 2),
          mat.steel,
        );
        arm.add(link);
      }
      root.add(arm);
      this.arms.push(arm);
    }
    for (const o of [this.axle, this.shaft, ...this.arms]) o.traverse((c) => (c.castShadow = true));
  }

  /** Poses the parts for the wheels' current hub heights (car-local Y), ordered FL, FR, RL, RR. */
  update(hubY: readonly number[]): void {
    const W = this.W;
    const [fl, fr, rl, rr] = hubY;
    _a.set(-W.halfTrack, rl, W.rearZ);
    _b.set(W.halfTrack, rr, W.rearZ);
    this.axle.position.addVectors(_a, _b).multiplyScalar(0.5);
    this.axle.quaternion.setFromUnitVectors(X, _b.sub(_a).normalize());
    // Driveshaft from the gearbox's tail to the pinion's U-joint.
    _b.copy(this.pinion).applyQuaternion(this.axle.quaternion).add(this.axle.position);
    _a.subVectors(_b, this.shaftFrom);
    this.shaft.position.addVectors(this.shaftFrom, _b).multiplyScalar(0.5);
    this.shaft.scale.set(1, _a.length(), 1);
    this.shaft.quaternion.setFromUnitVectors(Y, _a.normalize());
    // A-arms: the outer end sits a little below the hub centre.
    for (const [i, hub] of [fl, fr].entries()) {
      const side = i === 0 ? -1 : 1;
      const rise = hub - ARM.dropBelowHub - (ARM.h + this.gy);
      this.arms[i].rotation.z = side * Math.atan2(rise, W.halfTrack - 0.1 - ARM.innerX);
    }
  }
}

/** Front lower A-arm: inner pivot x and height, and how far below the hub the ball joint sits. */
const ARM = { innerX: 0.42, h: 0.28, dropBelowHub: 0.08 };

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
