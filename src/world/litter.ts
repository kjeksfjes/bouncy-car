import * as THREE from 'three';
import { GRAVITY } from '../constants';
import type { Car, ContactSurface } from '../vehicle/car';
import { COLORS, kindOf, type TreeKind } from './props';
import { treeKey, type Tree, type TreeLayout } from './trees';

/**
 * Falling leaves: thin plates in the quasi-steady model of Andersen, Pesavento & Wang, "Unsteady
 * aerodynamics of fluttering and tumbling plates" (J. Fluid Mech. 541, 2005), taken to 3D. Drag
 * along the flow is `drag` · (A − B·cos 2α) · |u|, so a leaf falls slowly flat and glides edgewise;
 * the flow's circulation lifts a gliding leaf (`lift`, their C_T); the flow's torque turns it
 * broadside (`turn`), so it pitches up at the end of each glide and swings back the other way;
 * `damping` + `damping2` · |ω| calms its turning. Each leaf varies these by ±`vary`, so most
 * flutter and a few tumble, and a sideways `twist` (a leaf isn't flat) makes it spiral.
 * Measured offline: ≈1.2 m/s down, swinging ±0.3 m every 1.2–1.5 s.
 */
const LEAF = {
  capacity: 3000,
  /** Drag scale (1/m): broadside, a leaf falls at ≈ √(g / (drag · (A + B))) ≈ 1 m/s. */
  drag: 4,
  /** Drag's dependence on the angle of attack (APW's A, B: 2.4 broadside, 0.4 edgewise). */
  A: 1.4,
  B: 1.0,
  lift: 1.2,
  turn: 12,
  damping: 2,
  damping2: 0.3,
  /** Spiral torque per (m/s)², either way round. */
  twist: [0.05, 0.3] as const,
  vary: 0.35,
  /** Length (m). Real leaves are 5–10 cm; these are drawn bigger to read from the chase camera. */
  size: [0.11, 0.17] as const,
  /** Integration step cap (s): the flow's torque is stiff at the speed a shaken branch flings a leaf. */
  step: 1 / 120,
};

/** Twigs, cones and snow: they tumble down (quadratic drag, falling at `fall` m/s). */
const BITS = {
  capacity: 1500,
  /** Size (m) along the bit's length (local z); `width` and `thick` are shares of it (local x, y). */
  twig: { length: [0.18, 0.34], width: 0.09, thick: 0.09, fall: 6 },
  cone: { length: [0.08, 0.13], width: 0.45, thick: 0.45, fall: 8 },
  snow: { length: [0.08, 0.16], width: 0.9, thick: 0.75, fall: 4 },
  /** Tumbling (rad/s). */
  spin: [3, 10] as const,
  /** Hitting the ground faster than this (m/s) bounces, keeping `bounce` of the speed. */
  bounceFrom: 1.5,
  bounce: 0.25,
  /** A snow lump landing flattens to `splat` of its height and spreads by 1 / √splat. */
  splat: 0.45,
} as const;

type BitKind = 'twig' | 'cone' | 'snow';

/**
 * What a tree drops when shaken through and through (a scale-1 tree; see Litter.shake), its crown
 * (m above its foot, per unit of scale; `taper` narrows it to the top, as a spruce's), and the
 * leaves' colours. Bark colours come from the tree models (props COLORS).
 */
const DROPS: Record<TreeKind, {
  leaves: number;
  leafColors: THREE.Color[];
  bits: Partial<Record<BitKind, number>>;
  crown: { low: number; high: number; radius: number; taper: boolean };
}> = {
  broadleaf: {
    leaves: 70,
    // A few yellowed among the green.
    leafColors: [COLORS.leaves, COLORS.leaves, COLORS.leavesDark, COLORS.leavesDark, new THREE.Color('#9aa83e'), new THREE.Color('#c2a64a')],
    bits: { twig: 6 },
    crown: { low: 2.3, high: 4.9, radius: 1.8, taper: false },
  },
  oak: {
    leaves: 160,
    leafColors: [COLORS.oakLeafLight, COLORS.oakLeafMid, COLORS.oakLeafMid, COLORS.oakLeafDeep, COLORS.oakLeafShade],
    bits: { twig: 14 },
    crown: { low: 6.5, high: 14, radius: 8, taper: false },
  },
  pine: {
    leaves: 0,
    leafColors: [],
    bits: { twig: 6, cone: 4 },
    crown: { low: 3.3, high: 6, radius: 1.4, taper: false },
  },
  spruce: {
    leaves: 0,
    leafColors: [],
    bits: { twig: 6, cone: 6 },
    crown: { low: 1.6, high: 5.6, radius: 1.7, taper: true },
  },
  spruceSnowy: {
    leaves: 0,
    leafColors: [],
    bits: { snow: 40, twig: 3, cone: 2 },
    crown: { low: 1.6, high: 5.6, radius: 1.7, taper: true },
  },
};

