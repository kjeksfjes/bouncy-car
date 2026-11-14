import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Car, ContactSurface } from '../vehicle/car';
import type { GroundMix } from './biome';
import { emptySample } from './environment';
import { hash2 } from './noise';
import type { TerrainField } from './terrainField';
import type { Tree, TreeLayout } from './trees';

/**
 * The rook: glossy black, with the pale bare face at the base of its bill and dark legs. Model-local
 * metres, facing −z with +y up: ≈45 cm from bill to tail, ≈90 cm across the wings.
 */
const LOOK = { body: '#15161b', face: '#a8a49c', wing: '#121317', legs: '#2a2a2e' };

/**
 * How a bird flies off. It takes off at `takeOffSpeed` m/s and works up to `speed` (rooks cruise at
 * ≈40 km/h), climbing at `climbRate` m/s to a height above the ground between `height` (min..max, m),
 * where it levels off and holds it. Its velocity follows what it wants at `response` (1/s). It
 * flees along a heading up to `spread` rad either side of straight away from what startled it,
 * wandering off it by up to `wander` rad/s. Wings: `climbBeat` while climbing, `cruiseBeat` after
 * (beats/s and amplitude in rad), cruising in bouts of flapping (`flapFor` s) and gliding
 * (`glideFor` s) with the wings held at `glideDihedral` rad. It keeps `clearance` m above the
 * ground, and is gone once `despawn` m from the camera or `maxAge` s after taking off.
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

/**
 * Flocks feeding on open grass. The ground is split into `cell` m squares, each holding a flock by
 * `chance`, of `birds` (min..max), at a spot picked within it: only where the ground is at least
 * `minGrass` grass, no steeper than `minGroundUp` (normal Y), and with no tree within `treeClear` m.
 * The birds spread over `spacing` × √count m round it. Flocks within `reach` m of the player are
 * there (a rook at that distance is under a pixel, so they don't pop in), further ones go, and come
 * back if it returns, unless they've flown.
 *
 * On the ground they walk at `walk` m/s, peck and look round (each for a while, see GroundBird
 * update), staying within the flock. A car within `startle` m of a bird, or a crash within `crash` m
 * of the flock, sets it off: the bird nearest the trouble first, then the rest in a ripple, each
 * `ripple.perMetre` s per m further off, plus up to `ripple.jitter` s.
 */
const FLOCKS = {
  cell: 120,
  chance: 0.2,
  birds: [8, 25] as const,
  minGrass: 0.6,
  minGroundUp: 0.92,
  treeClear: 12,
  spacing: 1.2,
  reach: 220,
  walk: 0.35,
  startle: 22,
  crash: 60,
  ripple: { perMetre: 0.06, jitter: 0.35 },
  /** How often the flocks round the player are looked over (s). */
  every: 0.5,
};

/** The body's centre above the ground standing (m), and the folded wings' length as a share of open. */
const STANCE = { height: 0.13, fold: 0.62 };

/** Most birds at once, on the ground and in the air. */
const CAPACITY = 192;

type GroundAction = 'walk' | 'peck' | 'look';

interface Bird {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** On the ground (with its flock) or flying off. */
  flying: boolean;
  /** Flying: the heading it's making for, as a yaw (from −z, positive turned toward −x). On the ground: the way it faces. */
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
  pitch: number;
  bank: number;
  /** Seconds still hidden in the crown before it leaves (rookery birds). */
  delay: number;
  /** Seconds since it took off. */
  age: number;
  /** On the ground: what it's doing and for how much longer, and its flock. */
  action: GroundAction;
  actionLeft: number;
  flock: Flock | null;
  /** Startled: seconds until it takes off, and the yaw it flees along. */
  leaveIn: number;
  leaveYaw: number;
}

interface Flock {
  key: string;
  centre: THREE.Vector3;
  radius: number;
  birds: Bird[];
  startled: boolean;
}

const _q = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _body = new THREE.Matrix4();
const _wing = new THREE.Matrix4();
const _hinge = new THREE.Matrix4();
const _flap = new THREE.Matrix4();
const _fold = new THREE.Matrix4();
const _foldScale = new THREE.Matrix4().makeScale(STANCE.fold, 1, 1);
const _want = new THREE.Vector3();
const _n = new THREE.Vector3();
const _env = emptySample();
const _mix: GroundMix = { snow: 0, grass: 0, dirt: 0, stone: 0 };
const ONE = new THREE.Vector3(1, 1, 1);
/** Where the wings join the body (right side; the left mirrors it), model-local m: open, and folded over the back. */
const HINGE = new THREE.Vector3(0.045, 0.025, -0.03);
const FOLDED = new THREE.Vector3(0.03, 0.05, -0.05);

