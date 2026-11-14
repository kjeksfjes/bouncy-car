import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Car, ContactSurface } from '../vehicle/car';
import { hash2 } from './noise';
import type { TerrainField } from './terrainField';
import type { Tree, TreeLayout } from './trees';

/**
 * The rook: glossy black, with the pale bare face at the base of its bill. Model-local metres,
 * facing −z with +y up: ≈45 cm from bill to tail, ≈90 cm across the wings.
 */
const LOOK = { body: '#15161b', face: '#a8a49c', wing: '#121317' };

/**
 * How a bird flies off. It takes off at `takeOffSpeed` m/s and works up to `speed` (rooks cruise at
 * ≈40 km/h), climbing at `climbRate` m/s to a height above the ground between `height` (min..max, m),
 * where it levels off and holds it. Its velocity follows what it wants at `response` (1/s). It
 * flees along a heading up to `spread` rad either side of straight away from what startled it,
 * wandering off it by up to `wander` rad/s. Wings: `climbBeat` while climbing, `cruiseBeat` after
 * (beats/s and amplitude in rad), cruising in bouts of flapping (`flapFor` s) and gliding
 * (`glideFor` s) with the wings held at `glideDihedral` rad. It keeps `clearance` m above the
 * ground, and is gone once `despawn` m from the camera or `maxAge` s old.
 */
const FLIGHT = {
  takeOffSpeed: 6,
  speed: 11,
  climbRate: 3.5,
  height: [12, 25] as const,
  response: 1.6,
  spread: 0.7,
  wander: 0.35,
  climbBeat: { rate: 5, amp: 0.95 },
  cruiseBeat: { rate: 3.2, amp: 0.6 },
  flapFor: [1.5, 3.5] as const,
  glideFor: [0.6, 1.8] as const,
  glideDihedral: 0.12,
  clearance: 2,
  despawn: 220,
  maxAge: 45,
};

/**
 * Rookeries: rooks live where the country is green, in tall trees by open ground. A broadleaf tree
 * (never a snowy one) at least `minScale` big holds one by `chance`, with `birds` (min..max) in it;
 * a great oak always does, with `oakBirds`. A hit of at least `hitFrom` (severity: Δv in m/s over
 * the car's toughness) sends them all up, each leaving the crown within `stagger` s, and that tree
 * stays empty.
 */
const ROOKERY = {
  chance: 0.35,
  minScale: 1.1,
  birds: [3, 8] as const,
  oakBirds: [6, 12] as const,
  hitFrom: 1,
  stagger: 0.6,
};

/** Most birds in the air at once. */
const CAPACITY = 96;

interface Bird {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** The heading it's making for, as a yaw (from −z, positive turned toward −x). */
  heading: number;
  /** Its own phase for wandering off the heading. */
  seed: number;
  /** The height above the ground it climbs to and then holds (m). */
  height: number;
  climbing: boolean;
  /** Wingbeat phase (rad), and how much it's flapping (0: gliding, 1: flapping), eased. */
  phase: number;
  flap: number;
  flapping: boolean;
  /** Seconds to the next switch between flapping and gliding (cruising only). */
  switchIn: number;
  yaw: number;
  bank: number;
  /** Seconds still hidden in the crown before it leaves. */
  delay: number;
  age: number;
}

const _q = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _body = new THREE.Matrix4();
const _wing = new THREE.Matrix4();
const _hinge = new THREE.Matrix4();
const _flap = new THREE.Matrix4();
const _want = new THREE.Vector3();
const ONE = new THREE.Vector3(1, 1, 1);
/** Where the wings join the body (right side; the left mirrors it), model-local m. */
const HINGE = new THREE.Vector3(0.045, 0.025, -0.03);

const between = (range: readonly [number, number], t: number) => range[0] + (range[1] - range[0]) * t;

/** Rooks: they burst out of rookery trees when a car hits one, and fly off. */
export class Birds {
  private readonly birds: Bird[] = [];
  /** Trees whose rooks have flown, by position (see treeKey). */
  private readonly emptied = new Set<string>();
  private readonly body: THREE.InstancedMesh;
  private readonly wingR: THREE.InstancedMesh;
  private readonly wingL: THREE.InstancedMesh;