const BIT_COLORS: Record<TreeKind, Partial<Record<BitKind, THREE.Color[]>>> = {
  broadleaf: { twig: [COLORS.broadTrunk] },
  oak: { twig: [COLORS.oakBark, COLORS.oakBarkLight] },
  pine: { twig: [COLORS.pineBark], cone: [new THREE.Color('#7d5a3c')] },
  spruce: { twig: [COLORS.trunk], cone: [new THREE.Color('#6e4a30')] },
  spruceSnowy: { twig: [COLORS.trunk], cone: [new THREE.Color('#6e4a30')], snow: [COLORS.snow] },
};

/**
 * How hard a hit shakes a tree, as a share of shaking it through (see DROPS): per m/s of an
 * impact's severity, on first touching it (`touch` + `touchPerSpeed` · the car's speed), and per
 * second of rubbing along it per m/s. A tree has only so much loose (1 = all of DROPS) and gets it
 * back over `recover` s, so the first hit drops the most.
 */
const SHAKE = {
  perSeverity: 0.15,
  touch: 0.05,
  touchPerSpeed: 0.03,
  rubPerSpeed: 0.02,
  recover: 90,
  /** Leaves and bits leave the branches over a while: delays average `stagger` s, up to `staggerMax`. */
  stagger: 0.35,
  staggerMax: 3,
  /** A shaken branch flings them out at up to `fling` m/s, away from the car, plus `scatter` any way. */
  fling: 1.5,
  scatter: 0.8,
  /** Trees further than this from the camera (m) drop nothing you'd see, so nothing is made. */
  seen: 150,
};

/**
 * Resting pieces nearer the camera than this (m) aren't reused while older or further ones remain,
 * looking at most `REUSE_LOOK` slots ahead of the oldest.
 */
const KEEP_NEAR = 30;
const REUSE_LOOK = 256;
/** Height above the ground a resting piece lies at (m), against z-fighting. */
const REST_LIFT = 0.015;

interface Piece {
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  scale: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Seconds until it leaves the branch; hidden until then. */
  delay: number;
  resting: boolean;
}

interface Leaf extends Piece {
  /** Angular velocity (world, rad/s). */
  spin: THREE.Vector3;
  drag: number;
  turn: number;
  damping: number;
  twist: number;
}

interface Bit extends Piece {
  kind: BitKind;
  spinAxis: THREE.Vector3;
  spin: number;
  /** Quadratic drag (1/m): g / fall². */
  drag: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _tau = new THREE.Vector3();
const _x = new THREE.Vector3();
const _z = new THREE.Vector3();
const _away = new THREE.Vector3();
const ZERO = new THREE.Vector3();

const between = (range: readonly [number, number] | readonly number[], t: number) => range[0] + (range[1] - range[0]) * t;
const pick = <T>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)];
/** Whole pieces for `expected`, rounded at random so gentle rubbing still drops one now and then. */
const count = (expected: number) => Math.floor(expected + Math.random());

/**
 * Instanced pieces in one draw call, each kept in its slot. Pieces in flight are redrawn every
 * frame, resting ones once as they settle. They stay where they land; when the slots run out, the
 * oldest resting piece out of the camera's near reach is reused.
 */
class Pool<T extends Piece> {
  readonly pieces: T[] = [];
  readonly mesh: THREE.InstancedMesh;
  private cursor = 0;