const between = (range: readonly [number, number], t: number) => range[0] + (range[1] - range[0]) * t;
const yawTo = (dx: number, dz: number) => Math.atan2(-dx, -dz);

/**
 * Rooks: they burst out of rookery trees when a car hits one, feed in flocks on open grass that lift
 * off when a car comes close, and fly off.
 */
export class Birds {
  private readonly birds: Bird[] = [];
  /** Trees whose rooks have flown, by position (see treeKey). */
  private readonly emptied = new Set<string>();
  /** The flocks on the ground round the player, by cell; the cells whose flock has flown, and those with none. */
  private readonly flocks = new Map<string, Flock>();
  private readonly flown = new Set<string>();
  private readonly barren = new Set<string>();
  private lookOver = 0;
  private readonly body: THREE.InstancedMesh;
  private readonly wingR: THREE.InstancedMesh;
  private readonly wingL: THREE.InstancedMesh;
  private readonly legs: THREE.InstancedMesh;

  /**
   * @param groundAt the drawn ground's height at (x, z), for standing birds on it (see Terrain.surfaceHeight)
   */
  constructor(
    scene: THREE.Scene,
    private readonly field: TerrainField,
    private readonly trees: TreeLayout,
    private readonly groundAt: (x: number, z: number) => number,
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
    this.legs = mesh(buildLegs());
  }

  /**
   * A car's hit (see CarEvents.impact): a hard enough knock on a rookery tree sends its rooks up,
   * and any crash near a flock sets it off.
   */
  impact(car: Car, at: THREE.Vector3, severity: number, surface: ContactSurface): void {
    for (const flock of this.flocks.values()) {
      if (!flock.startled && flock.centre.distanceTo(at) < FLOCKS.crash) this.startle(flock, at);
    }
    if (surface !== 'tree' || severity < ROOKERY.hitFrom) return;
    const tree = this.trees.blocking(at.x, at.z, 2);
    if (!tree) return;
    const count = this.rookery(tree);
    if (count === 0) return;
    this.emptied.add(treeKey(tree));
    const away = yawTo(tree.x - car.position.x, tree.z - car.position.z);
    const crownY = tree.y + (tree.oak ? 10 : 3.5) * tree.scale;
    const crownR = (tree.oak ? 4.5 : 1.4) * tree.scale;
    for (let i = 0; i < count && this.birds.length < CAPACITY; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = crownR * Math.sqrt(Math.random()) * 0.8;
      const b = newBird(new THREE.Vector3(tree.x + Math.cos(a) * r, crownY + (Math.random() - 0.3) * crownR * 0.6, tree.z + Math.sin(a) * r));
      b.delay = Math.random() * ROOKERY.stagger;
      this.takeOff(b, away + (Math.random() * 2 - 1) * FLIGHT.spread);
      this.birds.push(b);
    }
  }

  /**
   * @param dt game time (s): birds freeze when paused and slow down in slow motion
   * @param eye the camera's position: flying birds far from it are gone
   * @param player the player's car, round which the flocks are
   * @param cars every car's position (the player's included), which startle the flocks
   */
  update(dt: number, eye: THREE.Vector3, player: THREE.Vector3, cars: readonly THREE.Vector3[]): void {
    if ((this.lookOver -= dt) <= 0) {
      this.lookOver = FLOCKS.every;
      this.placeFlocks(player);
    }
    for (const flock of this.flocks.values()) {
      if (flock.startled) continue;
      for (const b of flock.birds) {
        const near = cars.find((c) => c.distanceTo(b.pos) < FLOCKS.startle);
        if (near) {
          this.startle(flock, near);
          break;
        }
      }
    }

    for (let i = this.birds.length - 1; i >= 0; i--) {
      const b = this.birds[i];
      if (b.delay > 0) {
        b.delay -= dt;
        continue;
      }
      if (!b.flying) {
        if (b.leaveIn >= 0 && (b.leaveIn -= dt) < 0) this.takeOff(b, b.leaveYaw);
        else this.graze(dt, b);
        continue;
      }
      b.age += dt;
      if (b.age > FLIGHT.maxAge || b.pos.distanceTo(eye) > FLIGHT.despawn) {
        this.birds[i] = this.birds[this.birds.length - 1];
        this.birds.pop();
        continue;
      }
      this.fly(dt, b);
    }
    this.draw();
  }