  constructor(
    scene: THREE.Scene,
    private readonly field: TerrainField,
    private readonly trees: TreeLayout,
  ) {
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.55, metalness: 0.15 });
    const mesh = (geometry: THREE.BufferGeometry) => {
      const m = new THREE.InstancedMesh(geometry, material, CAPACITY);
      m.count = 0;
      m.castShadow = true;
      // They fly anywhere: the bounds of where they were made don't hold.
      m.frustumCulled = false;
      scene.add(m);
      return m;
    };
    this.body = mesh(buildBody());
    this.wingR = mesh(buildWing(1));
    this.wingL = mesh(buildWing(-1));
  }

  /** A car's hit (see CarEvents.impact): a hard enough knock on a rookery tree sends its rooks up. */
  impact(car: Car, at: THREE.Vector3, severity: number, surface: ContactSurface): void {
    if (surface !== 'tree' || severity < ROOKERY.hitFrom) return;
    const tree = this.trees.blocking(at.x, at.z, 2);
    if (!tree) return;
    const count = this.rookery(tree);
    if (count === 0) return;
    this.emptied.add(treeKey(tree));
    // Away from the car, as seen from the tree.
    const away = Math.atan2(-(tree.x - car.position.x), -(tree.z - car.position.z));
    const crownY = tree.y + (tree.oak ? 10 : 3.5) * tree.scale;
    const crownR = (tree.oak ? 4.5 : 1.4) * tree.scale;
    for (let i = 0; i < count && this.birds.length < CAPACITY; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = crownR * Math.sqrt(Math.random()) * 0.8;
      const heading = away + (Math.random() * 2 - 1) * FLIGHT.spread;
      const pos = new THREE.Vector3(tree.x + Math.cos(a) * r, crownY + (Math.random() - 0.3) * crownR * 0.6, tree.z + Math.sin(a) * r);
      this.birds.push({
        pos,
        vel: new THREE.Vector3(-Math.sin(heading) * 2, 2.5, -Math.cos(heading) * 2),
        heading,
        seed: Math.random() * 100,
        height: between(FLIGHT.height, Math.random()),
        climbing: true,
        phase: Math.random() * Math.PI * 2,
        flap: 1,
        flapping: true,
        switchIn: 0,
        yaw: heading,
        bank: 0,
        delay: Math.random() * ROOKERY.stagger,
        age: 0,
      });
    }
  }

  /**
   * @param dt game time (s): birds freeze when paused and slow down in slow motion
   * @param eye the camera's position: birds far from it are gone
   */
  update(dt: number, eye: THREE.Vector3): void {
    const F = FLIGHT;
    const follow = 1 - Math.exp(-F.response * dt);
    for (let i = this.birds.length - 1; i >= 0; i--) {
      const b = this.birds[i];
      if (b.delay > 0) {
        b.delay -= dt;
        continue;
      }
      b.age += dt;
      if (b.age > F.maxAge || b.pos.distanceTo(eye) > F.despawn) {
        this.birds[i] = this.birds[this.birds.length - 1];
        this.birds.pop();
        continue;
      }
      const above = b.pos.y - this.field.height(b.pos.x, b.pos.z);
      if (b.climbing && above > b.height) b.climbing = false;
      b.heading += Math.sin(b.age * 0.7 + b.seed) * F.wander * dt;
      const speed = b.climbing ? THREE.MathUtils.lerp(F.takeOffSpeed, F.speed, Math.min(1, b.age / 3)) : F.speed;
      const rise = b.climbing ? F.climbRate : THREE.MathUtils.clamp((b.height - above) * 0.5, -2, 2);
      _want.set(-Math.sin(b.heading) * speed, rise, -Math.cos(b.heading) * speed);
      b.vel.lerp(_want, follow);
      if (above < F.clearance) b.vel.y = Math.max(b.vel.y, 2);
      b.pos.addScaledVector(b.vel, dt);

      // Flapping all the way up; then bouts of flapping and gliding.
      if (b.climbing) b.flapping = true;
      else if ((b.switchIn -= dt) <= 0) {
        b.flapping = !b.flapping;
        b.switchIn = between(b.flapping ? F.flapFor : F.glideFor, Math.random());
      }
      b.flap += ((b.flapping ? 1 : 0) - b.flap) * (1 - Math.exp(-6 * dt));
      b.phase += (b.climbing ? F.climbBeat.rate : F.cruiseBeat.rate) * Math.PI * 2 * dt;

      // Facing where it flies, nose up or down with its climb, banking into turns.
      const yaw = Math.atan2(-b.vel.x, -b.vel.z);
      const turn = THREE.MathUtils.euclideanModulo(yaw - b.yaw + Math.PI, Math.PI * 2) - Math.PI;
      b.yaw = yaw;
      b.bank += (THREE.MathUtils.clamp((turn / Math.max(dt, 1e-4)) * 0.5, -0.7, 0.7) - b.bank) * (1 - Math.exp(-4 * dt));
    }
    this.draw();
  }

  /** How many rooks `tree` holds now: none unless it's a rookery that hasn't been emptied. */
  private rookery(tree: Tree): number {
    const R = ROOKERY;
    if (this.emptied.has(treeKey(tree))) return 0;
    const ix = Math.round(tree.x * 10);
    const iz = Math.round(tree.z * 10);
    if (tree.oak) return Math.round(between(R.oakBirds, hash2(ix, iz, 71)));
    if (tree.species !== 'broadleaf' || tree.snowy || tree.scale < R.minScale || hash2(ix, iz, 70) >= R.chance) return 0;
    return Math.round(between(R.birds, hash2(ix, iz, 72)));
  }

  private draw(): void {
    const F = FLIGHT;
    let n = 0;
    for (const b of this.birds) {
      if (b.delay > 0) continue;
      const horizontal = Math.hypot(b.vel.x, b.vel.z);
      const pitch = THREE.MathUtils.clamp(Math.atan2(b.vel.y, horizontal), -0.6, 0.6);
      // A left turn (yaw growing) rolls about +z, which lifts the right wing.
      _q.setFromEuler(_euler.set(pitch, b.yaw, b.bank));
      _body.compose(b.pos, _q, ONE);
      this.body.setMatrixAt(n, _body);
      const beat = b.climbing ? F.climbBeat : F.cruiseBeat;
      const angle = F.glideDihedral * (1 - b.flap) + b.flap * beat.amp * Math.sin(b.phase);
      for (const side of [1, -1] as const) {
        _hinge.makeTranslation(HINGE.x * side, HINGE.y, HINGE.z);
        _flap.makeRotationZ(angle * side);
        _wing.multiplyMatrices(_body, _hinge).multiply(_flap);
        (side > 0 ? this.wingR : this.wingL).setMatrixAt(n, _wing);
      }
      n++;
    }
    for (const m of [this.body, this.wingR, this.wingL]) {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
    }
  }
}