  constructor(scene: THREE.Scene, geometry: THREE.BufferGeometry, private readonly capacity: number) {
    const material = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.8, side: THREE.DoubleSide });
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.setColorAt(0, new THREE.Color()); // allocates instanceColor
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  add(piece: T, color: THREE.Color, eye: THREE.Vector3): void {
    let slot = this.pieces.length;
    if (slot >= this.capacity) {
      slot = this.cursor;
      for (let i = 0; i < REUSE_LOOK; i++) {
        const at = (this.cursor + i) % this.capacity;
        const p = this.pieces[at];
        if (p.resting && p.position.distanceToSquared(eye) > KEEP_NEAR * KEEP_NEAR) {
          slot = at;
          break;
        }
      }
      this.cursor = (slot + 1) % this.capacity;
    }
    this.pieces[slot] = piece;
    this.mesh.setColorAt(slot, color);
    this.mesh.instanceColor!.needsUpdate = true;
    this.mesh.count = this.pieces.length;
    this.draw(slot);
  }

  draw(slot: number): void {
    const p = this.pieces[slot];
    this.mesh.setMatrixAt(slot, _m.compose(p.position, p.rotation, p.delay > 0 ? ZERO : p.scale));
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/**
 * Litter shaken out of trees by the cars that hit them: leaves from broadleaf trees and oaks that
 * flutter down, and twigs, cones and snow lumps that tumble. Visual only (no physics
 * bodies), on the drawn ground, where they stay.
 */
export class Litter {
  private readonly leaves: Pool<Leaf>;
  private readonly bits: Pool<Bit>;
  /** How much each shaken tree still has loose (0..1) and when that was so (s), by treeKey. */
  private readonly loose = new Map<string, { share: number; at: number }>();
  /** Trees each car touched last frame (by treeKey), to tell a first touch from rubbing along. */
  private readonly touched = new Map<Car, Set<string>>();
  private readonly eye = new THREE.Vector3();
  private time = 0;

  /** @param groundAt the drawn ground's height at (x, z) (see Terrain.surfaceHeight) */
  constructor(
    scene: THREE.Scene,
    private readonly trees: TreeLayout,
    private readonly groundAt: (x: number, z: number) => number,
  ) {
    this.leaves = new Pool<Leaf>(scene, buildLeaf(), LEAF.capacity);
    this.bits = new Pool<Bit>(scene, new THREE.OctahedronGeometry(0.5, 0), BITS.capacity);
  }

  /** A car's hit (see CarEvents.impact): a hit on a tree shakes it by the hit's severity. */
  impact(car: Car, at: THREE.Vector3, severity: number, surface: ContactSurface): void {
    if (surface !== 'tree') return;
    const tree = this.trees.blocking(at.x, at.z, 2);
    if (tree) this.shake(tree, car.position, severity * SHAKE.perSeverity);
  }

  /**
   * @param dt game time (s): litter hangs still when paused and falls slowly in slow motion
   * @param eye the camera's position: resting litter near it is kept longest
   * @param cars every car: touching a tree shakes it, a little on first touch and while rubbing along
   */
  update(dt: number, eye: THREE.Vector3, cars: readonly Car[]): void {
    this.eye.copy(eye);
    this.time += dt;
    for (const car of cars) {
      const before = this.touched.get(car);
      const now = new Set<string>();
      const speed = car.velocity.length();
      this.trees.touching(car.position, car.model.root.quaternion, (tree) => {
        const key = treeKey(tree);
        if (now.has(key)) return;
        now.add(key);
        const amount = before?.has(key) ? speed * SHAKE.rubPerSpeed * dt : SHAKE.touch + speed * SHAKE.touchPerSpeed;
        this.shake(tree, car.position, amount);
      });
      if (now.size > 0) this.touched.set(car, now);
      else this.touched.delete(car);
    }
    for (const car of this.touched.keys()) if (!cars.includes(car)) this.touched.delete(car);
    if (dt <= 0) return;
    this.flyLeaves(dt);
    this.flyBits(dt);
  }

  /**
   * Shakes `tree` (touched by a car at `from`) by `amount`, a share of shaking it through (see
   * DROPS): it drops that share of its leaves and bits, as far as it has any loose.
   */
  private shake(tree: Tree, from: THREE.Vector3, amount: number): void {
    const key = treeKey(tree);
    const state = this.loose.get(key) ?? { share: 1, at: this.time };
    state.share = Math.min(1, state.share + (this.time - state.at) / SHAKE.recover);
    state.at = this.time;
    const take = Math.min(state.share, amount);
    state.share -= take;
    this.loose.set(key, state);
    if (take <= 0 || Math.hypot(tree.x - this.eye.x, tree.z - this.eye.z) > SHAKE.seen) return;

    const kind = kindOf(tree);
    const drop = DROPS[kind];
    // A bigger tree holds more: by its crown's spread.
    const share = take * tree.scale * tree.scale;
    _away.set(tree.x - from.x, 0, tree.z - from.z).normalize();
    const strength = Math.min(1, take * 2);
    for (let i = count(drop.leaves * share); i > 0; i--) this.addLeaf(tree, kind, strength);
    for (const bitKind of Object.keys(drop.bits) as BitKind[]) {
      for (let i = count(drop.bits[bitKind]! * share); i > 0; i--) this.addBit(tree, kind, bitKind, strength);
    }
  }

  /** A point in `tree`'s crown, into `out`. */
  private inCrown(tree: Tree, kind: TreeKind, out: THREE.Vector3): THREE.Vector3 {
    const c = DROPS[kind].crown;
    const y = between([c.low, c.high], Math.random());
    const reach = c.taper ? c.radius * (c.high + 0.5 - y) / (c.high + 0.5 - c.low) : c.radius;
    const r = reach * Math.sqrt(Math.random()) * 0.85;
    const a = Math.random() * Math.PI * 2;
    return out.set(tree.x + Math.cos(a) * r * tree.scale, tree.y + y * tree.scale, tree.z + Math.sin(a) * r * tree.scale);
  }

  /** The speed a shaken branch flings a piece out at, `strength` 0..1. */
  private fling(strength: number): THREE.Vector3 {
    const S = SHAKE;
    return _away.clone().multiplyScalar(S.fling * strength * Math.random()).add(new THREE.Vector3(
      (Math.random() * 2 - 1) * S.scatter,
      (Math.random() - 0.3) * S.scatter,
      (Math.random() * 2 - 1) * S.scatter,
    ));
  }

  private delay(): number {
    return Math.min(SHAKE.staggerMax, -Math.log(1 - Math.random()) * SHAKE.stagger);
  }

  private addLeaf(tree: Tree, kind: TreeKind, strength: number): void {
    const L = LEAF;
    const vary = () => 1 + (Math.random() * 2 - 1) * L.vary;
    const size = between(L.size, Math.random());
    const leaf: Leaf = {
      position: this.inCrown(tree, kind, new THREE.Vector3()),
      rotation: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3)),
      scale: new THREE.Vector3(size, size, size),
      velocity: this.fling(strength),
      delay: this.delay(),
      resting: false,
      spin: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(10),
      drag: L.drag * vary(),
      turn: L.turn * vary(),
      damping: L.damping * vary(),
      twist: between(L.twist, Math.random()) * (Math.random() < 0.5 ? -1 : 1),
    };
    const color = pick(DROPS[kind].leafColors).clone().multiplyScalar(0.9 + Math.random() * 0.2);
    this.leaves.add(leaf, color, this.eye);
  }

  private addBit(tree: Tree, kind: TreeKind, bitKind: BitKind, strength: number): void {
    const B = BITS[bitKind];
    const length = between(B.length, Math.random());
    const bit: Bit = {
      kind: bitKind,
      position: this.inCrown(tree, kind, new THREE.Vector3()),
      rotation: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3)),
      scale: new THREE.Vector3(length * B.width, length * B.thick, length),
      velocity: this.fling(strength),
      delay: this.delay(),
      resting: false,
      spinAxis: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
      spin: between(BITS.spin, Math.random()),
      drag: GRAVITY / (B.fall * B.fall),
    };
    const color = pick(BIT_COLORS[kind][bitKind]!).clone().multiplyScalar(0.9 + Math.random() * 0.2);
    this.bits.add(bit, color, this.eye);
  }

  private flyLeaves(dt: number): void {
    const L = LEAF;
    const pieces = this.leaves.pieces;
    const steps = Math.ceil(dt / L.step);
    const h = dt / steps;
    for (let i = 0; i < pieces.length; i++) {
      const l = pieces[i];
      if (l.resting) continue;
      if (l.delay > 0) {
        l.delay -= dt;
        if (l.delay <= 0) this.leaves.draw(i);
        continue;
      }
      for (let s = 0; s < steps; s++) {
        const u = l.velocity;
        const n = _n.set(0, 1, 0).applyQuaternion(l.rotation);
        const un = u.dot(n);
        const ut = _t.copy(u).addScaledVector(n, -un);
        const ut2 = ut.lengthSq();
        const u2 = u.lengthSq();
        const ul = Math.sqrt(u2);
        // The flow's torque turns the leaf broadside to it; its twist spirals it.
        _tau.crossVectors(n, u).multiplyScalar(l.turn * un).addScaledVector(n, l.twist * u2);
        if (ul > 1e-6) {
          // Lift from circulation, at right angles to the flow: −c (u·n / |u|) (|u_t|² n − (u·n) u_t).
          const c = -l.drag * 2 * L.lift * un / ul;
          u.addScaledVector(n, c * ut2 * h).addScaledVector(ut, -c * un * h);
          // Drag along the flow, strongest broadside; implicit, so a fast fling can't overshoot.
          const cos2 = (ut2 - un * un) / u2;
          u.multiplyScalar(1 / (1 + l.drag * (L.A - L.B * cos2) * ul * h));
        }
        u.y -= GRAVITY * h;
        l.spin.addScaledVector(_tau, h);
        const w = l.spin.length();
        l.spin.multiplyScalar(1 / (1 + (l.damping + L.damping2 * w) * h));
        const wl = l.spin.length();
        if (wl > 1e-6) l.rotation.premultiply(_q.setFromAxisAngle(_x.copy(l.spin).divideScalar(wl), wl * h)).normalize();
        l.position.addScaledVector(u, h);
      }
      const ground = this.groundAt(l.position.x, l.position.z);
      if (l.position.y < ground + REST_LIFT) this.settle(l, ground, 0);
      this.leaves.draw(i);
    }
  }

  private flyBits(dt: number): void {
    const B = BITS;
    const pieces = this.bits.pieces;
    for (let i = 0; i < pieces.length; i++) {
      const b = pieces[i];
      if (b.resting) continue;
      if (b.delay > 0) {
        b.delay -= dt;
        if (b.delay <= 0) this.bits.draw(i);
        continue;
      }
      const v = b.velocity;
      v.multiplyScalar(1 / (1 + b.drag * v.length() * dt));
      v.y -= GRAVITY * dt;
      b.position.addScaledVector(v, dt);
      b.rotation.multiply(_q.setFromAxisAngle(b.spinAxis, b.spin * dt));
      const ground = this.groundAt(b.position.x, b.position.z);
      const half = b.scale.y * 0.5;
      if (b.position.y < ground + half) {
        if (b.kind !== 'snow' && -v.y > B.bounceFrom) {
          b.position.y = ground + half;
          v.set(v.x * 0.5, -v.y * B.bounce, v.z * 0.5);
          b.spin *= 0.5;
        } else {
          if (b.kind === 'snow') b.scale.multiply(_x.set(1 / Math.sqrt(B.splat), B.splat, 1 / Math.sqrt(B.splat)));
          this.settle(b, ground, b.scale.y * 0.5);
        }
      }
      this.bits.draw(i);
    }
  }

  /** Lays `piece` flat on the ground at its spot (its height `ground`), raised by `half`, keeping its heading. */
  private settle(piece: Piece, ground: number, half: number): void {
    const { x, z } = piece.position;
    const e = 0.2;
    // The ground's normal, from its slope across the piece.
    _n.set(this.groundAt(x - e, z) - this.groundAt(x + e, z), 2 * e, this.groundAt(x, z - e) - this.groundAt(x, z + e)).normalize();
    _z.set(0, 0, 1).applyQuaternion(piece.rotation).addScaledVector(_n, -_z.dot(_n));
    if (_z.lengthSq() < 1e-6) _z.set(1, 0, 0).addScaledVector(_n, -_n.x);
    _z.normalize();
    _x.crossVectors(_n, _z);
    piece.rotation.setFromRotationMatrix(_m.makeBasis(_x, _n, _z));
    piece.position.y = ground + REST_LIFT + half;
    piece.velocity.set(0, 0, 0);
    piece.resting = true;
  }
}

/**
 * A leaf 1 m long along +z, lying in the xz plane (its face up +y): an oval blade folded a little
 * along its midrib, so its halves catch the light differently.
 */
function buildLeaf(): THREE.BufferGeometry {
  const fold = -0.06;
  // Along the midrib from the stalk (z −0.5) to the tip (z 0.5): the blade's half-width at each point.
  const rib = [[-0.5, 0], [-0.32, 0.16], [-0.08, 0.26], [0.16, 0.24], [0.36, 0.13], [0.5, 0]];
  const positions: number[] = [];
  for (const sign of [1, -1]) {
    const mid = (k: number) => [0, 0, rib[k][0]];
    const edge = (k: number) => [rib[k][1] * sign, fold, rib[k][0]];
    // Each half, wound so its face is up (+y).
    const tri = (a: number[], b: number[], c: number[]) => positions.push(...(sign > 0 ? [...a, ...c, ...b] : [...a, ...b, ...c]));
    for (let k = 0; k < rib.length - 1; k++) {
      if (k > 0) tri(mid(k), edge(k), mid(k + 1));
      if (k < rib.length - 2) tri(k > 0 ? edge(k) : mid(k), edge(k + 1), mid(k + 1));
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}
