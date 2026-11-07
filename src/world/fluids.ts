import * as THREE from 'three';
import type { TerrainField } from './terrainField';

/** Feel values for fluid stains on the snow. */
const FLUIDS = {
  capacity: 900,
  /** Seconds a stain lasts; the last `fadeTime` of it is spent shrinking away. */
  lifetime: 60,
  fadeTime: 4,
  /** Height above the snow (m), plus polygon offset in the material, so stains don't z-fight it. */
  lift: 0.015,
  /** Growth rate (1/s) toward a stain's full size: drops splat out quickly, puddles spread slowly. */
  spread: 6,
};

export type FluidKind = 'oil' | 'coolant';

const COLOR: Record<FluidKind, THREE.Color> = {
  oil: new THREE.Color('#231d17'),
  coolant: new THREE.Color('#3f8d4c'),
};

/** A stain that's been placed; puddles keep a handle to grow it. */
export interface FluidStain {
  size: number;
  readonly position: THREE.Vector3;
}

interface Stain extends FluidStain {
  /** Current drawn size, easing toward `size`. */
  drawn: number;
  /** Stretch along `direction` (1 = round). */
  stretch: number;
  quaternion: THREE.Quaternion;
  age: number;
  color: THREE.Color;
  rate: number;
}

const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * Oil and coolant stains on the snow: flat low-poly blobs (one instanced draw) lying on the
 * analytic terrain, tilted to its slope, that splat out and later shrink away.
 */
export class Fluids {
  private readonly mesh: THREE.InstancedMesh;
  private readonly stains: Stain[] = [];

  constructor(
    scene: THREE.Scene,
    private readonly field: TerrainField,
  ) {
    // An irregular 7-sided blob in the XZ plane, so stains don't read as perfect discs.
    const radii = [1, 0.8, 0.95, 0.7, 1, 0.85, 0.75];
    const blob = new THREE.Shape(radii.map((r, i) => new THREE.Vector2(Math.cos((i / radii.length) * Math.PI * 2) * r, Math.sin((i / radii.length) * Math.PI * 2) * r)));
    const geometry = new THREE.ShapeGeometry(blob).rotateX(-Math.PI / 2);
    const material = new THREE.MeshStandardMaterial({
      roughness: 0.25,
      metalness: 0.1,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, FLUIDS.capacity);
    this.mesh.setColorAt(0, COLOR.oil); // allocates instanceColor
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    scene.add(this.mesh);
  }

  /**
   * Drops a stain on the snow under world (x, z), `size` metres across, stretched along the
   * horizontal `direction` by `stretch` (a splash at speed). Returns it so a puddle can grow.
   */
  drip(x: number, z: number, kind: FluidKind, size: number, direction?: THREE.Vector3, stretch = 1, rate = FLUIDS.spread): FluidStain {
    if (this.stains.length >= FLUIDS.capacity) this.stains.shift();
    const normal = this.field.normal(x, z, _n);
    const position = new THREE.Vector3(x, this.field.height(x, z), z).addScaledVector(normal, FLUIDS.lift);
    // Lie flat on the slope, the long axis along the direction of travel, plus a random turn.
    const yaw = direction && direction.lengthSq() > 1e-6 ? Math.atan2(direction.x, direction.z) : Math.random() * Math.PI * 2;
    const quaternion = new THREE.Quaternion().setFromUnitVectors(_up, normal).multiply(_q.setFromAxisAngle(_up, yaw));
    const shade = 0.85 + Math.random() * 0.3;
    const stain: Stain = { size, drawn: size * 0.3, stretch, position, quaternion, age: 0, color: COLOR[kind].clone().multiplyScalar(shade), rate };
    this.stains.push(stain);
    return stain;
  }

  update(dt: number): void {
    const F = FLUIDS;
    let n = 0;
    for (let i = 0; i < this.stains.length; i++) {
      const s = this.stains[i];
      s.age += dt;
      if (s.age >= F.lifetime) continue;
      s.drawn += (s.size - s.drawn) * (1 - Math.exp(-s.rate * dt));
      const fade = Math.min(1, (F.lifetime - s.age) / F.fadeTime);
      const r = (s.drawn / 2) * fade;
      this.mesh.setMatrixAt(n, _m.compose(s.position, s.quaternion, _s.set(r, 1, r * s.stretch)));
      this.mesh.setColorAt(n, s.color);
      this.stains[n++] = s;
    }
    this.stains.length = n;
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }
}
