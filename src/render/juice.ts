import * as THREE from 'three';
import type { Car, CarEvents, ContactSurface } from '../vehicle/car';
import type { GroundMix } from '../world/biome';
import { emptySample } from '../world/environment';
import type { TerrainField } from '../world/terrainField';
import type { TreeLayout } from '../world/trees';
import type { OrbitCamera } from './orbitCamera';
import { Particles } from './particles';

/** Feel values for all the feedback effects. */
const JUICE = {
  /** Only cars this close to the camera throw particles (m). */
  effectRange: 120,
  /** Tyre spray, particles per second per tyre. */
  sprayPerSlip: 9,
  sprayPerSpeed: 0.7,
  sprayFromSpeed: 6,
  /** Terrain steeper than this (normal Y below) is rock: sparks, no snow. Matches the terrain colouring. */
  rockBelow: 0.7,
  /** Ground counts as hard (metal scraping it sparks) past this share of stone. */
  stoneHard: 0.5,
  /** Screen shake (trauma 0..1) per m/s of impact severity / landing speed. */
  shakePerSeverity: 0.06,
  maxImpactShake: 0.7,
  shakePerLanding: 0.05,
  landingShakeFrom: 4,
  maxLandingShake: 0.5,
  /** Camera dip per m/s of landing speed. */
  kickPerLanding: 0.09,
  /** Hit-stop: freeze the simulation briefly on big crashes (s). */
  hitStopFrom: 8,
  hitStopBase: 0.05,
  hitStopMax: 0.12,
  /** Crashes of other cars this close still rattle the camera a little (m). */
  nearbyShakeRange: 40,
};

const COLOR = {
  snow: new THREE.Color('#f4f8fc'),
  snowShade: new THREE.Color('#dce6f1'),
  /** Torn turf: grass bits and the dark soil under them, and the faint dust they raise. */
  turf: new THREE.Color('#5f8a3c'),
  soil: new THREE.Color('#5e4330'),
  grassDust: new THREE.Color('#b9b48f'),
  dirtDust: new THREE.Color('#9a7a5a'),
  stoneChip: new THREE.Color('#7f7b74'),
  /** Leaves and needles knocked off bare trees. */
  leaf: new THREE.Color('#5d8f37'),
  leafDark: new THREE.Color('#467429'),
  needle: new THREE.Color('#2f5a3c'),
  spark: new THREE.Color('#ff8a1a'),
  sparkHot: new THREE.Color('#ffc94a'),
  rockDust: new THREE.Color('#9a9ca3'),
};

const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _mix: GroundMix = { snow: 0, grass: 0, dirt: 0, stone: 0 };
const _env = emptySample();
type Ground = keyof GroundMix;

/**
 * "Juice": feedback that makes driving and crashing feel physical. Spray from
 * tyres and puffs on landings and impacts that match the ground (snow powder,
 * torn turf, dirt, stone dust), sparks from metal on rock or metal, snow,
 * leaves or needles shaken off trees, screen shake, a landing dip and hit-stop.
 */
export class Juice implements CarEvents {
  /** Light stuff that hangs in the air: snow powder, dust, leaves. */
  private readonly snow: Particles;
  /** Heavy bits that fall straight back: turf, soil clods, stone chips. */
  private readonly clods: Particles;
  private readonly sparks: Particles;
  /** Fractional particles carried between frames, per emitter. */
  private readonly carry = new WeakMap<object, number>();

  constructor(
    scene: THREE.Scene,
    private readonly field: TerrainField,
    private readonly trees: TreeLayout,
    private readonly orbit: OrbitCamera,
    private readonly camera: THREE.Camera,
    private readonly isPlayer: (car: Car) => boolean,
    private readonly hitStop: (seconds: number) => void,
  ) {
    this.snow = new Particles(scene, field, { capacity: 2500, blending: THREE.NormalBlending, gravity: 0.25, drag: 2.5 });
    this.clods = new Particles(scene, field, { capacity: 1500, blending: THREE.NormalBlending, gravity: 1, drag: 0.6 });
    // Normal blending: additive sparks wash out to white against bright snow.
    this.sparks = new Particles(scene, field, { capacity: 600, blending: THREE.NormalBlending, gravity: 1, drag: 0.4 });
  }

  update(dt: number, cars: readonly Car[], halfHeight: number): void {
    for (const car of cars) {
      if (car.position.distanceTo(this.camera.position) > JUICE.effectRange) continue;
      this.tyreSpray(dt, car);
      this.scrape(dt, car);
    }
    this.snow.update(dt, halfHeight);
    this.clods.update(dt, halfHeight);
    this.sparks.update(dt, halfHeight);
  }

  // --- CarEvents

