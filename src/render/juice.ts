import * as THREE from 'three';
import type { Car, CarEvents, ContactSurface, Grind } from '../vehicle/car';
import type { GroundMix } from '../world/biome';
import { SOD_AREA, type Clods } from '../world/clods';
import { emptySample } from '../world/environment';
import type { TerrainField } from '../world/terrainField';
import { GroundScars } from './groundScars';
import type { OrbitCamera } from './orbitCamera';
import { Particles } from './particles';
import { Sparks } from './sparks';

/** Feel values for all the feedback effects. */
const JUICE = {
  /** Only cars this close to the camera throw particles (m). */
  effectRange: 120,
  /** Tyre spray, particles per second per tyre. */
  sprayPerSlip: 9,
  sprayPerSpeed: 0.7,
  sprayFromSpeed: 6,
  /** Screen shake (trauma 0..1) per m/s of impact severity / landing speed. */
  shakePerSeverity: 0.06,
  maxImpactShake: 0.7,
  shakePerLanding: 0.05,
  landingShakeFrom: 4,
  maxLandingShake: 0.5,
  /** Camera dip per m/s of landing speed. */
  kickPerLanding: 0.09,
  /** Crashes of other cars this close still rattle the camera a little (m). */
  nearbyShakeRange: 40,
  /**
   * Sparks from the body grinding along rock or another car: per second per m/s of slide over
   * `sparkFrom`, per grinding contact. Torn off between the car and what it grinds on, they leave
   * with `sparkCarry` (min..max) of the slide, so they trail out behind the car; spread
   * `sparkSpread` m/s across it and up to `sparkLift` m/s off the surface.
   */
  sparksPerSlide: 30,
  sparkFrom: 2,
  sparkCarry: [0.3, 0.9],
  sparkSpread: 2,
  sparkLift: 2,
  /** Sparks on a hard hit: a base count plus more per m/s of severity, flung in a wide fan. */
  hitSparks: 15,
  hitSparksPerSeverity: 6,
  /**
   * Torn turf (see GroundScars). Only a tyre in a real slide tears the grass: its sideways slip,
   * held over `tearHold` s (bumps and body roll only spike it), past `tearSlip[0]` m/s, and its
   * slip angle past `tearAngle[0]`°, now and then; past both upper ends all the time. A wheel
   * locked by the handbrake skids along instead: it tears from `lockedTear[0]` m/s (held the same
   * way), all the time from `lockedTear[1]`. It leaves a rut `tyreScar` m wide.
   */
  tearSlip: [3.5, 7.5],
  tearAngle: [12, 25],
  lockedTear: [4, 8],
  tearHold: 0.3,
  tyreScar: 0.25,
  /** Ground tears only where at least this share of it shows grass or dirt (see TerrainField.softShare). */
  tearableFrom: 0.6,
  /**
   * A hit on grass harder than `gougeFrom` (m/s of severity) presses the body into it where it
   * touches: a small gouge at each touching point, `gouge` m across plus `gougePerSeverity` per
   * m/s of severity (up to `maxGouge`), stretched along the car's way by up to `gougeStretch` at
   * `stretchSpeed` m/s.
   */
  gougeFrom: 4.5,
  gouge: 0.1,
  gougePerSeverity: 0.015,
  maxGouge: 0.3,
  gougeStretch: 0.8,
  stretchSpeed: 15,
  /** A body in contact reports a hit every physics step: a car's next gouge waits this long (s), unless it's moved on by its width. */
  gougeGap: 0.25,
  /**
   * Landings that hit the ground faster than `landingGougeFrom` m/s (into it, square to its slope:
   * running down a steep slope is fast downward too) gouge under each tyre, `landingGouge` +
   * `landingGougePerSpeed` × that speed across.
   */
  landingGougeFrom: 7.5,
  landingGouge: 0.1,
  landingGougePerSpeed: 0.01,
  /** Sods torn out of a tyre's rut and thrown: per new piece of it, × how hard it slides. (Every gouge throws out its own.) */
  sodPerRut: 0.35,
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
  rockDust: new THREE.Color('#9a9ca3'),
};

const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _across = new THREE.Vector3();
const _out = new THREE.Vector3();
const _slide = new THREE.Vector3();
const _mix: GroundMix = { snow: 0, grass: 0, dirt: 0, stone: 0 };
const _env = emptySample();
const _grassNormal = new THREE.Vector3();
const _grassEnv = emptySample();
type Ground = keyof GroundMix;

