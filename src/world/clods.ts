import * as THREE from 'three';
import { GROUND } from './biome';
import type { BedGround } from './imprints';
import { mulberry32 } from './noise';

/** Clods of earth (chips of stone, from rock) thrown out when a boulder tears loose. Feel values. */
const CLODS = {
  /** Clods of each kind kept lying about; past this, the oldest is picked up and thrown again. */
  capacity: 2000,
  /** Per boulder: `count` plus `countPerRadius` × its radius (m). */
  count: 10,
  countPerRadius: 18,
  /** Size (m across): `minSize` plus up to `extra` (+ `extraPerRadius` × radius), small ones far more common. */
  minSize: 0.06,
  extra: 0.12,
  extraPerRadius: 0.06,
  /** Thrown out from the bed's edge (m/s): carried along with the boulder, outward, and up. */
  carry: 0.4,
  outward: [1.2, 3.5] as const,
  up: [1.5, 4] as const,
  /** How far a resting clod sinks into the ground (× its size). */
  sink: 0.3,
  /** Share of clods that are torn turf (grass on top) where the boulder lay in grass. */
  turf: 0.6,
};

const GRAVITY = 9.81;
const SOIL = new THREE.Color('#5e4330');
const SOIL_DARK = new THREE.Color('#4a3424');
const TURF = new THREE.Color('#5f8a3c');
/** Stone chips: a little darker than the bare rock they come out of (fresh faces, not weathered). */
const CHIP = GROUND.stone.clone().multiplyScalar(0.8);
const CHIP_DARK = GROUND.stoneDark.clone().multiplyScalar(0.75);

type Kind = 'soil' | 'turf' | 'chip';

interface Flying {
  index: number;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  size: number;
  spin: THREE.Vector3;
  rotation: THREE.Quaternion;
  kind: Kind;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _axis = new THREE.Vector3();

/**
 * Clods of earth a boulder throws out as it tears loose (chips of stone from rock): they fly (no
 * physics bodies, only gravity) and stay where they land for good. One instanced draw per kind.
 */
export class Clods {
  private readonly meshes: Record<Kind, THREE.InstancedMesh>;
  private readonly flying: Flying[] = [];
  /** Next slot to fill in each mesh (a ring: the oldest goes first). */
  private readonly next: Record<Kind, number> = { soil: 0, turf: 0, chip: 0 };