  /** Flying: away along its heading, up to its height, flapping and gliding. */
  private fly(dt: number, b: Bird): void {
    const F = FLIGHT;
    const above = b.pos.y - this.field.height(b.pos.x, b.pos.z);
    if (b.climbing && above > b.height) b.climbing = false;
    b.heading += Math.sin(b.age * 0.7 + b.seed) * F.wander * dt;
    const speed = b.climbing ? THREE.MathUtils.lerp(F.takeOffSpeed, F.speed, Math.min(1, b.age / 3)) : F.speed;
    const rise = b.climbing ? F.climbRate : THREE.MathUtils.clamp((b.height - above) * 0.5, -2, 2);
    _want.set(-Math.sin(b.heading) * speed, rise, -Math.cos(b.heading) * speed);
    b.vel.lerp(_want, 1 - Math.exp(-F.response * dt));
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
    const yaw = yawTo(b.vel.x, b.vel.z);
    const turn = THREE.MathUtils.euclideanModulo(yaw - b.yaw + Math.PI, Math.PI * 2) - Math.PI;
    b.yaw = yaw;
    b.pitch = THREE.MathUtils.clamp(Math.atan2(b.vel.y, Math.hypot(b.vel.x, b.vel.z)), -0.6, 0.6);
    b.bank += (THREE.MathUtils.clamp((turn / Math.max(dt, 1e-4)) * 0.5, -0.7, 0.7) - b.bank) * (1 - Math.exp(-4 * dt));
  }

  /** On the ground: walking, pecking and looking round, staying with its flock. */
  private graze(dt: number, b: Bird): void {
    const flock = b.flock!;
    if ((b.actionLeft -= dt) <= 0) {
      const r = Math.random();
      b.action = r < 0.45 ? 'peck' : r < 0.8 ? 'walk' : 'look';
      b.actionLeft = b.action === 'peck' ? 0.25 + Math.random() * 0.4 : b.action === 'walk' ? 0.6 + Math.random() * 1.4 : 0.5 + Math.random();
      if (b.action === 'walk') {
        // Back toward the flock once it has strayed to its edge.
        const dx = flock.centre.x - b.pos.x;
        const dz = flock.centre.z - b.pos.z;
        b.heading = Math.hypot(dx, dz) > flock.radius ? yawTo(dx, dz) : b.heading + (Math.random() * 2 - 1) * 1.2;
      }
    }
    if (b.action === 'walk') {
      b.pos.x -= Math.sin(b.heading) * FLOCKS.walk * dt;
      b.pos.z -= Math.cos(b.heading) * FLOCKS.walk * dt;
    }
    b.yaw = b.heading;
    b.pitch += ((b.action === 'peck' ? -0.55 : b.action === 'look' ? 0.12 : 0) - b.pitch) * (1 - Math.exp(-14 * dt));
    b.pos.y = this.groundAt(b.pos.x, b.pos.z) + STANCE.height;
  }

  /** Sets a flock off from `from`: the bird nearest it first, the rest in a ripple. */
  private startle(flock: Flock, from: THREE.Vector3): void {
    const R = FLOCKS.ripple;
    flock.startled = true;
    this.flown.add(flock.key);
    this.flocks.delete(flock.key);
    let first = Infinity;
    for (const b of flock.birds) first = Math.min(first, b.pos.distanceTo(from));
    for (const b of flock.birds) {
      b.leaveIn = (b.pos.distanceTo(from) - first) * R.perMetre + Math.random() * R.jitter;
      b.leaveYaw = yawTo(b.pos.x - from.x, b.pos.z - from.z) + (Math.random() * 2 - 1) * FLIGHT.spread;
    }
  }

  private takeOff(b: Bird, heading: number): void {
    b.flying = true;
    b.flock = null;
    b.heading = heading;
    b.yaw = heading;
    b.vel.set(-Math.sin(heading) * 2, 2.5, -Math.cos(heading) * 2);
    b.climbing = true;
    b.flapping = true;
    b.flap = 1;
    b.age = 0;
  }

  /** Puts down the flocks of the cells within reach of the player, and lifts those beyond it. */
  private placeFlocks(player: THREE.Vector3): void {
    const F = FLOCKS;
    for (const [key, flock] of this.flocks) {
      if (flock.centre.distanceTo(player) <= F.reach + F.cell) continue;
      this.flocks.delete(key);
      for (const b of flock.birds) {
        const i = this.birds.indexOf(b);
        if (i >= 0) this.birds.splice(i, 1);
      }
    }
    const reach = Math.ceil(F.reach / F.cell);
    const cx0 = Math.floor(player.x / F.cell);
    const cz0 = Math.floor(player.z / F.cell);
    for (let cz = cz0 - reach; cz <= cz0 + reach; cz++) {
      for (let cx = cx0 - reach; cx <= cx0 + reach; cx++) {
        const key = `${cx}:${cz}`;
        if (this.flocks.has(key) || this.flown.has(key) || this.barren.has(key)) continue;
        const site = this.flockSite(cx, cz);
        if (!site) {
          this.barren.add(key);
          continue;
        }
        if (Math.hypot(site.x - player.x, site.z - player.z) > F.reach) continue;
        const count = Math.round(between(F.birds, hash2(cx, cz, 82)));
        if (this.birds.length + count > CAPACITY) return;
        this.putDown(key, site, count);
      }
    }
  }

