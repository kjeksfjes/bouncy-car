import * as THREE from 'three';
import { GRAVITY } from '../constants';
import type { TerrainField } from './terrainField';

/** Feel values for fluid stains on the snow. */
const FLUIDS = {
  capacity: 900,
  /** Seconds a stain lasts; the last `fadeTime` of it is spent shrinking away. */
  lifetime: 60,
  fadeTime: 4,
  /** Height above the snow (m), plus polygon offset in the material, so stains don't z-fight it. */
  lift: 0.015,
  /**
   * How opaque a stain is: where oil and coolant overlap they blend, the colours mixing and the
   * spot darkening, instead of one cutting through the other.
   */
  opacity: 0.8,
  /** Growth rate (1/s) toward a stain's full size: drops splat out quickly, puddles spread slowly. */
  spread: 6,
};

/** Feel values for drops falling from a leaking car. */
const DROPS = {
  capacity: 96,
  /**
   * A drop swells under the car for `hang` s before it lets go when the car stands still, shorter
   * the faster it goes (÷ (1 + speed in m/s)). Drawn `radius` × the size of the stain it makes
   * (exaggerated, to be seen), growing from `start` of that, and up to `stretch` times as long as
   * wide just as it lets go.
   */
  hang: 0.9,
  radius: 0.09,
  start: 0.3,
  stretch: 1.5,
  /** A drop still falling after this long (s) is dropped. */
  maxAge: 4,
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

/** A drop forming under a car, then falling (see DROPS). */
interface Drop {
  /** What it hangs from, and where on it (local): followed until it lets go. */
  anchor: THREE.Object3D;
  local: THREE.Vector3;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  kind: FluidKind;
  /** The stain it makes (m across), or none (falling into a puddle). */
  size: number;
  stain: boolean;
  hang: number;
  age: number;
  color: THREE.Color;
}

const _m = new THREE.Matrix4();
const _was = new THREE.Vector3();
const _flat = new THREE.Vector3();
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
  private readonly dropMesh: THREE.InstancedMesh;
  private readonly drops: Drop[] = [];

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
      // Stains lie at the same height over the snow: depth-tested against everything else, but not
      // against each other (they don't write depth), or overlapping ones z-fight in flickering
      // stripes. They're drawn oldest first, so a newer one lies over an older one, blending.
      transparent: true,
      opacity: FLUIDS.opacity,
      depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, FLUIDS.capacity);
    this.mesh.setColorAt(0, COLOR.oil); // allocates instanceColor
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    scene.add(this.mesh);

    // A low-poly bead, glossy so it catches the light.
    const bead = new THREE.IcosahedronGeometry(1, 0);
    this.dropMesh = new THREE.InstancedMesh(bead, new THREE.MeshStandardMaterial({ roughness: 0.15, metalness: 0.1 }), DROPS.capacity);
    this.dropMesh.setColorAt(0, COLOR.oil); // allocates instanceColor
    this.dropMesh.count = 0;
    this.dropMesh.frustumCulled = false;
    scene.add(this.dropMesh);
  }

  /**
   * A drop forming at `local` on `anchor` (a car's model root, going at `speed` m/s), swelling
   * before it lets go and falls, carried along with the anchor's motion, and leaves a stain `size`
   * m across where it lands (unless `stain` is false: falling into a puddle).
   */
  hangDrop(anchor: THREE.Object3D, local: THREE.Vector3, kind: FluidKind, size: number, speed: number, stain = true): void {
    const hang = DROPS.hang / (1 + speed);
    if (this.drops.length >= DROPS.capacity) return;
    const position = anchor.localToWorld(local.clone());
    const color = COLOR[kind].clone().multiplyScalar(0.85 + Math.random() * 0.3);
    this.drops.push({ anchor, local: local.clone(), position, velocity: new THREE.Vector3(), kind, size, stain, hang, age: 0, color });
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
    this.updateDrops(dt);
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

  private updateDrops(dt: number): void {
    const D = DROPS;
    let n = 0;
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i];
      d.age += dt;
      if (d.age >= D.maxAge) continue;
      const r = D.radius * d.size;
      if (d.age < d.hang) {
        // Hanging: it follows the car, which it'll leave with.
        _was.copy(d.position);
        d.anchor.localToWorld(d.position.copy(d.local));
        if (dt > 0) d.velocity.subVectors(d.position, _was).divideScalar(dt);
        const grown = d.age / d.hang;
        const radius = r * (D.start + (1 - D.start) * grown);
        const length = 1 + (D.stretch - 1) * grown * grown;
        // It hangs under the drip point, not round it.
        _was.set(d.position.x, d.position.y - radius * length, d.position.z);
        this.dropMesh.setMatrixAt(n, _m.compose(_was, _q.identity(), _s.set(radius, radius * length, radius)));
      } else {
        d.velocity.y -= GRAVITY * dt;
        d.position.addScaledVector(d.velocity, dt);
        const ground = this.field.height(d.position.x, d.position.z);
        if (d.position.y - r * D.stretch <= ground) {
          if (d.stain) {
            const flat = _flat.set(d.velocity.x, 0, d.velocity.z);
            this.drip(d.position.x, d.position.z, d.kind, d.size, flat, 1 + Math.min(flat.length(), 30) * 0.08);
          }
          continue;
        }
        _was.set(d.position.x, d.position.y - r * D.stretch, d.position.z);
        this.dropMesh.setMatrixAt(n, _m.compose(_was, _q.identity(), _s.set(r, r * D.stretch, r)));
      }
      this.dropMesh.setColorAt(n, d.color);
      this.drops[n++] = d;
    }
    this.drops.length = n;
    this.dropMesh.count = n;
    this.dropMesh.instanceMatrix.needsUpdate = true;
    this.dropMesh.instanceColor!.needsUpdate = true;
  }
}