/**
 * "Juice": feedback that makes driving and crashing feel physical. Spray from
 * tyres and puffs on landings and impacts that match the ground (snow powder,
 * torn turf, dirt, stone dust), sparks from metal on rock or metal, screen
 * shake and a landing dip. (What a hit tree drops is the Litter's.)
 */
export class Juice implements CarEvents {
  /** Light stuff that hangs in the air: snow powder, dust, leaves. */
  private readonly snow: Particles;
  /** Heavy bits that fall straight back: turf, soil clods, stone chips. */
  private readonly clods: Particles;
  private readonly sparks: Sparks;
  /** Fractional particles carried between frames, per emitter. */
  private readonly carry = new WeakMap<object, number>();
  /** Emitter keys for a car's grinding contacts, by index (shared between cars: they only carry fractions). */
  private readonly grindKeys = Array.from({ length: 8 }, () => ({}));
  private readonly scars: GroundScars;
  /** Each car's last gouge: where, how wide, and when (see `time`). */
  private readonly lastGouge = new WeakMap<Car, { at: THREE.Vector3; radius: number; time: number }>();
  /** Each tyre's slip (m/s), slip angle (°) and locked skid (m/s), held over JUICE.tearHold. */
  private readonly heldSlip = new WeakMap<object, { slip: number; angle: number; skid: number }>();
  /** Seconds of game time so far. */
  private time = 0;

  constructor(
    scene: THREE.Scene,
    private readonly field: TerrainField,
    private readonly orbit: OrbitCamera,
    private readonly camera: THREE.Camera,
    private readonly isPlayer: (car: Car) => boolean,
    /** The drawn ground's height at (x, z) (see Terrain.surfaceHeight), for laying scars on it. */
    surfaceHeight: (x: number, z: number) => number,
    /** Lasting clods and sods, for the turf the car tears up. */
    private readonly groundBits: Clods,
  ) {
    this.scars = new GroundScars(scene, surfaceHeight, (x, z, out) =>
      field.biome.colour(x, z, field.normal(x, z, _grassNormal), field.environment.at(x, z, _grassEnv), out),
    );
    this.snow = new Particles(scene, field, { capacity: 2500, blending: THREE.NormalBlending, gravity: 0.25, drag: 2.5 });
    this.clods = new Particles(scene, field, { capacity: 1500, blending: THREE.NormalBlending, gravity: 1, drag: 0.6 });
    this.sparks = new Sparks(scene, field, 1500);
  }

  update(dt: number, cars: readonly Car[], halfHeight: number): void {
    this.time += dt;
    for (const car of cars) {
      if (car.position.distanceTo(this.camera.position) > JUICE.effectRange) continue;
      this.tyreSpray(dt, car);
      this.scrape(dt, car);
      this.tear(dt, car);
    }
    this.scars.update();
    this.snow.update(dt, halfHeight);
    this.clods.update(dt, halfHeight);
    this.sparks.update(dt, halfHeight);
  }

  // --- CarEvents

  impact(car: Car, at: THREE.Vector3, severity: number, surface: ContactSurface): void {
    if (this.near(at)) {
      const k = Math.min(1, severity / 12);
      if (surface === 'metal' || surface === 'rock' || (surface === 'ground' && this.isHard(at))) {
        this.burstSparks(at, car.velocity, JUICE.hitSparks + Math.round(JUICE.hitSparksPerSeverity * severity));
        if (surface !== 'metal') this.burstDust(at, car.velocity, 6, 1.5, COLOR.rockDust);
      } else if (surface !== 'tree') {
        this.burstGround(at, car.velocity, 8 + Math.round(40 * k), 2 + 4 * k);
        if (surface === 'ground' && severity > JUICE.gougeFrom && grassy(this.groundAt(at))) this.gouges(car, at, severity);
      }
    }

    const J = JUICE;
    if (this.isPlayer(car)) {
      this.orbit.addTrauma(Math.min(J.maxImpactShake, severity * J.shakePerSeverity));
    } else {
      const d = at.distanceTo(this.camera.position);
      if (d < J.nearbyShakeRange) this.orbit.addTrauma((1 - d / J.nearbyShakeRange) * severity * J.shakePerSeverity * 0.5);
    }
  }