  /** Where cell (cx, cz)'s flock feeds, or null if it has none (see FLOCKS). */
  private flockSite(cx: number, cz: number): { x: number; z: number } | null {
    const F = FLOCKS;
    if (hash2(cx, cz, 80) >= F.chance) return null;
    const x = (cx + 0.15 + 0.7 * hash2(cx, cz, 81)) * F.cell;
    const z = (cz + 0.15 + 0.7 * hash2(cx, cz, 83)) * F.cell;
    const normal = this.field.normal(x, z, _n);
    if (normal.y < F.minGroundUp) return null;
    if (this.field.biome.mix(x, z, normal, this.field.environment.at(x, z, _env), _mix).grass < F.minGrass) return null;
    if (this.trees.blocking(x, z, F.treeClear)) return null;
    return { x, z };
  }

  private putDown(key: string, site: { x: number; z: number }, count: number): void {
    const radius = FLOCKS.spacing * Math.sqrt(count);
    const flock: Flock = { key, centre: new THREE.Vector3(site.x, this.groundAt(site.x, site.z), site.z), radius, birds: [], startled: false };
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = radius * Math.sqrt(Math.random());
      const x = site.x + Math.cos(a) * r;
      const z = site.z + Math.sin(a) * r;
      const b = newBird(new THREE.Vector3(x, this.groundAt(x, z) + STANCE.height, z));
      b.flying = false;
      b.flock = flock;
      b.heading = b.yaw = Math.random() * Math.PI * 2;
      b.actionLeft = Math.random();
      flock.birds.push(b);
      this.birds.push(b);
    }
    this.flocks.set(key, flock);
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
    let standing = 0;
    for (const b of this.birds) {
      if (b.delay > 0) continue;
      // A left turn (yaw growing) rolls about +z, which lifts the right wing.
      _q.setFromEuler(_euler.set(b.pitch, b.yaw, b.flying ? b.bank : 0));
      _body.compose(b.pos, _q, ONE);
      this.body.setMatrixAt(n, _body);
      const beat = b.climbing ? F.climbBeat : F.cruiseBeat;
      const angle = F.glideDihedral * (1 - b.flap) + b.flap * beat.amp * Math.sin(b.phase);
      for (const side of [1, -1] as const) {
        if (b.flying) {
          _hinge.makeTranslation(HINGE.x * side, HINGE.y, HINGE.z);
          _flap.makeRotationZ(angle * side);
        } else {
          // Folded back along the body, over the back.
          _hinge.makeTranslation(FOLDED.x * side, FOLDED.y, FOLDED.z);
          _flap.makeRotationY((-side * Math.PI) / 2).multiply(_fold.makeRotationZ(-side * 0.25)).multiply(_foldScale);
        }
        _wing.multiplyMatrices(_body, _hinge).multiply(_flap);
        (side > 0 ? this.wingR : this.wingL).setMatrixAt(n, _wing);
      }
      if (!b.flying) this.legs.setMatrixAt(standing++, _body);
      n++;
    }
    for (const m of [this.body, this.wingR, this.wingL]) {
      m.count = n;
      m.instanceMatrix.needsUpdate = true;
    }
    this.legs.count = standing;
    this.legs.instanceMatrix.needsUpdate = true;
  }
}

/** A bird at `pos`, not yet doing anything (the caller puts it on the ground or in the air). */
function newBird(pos: THREE.Vector3): Bird {
  return {
    pos,
    vel: new THREE.Vector3(),
    flying: true,
    heading: 0,
    seed: Math.random() * 100,
    height: between(FLIGHT.height, Math.random()),
    climbing: true,
    phase: Math.random() * Math.PI * 2,
    flap: 1,
    flapping: true,
    switchIn: 0,
    yaw: 0,
    pitch: 0,
    bank: 0,
    delay: 0,
    age: 0,
    action: 'look',
    actionLeft: 0,
    flock: null,
    leaveIn: -1,
    leaveYaw: 0,
  };
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

/** The two legs, from under the body down to the ground (STANCE.height below its centre). */
function buildLegs(): THREE.BufferGeometry {
  const length = STANCE.height - 0.04;
  const parts = [-1, 1].map((side) => {
    const leg = new THREE.BoxGeometry(0.012, length, 0.012).toNonIndexed();
    leg.translate(side * 0.025, -STANCE.height + length / 2, 0.01);
    leg.deleteAttribute('uv');
    return paint(leg, LOOK.legs);
  });
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