  impact(car: Car, at: THREE.Vector3, severity: number, surface: ContactSurface): void {
    if (this.near(at)) {
      const k = Math.min(1, severity / 12);
      if (surface === 'metal' || surface === 'rock' || (surface === 'ground' && this.isHard(at))) {
        this.burstSparks(at, car.velocity, 10 + Math.round(30 * k));
        if (surface !== 'metal') this.burstDust(at, car.velocity, 6, 1.5, COLOR.rockDust);
      } else {
        this.burstGround(at, car.velocity, 8 + Math.round(40 * k), 2 + 4 * k);
      }
      if (surface === 'tree') this.treeShower(at);
    }

    const J = JUICE;
    if (this.isPlayer(car)) {
      this.orbit.addTrauma(Math.min(J.maxImpactShake, severity * J.shakePerSeverity));
      if (severity > J.hitStopFrom) this.hitStop(Math.min(J.hitStopMax, J.hitStopBase + (severity - J.hitStopFrom) * 0.01));
    } else {
      const d = at.distanceTo(this.camera.position);
      if (d < J.nearbyShakeRange) this.orbit.addTrauma((1 - d / J.nearbyShakeRange) * severity * J.shakePerSeverity * 0.5);
    }
  }

  glass(): void {}

  clank(): void {}

  land(car: Car, _at: THREE.Vector3, strength: number): void {
    if (this.near(car.position)) {
      for (const tyre of car.tyres) {
        if (!tyre.attached || !tyre.grounded || this.isRock(tyre.contact)) continue;
        this.burstGround(tyre.contact, car.velocity, Math.min(25, 6 + Math.round(strength * 1.5)), 1 + strength * 0.25);
      }
    }
    if (!this.isPlayer(car)) return;
    const J = JUICE;
    if (strength > J.landingShakeFrom) this.orbit.addTrauma(Math.min(J.maxLandingShake, (strength - J.landingShakeFrom) * J.shakePerLanding));
    this.orbit.kick(strength * J.kickPerLanding);
  }

  // --- Continuous emitters

  private tyreSpray(dt: number, car: Car): void {
    const speed = Math.abs(car.forwardSpeed);
    const boost = car.lastInput.handbrake ? 1.5 : 1;
    for (const tyre of car.tyres) {
      if (!tyre.attached || !tyre.grounded) continue;
      const rate = (tyre.slip * JUICE.sprayPerSlip + Math.max(0, speed - JUICE.sprayFromSpeed) * JUICE.sprayPerSpeed) * boost;
      const n = this.take(tyre, rate * dt);
      if (n === 0 || this.isRock(tyre.contact)) continue;
      this.groundAt(tyre.contact);
      _p.copy(tyre.contact).setY(tyre.contact.y + 0.1);
      for (let i = 0; i < n; i++) {
        _v.copy(car.velocity).multiplyScalar(0.35);
        _v.x += (Math.random() - 0.5) * 3;
        _v.y += 1 + Math.random() * (1 + tyre.slip * 0.3);
        _v.z += (Math.random() - 0.5) * 3;
        this.emitGround(pickGround(), _p, _v, 0.25);
      }
    }
  }

  /** Metal on rock or metal throws sparks; a body dragging through snow throws a plume. */
  private scrape(dt: number, car: Car): void {
    const speed = car.velocity.length();
    if (!car.scraping || speed < 3) return;
    const at = car.scrapePoint;
    const metal = car.scrapeSurface === 'metal' || car.scrapeSurface === 'rock' || (car.scrapeSurface === 'ground' && this.isHard(at));
    const n = this.take(car, speed * (metal ? 3 : 2) * dt);
    if (metal) this.burstSparks(at, car.velocity, n);
    else if (n > 0) this.burstGround(at, car.velocity, n, 1.5);
  }

  // --- Bursts

  /** A puff of whatever the ground at `at` is made of (see emitGround). */
  private burstGround(at: THREE.Vector3, carry: THREE.Vector3, count: number, spread: number): void {
    this.groundAt(at);
    for (let i = 0; i < count; i++) {
      _v.copy(carry).multiplyScalar(0.3);
      _v.x += (Math.random() - 0.5) * 2 * spread;
      _v.y += Math.random() * spread;
      _v.z += (Math.random() - 0.5) * 2 * spread;
      this.emitGround(pickGround(), at, _v, 0.3);
    }
  }

  private burstDust(at: THREE.Vector3, carry: THREE.Vector3, count: number, spread: number, color: THREE.Color): void {
    for (let i = 0; i < count; i++) {
      _v.copy(carry).multiplyScalar(0.3);
      _v.x += (Math.random() - 0.5) * 2 * spread;
      _v.y += Math.random() * spread;
      _v.z += (Math.random() - 0.5) * 2 * spread;
      this.snow.emit({ position: at, velocity: _v, size: 0.3 + Math.random() * 0.3, grow: 1.1, life: 0.8 + Math.random() * 0.8, color, alpha: 0.75 });
    }
  }