  /** A boulder tearing out of its bed: soil clods and a brown cloud (stone chips and grey dust from rock), more for a bigger one. */
  uproot(at: THREE.Vector3, velocity: THREE.Vector3, radius: number, rock: boolean): void {
    const count = Math.round(6 + 10 * radius);
    for (let i = 0; i < count; i++) {
      _v.copy(velocity).multiplyScalar(0.5);
      _v.x += (Math.random() - 0.5) * 3;
      _v.y += 1 + Math.random() * 2.5;
      _v.z += (Math.random() - 0.5) * 3;
      _p.set(at.x + (Math.random() - 0.5) * radius, at.y + 0.1, at.z + (Math.random() - 0.5) * radius);
      this.emitGround(rock ? 'stone' : 'dirt', _p, _v, 0.3 + 0.2 * radius);
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
      const J = JUICE;
      const p = car.position;
      const into = Math.max(0, -car.velocity.dot(this.field.normal(p.x, p.z, _n)));
      if (into > J.landingGougeFrom && grassy(car.tyreGround)) {
        for (const tyre of car.tyres) {
          if (tyre.attached && tyre.grounded) this.hole(tyre.contact, car.velocity, J.landingGouge + J.landingGougePerSpeed * into, 1.3);
        }
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
    const boost = car.lastInput.handbrake || car.lastInput.parkingBrake ? 1.5 : 1;
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

  /**
   * The body grinding along rock or another car throws sparks from each contact (see grind); a
   * body dragging through snow, grass or dirt throws a plume of it.
   */
  private scrape(dt: number, car: Car): void {
    const grinds = car.grinds;
    for (let i = 0; i < grinds.length; i++) {
      if (grinds[i].surface !== 'tree') this.grind(dt, grinds[i], this.grindKeys[i]);
    }
    const speed = car.velocity.length();
    if (!car.scraping || speed < 3) return;
    const at = car.scrapePoint;
    if (car.scrapeSurface !== 'ground' || this.isHard(at)) return;
    const n = this.take(car, speed * 2 * dt);
    if (n > 0) this.burstGround(at, car.velocity, n, 1.5);
  }

  /**
   * Tyres sliding hard on grass, or skidding locked by the handbrake, tear it up behind them,
   * patchily at first and all the way at full slide.
   */
  private tear(dt: number, car: Car): void {
    const J = JUICE;
    const onGrass = grassy(car.tyreGround);
    const hold = Math.min(1, dt / J.tearHold);
    for (const tyre of car.tyres) {
      let held = this.heldSlip.get(tyre);
      if (!held) this.heldSlip.set(tyre, (held = { slip: 0, angle: 0, skid: 0 }));
      const rolling = tyre.attached && tyre.grounded;
      const angle = rolling ? THREE.MathUtils.radToDeg(Math.atan2(tyre.slip, Math.abs(car.forwardSpeed))) : 0;
      held.slip += ((rolling ? tyre.slip : 0) - held.slip) * hold;
      held.angle += (angle - held.angle) * hold;
      held.skid += ((rolling && tyre.locked ? Math.hypot(car.forwardSpeed, tyre.slip) : 0) - held.skid) * hold;
      if (onGrass && rolling) {
        const sliding = Math.min(
          THREE.MathUtils.smoothstep(held.slip, J.tearSlip[0], J.tearSlip[1]),
          THREE.MathUtils.smoothstep(held.angle, J.tearAngle[0], J.tearAngle[1]),
        );
        const torn = Math.max(sliding, THREE.MathUtils.smoothstep(held.skid, J.lockedTear[0], J.lockedTear[1]));
        // A patchy tear: streaks start and break off at random, holding longer the harder it slides;
        // never onto rock or snow under this very tyre.
        const tearing = torn > 0 && this.tearable(tyre.contact) && (torn >= 1 || (this.scars.streaking(tyre) ? Math.random() > (1 - torn) * 4 * dt : Math.random() < torn * 6 * dt));
        if (this.scars.streak(tyre, tyre.contact, car.velocity, J.tyreScar, tearing) && Math.random() < J.sodPerRut * torn) {
          this.groundBits.sods(tyre.contact, car.velocity, 1, 0.16 + 0.1 * Math.random());
        }
      } else this.scars.streak(tyre, tyre.contact, car.velocity, J.tyreScar, false);
    }
  }

  /**
   * A hit on grass presses the body into it: a small gouge where each corner or edge touched
   * (see Car.hitPoints), stretched along the car's way, throwing out turf.
   */
  private gouges(car: Car, at: THREE.Vector3, severity: number): void {
    const J = JUICE;
    const radius = Math.min(J.maxGouge, J.gouge + J.gougePerSeverity * severity);
    const last = this.lastGouge.get(car);
    if (last && this.time - last.time < J.gougeGap && last.at.distanceTo(at) < last.radius) return;
    this.lastGouge.set(car, { at: at.clone(), radius, time: this.time });
    const velocity = car.velocity;
    const speed = Math.hypot(velocity.x, velocity.z);
    const stretch = 1 + J.gougeStretch * Math.min(1, speed / J.stretchSpeed);
    const points = car.hitPoints;
    const marked: THREE.Vector3[] = [];
    for (const point of points.length > 0 ? points : [at]) {
      // Points closer than a gouge's width make one gouge.
      if (marked.some((m) => m.distanceTo(point) < radius * 1.5)) continue;
      marked.push(point);
      this.hole(point, velocity, radius * (0.8 + 0.4 * Math.random()), stretch * (0.8 + 0.4 * Math.random()));
    }
    this.groundBits.burst(at, velocity, radius, 'grass');
  }

  /** Whether the ground at `at` is grass or dirt the car can tear up: not snow, stone or rock face. */
  private tearable(at: THREE.Vector3): boolean {
    return this.field.softShare(at.x, at.z) > JUICE.tearableFrom;
  }

  /** A gouge, and the sod torn out of it thrown on: about as big as the hole it leaves. Only in grass or dirt. */
  private hole(at: THREE.Vector3, velocity: THREE.Vector3, radius: number, stretch: number): void {
    if (!this.tearable(at)) return;
    this.scars.gouge(at, velocity, radius, stretch);
    this.groundBits.sods(at, velocity, 1, Math.sqrt((Math.PI * radius * radius * stretch) / SOD_AREA), false);
  }

  /** Sparks streaming off one grinding contact, along the slide, with fractions carried per `key`. */
  private grind(dt: number, grind: Grind, key: object): void {
    const J = JUICE;
    const speed = grind.slide.length();
    if (speed < J.sparkFrom) return;
    const n = this.take(key, (speed - J.sparkFrom) * J.sparksPerSlide * dt);
    if (n === 0) return;
    // The surface they fly off, facing out of it: on the ground its own (a box edge landing on it
    // reports a slanted contact normal, which would send the sparks steeply up); on anything else
    // the contact's (which points out of the car, into it).
    if (grind.surface === 'ground') this.field.normal(grind.at.x, grind.at.z, _out);
    else _out.copy(grind.normal).negate();
    // Along it: the slide laid onto the surface.
    _slide.copy(grind.slide).addScaledVector(_out, -grind.slide.dot(_out));
    _across.crossVectors(_out, _slide).normalize();
    for (let i = 0; i < n; i++) {
      _v.copy(_slide).multiplyScalar(J.sparkCarry[0] + (J.sparkCarry[1] - J.sparkCarry[0]) * Math.random());
      _v.addScaledVector(_across, (Math.random() - 0.5) * 2 * J.sparkSpread);
      _v.addScaledVector(_out, Math.random() * J.sparkLift);
      // Spread along the last step's slide, so a stream doesn't come out of one point, and start
      // just off the surface.
      _p.copy(grind.at).addScaledVector(_slide, -Math.random() * 0.02).addScaledVector(_out, 0.03);
      this.sparks.emit({ position: _p, velocity: _v, life: 0.25 + Math.random() * 0.45 });
    }
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

  /** A hard hit's fan of sparks, carried on with the car and flung wide. */
  private burstSparks(at: THREE.Vector3, carry: THREE.Vector3, count: number): void {
    for (let i = 0; i < count; i++) {
      _v.copy(carry).multiplyScalar(0.4 + 0.4 * Math.random());
      _v.x += (Math.random() - 0.5) * 10;
      _v.y += 1 + Math.random() * 5;
      _v.z += (Math.random() - 0.5) * 10;
      this.sparks.emit({ position: at, velocity: _v, life: 0.25 + Math.random() * 0.5 });
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
    return this.field.isRockFace(at.x, at.z);
  }

  /** Hard ground that metal sparks against (see TerrainField.isHard). */
  private isHard(at: THREE.Vector3): boolean {
    return this.field.isHard(at.x, at.z);
  }

  /** What the ground at `at` is made of; also leaves it in the shared mix that pickGround reads. */
  private groundAt(at: THREE.Vector3): GroundMix {
    return this.field.biome.mix(at.x, at.z, this.field.normal(at.x, at.z, _n), this.field.environment.at(at.x, at.z, _env), _mix);
  }

  private near(at: THREE.Vector3): boolean {
    return at.distanceTo(this.camera.position) < JUICE.effectRange;
  }
}

/** Mostly grass or dirt, not hard ground (stone counts 1 there on top of its cover): ground that tears. */
function grassy(g: GroundMix): boolean {
  const total = g.snow + g.grass + g.dirt + g.stone;
  return total > 0 && g.stone < 0.5 && (g.grass + g.dirt) / total > 0.5;
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