  /** @param ground the drawn ground's height at (x, z), hollows included */
  constructor(
    scene: THREE.Scene,
    private readonly ground: (x: number, z: number) => number,
  ) {
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 });
    this.meshes = { soil: makeMesh(clodGeometry('soil'), material), turf: makeMesh(clodGeometry('turf'), material), chip: makeMesh(clodGeometry('chip'), material) };
    scene.add(...Object.values(this.meshes));
  }

  /**
   * Throws out clods from round a boulder's bed at `at` (the bed's middle on the ground),
   * `radius` m, the boulder moving off at `velocity`: turf among them if it lay in grass, stone
   * chips instead if it lay in rock.
   */
  burst(at: THREE.Vector3, velocity: THREE.Vector3, radius: number, ground: BedGround): void {
    const C = CLODS;
    const count = Math.round(C.count + C.countPerRadius * radius);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const out = radius * (0.6 + 0.4 * Math.random());
      const position = new THREE.Vector3(at.x + Math.cos(a) * out, at.y + 0.1, at.z + Math.sin(a) * out);
      const speed = C.outward[0] + Math.random() * (C.outward[1] - C.outward[0]);
      const v = new THREE.Vector3(Math.cos(a) * speed, C.up[0] + Math.random() * (C.up[1] - C.up[0]), Math.sin(a) * speed).addScaledVector(velocity, C.carry);
      const r = Math.random();
      const size = C.minSize + r * r * (C.extra + C.extraPerRadius * radius);
      const kind: Kind = ground === 'rock' ? 'chip' : ground === 'grass' && Math.random() < C.turf ? 'turf' : 'soil';
      const index = this.next[kind];
      this.next[kind] = (index + 1) % C.capacity;
      const mesh = this.meshes[kind];
      mesh.count = Math.max(mesh.count, index + 1);
      // A slot taken over from a clod still in flight: that one just stops being drawn.
      const taken = this.flying.findIndex((f) => f.kind === kind && f.index === index);
      if (taken >= 0) this.flying.splice(taken, 1);
      const spin = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(4 + Math.random() * 10);
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3));
      mesh.setMatrixAt(index, _m.compose(position, rotation, _s.setScalar(size)));
      mesh.instanceMatrix.needsUpdate = true;
      this.flying.push({ index, position, velocity: v, size, spin, rotation, kind });
    }
  }

  update(dt: number): void {
    if (this.flying.length === 0) return;
    let n = 0;
    for (const f of this.flying) {
      f.velocity.y -= GRAVITY * dt;
      f.position.addScaledVector(f.velocity, dt);
      const ground = this.ground(f.position.x, f.position.z);
      const landed = f.velocity.y < 0 && f.position.y <= ground + f.size * (0.5 - CLODS.sink);
      if (landed) {
        f.position.y = ground + f.size * (0.5 - CLODS.sink);
      } else {
        const angle = f.spin.length() * dt;
        f.rotation.premultiply(_q.setFromAxisAngle(_axis.copy(f.spin).normalize(), angle));
      }
      const mesh = this.meshes[f.kind];
      // Turf comes to rest grass up, turned any way round.
      if (landed && f.kind === 'turf') f.rotation.setFromAxisAngle(_axis.set(0, 1, 0), Math.random() * Math.PI * 2);
      mesh.setMatrixAt(f.index, _m.compose(f.position, f.rotation, _s.setScalar(f.size)));
      mesh.instanceMatrix.needsUpdate = true;
      if (!landed) this.flying[n++] = f;
    }
    this.flying.length = n;
  }
}

function makeMesh(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, CLODS.capacity);
  mesh.count = 0;
  // Clods lie scattered all along the descent: one bounding sphere can't cover them usefully.
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  return mesh;
}

/** A lumpy clod about 1 across: soil all over, a sod with grass on top, or an angular chip of stone. */
function clodGeometry(kind: Kind): THREE.BufferGeometry {
  const turf = kind === 'turf';
  const chip = kind === 'chip';
  const random = mulberry32(turf ? 517 : chip ? 389 : 263);
  const g = new THREE.IcosahedronGeometry(0.5, 0);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  // Jitter by position, so the corners shared between faces move together and the clod stays closed.
  const moved = new Map<string, number>();
  for (let v = 0; v < pos.count; v++) {
    const key = `${pos.getX(v).toFixed(3)},${pos.getY(v).toFixed(3)},${pos.getZ(v).toFixed(3)}`;
    let k = moved.get(key);
    // Chips jitter more (sharp, uneven faces) and stay flatter, like split-off flakes.
    if (k === undefined) moved.set(key, (k = chip ? 0.6 + random() * 0.8 : 0.75 + random() * 0.5));
    pos.setXYZ(v, pos.getX(v) * k, pos.getY(v) * k * (turf ? 0.6 : chip ? 0.55 : 0.8), pos.getZ(v) * k);
  }
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  const n = g.getAttribute('normal');
  const colours = new Float32Array(n.count * 3);
  const c = new THREE.Color();
  for (let f = 0; f < n.count; f += 3) {
    const up = (n.getY(f) + n.getY(f + 1) + n.getY(f + 2)) / 3;
    if (chip) c.copy(random() < 0.5 ? CHIP : CHIP_DARK);
    else c.copy(turf && up > 0.3 ? TURF : random() < 0.5 ? SOIL : SOIL_DARK);
    for (let k = 0; k < 3; k++) c.toArray(colours, (f + k) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  return g;
}
