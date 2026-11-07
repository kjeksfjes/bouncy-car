import * as THREE from 'three';
import type { Car, CarEvents, ContactSurface } from '../vehicle/car';
import type { TerrainField } from '../world/terrainField';
import type { ChaseCamera } from './chaseCamera';
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
  spark: new THREE.Color('#ff8a1a'),
  sparkHot: new THREE.Color('#ffc94a'),
  rockDust: new THREE.Color('#9a9ca3'),
};

const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();

/**
 * "Juice": feedback that makes driving and crashing feel physical. Snow spray
 * from tyres, puffs on landings and impacts, sparks from metal on rock or
 * metal, snow shaken off trees, screen shake, a landing dip and hit-stop.
 */
export class Juice implements CarEvents {
  private readonly snow: Particles;
  private readonly sparks: Particles;
  /** Fractional particles carried between frames, per emitter. */
  private readonly carry = new WeakMap<object, number>();

  constructor(
    scene: THREE.Scene,
    private readonly field: TerrainField,
    private readonly chase: ChaseCamera,
    private readonly camera: THREE.Camera,
    private readonly isPlayer: (car: Car) => boolean,
    private readonly hitStop: (seconds: number) => void,
  ) {
    this.snow = new Particles(scene, field, { capacity: 2500, blending: THREE.NormalBlending, gravity: 0.25, drag: 2.5 });
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
    this.sparks.update(dt, halfHeight);
  }

  // --- CarEvents

  impact(car: Car, at: THREE.Vector3, severity: number, surface: ContactSurface): void {
    if (this.near(at)) {
      const k = Math.min(1, severity / 12);
      if (surface === 'metal' || (surface === 'ground' && this.isRock(at))) {
        this.burstSparks(at, car.velocity, 10 + Math.round(30 * k));
        if (surface === 'ground') this.burstSnow(at, car.velocity, 6, 1.5, COLOR.rockDust);
      } else {
        this.burstSnow(at, car.velocity, 8 + Math.round(40 * k), 2 + 4 * k, COLOR.snow);
      }
      if (surface === 'tree') this.treeShower(at);
    }

    const J = JUICE;
    if (this.isPlayer(car)) {
      this.chase.addTrauma(Math.min(J.maxImpactShake, severity * J.shakePerSeverity));
      if (severity > J.hitStopFrom) this.hitStop(Math.min(J.hitStopMax, J.hitStopBase + (severity - J.hitStopFrom) * 0.01));
    } else {
      const d = at.distanceTo(this.camera.position);
      if (d < J.nearbyShakeRange) this.chase.addTrauma((1 - d / J.nearbyShakeRange) * severity * J.shakePerSeverity * 0.5);
    }
  }

  glass(): void {}

  clank(): void {}

  land(car: Car, _at: THREE.Vector3, strength: number): void {
    if (this.near(car.position)) {
      for (const tyre of car.tyres) {
        if (!tyre.attached || !tyre.grounded || this.isRock(tyre.contact)) continue;
        this.burstSnow(tyre.contact, car.velocity, Math.min(25, 6 + Math.round(strength * 1.5)), 1 + strength * 0.25, COLOR.snow);
      }
    }
    if (!this.isPlayer(car)) return;
    const J = JUICE;
    if (strength > J.landingShakeFrom) this.chase.addTrauma(Math.min(J.maxLandingShake, (strength - J.landingShakeFrom) * J.shakePerLanding));
    this.chase.kick(strength * J.kickPerLanding);
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
      for (let i = 0; i < n; i++) {
        _v.copy(car.velocity).multiplyScalar(0.35);
        _v.x += (Math.random() - 0.5) * 3;
        _v.y += 1 + Math.random() * (1 + tyre.slip * 0.3);
        _v.z += (Math.random() - 0.5) * 3;
        this.snow.emit({
          position: _p.copy(tyre.contact).setY(tyre.contact.y + 0.1),
          velocity: _v,
          size: 0.25 + Math.random() * 0.2,
          grow: 0.9,
          life: 0.7 + Math.random() * 0.5,
          color: Math.random() < 0.5 ? COLOR.snow : COLOR.snowShade,
          alpha: 0.7,
        });
      }
    }
  }

  /** Metal on rock or metal throws sparks; a body dragging through snow throws a plume. */
  private scrape(dt: number, car: Car): void {
    const speed = car.velocity.length();
    if (!car.scraping || speed < 3) return;
    const at = car.scrapePoint;
    const metal = car.scrapeSurface === 'metal' || (car.scrapeSurface === 'ground' && this.isRock(at));
    const n = this.take(car, speed * (metal ? 3 : 2) * dt);
    if (metal) this.burstSparks(at, car.velocity, n);
    else if (n > 0) this.burstSnow(at, car.velocity, n, 1.5, COLOR.snow);
  }

  // --- Bursts

  private burstSnow(at: THREE.Vector3, carry: THREE.Vector3, count: number, spread: number, color: THREE.Color): void {
    for (let i = 0; i < count; i++) {
      _v.copy(carry).multiplyScalar(0.3);
      _v.x += (Math.random() - 0.5) * 2 * spread;
      _v.y += Math.random() * spread;
      _v.z += (Math.random() - 0.5) * 2 * spread;
      this.snow.emit({ position: at, velocity: _v, size: 0.3 + Math.random() * 0.3, grow: 1.1, life: 0.8 + Math.random() * 0.8, color, alpha: 0.75 });
    }
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

  /** Snow knocked off the branches drifts down around the trunk. */
  private treeShower(at: THREE.Vector3): void {
    for (let i = 0; i < 40; i++) {
      _p.set(at.x + (Math.random() - 0.5) * 3, at.y + 2 + Math.random() * 3.5, at.z + (Math.random() - 0.5) * 3);
      _v.set((Math.random() - 0.5) * 0.6, -0.3 - Math.random() * 0.5, (Math.random() - 0.5) * 0.6);
      this.snow.emit({ position: _p, velocity: _v, size: 0.35 + Math.random() * 0.3, grow: 0.4, life: 2 + Math.random(), color: COLOR.snow, alpha: 0.8 });
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

  private near(at: THREE.Vector3): boolean {
    return at.distanceTo(this.camera.position) < JUICE.effectRange;
  }
}