function treeKey(tree: Tree): string {
  return `${Math.round(tree.x * 10)}:${Math.round(tree.z * 10)}`;
}

/** Colours every vertex of `geometry` (non-indexed). */
function paint(geometry: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) c.toArray(colors, i * 3);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Body, head, bill and tail, facing −z. */
function buildBody(): THREE.BufferGeometry {
  const torso = new THREE.IcosahedronGeometry(0.1, 0).toNonIndexed();
  torso.scale(0.62, 0.62, 1.5);
  const head = new THREE.IcosahedronGeometry(0.055, 0).toNonIndexed();
  head.translate(0, 0.035, -0.16);
  // The bill points −z: a cone along +y turned forward.
  const bill = new THREE.ConeGeometry(0.022, 0.075, 4).toNonIndexed();
  bill.rotateX(-Math.PI / 2).translate(0, 0.025, -0.225);
  const tail = new THREE.BoxGeometry(0.09, 0.015, 0.15).toNonIndexed();
  tail.translate(0, -0.005, 0.2);
  const parts = [paint(torso, LOOK.body), paint(head, LOOK.body), paint(bill, LOOK.face), paint(tail, LOOK.body)];
  for (const p of parts) p.deleteAttribute('uv');
  return mergeGeometries(parts)!;
}

/**
 * One wing from its root at the hinge out along +x (`side` 1) or −x (−1): a broad wing with a
 * blunt, fingered tip, faced on both sides.
 */
function buildWing(side: 1 | -1): THREE.BufferGeometry {
  // Outline from above (x out along the wing, z toward the tail), fanned from the leading root.
  const outline: [number, number][] = [
    [0, -0.05],
    [0.2, -0.07],
    [0.4, -0.02],
    [0.45, 0.04],
    [0.36, 0.08],
    [0.18, 0.12],
    [0, 0.09],
  ];
  const v: number[] = [];
  const push = ([x, z]: [number, number]) => v.push(x * side, 0, z);
  for (let i = 1; i < outline.length - 1; i++) {
    // Each triangle both ways round, so it shows from above and below.
    for (const tri of [[0, i, i + 1], [0, i + 1, i]]) tri.forEach((k) => push(outline[k]));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  geometry.computeVertexNormals();
  return paint(geometry, LOOK.wing);
}