  /**
   * One particle of thrown-up ground, `size` the base for powder: snow is light powder that
   * hangs; grass tears into turf and soil bits that fall back, with a faint dust; dirt raises a
   * brown cloud and clods; stone gives grey dust and chips.
   */
  private emitGround(ground: Ground, at: THREE.Vector3, velocity: THREE.Vector3, size: number): void {
    const r = Math.random();
    const powder = (color: THREE.Color, scale: number, alpha: number, life: number) =>
      this.snow.emit({ position: at, velocity, size: size * scale * (1 + Math.random() * 0.8), grow: 1, life: life * (0.8 + Math.random() * 0.6), color, alpha });
    const clod = (color: THREE.Color) =>
      this.clods.emit({ position: at, velocity, size: 0.07 + Math.random() * 0.07, grow: 0, life: 0.7 + Math.random() * 0.5, color, alpha: 1 });
    if (ground === 'snow') powder(r < 0.5 ? COLOR.snow : COLOR.snowShade, 1, 0.7, 1);
    else if (ground === 'grass') r < 0.7 ? clod(r < 0.45 ? COLOR.turf : COLOR.soil) : powder(COLOR.grassDust, 1, 0.3, 0.9);
    else if (ground === 'dirt') r < 0.4 ? clod(COLOR.soil) : powder(COLOR.dirtDust, 1.4, 0.5, 1.6);
    else r < 0.5 ? clod(COLOR.stoneChip) : powder(COLOR.rockDust, 0.9, 0.5, 0.9);
  }

  private burstSparks(at: THREE.Vector3, carry: THREE.Vector3, count: number): void {
    for (let i = 0; i < count; i++) {
      _v.copy(carry).multiplyScalar(0.6);
      _v.x += (Math.random() - 0.5) * 8;
      _v.y += 1 + Math.random() * 4;
      _v.z += (Math.random() - 0.5) * 8;
      this.sparks.emit({
        position: at,
        velocity: _v,
        size: 0.09 + Math.random() * 0.06,
        grow: -0.08,
        life: 0.3 + Math.random() * 0.35,
        color: Math.random() < 0.4 ? COLOR.sparkHot : COLOR.spark,
        alpha: 1,
      });
    }
  }

  /**
   * Whatever the hit tree carries drifts down around the trunk: snow from a snowy spruce, leaves
   * from a broadleaf tree, a few needles from a bare conifer.
   */
  private treeShower(at: THREE.Vector3): void {
    const tree = this.trees.blocking(at.x, at.z, 2);
    const kind = !tree || tree.snowy ? 'snow' : tree.species === 'broadleaf' ? 'leaves' : 'needles';
    const count = kind === 'needles' ? 12 : 40;
    for (let i = 0; i < count; i++) {
      _p.set(at.x + (Math.random() - 0.5) * 3, at.y + 2 + Math.random() * 3.5, at.z + (Math.random() - 0.5) * 3);
      _v.set((Math.random() - 0.5) * 0.6, -0.3 - Math.random() * 0.5, (Math.random() - 0.5) * 0.6);
      if (kind === 'snow') {
        this.snow.emit({ position: _p, velocity: _v, size: 0.35 + Math.random() * 0.3, grow: 0.4, life: 2 + Math.random(), color: COLOR.snow, alpha: 0.8 });
      } else {
        // Leaves and needles flutter down slowly and don't grow.
        const color = kind === 'leaves' ? (Math.random() < 0.5 ? COLOR.leaf : COLOR.leafDark) : COLOR.needle;
        this.snow.emit({ position: _p, velocity: _v.multiplyScalar(0.6), size: 0.12 + Math.random() * 0.1, grow: 0, life: 2.5 + Math.random() * 1.5, color, alpha: 1 });
      }
    }
  }

  // --- Helpers

  /** Whole particles to emit now for `amount` (fractions carry over per emitter). */
  private take(emitter: object, amount: number): number {
    const total = (this.carry.get(emitter) ?? 0) + amount;
    const n = Math.floor(total);
    this.carry.set(emitter, total - n);
    return n;
  }

  private isRock(at: THREE.Vector3): boolean {
    return this.field.normal(at.x, at.z, _n).y < JUICE.rockBelow;
  }

  /** Hard ground that metal sparks against: near-vertical rock, or mostly stone. */
  private isHard(at: THREE.Vector3): boolean {
    return this.isRock(at) || this.groundAt(at).stone > JUICE.stoneHard;
  }

  /** What the ground at `at` is made of; also leaves it in the shared mix that pickGround reads. */
  private groundAt(at: THREE.Vector3): GroundMix {
    return this.field.biome.mix(at.x, at.z, this.field.normal(at.x, at.z, _n), this.field.environment.at(at.x, at.z, _env), _mix);
  }

  private near(at: THREE.Vector3): boolean {
    return at.distanceTo(this.camera.position) < JUICE.effectRange;
  }
}

/** A random ground material, weighted by the shared mix (set by Juice.groundAt). */
function pickGround(): Ground {
  let r = Math.random();
  for (const g of ['snow', 'grass', 'dirt', 'stone'] as const) {
    r -= _mix[g];
    if (r < 0) return g;
  }
  return 'grass';
}
