import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { GRAVITY, PHYSICS_STEP } from '../constants';
import type { Debris } from '../world/debris';
import type { GroundMix } from '../world/biome';
import type { FluidStain } from '../world/fluids';
import type { TerrainField } from '../world/terrainField';
import type { CarConfig } from './carConfig';
import { buildCarModel, GLASS_OPACITY, GLASS_TINT, type CarModel, type CarPiece, type WheelVisual } from './carModel';
import { hullBoxes } from './blueprint';
import { Crush, type CrushEnd } from './crush';
import { CarLights, lightWireWarmUp } from './lights';
import { BodyOutline } from './outline';
import { applyDent, inwardDirection } from './damage';
import { grindPaint, wearPaint } from './paintWear';
import { withSnow } from './snowCover';
import { HingedPanels, createPanelBody } from './panels';
import { sample } from './blueprint';
import { Smoke } from '../render/smoke';
import { crackTexture } from '../render/crackTexture';

/**
 * The taillights' glow: dim red (as the shared taillight material, see carModel), and bright while
 * braking. Feel values.
 */
/** The headlamps' own glow while on (see the headlight material in carModel); off, none. */
const HEADLIGHT_ON = 0.7;

const BRAKE_LIGHT = {
  off: { colour: new THREE.Color('#7a0a10'), intensity: 0.5 },
  // Strong, but not so strong that tone mapping washes the red out toward orange.
  on: { colour: new THREE.Color('#ff140a'), intensity: 1 },
};

export interface CarInput {
  throttle: number;
  brake: number;
  /** +1 = left, −1 = right. */
  steer: number;
  /** Locks the rear wheels (held: for sliding the tail round). */
  handbrake: boolean;
  /** Locks all four wheels (set: stops the car and keeps it parked). */
  parkingBrake?: boolean;
  /** Brake only, never back up: held on from braking, it stops the car and holds it (the player's keys, see Input.car). */
  holdStill?: boolean;
}

/** What a body contact touched: snow/rock ground, a tree trunk, a boulder, or another moving body. */
export type ContactSurface = 'ground' | 'tree' | 'rock' | 'metal';

/** Read-only view of a tyre, for effects. */
export interface TyreState {
  readonly attached: boolean;
  readonly grounded: boolean;
  /** World-space contact patch (valid while grounded). */
  readonly contact: THREE.Vector3;
  /** Sideways slip speed (m/s). */
  readonly slip: number;
  /** Locked by the handbrake while on the ground: skidding along instead of rolling. */
  readonly locked: boolean;
}

interface Wheel extends TyreState {
  /** Suspension top mount, car-local. */
  anchor: THREE.Vector3;
  front: boolean;
  driven: boolean;
  attached: boolean;
  hp: number;
  /** Damage taken so far, for popping the hubcap. */
  knocks: number;
  grounded: boolean;
  locked: boolean;
  compression: number;
  /** Current spring length, also drives the visual wheel position. */
  suspLen: number;
  /** The spring length a step ago, for drawing between steps (see syncVisual). */
  prevSuspLen: number;
  spinSpeed: number;
  contact: THREE.Vector3;
  slip: number;
  visual: WheelVisual;
}

/** Things a car reports as they happen (e.g. for sound). Positions are world space. */
/** A cracked pane's material, over its crack pattern. */
function crackedGlass(map: THREE.Texture): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ map, transparent: true, roughness: 0.1, metalness: 0.3, flatShading: true });
  withSnow(material);
  return material;
}

/**
 * Stand-ins for what only appears on a car in a crash (a cracked pane, a light's wire), for
 * compiling their shaders at load instead of mid-crash (see Stage.warmUp).
 */
export function crashWarmUpObjects(): THREE.Object3D[] {
  const plane = new THREE.PlaneGeometry(0.01, 0.01);
  return [new THREE.Mesh(plane, crackedGlass(new THREE.Texture())), lightWireWarmUp()];
}

export interface CarEvents {
  impact(car: Car, at: THREE.Vector3, severity: number, surface: ContactSurface): void;
  glass(car: Car, at: THREE.Vector3, shattered: boolean): void;
  /** A panel breaking loose or tearing off, or a wheel coming off; size 0..1. */
  clank(car: Car, at: THREE.Vector3, size: number): void;
  /** Touching down after a jump; strength = downward speed (m/s). */
  land(car: Car, at: THREE.Vector3, strength: number): void;
}

/**
 * The body grinding along something hard this step (for sparks). World space: the contact point,
 * the normal out of the car, and how fast the car slides along the surface there (m/s).
 */
export interface Grind {
  at: THREE.Vector3;
  normal: THREE.Vector3;
  slide: THREE.Vector3;
  surface: ContactSurface;
}

/** At most this many grinds are kept per step (one per touching collider pair). */
const MAX_GRINDS = 6;

interface PendingImpact {
  own: RAPIER.Collider;
  other: RAPIER.Collider;
  dv: number;
}

const UP = new THREE.Vector3(0, 1, 0);
/**
 * The dev blast (Car.blast): an impulse worth `kick` m/s of the car's mass (± `vary`), up and slanting
 * `slant` away from the blast, at a point `side` m out to the car's left or right and `low` m under
 * its centre of mass, up to `along` m fore or aft (at random). Off centre, it both throws and rolls the car.
 */
const BLAST = { kick: 6, slant: 0.15, side: 0.5, low: 0.3, along: 0.8, vary: 0.15 };

const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _com = new THREE.Vector3();
const _lin = new THREE.Vector3();
const _ang = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _down = new THREE.Vector3();
const _contact = new THREE.Vector3();
const _n = new THREE.Vector3();
const _wf = new THREE.Vector3();
const _rg = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _arm = new THREE.Vector3();
const _imp = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tyreMid = new THREE.Vector3();
const _contactLocal = new THREE.Vector3();
const _contactNormal = new THREE.Vector3();
const _qInv = new THREE.Quaternion();
const _bodyUp = new THREE.Vector3();
const _hitWear = { chips: 1, scratches: 1 };
/** A touching pair's points, for grinding: a box resting flat touches at its four corners, a few more on rough ground. */
const MAX_GRIND_CONTACTS = 8;
/** Touching points kept per hit (see Car.hitPoints). */
const MAX_HIT_POINTS = 8;
/** A ground hit counts as a landing when it comes from within ~45° of straight below the car (cos 45°). */
const LANDING_UPRIGHT = 0.7;
const _grindContacts = Array.from({ length: MAX_GRIND_CONTACTS }, () => new THREE.Vector3());
const _grindNormal = new THREE.Vector3();
const _grindCentre = new THREE.Vector3();
/** World-space move of the car by its crush (see advanceIntoCrush). */
const _shift = new THREE.Vector3();

/** Contacts closer than this (m) count as touching. */
const CONTACT_TOUCH_DIST = 0.02;
/**
 * Steps (0.25 s) a panel that broke onto its hinge keeps taking the crash's crush: a crash pushes
 * the body in over several steps, and the panel goes in with it. After that, an open panel
 * no longer crumples with the body.
 */
const CRUSH_AFTER_HINGE = 15;

export class Car {
  readonly body: RAPIER.RigidBody;
  readonly model: CarModel;
  private readonly colliders = new Map<number, RAPIER.Collider>();
  /** Each collider's offset from the body origin (car-local); colliders are unrotated. */
  private readonly colliderOffsets = new Map<number, THREE.Vector3>();
  private readonly wheels: Wheel[] = [];
  private readonly pending = new Map<number, PendingImpact>();
  private readonly panels: HingedPanels;
  private readonly smoke: Smoke;
  /** Car-local point on top of the engine, where steam and smoke come out. */
  private readonly engineVent: THREE.Vector3;
  /** Car-local drip points under the radiator (coolant) and the engine (oil). */
  private readonly radiatorDrip: THREE.Vector3;
  private readonly sumpDrip: THREE.Vector3;
  /** Radiator and sump damage (hit points, see radiatorHp/sumpHp), and what's left in each (litres). */
  private radiatorDamage = 0;
  private sumpDamage = 0;
  private coolantLeft: number;
  private oilLeft: number;
  /** Distance (m) driven since each stream's last drop. */
  private readonly leakDistance = { coolant: 0, oil: 0 };
  /** The oil puddle growing under a dead, stopped car, and the time (s) to the next drop into it. */
  private puddle: FluidStain | null = null;
  private puddleDrip = 0;
  /** Wheel rays skip this car's own hanging panels. */
  private readonly rayFilter = (c: RAPIER.Collider) => !this.panels.owns(c);
  /** Front and rear crumple zones. */
  private readonly crush: Crush;
  /** Panels that broke onto their hinge in this crash, with the steps left until it's over (see Crush.deform). */
  private readonly justLoose = new Map<CarPiece, number>();
  private readonly lights: CarLights;
  /** The lower-body box and its uncrushed shape: its ends follow the crumple zones in. */
  private readonly lowerCollider: RAPIER.Collider;
  private readonly lowerHull: { center: THREE.Vector3; half: THREE.Vector3 };
  /** The cabin box and its uncrushed shape: its top comes down with the roof. */
  private readonly cabinCollider: RAPIER.Collider;
  private readonly cabinHull: { center: THREE.Vector3; half: THREE.Vector3 };
  /** Envelope used to aim dents inward. */
  private readonly hullCenter: THREE.Vector3;
  private readonly hullHalf: THREE.Vector3;

  steer = 0;
  /** The steering angle a step ago, for drawing between steps (see syncVisual). */
  private prevSteer = 0;
  integrity = 1;
  airTime = 0;
  groundedWheels = 0;
  forwardSpeed = 0;
  /** Controls applied in the last physics step. */
  lastInput: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  /** Braking on the ground this step (the pedal against the way it rolls, or holding it still): the brake lights are on. */
  braking = false;
  /** Headlights on (L switches them); a new car starts with them on. */
  headlightsOn = true;
  /** Average sideways slip of the grounded tyres (m/s). */
  slip = 0;
  /** What the tyres carry together, in car weights: 1 standing still, more in compressions, less over crests. */
  tyreLoad = 0;
  events?: CarEvents;
  /** Whether the body itself (not the wheels) touched anything in the last step. */
  private bodyTouching = false;

  private readonly prevPos = new THREE.Vector3();
  private readonly currPos = new THREE.Vector3();
  private readonly prevQuat = new THREE.Quaternion();
  private readonly currQuat = new THREE.Quaternion();

  constructor(
    readonly cfg: CarConfig,
    private readonly world: RAPIER.World,
    private readonly scene: THREE.Scene,
    private readonly debris: Debris,
    spawn: THREE.Vector3,
    yaw: number,
    paint = cfg.look.paint,
  ) {
    const [cx, cy, cz] = cfg.centerOfMass;
    const [ix, iy, iz] = cfg.inertia;
    const rot = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spawn.x, spawn.y, spawn.z)
        .setRotation(rot)
        .setAdditionalMassProperties(cfg.mass, { x: cx, y: cy, z: cz }, { x: ix, y: iy, z: iz }, { x: 0, y: 0, z: 0, w: 1 })
        .setCanSleep(false)
        .setCcdEnabled(true),
    );

    this.panels = new HingedPanels(world, scene, debris, this.body, cfg.damage);
    this.panels.onTear = (piece) => this.events?.clank(this, piece.mesh.position.clone(), 1);
    this.smoke = new Smoke(scene);
    const bp = cfg.blueprint;
    const ventZ = (bp.hood[0] + bp.hood[1]) / 2;
    this.engineVent = new THREE.Vector3(0, sample(bp.deck, ventZ) + bp.groundY + 0.05, ventZ);
    // Radiator just behind the grille, engine sump mid-bay, both at floor level.
    const floor = sample(bp.rocker, ventZ) + bp.groundY;
    this.radiatorDrip = new THREE.Vector3(0, floor, bp.front + 0.3);
    this.sumpDrip = new THREE.Vector3(0, floor, ventZ);
    this.coolantLeft = cfg.damage.coolantCapacity;
    this.oilLeft = cfg.damage.oilCapacity;

    // Report contacts whose force corresponds to at least ~2 m/s of Δv in one step.
    const forceThreshold = (cfg.mass * 2) / PHYSICS_STEP;
    const hull = hullBoxes(cfg.blueprint);
    const boxes = [hull.lower, hull.cabin].map(({ center: c, half: h }) =>
      RAPIER.ColliderDesc.cuboid(h.x, h.y, h.z).setTranslation(c.x, c.y, c.z),
    );
    for (const desc of boxes) {
      const t = desc.translation;
      desc
        .setDensity(0)
        // Low friction so a high-centred body slides off bumps instead of sticking.
        .setFriction(0.2)
        .setRestitution(0.1)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(forceThreshold);
      const collider = world.createCollider(desc, this.body);
      this.colliders.set(collider.handle, collider);
      this.colliderOffsets.set(collider.handle, new THREE.Vector3(t.x, t.y, t.z));
    }
    [this.lowerCollider, this.cabinCollider] = [...this.colliders.values()];
    this.lowerHull = { center: hull.lower.center.clone(), half: hull.lower.half.clone() };
    this.cabinHull = { center: hull.cabin.center.clone(), half: hull.cabin.half.clone() };
    // Envelope of both boxes, used to aim dents inward.
    const envelope = new THREE.Box3();
    for (const { center, half } of [hull.lower, hull.cabin]) {
      envelope.union(new THREE.Box3(center.clone().sub(half), center.clone().add(half)));
    }
    this.hullCenter = envelope.getCenter(new THREE.Vector3());
    this.hullHalf = envelope.getSize(new THREE.Vector3()).multiplyScalar(0.5);

    this.model = buildCarModel(cfg, paint);
    scene.add(this.model.root);
    this.crush = new Crush(cfg.blueprint, cfg.damage);
    this.crush.prepare(this.model.pieces);
    this.lights = new CarLights(
      this.model.lights, this.model.root, scene, debris, cfg.damage, this.model.smashedLens,
      new BodyOutline(cfg.blueprint, this.crush, this.model.pieces), debris.field,
      this.model.pieces.find((p) => p.name === 'shell')!.mesh,
    );

    const W = cfg.wheels;
    let i = 0;
    for (const z of [W.frontZ, W.rearZ]) {
      for (const side of [-1, 1]) {
        const front = z === W.frontZ;
        this.wheels.push({
          anchor: new THREE.Vector3(side * W.halfTrack, W.mountY, z),
          front,
          driven: W.drive === 'all' || (W.drive === 'front') === front,
          attached: true,
          hp: cfg.damage.wheelHp,
          knocks: 0,
          grounded: false,
          compression: 0,
          suspLen: cfg.suspension.restLength,
          prevSuspLen: cfg.suspension.restLength,
          spinSpeed: 0,
          contact: new THREE.Vector3(),
          slip: 0,
          locked: false,
          visual: this.model.wheels[i++],
        });
      }
    }

    this.captureTransform();
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    // Place the model now, so a car created mid-frame never renders at the origin.
    this.syncVisual(1, 0);
  }

  get engineAlive(): boolean {
    return this.integrity > this.cfg.damage.engineDeathAt;
  }

  get wheelsLost(): number {
    return this.wheels.filter((w) => !w.attached).length;
  }

  /** Applies suspension, tyre, engine and air-control impulses. Call before world.step(). */
  step(dt: number, input: CarInput): void {
    this.assertLive();
    this.prevSteer = this.steer;
    for (const w of this.wheels) w.prevSuspLen = w.suspLen;
    const cfg = this.cfg;
    const t = this.body.translation();
    const r = this.body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    _p.set(t.x, t.y, t.z);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _fwd.set(0, 0, -1).applyQuaternion(_q);
    _right.set(1, 0, 0).applyQuaternion(_q);
    const lin = this.body.linvel();
    const ang = this.body.angvel();
    const com = this.body.worldCom();
    _lin.set(lin.x, lin.y, lin.z);
    _ang.set(ang.x, ang.y, ang.z);
    _com.set(com.x, com.y, com.z);

    const forwardSpeed = _lin.dot(_fwd);
    this.forwardSpeed = forwardSpeed;
    this.lastInput = input;

    // Steering: less lock at speed, rate-limited for a weighty feel.
    const S = cfg.steering;
    const lock = THREE.MathUtils.lerp(S.maxAngle, S.minAngle, Math.min(1, Math.abs(forwardSpeed) / S.fullSpeed));
    const target = input.steer * lock;
    this.steer += THREE.MathUtils.clamp(target - this.steer, -S.rate * dt, S.rate * dt);

    // Throttle/brake intent. Pressing against the direction of travel brakes first.
    const E = cfg.engine;
    let drive = 0;
    let braking = false;
    if (input.throttle > 0) {
      if (forwardSpeed < -1) braking = true;
      else if (this.engineAlive) drive += input.throttle * E.force * Math.max(0, 1 - forwardSpeed / E.maxSpeed);
    }
    if (input.brake > 0) {
      if (forwardSpeed > 1 || input.holdStill) braking = true;
      else if (this.engineAlive) drive -= input.brake * E.reverseForce * Math.max(0, 1 + forwardSpeed / E.reverseMaxSpeed);
    }
    const drivenCount = this.wheels.filter((w) => w.attached && w.driven).length;

    const Su = cfg.suspension;
    const Ti = cfg.tire;
    // From the ground sampled last step (see sampleTyreGround), a step behind: it changes slowly.
    const surfaceGrip = this.surfaceGrip();
    const radius = cfg.wheels.radius;
    const mEff = cfg.mass / 4;
    _down.copy(_up).negate();
    let grounded = 0;
    let slipSum = 0;
    let loadSum = 0;

    for (const wheel of this.wheels) {
      if (!wheel.attached) continue;
      _origin.copy(wheel.anchor).applyQuaternion(_q).add(_p);
      const hit = this.world.castRayAndGetNormal(
        new RAPIER.Ray(_origin, _down),
        Su.restLength + radius,
        true,
        undefined,
        undefined,
        undefined,
        this.body,
        this.panels.count > 0 ? this.rayFilter : undefined,
      );

      if (!hit) {
        wheel.grounded = false;
        wheel.locked = false;
        wheel.compression = 0;
        // Let the wheel droop back to full extension smoothly.
        wheel.suspLen += (Su.restLength - wheel.suspLen) * Math.min(1, dt * 12);
        wheel.spinSpeed *= 0.99;
        continue;
      }

      // --- Suspension: spring + asymmetric damper + bump stop, along the car's up axis.
      const suspLen = Math.max(0, hit.timeOfImpact - radius);
      const compression = Su.restLength - suspLen;
      const compVel = (compression - wheel.compression) / dt;
      const bumpStart = Su.restLength * Su.bumpStopAt;
      if (wheel.grounded && compression > bumpStart && compVel > cfg.damage.bottomOutSpeed) {
        const bottomOut = (compVel - cfg.damage.bottomOutSpeed) * cfg.damage.bottomOutDamagePerDv;
        // Slamming down to the bump stops knocks the sump too.
        this.sumpDamage += bottomOut * cfg.damage.sumpBottomOutShare;
        this.damageWheel(wheel, bottomOut);
        // Torn off by the landing: it isn't one of the grounded wheels any more.
        if (!wheel.attached) continue;
      }
      grounded++;
      wheel.grounded = true;
      wheel.compression = compression;
      wheel.suspLen = suspLen;

      let spring = Su.stiffness * compression + (compVel > 0 ? Su.dampCompression : Su.dampRebound) * compVel;
      if (compression > bumpStart) spring += Su.bumpStopStiffness * (compression - bumpStart);
      const load = Math.max(0, spring);
      loadSum += load;
      this.body.applyImpulseAtPoint(_imp.copy(_up).multiplyScalar(load * dt), _origin, true);

      // --- Tyre: velocity-cancelling lateral grip + drive/brake, limited by a friction circle.
      _contact.copy(_origin).addScaledVector(_down, hit.timeOfImpact);
      _n.set(hit.normal.x, hit.normal.y, hit.normal.z);
      _wf.copy(_fwd);
      if (wheel.front) _wf.applyAxisAngle(_up, this.steer);
      _wf.addScaledVector(_n, -_wf.dot(_n)).normalize();
      _rg.crossVectors(_wf, _n).normalize();

      _arm.subVectors(_contact, _com);
      _vel.crossVectors(_ang, _arm).add(_lin);
      const vLong = _vel.dot(_wf);
      const vLat = _vel.dot(_rg);
      const stopLong = (Math.abs(vLong) * mEff) / dt; // force that would stop rolling this step

      const handbrake = (input.handbrake && !wheel.front) || !!input.parkingBrake;
      let fLat: number;
      let fLong: number;
      let maxF = Ti.mu * surfaceGrip * load;
      if (handbrake) {
        // Locked: no rolling direction, so it slides, its friction against the whole slip (and,
        // once stopped, holds still up to that friction). The engine can't turn it.
        fLat = (-vLat * mEff) / dt;
        fLong = (-vLong * mEff) / dt;
        maxF *= Ti.lockedSlide;
      } else {
        const grip = (wheel.front ? Ti.gripFront : Ti.gripRear) * surfaceGrip;
        fLat = (-vLat * mEff * grip) / dt;
        fLong = wheel.driven && drivenCount > 0 ? drive / drivenCount : 0;
        if (braking) fLong -= Math.sign(vLong) * Math.min(E.brakeForce / 4, stopLong);
        fLong -= Math.sign(vLong) * Math.min(Ti.rollingResistance * load, stopLong);
      }

      const total = Math.hypot(fLat, fLong);
      if (total > maxF) {
        const k = maxF / total;
        fLat *= k;
        fLong *= k;
      }

      // Raise the force point toward the CoM to tame body roll (rollInfluence).
      _tmp.subVectors(_com, _contact);
      _pt.copy(_contact).addScaledVector(_up, _tmp.dot(_up) * (1 - Ti.rollInfluence));
      _imp.copy(_rg).multiplyScalar(fLat * dt).addScaledVector(_wf, fLong * dt);
      this.body.applyImpulseAtPoint(_imp, _pt, true);

      wheel.spinSpeed = handbrake ? 0 : vLong / radius;
      slipSum += Math.abs(vLat);
      wheel.contact.copy(_contact);
      wheel.slip = Math.abs(vLat);
      wheel.locked = handbrake;
    }

    // Brake lights only for braking on the ground: in the air the same key levels the car.
    this.braking = braking && grounded > 0;

    // --- Air control (also works when stuck on the roof: a handy self-righting tool).
    this.groundedWheels = grounded;
    this.body.setAngularDamping(grounded === 0 ? cfg.air.angularDamping : 0);
    if (grounded === 0) {
      // Lying on the roof or side isn't air: only count truly airborne time.
      this.airTime = this.bodyTouching ? 0 : this.airTime + dt;
      // Throttle is usually held through jumps, so W does nothing here.
      // S either lifts the nose ('auto') or engages the levelling ('hold').
      const A = cfg.air;
      const holdLevel = input.brake > 0;
      _imp.set(0, 0, 0);
      if (A.leveling === 'auto') _imp.addScaledVector(_right, input.brake * A.pitchTorque * dt);
      _imp.addScaledVector(_fwd, -input.steer * A.rollTorque * dt);
      if (!this.bodyTouching && (A.leveling === 'auto' || holdLevel)) this.addAirLeveling(_imp, dt);
      this.body.applyTorqueImpulse(_imp, true);
    } else {
      if (this.airTime > 0.25) this.events?.land(this, _p.clone(), Math.max(0, -_lin.y));
      this.airTime = 0;
    }
    this.slip = grounded > 0 ? slipSum / grounded : 0;
    this.tyreLoad = loadSum / (cfg.mass * GRAVITY);
    if (grounded > 0) this.sampleTyreGround();

    // --- Aerodynamic drag ∝ v².
    _imp.copy(_lin).multiplyScalar(-_lin.length() * cfg.aeroDrag * dt);
    this.body.applyImpulse(_imp, true);
    this.panels.step(dt);
  }

  /**
   * Adds a torque impulse that turns the nose toward the flight path and the
   * wings level, so a plain jump lands on its wheels. Skipped when flying
   * backwards or mostly upside down, where the target would be ambiguous.
   * Expects the step's scratch vectors (_lin, _ang, _up, _fwd, _right) to be current.
   */
  private addAirLeveling(torqueImpulse: THREE.Vector3, dt: number): void {
    const A = this.cfg.air;
    const [pitchInertia, , rollInertia] = this.cfg.inertia;
    const along = _lin.dot(_fwd);
    if (along < 3 || _up.y < 0.3) return;
    const pitchError = Math.atan2(_lin.dot(_up), along); // + = flight path above the nose
    const pitchAcc = A.levelPitch * pitchError - A.levelPitchDamping * _ang.dot(_right);
    const rollError = _right.y; // + = right side high
    const rollAcc = A.levelRoll * rollError - A.levelRollDamping * _ang.dot(_fwd);
    torqueImpulse.addScaledVector(_right, pitchAcc * pitchInertia * dt);
    torqueImpulse.addScaledVector(_fwd, rollAcc * rollInertia * dt);
  }

  /** Records a contact-force event if one of the colliders is ours. */
  handleContactForce(h1: number, h2: number, totalForce: number): void {
    const own = this.colliders.get(h1) ?? this.colliders.get(h2);
    if (!own) return;
    const otherHandle = own.handle === h1 ? h2 : h1;
    const other = this.world.getCollider(otherHandle);
    const dv = (totalForce * PHYSICS_STEP) / this.cfg.mass;
    const prev = this.pending.get(otherHandle);
    if (!prev || prev.dv < dv) this.pending.set(otherHandle, { own, other, dv });
  }

  /** Resolves impacts from this step and snapshots the transform. Call after world.step(). */
  afterStep(): void {
    this.assertLive();
    for (const [piece, steps] of this.justLoose) {
      if (steps <= 1 || piece.state !== 'hinged') this.justLoose.delete(piece);
      else this.justLoose.set(piece, steps - 1);
    }
    this.captureTransform();
    this.panels.afterStep();
    // A door window goes when its door is torn off.
    for (const piece of this.model.pieces) {
      const follows = piece.glass?.follows;
      if (follows && piece.state !== 'gone' && this.piece(follows).state === 'gone') this.shatter(piece);
    }
    this.bodyTouching = false;
    this.grindCount = 0;
    this.scrapeSpeed = 0;
    let scrapeFound = false;
    for (const own of this.colliders.values()) {
      this.world.contactPairsWith(own, (other) => {
        // All of the pair's touching points: the body grinds wherever it rests against `other`.
        let count = 0;
        _grindNormal.set(0, 0, 0);
        this.forEachContact(own, other, (local, normal) => {
          if (count === MAX_GRIND_CONTACTS) return;
          _grindContacts[count++].copy(local);
          _grindNormal.add(normal);
        });
        if (count === 0) return;
        this.bodyTouching = true;
        _grindNormal.normalize();
        const speed = this.scratchPaint(_grindContacts, count, _grindNormal, other);
        // The scrape heard and seen is the fastest-sliding pair.
        if (scrapeFound && speed <= this.scrapeSpeed) return;
        scrapeFound = true;
        this.scrapeSpeed = speed;
        this.scrapePoint.copy(this.localToWorld(_grindCentre));
        this.scrapeSurface = surfaceOf(other);
      });
    }
    if (scrapeFound && this.scrapeSurface === 'ground') {
      const at = this.scrapePoint;
      const field = this.debris.field;
      Object.assign(this.scrapeGround, field.groundMix(at.x, at.z));
      // Near-vertical rock counts as stone whatever its cover.
      if (field.isHard(at.x, at.z)) this.scrapeGround.stone = 1;
    }
    const d = this.cfg.damage;
    for (const impact of this.pending.values()) {
      if (impact.dv < Math.min(d.toughness, d.roofToughness)) continue;
      const sum = new THREE.Vector3();
      const normal = new THREE.Vector3();
      let count = 0;
      this.forEachContact(impact.own, impact.other, (local, n) => {
        sum.add(local);
        normal.add(n);
        if (count < MAX_HIT_POINTS) this.hitPointPool[count].copy(local);
        count++;
      });
      if (count > 0) normal.normalize();
      this.hitPointCount = Math.min(count, MAX_HIT_POINTS);
      for (let i = 0; i < this.hitPointCount; i++) this.hitPointPool[i].applyQuaternion(this.currQuat).add(this.currPos);
      // A landing: the ground hits the underside (the contact normal points down out of the car).
      // A pair that bounced apart within the step has no contacts left; then an upright car counts as landing.
      const upright = _bodyUp.set(0, 1, 0).applyQuaternion(this.currQuat).y > LANDING_UPRIGHT;
      const landing = surfaceOf(impact.other) === 'ground' && (count > 0 ? normal.y < -LANDING_UPRIGHT : upright);
      this.loseIntegrity(Math.max(0, impact.dv - d.toughness) * d.integrityPerDv, landing);

      // The pair can separate within the step (bounce); then there's no point to dent.
      if (count === 0) continue;
      // The roof is the body's weak spot: a landing on it is spread over several steps, each
      // under the chassis's toughness, so hits from above on the cabin use a lower threshold.
      const threshold = impact.own === this.cabinCollider && normal.y > 0.5 ? d.roofToughness : d.toughness;
      if (impact.dv < threshold) continue;
      this.applyImpact(sum.divideScalar(count), normal, impact.dv - threshold, impact.dv, surfaceOf(impact.other), landing);
    }
    this.pending.clear();
  }

  /** Takes `loss` off the integrity; a landing's share of it, and only down to the landing floor (see CarConfig landingShare). */
  private loseIntegrity(loss: number, landing: boolean): void {
    const d = this.cfg.damage;
    if (landing) {
      loss *= d.landingShare;
      if (this.integrity > d.landingFloor) loss = Math.min(loss, this.integrity - d.landingFloor);
    }
    this.integrity = Math.max(0, this.integrity - loss);
  }

  /**
   * Calls `fn` with each touching contact point between one of our colliders
   * and `other`, in car-local space, plus the contact normal pointing out of our
   * collider (car-local too: colliders are unrotated). Reads the narrow-phase
   * contacts: solver contacts are already cleared by the time world.step() returns.
   */
  private forEachContact(
    own: RAPIER.Collider,
    other: RAPIER.Collider,
    fn: (local: THREE.Vector3, normal: THREE.Vector3) => void,
  ): void {
    const offset = this.colliderOffsets.get(own.handle)!;
    this.world.contactPair(own, other, (m, flipped) => {
      const n = flipped ? m.localNormal2() : m.localNormal1();
      _contactNormal.set(n.x, n.y, n.z);
      for (let k = 0; k < m.numContacts(); k++) {
        // Positive distances are predictive contacts that aren't touching yet.
        if (m.contactDist(k) > CONTACT_TOUCH_DIST) continue;
        const p = flipped ? m.localContactPoint2(k) : m.localContactPoint1(k);
        if (p) fn(_contactLocal.set(p.x, p.y, p.z).add(offset), _contactNormal);
      }
    });
  }

  /**
   * Scratches the paint where the body slides along something hard (rock, a tree, a boulder,
   * another car; snow and grass don't): wherever it rests against it, by how far it slid this
   * step, along the slide. Leaves the contacts' middle in `_grindCentre`.
   * @param contacts the touching points (the first `count`), car-local
   * @param normal contact normal pointing out of the car (car-local)
   * @returns how fast the body slides there (m/s), scratched or not
   */
  private scratchPaint(contacts: readonly THREE.Vector3[], count: number, normal: THREE.Vector3, other: RAPIER.Collider): number {
    const d = this.cfg.damage;
    const local = _grindCentre.set(0, 0, 0);
    for (let c = 0; c < count; c++) local.add(contacts[c]);
    local.divideScalar(count);
    const slide = this.slideAt(local, normal, other);
    const speed = slide.length();
    if (speed < d.scratchFrom) return speed;
    const surface = surfaceOf(other);
    if (surface === 'ground') {
      const at = this.localToWorld(local);
      if (!this.debris.field.isHard(at.x, at.z)) return speed;
    }
    if (this.grindCount < MAX_GRINDS) {
      const grind = this.grindPool[this.grindCount++];
      grind.at.copy(local).applyQuaternion(this.currQuat).add(this.currPos);
      grind.normal.copy(normal).applyQuaternion(this.currQuat);
      grind.slide.copy(slide).applyQuaternion(this.currQuat);
      grind.surface = surface;
    }
    const share = surface === 'tree' ? d.slideScratches.tree : surface === 'metal' ? d.slideScratches.metal : 1;
    const scratch = speed * PHYSICS_STEP * d.scratchPerMetre * share;
    // Rock (boulders, rock faces, stony ground) leaves its dust in the scratches.
    const dust = surface === 'rock' || surface === 'ground' ? scratch : 0;
    grindPaint(this.model.pieces, contacts, count, normal, d.scratchReach, d.scratchDepth, scratch, slide.divideScalar(speed), dust);
    return speed;
  }

  /**
   * How much a hit chips and scratches the paint, as a share of a hit on something hard: full on
   * rock, trees, boulders, cars and hard ground; less on snow and grass (see softHitChips and
   * softHitScratches). Shared result, overwritten on the next call.
   * @param local the hit, car-local
   */
  private hitWear(local: THREE.Vector3, surface: ContactSurface): Readonly<{ chips: number; scratches: number }> {
    _hitWear.chips = _hitWear.scratches = 1;
    if (surface !== 'ground') return _hitWear;
    const at = this.localToWorld(local);
    const field = this.debris.field;
    if (field.isHard(at.x, at.z)) return _hitWear;
    const d = this.cfg.damage;
    const mix = field.groundMix(at.x, at.z);
    const by = (soft: { snow: number; grass: number }) => mix.snow * soft.snow + (mix.grass + mix.dirt) * soft.grass + mix.stone;
    _hitWear.chips = by(d.softHitChips);
    _hitWear.scratches = by(d.softHitScratches);
    return _hitWear;
  }

  /**
   * How a car-local contact point moves along the surface it touches (car-local, m/s): the body's
   * velocity there, less that of what it touches if that moves, less the part along the normal.
   */
  private slideAt(local: THREE.Vector3, normal: THREE.Vector3, other?: RAPIER.Collider): THREE.Vector3 {
    const slide = this.pointVelocity(this.localToWorld(local));
    const body = other?.parent();
    if (body?.isDynamic()) {
      const v = body.linvel();
      slide.x -= v.x;
      slide.y -= v.y;
      slide.z -= v.z;
    }
    slide.applyQuaternion(_qInv.copy(this.currQuat).invert());
    return slide.addScaledVector(normal, -slide.dot(normal));
  }

  /**
   * @param normal contact normal pointing out of the car (car-local)
   * @param severity Δv over the toughness threshold; `dv` is the whole Δv
   * @param landing the ground hit the underside (see CarConfig landingShare)
   */
  private applyImpact(local: THREE.Vector3, normal: THREE.Vector3, severity: number, dv: number, surface: ContactSurface, landing: boolean): void {
    const d = this.cfg.damage;
    this.events?.impact(this, this.localToWorld(local), severity, surface);

    // Hits squarely on the nose or tail crumple that end; the rest of the force dents locally.
    // Squared, because box edges report diagonal normals: a nose-edge scrape on landing
    // (normal ≈ −Y, a little forward) should barely crush, a head-on hit fully.
    const end = this.crush.zoneAt(local.z);
    const along = end === 'front' ? -normal.z : end === 'rear' ? normal.z : 0;
    let square = Math.max(0, along) ** 2;
    if (end && square > 0) {
      const before = this.crush.depth(end);
      this.crush.hit(end, local.x, severity * square, surface === 'tree');
      this.crush.deform(end, this.model.pieces, this.model.root, this.justLoose);
      this.fitHullToCrush();
      this.advanceIntoCrush(end, this.crush.depth(end) - before);
    }
    // Hits from above on the cabin (landing on the roof) push the roof down, and a hit on its
    // corner leans it over. The normal points out of the car, so "from above" is normal.y > 0.
    if (this.crush.inRoof(local) && normal.y > 0) {
      const down = normal.y ** 2;
      this.crush.hitRoof(local.x, severity * down, -normal.x);
      this.crush.deform('roof', this.model.pieces, this.model.root, this.justLoose);
      this.fitHullToCrush();
      if (this.crush.roofDepth() > d.roofGlassBreak) {
        for (const piece of this.model.pieces) if (piece.glass && piece.state !== 'gone') this.shatter(piece);
      }
      square = Math.max(square, down);
    }

    // Radiator (hits near the nose) and sump (hits from below on the engine bay) start leaking.
    const leakReach = d.dentRadius * 1.3;
    const toRadiator = local.distanceTo(this.radiatorDrip);
    if (toRadiator < leakReach) this.radiatorDamage += severity * d.partDamagePerDv * (1 - toRadiator / leakReach);
    if (normal.y < -0.5 && local.z < this.sumpDrip.z + leakReach && local.z > this.radiatorDrip.z - leakReach) {
      this.sumpDamage += severity * d.partDamagePerDv * -normal.y * d.sumpHitShare;
    }

    const dir = inwardDirection(local, this.hullCenter, this.hullHalf);
    const radius = d.dentRadius * (1 + Math.min(severity, 10) * 0.05);
    // Paint: a head-on hit flakes it off in big pieces; a glancing one (still sliding fast after
    // the hit, against the Δv it took) mostly scratches, with a few chips drawn out into gouges.
    const wear = this.hitWear(local, surface);
    const slide = this.slideAt(local, normal);
    const headOn = dv * dv / (dv * dv + slide.lengthSq());
    const chips = severity * wear.chips;
    wearPaint(this.model.pieces, local, normal, radius * d.chipReach, chips * d.chipPerDv * (d.glancingChips + (1 - d.glancingChips) * headOn), 0, 0);
    wearPaint(this.model.pieces, local, normal, radius * d.flakeReach, 0, 0, chips * d.flakePerDv * headOn * headOn);
    // Scratches close round the hit, along the way the car was going there (or the car's length,
    // for a hit straight on).
    if (slide.lengthSq() < 1) slide.set(0, 0, 1).addScaledVector(normal, -normal.z);
    if (slide.lengthSq() > 1e-6) {
      wearPaint(this.model.pieces, local, normal, d.scratchHitReach, 0, severity * wear.scratches * d.scratchPerDv, 0, slide.normalize());
    }
    const dent = Math.min(d.maxDent, severity * d.dentPerDv) * (1 - square);
    if (dent > 0) {
      applyDent(this.model.pieces, local, dir, dent, radius, d.maxDent);
      this.lights.dent(local, dir, dent, radius, d.maxDent);
    }
    // Lights leave from where the car really is (like breaking panels).
    this.snapRootToPhysics();
    const velocityAt = (world: THREE.Vector3) => this.pointVelocity(world);
    this.lights.follow(this.crush, velocityAt);
    this.lights.hit(local, severity * d.partDamagePerDv, velocityAt);

    const reach = d.dentRadius * 1.3;
    for (const piece of this.model.pieces) {
      if (!piece.detachable || piece.state === 'gone') continue;
      let dist: number;
      if (piece.rides) {
        // A mirror goes along with a door that's torn off; on a closed or hanging door it takes
        // hits where it is now (a hanging door swings it away from its build-time bounds).
        if (this.piece(piece.rides).state === 'gone') continue;
        const at = this.model.root.worldToLocal(piece.mesh.getWorldPosition(_tmp));
        dist = Math.max(0, at.distanceTo(local) - piece.bounds.getSize(_pt).length() / 2);
      } else {
        dist = piece.bounds.distanceToPoint(local);
      }
      if (dist >= reach) continue;
      // Hanging panels keep taking damage; HingedPanels tears them off past their limit.
      piece.hp -= severity * d.partDamagePerDv * (1 - dist / reach);
      if (piece.state === 'closed' && piece.hp <= 0) this.breakLoose(piece, local);
    }
    // Glass is more fragile and feels hits from further away; hard hits carry through the body.
    const glassReach = d.dentRadius * 1.6 * (1 + d.glassReachGrowth * Math.min(severity, d.glassReachCap));
    for (const piece of this.model.pieces) {
      if (!piece.glass || piece.state === 'gone') continue;
      const dist = piece.bounds.distanceToPoint(local);
      if (dist >= glassReach) continue;
      piece.hp -= severity * d.partDamagePerDv * (1 - dist / glassReach);
      if (piece.hp <= 0) this.shatter(piece);
      else if (!piece.glass.cracked && piece.hp < d.glassHp * d.crackAt) this.crack(piece, local);
    }
    // A landing already knocks the wheels as they bottom out (see bottomOutSpeed), so the body
    // hitting the ground beside them only adds a share of a crash's knock.
    const wheelShare = landing ? d.landingShare : 1;
    for (const wheel of this.wheels) {
      if (!wheel.attached) continue;
      _tmp.copy(wheel.anchor).setY(wheel.anchor.y - wheel.suspLen);
      const dist = _tmp.distanceTo(local);
      if (dist < 1) this.damageWheel(wheel, severity * d.partDamagePerDv * (1 - dist) * wheelShare);
    }
  }

  /**
   * Pulls the lower body box's ends in with the crumple zones and the cabin box's top down with
   * the roof, so a crushed car doesn't collide like an intact one.
   */
  private fitHullToCrush(): void {
    const { center, half } = this.lowerHull;
    const front = center.z - half.z + this.crush.depth('front');
    const rear = center.z + half.z - this.crush.depth('rear');
    const offset = new THREE.Vector3(center.x, center.y, (front + rear) / 2);
    this.lowerCollider.setHalfExtents({ x: half.x, y: half.y, z: (rear - front) / 2 });
    this.lowerCollider.setTranslationWrtParent(offset);
    this.colliderOffsets.set(this.lowerCollider.handle, offset);

    // The cabin box's bottom stays put; its top comes down with the roof.
    const cabin = this.cabinHull;
    const drop = Math.min(this.crush.roofDepth(), cabin.half.y * 1.5);
    const cabinOffset = new THREE.Vector3(cabin.center.x, cabin.center.y - drop / 2, cabin.center.z);
    this.cabinCollider.setHalfExtents({ x: cabin.half.x, y: cabin.half.y - drop / 2, z: cabin.half.z });
    this.cabinCollider.setTranslationWrtParent(cabinOffset);
    this.colliderOffsets.set(this.cabinCollider.handle, cabinOffset);
  }

  /**
   * Moves the car on by how far an end was just pushed in, along its own axis toward that end,
   * so the crushed end stays where it hit. The body box is rigid, so the contact stops it dead
   * where the uncrushed end touched; shrinking the box by the crush alone would leave the
   * crumpled nose or tail standing that far short of what it hit. In a real crash the cabin
   * travels on over the crumple zone, so the whole car (hanging panels and dangling lights
   * with it) is carried forward by the crush, which puts the shrunk box's end face back exactly
   * on the contact.
   */
  private advanceIntoCrush(end: CrushEnd, by: number): void {
    if (by <= 0) return;
    _shift.set(0, 0, end === 'front' ? -by : by).applyQuaternion(this.currQuat);
    const t = this.body.translation();
    this.body.setTranslation({ x: t.x + _shift.x, y: t.y + _shift.y, z: t.z + _shift.z }, true);
    // A slide, not a cut: only the latest snapshot moves, so the drawn car travels the crush over
    // the step instead of jumping (in slow motion a step spans several frames). Hanging panels
    // slide with it; dangling lights follow the drawn car every frame, as they do any move.
    this.currPos.add(_shift);
    this.panels.shift(_shift);
  }

  private damageWheel(wheel: Wheel, amount: number): void {
    wheel.hp -= amount;
    wheel.knocks += amount;
    if (wheel.knocks >= this.cfg.damage.hubcapHp) this.popHubcap(wheel);
    if (wheel.hp > 0) return;
    wheel.attached = false;
    wheel.grounded = false;
    const W = this.cfg.wheels;
    const collider = RAPIER.ColliderDesc.cylinder(W.width / 2, W.radius)
      .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2))
      .setDensity(300)
      .setFriction(0.9);
    this.release(wheel.visual.pivot, [collider]);
    this.events?.clank(this, wheel.visual.pivot.position.clone(), 1);
  }

  /** Knocks a wheel's hubcap off; it leaves spinning with the wheel, so it rolls away on its rim. */
  private popHubcap(wheel: Wheel): void {
    const hubcap = wheel.visual.hubcap;
    if (hubcap.parent !== wheel.visual.spin) return;
    this.snapRootToPhysics();
    this.scene.attach(hubcap);
    const vel = this.pointVelocity(hubcap.position);
    // Flung out along the axle and up, clear of the wheel arch, so it's seen leaving.
    const axle = new THREE.Vector3(Math.sign(wheel.anchor.x), 0, 0).applyQuaternion(this.currQuat);
    vel.addScaledVector(axle, 3.5).add(_tmp.set(0, 1.5, 0));
    // The wheel rolls about its own axis; the visual spins as rotation.x −= spinSpeed·dt.
    const spin = new THREE.Vector3(1, 0, 0).applyQuaternion(this.currQuat).multiplyScalar(-wheel.spinSpeed);
    const r = this.cfg.wheels.radius * 0.62;
    const collider = RAPIER.ColliderDesc.cylinder(0.015, r)
      .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2))
      .setDensity(400)
      .setFriction(0.6);
    this.debris.spawn(hubcap, [collider], vel, spin);
    this.events?.clank(this, hubcap.position.clone(), 0.25);
  }

  /** Swaps a pane's material for a crack pattern centred on the car-local hit point. */
  private crack(piece: CarPiece, local: THREE.Vector3): void {
    const pane = piece.glass!;
    // Geometry is centred on the piece's rest bounds, so this gives the hit in pane space.
    const p = local.clone().sub(piece.bounds.getCenter(_tmp));
    const uv = new THREE.Vector2(
      THREE.MathUtils.clamp((p.dot(pane.u) - pane.min.x) / pane.size.x, 0.05, 0.95),
      THREE.MathUtils.clamp((p.dot(pane.v) - pane.min.y) / pane.size.y, 0.05, 0.95),
    );
    pane.cracked = crackedGlass(crackTexture(uv, GLASS_TINT, GLASS_OPACITY));
    piece.mesh.material = pane.cracked;
    this.events?.glass(this, piece.mesh.getWorldPosition(new THREE.Vector3()), false);
  }

  /** Removes a pane and bursts it into shards sampled across its surface. */
  private shatter(piece: CarPiece): void {
    piece.state = 'gone';
    const mesh = piece.mesh;
    mesh.updateWorldMatrix(true, false);
    const pos = mesh.geometry.getAttribute('position');
    const size = piece.bounds.getSize(_tmp);
    const area = Math.max(size.x * size.y, size.y * size.z, size.x * size.z);
    const count = THREE.MathUtils.clamp(Math.round(area * 60), 16, 80);
    const points: THREE.Vector3[] = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const t = Math.floor(Math.random() * (pos.count / 3)) * 3;
      a.fromBufferAttribute(pos, t);
      b.fromBufferAttribute(pos, t + 1);
      c.fromBufferAttribute(pos, t + 2);
      let r1 = Math.random();
      let r2 = Math.random();
      if (r1 + r2 > 1) [r1, r2] = [1 - r1, 1 - r2];
      points.push(a.clone().addScaledVector(b.sub(a), r1).addScaledVector(c.sub(a), r2).applyMatrix4(mesh.matrixWorld));
    }
    // Thrown away from the body: from the car's centre out through the pane, tipped upward.
    const at = mesh.getWorldPosition(new THREE.Vector3());
    const outward = at.clone().sub(this.position).setY(0).normalize();
    outward.y = 0.6;
    this.debris.shatter(points, this.velocity, outward.normalize());
    this.events?.glass(this, at, true);
    mesh.removeFromParent();
    mesh.geometry.dispose();
    this.disposeCrack(piece);
  }

  private disposeCrack(piece: CarPiece): void {
    const cracked = piece.glass?.cracked as THREE.MeshStandardMaterial | null | undefined;
    if (!cracked) return;
    cracked.map?.dispose();
    cracked.dispose();
    piece.glass!.cracked = null;
  }

  private piece(name: string): CarPiece {
    const piece = this.model.pieces.find((p) => p.name === name);
    if (!piece) throw new Error(`No car piece named "${name}"`);
    return piece;
  }

  /** A panel past its hp: hangs on its hinge if it has one, otherwise falls off entirely. */
  private breakLoose(piece: CarPiece, impact: THREE.Vector3): void {
    this.snapRootToPhysics();
    const box = this.looseBox(piece);
    if (piece.hinge) {
      this.panels.hinge(piece, piece.hinge, impact, (p) => this.pointVelocity(p), box);
      this.justLoose.set(piece, CRUSH_AFTER_HINGE);
      this.events?.clank(this, piece.mesh.position.clone(), 0.5);
      return;
    }
    piece.state = 'gone';
    this.scene.attach(piece.mesh);
    this.debris.adopt(piece.mesh, createPanelBody(this.world, piece.mesh, piece.mass, this.pointVelocity(piece.mesh.position), box));
    if (piece.mass < 10) this.events?.clank(this, piece.mesh.position.clone(), 0.2);
  }

  /**
   * Collision box (piece-local) for a panel leaving the car: its build-time bounds, with an end
   * that lies in a crushed crumple zone cut back by that zone's crush. The panel itself has been
   * pushed in that far where the crush is deepest; a box reaching out to its less crushed
   * corners would sit inside whatever crushed it (a tree in the nose's notch) and be shoved out,
   * yanking the car on the hinge.
   */
  private looseBox(piece: CarPiece): THREE.Box3 {
    const box = piece.bounds.clone().translate(_tmp.copy(piece.origin).negate());
    const o = piece.origin;
    const front = this.crush.depth('front');
    const rear = this.crush.depth('rear');
    if (front > 0 && this.crush.zoneAt(box.min.z + o.z) === 'front') box.min.z = Math.min(box.min.z + front, box.max.z - 0.03);
    if (rear > 0 && this.crush.zoneAt(box.max.z + o.z) === 'rear') box.max.z = Math.max(box.max.z - rear, box.min.z + 0.03);
    return box;
  }

  /** Moves a part from the car into the world as a tumbling debris body. */
  private release(object: THREE.Object3D, colliders: RAPIER.ColliderDesc[]): void {
    this.snapRootToPhysics();
    this.scene.attach(object);
    const vel = this.pointVelocity(object.position);
    // A little outward kick so parts visibly fly off.
    _arm.subVectors(object.position, this.currPos).setY(0).normalize().multiplyScalar(1.5 + Math.random() * 1.5);
    vel.add(_arm).add(_tmp.set(0, 1.5 + Math.random() * 2, 0));
    const spin = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(8);
    this.debris.spawn(object, colliders, vel, spin);
  }

  /** Velocity of the car body at a world-space point. */
  private pointVelocity(world: THREE.Vector3): THREE.Vector3 {
    const lin = this.body.linvel();
    const ang = this.body.angvel();
    const com = this.body.worldCom();
    _arm.set(world.x - com.x, world.y - com.y, world.z - com.z);
    return new THREE.Vector3(ang.x, ang.y, ang.z).cross(_arm).add(_tmp.set(lin.x, lin.y, lin.z));
  }

  /** Puts the visual root at the physics pose, so parts leave the car from where they really are. */
  private snapRootToPhysics(): void {
    this.model.root.position.copy(this.currPos);
    this.model.root.quaternion.copy(this.currQuat);
    this.model.root.updateMatrixWorld(true);
  }

  /** Which side the next dev blast goes off under: −1 left, 1 right (they take turns). */
  private blastSide = -1;

  /**
   * Dev key F: a sudden blast under the car, as if from a small invisible charge (see BLAST), under
   * its left and right sides by turns. It pushes at one point, so it's thrown up and rolled over by
   * the blast itself, and spins a little differently every time; physics does the rest.
   */
  blast(): void {
    const B = BLAST;
    const side = this.blastSide;
    this.blastSide = -side;
    const q = this.currQuat;
    const com = this.body.worldCom();
    _right.set(1, 0, 0).applyQuaternion(q);
    _up.set(0, 1, 0).applyQuaternion(q);
    _fwd.set(0, 0, -1).applyQuaternion(q);
    // Under a sill, somewhere along the car.
    _pt.set(com.x, com.y, com.z)
      .addScaledVector(_right, side * B.side)
      .addScaledVector(_up, -B.low)
      .addScaledVector(_fwd, (Math.random() * 2 - 1) * B.along);
    // Straight up, slanting off toward the other side (level, however the car lies).
    _tmp.copy(_right).multiplyScalar(-side).setY(0);
    if (_tmp.lengthSq() > 1e-4) _tmp.normalize();
    _imp.set(0, 1, 0).addScaledVector(_tmp, B.slant).normalize();
    const strength = this.body.mass() * B.kick * (1 + (Math.random() * 2 - 1) * B.vary);
    this.body.applyImpulseAtPoint(_imp.multiplyScalar(strength), _pt, true);
  }

  /**
   * Puts the car back on its wheels, keeping its damage: where it is and as it's facing, or at
   * `to` with heading `to.yaw` (0 = downhill).
   */
  resetUpright(field: TerrainField, to?: { x: number; z: number; yaw: number }): void {
    const t = to ? { x: to.x, y: 0, z: to.z } : this.body.translation();
    _fwd.set(0, 0, -1).applyQuaternion(this.currQuat).setY(0);
    const yaw = to ? to.yaw : _fwd.lengthSq() > 1e-4 ? Math.atan2(-_fwd.x, -_fwd.z) : 0;
    _q.setFromAxisAngle(UP, yaw);
    // Clear the highest ground under the footprint, so steep slopes don't trap the body.
    let ground = field.height(t.x, t.z);
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      _tmp.set(x * this.hullHalf.x, 0, z * this.hullHalf.z).applyQuaternion(_q);
      ground = Math.max(ground, field.height(t.x + _tmp.x, t.z + _tmp.z));
    }
    const before = new THREE.Matrix4().compose(this.currPos, this.currQuat, _tmp.set(1, 1, 1));
    this.body.setTranslation({ x: t.x, y: ground + 1.5, z: t.z }, true);
    this.body.setRotation(_q, true);
    this.panels.teleport(before, new THREE.Matrix4().compose(_p.set(t.x, ground + 1.5, t.z), _q, _tmp.set(1, 1, 1)));
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    for (const w of this.wheels) {
      w.compression = 0;
      w.grounded = false;
    }
    this.captureTransform();
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    this.lights.teleport();
  }

  /** Interpolates the visual between the last two physics states. */
  syncVisual(alpha: number, frameDt: number): void {
    const lamp = this.braking ? BRAKE_LIGHT.on : BRAKE_LIGHT.off;
    this.model.brakeLight.emissive.copy(lamp.colour);
    this.model.brakeLight.emissiveIntensity = lamp.intensity;
    this.model.headLight.emissiveIntensity = this.headlightsOn ? HEADLIGHT_ON : 0;
    for (const { glow, lens, lamp, brake } of this.model.lampGlows) {
      glow.visible = lens.material === lamp && (brake ? this.braking : this.headlightsOn);
    }
    const root = this.model.root;
    root.position.lerpVectors(this.prevPos, this.currPos, alpha);
    root.quaternion.slerpQuaternions(this.prevQuat, this.currQuat, alpha);
    // Springs and steering are drawn between steps too, as the body is: in slow motion a step
    // lasts several frames, and drawing the latest step's would jerk from one to the next.
    const steer = THREE.MathUtils.lerp(this.prevSteer, this.steer, alpha);
    for (const w of this.wheels) {
      if (!w.attached) continue;
      w.visual.pivot.position.y = w.anchor.y - THREE.MathUtils.lerp(w.prevSuspLen, w.suspLen, alpha);
      w.visual.pivot.rotation.y = w.front ? steer : 0;
      w.visual.spin.rotation.x -= w.spinSpeed * frameDt;
    }
    // A lost wheel's last spring length stands in for its hub, so the axle and arms stay put.
    this.model.linkage.update(this.wheels.map((w) => w.anchor.y - THREE.MathUtils.lerp(w.prevSuspLen, w.suspLen, alpha)));
    this.panels.sync(alpha);
    this.leak(frameDt);
    this.lights.update(frameDt);
    this.emitEngineSmoke(frameDt);
  }

  /** Steam once the car is badly hurt, thick dark smoke once the engine has died. */
  private emitEngineSmoke(dt: number): void {
    const d = this.cfg.damage;
    if (this.integrity < d.steamBelow) {
      const at = this.model.root.localToWorld(_pt.copy(this.engineVent));
      const drift = this.velocity.multiplyScalar(0.6);
      if (this.engineAlive) {
        const rate = 6 + ((d.steamBelow - this.integrity) / d.steamBelow) * 18;
        this.smoke.emit(dt, rate, at, drift, '#eef1f5', 0.7);
      } else {
        this.smoke.emit(dt, 16, at, drift, '#3b3b3e', 1.1);
      }
    }
    this.smoke.update(dt);
  }

  /**
   * Coolant (green, from the radiator) and oil (dark, from the sump) leak independently, each
   * from its own damage, as trails of drops spaced by distance until its tank runs dry. A dead
   * car that has stopped bleeds its remaining oil into a spreading puddle.
   */
  private leak(dt: number): void {
    if (dt <= 0) return;
    const d = this.cfg.damage;
    // Each measure runs 0..1; the first leakTolerance of it is shrugged off.
    const leaking = (x: number) => THREE.MathUtils.clamp((x - d.leakTolerance) / (1 - d.leakTolerance), 0, 1);
    const coolant = leaking(Math.max(this.radiatorDamage / d.radiatorHp, this.crush.depth('front') / d.coolantCrushFull));
    const oil = Math.max(leaking(this.sumpDamage / d.sumpHp), (d.oilWreckBelow - this.integrity) / d.oilWreckBelow);
    if (coolant <= 0 && oil <= 0) return;
    const velocity = this.velocity.setY(0);
    const speed = velocity.length();
    if (coolant > 0 && this.coolantLeft > 0) this.coolantLeft -= this.drip('coolant', coolant, this.radiatorDrip, dt, speed, velocity);
    if (oil > 0 && this.oilLeft > 0) this.oilLeft -= this.drip('oil', oil, this.sumpDrip, dt, speed, velocity);

    // Dead and standing still: the sump empties into a spreading puddle.
    if (!this.engineAlive && speed < 0.4 && this.groundedWheels > 0 && this.oilLeft > 0) {
      const at = this.model.root.localToWorld(_pt.copy(this.sumpDrip));
      // A new puddle once the car has shifted off the old one (compared on the ground plane).
      if (!this.puddle || Math.hypot(this.puddle.position.x - at.x, this.puddle.position.z - at.z) > 0.8) {
        this.puddle = this.debris.fluids.drip(at.x, at.z, 'oil', 0.3, undefined, 1, 0.5);
      }
      this.puddle.size = Math.min(d.puddleMax, this.puddle.size + d.puddleGrowth * dt);
      this.oilLeft -= d.puddleDrain * dt;
      this.puddleDrip -= dt;
      if (this.puddleDrip <= 0 && this.upright() >= d.dropsUpright) {
        this.puddleDrip = d.puddleDrip * (0.6 + Math.random() * 0.8);
        this.debris.fluids.hangDrop(this.model.root, this.crush.displace(_tmp.copy(this.sumpDrip)), 'oil', 0.15 + Math.random() * 0.1, 0, false);
      }
    } else {
      this.puddle = null;
    }
  }

  /** How far the car's up axis points up: 1 upright, 0 on its side, −1 on its roof. */
  private upright(): number {
    return _up.copy(UP).applyQuaternion(this.model.root.quaternion).y;
  }

  /** One leak's drops for this frame, at `rate` (0..1) from car-local `source`; returns litres lost. */
  private drip(kind: 'coolant' | 'oil', rate: number, source: THREE.Vector3, dt: number, speed: number, velocity: THREE.Vector3): number {
    const d = this.cfg.damage;
    const field = this.debris.field;
    let lost = 0;
    this.leakDistance[kind] += (speed + d.leakIdle) * dt;
    const spacing = THREE.MathUtils.lerp(d.leakSpacingMax, d.leakSpacingMin, rate);
    while (this.leakDistance[kind] >= spacing) {
      this.leakDistance[kind] -= spacing;
      const size = (0.08 + Math.random() * 0.14) * (0.6 + rate);
      lost += d.dropVolume * (size / 0.15) ** 2;
      // Where the radiator or sump is now, after any crush.
      const from = this.crush.displace(_tmp.copy(source).add(_pt.set((Math.random() - 0.5) * 0.3, 0, (Math.random() - 0.5) * 0.3)));
      // Slow and upright, it's seen forming under the car and falling, landing where it falls.
      if (speed < d.dropsSeenBelow && this.upright() >= d.dropsUpright) {
        this.debris.fluids.hangDrop(this.model.root, from, kind, size, speed);
        continue;
      }
      const at = this.model.root.localToWorld(from);
      // Only on the ground: drops shaken off mid-air would land somewhere unpredictable.
      if (at.y - field.height(at.x, at.z) > 1) continue;
      this.debris.fluids.drip(at.x, at.z, kind, size, velocity, 1 + Math.min(speed, 30) * 0.08);
    }
    return lost;
  }

  /** True while the body itself drags along something (for scrape sounds and sparks). */
  get scraping(): boolean {
    return this.bodyTouching;
  }

  /** What the ground under the grounded tyres is made of (stone 1 on near-vertical rock), for their sound. */
  readonly tyreGround: GroundMix = { snow: 1, grass: 0, dirt: 0, stone: 0 };

  /** How well the tyres grip on the ground under them, as a multiple of the car's grip on snow (see tire.surfaceGrip). */
  get grip(): number {
    return this.surfaceGrip();
  }

  /** How well the tyres grip on the ground under them, as a multiple of the car's grip (see tire.surfaceGrip). */
  private surfaceGrip(): number {
    const g = this.tyreGround;
    const s = this.cfg.tire.surfaceGrip;
    // Hard ground sets stone to 1 on top of its cover, so the mix can add up to more than 1.
    const total = g.snow + g.grass + g.dirt + g.stone;
    if (total <= 0) return s.snow;
    return (g.snow * s.snow + g.grass * s.grass + g.dirt * s.dirt + g.stone * s.stone) / total;
  }

  private sampleTyreGround(): void {
    _tyreMid.set(0, 0, 0);
    let n = 0;
    for (const w of this.wheels) {
      if (!w.attached || !w.grounded) continue;
      _tyreMid.add(w.contact);
      n++;
    }
    _tyreMid.divideScalar(n);
    const field = this.debris.field;
    Object.assign(this.tyreGround, field.groundMix(_tyreMid.x, _tyreMid.z));
    if (field.isHard(_tyreMid.x, _tyreMid.z)) this.tyreGround.stone = 1;
  }

  /** World-space point and surface of the body's fastest-sliding contact, while scraping. */
  readonly scrapePoint = new THREE.Vector3();
  scrapeSurface: ContactSurface = 'ground';
  /** How fast that contact slides (m/s), relative to what it touches. */
  scrapeSpeed = 0;
  /** What the ground is made of there, when scraping the ground (stone 1 on near-vertical rock). */
  readonly scrapeGround: GroundMix = { snow: 0, grass: 0, dirt: 0, stone: 0 };

  private readonly grindPool: Grind[] = Array.from({ length: MAX_GRINDS }, () => ({
    at: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    slide: new THREE.Vector3(),
    surface: 'ground' as ContactSurface,
  }));
  private grindCount = 0;

  private readonly hitPointPool = Array.from({ length: MAX_HIT_POINTS }, () => new THREE.Vector3());
  private hitPointCount = 0;

  /**
   * Where the body touches what it hit (world space), for the hit being reported to `events.impact`
   * right now (its `at` is their middle). Shared objects, overwritten by the next hit.
   */
  get hitPoints(): readonly THREE.Vector3[] {
    return this.hitPointPool.slice(0, this.hitPointCount);
  }

  /**
   * Where the body slid along something hard in the last physics step (rock faces, stony ground,
   * boulders, trees, other cars; not snow, grass or dirt), faster than the paint's scratchFrom.
   * Shared objects, overwritten every step.
   */
  get grinds(): readonly Grind[] {
    return this.grindPool.slice(0, this.grindCount);
  }

  get tyres(): readonly TyreState[] {
    return this.wheels;
  }

  private localToWorld(local: THREE.Vector3): THREE.Vector3 {
    return local.clone().applyQuaternion(this.currQuat).add(this.currPos);
  }

  get position(): THREE.Vector3 {
    return this.model.root.position;
  }

  get velocity(): THREE.Vector3 {
    this.assertLive();
    const v = this.body.linvel();
    return new THREE.Vector3(v.x, v.y, v.z);
  }

  /**
   * Touching a removed body is a Rapier panic that poisons the whole physics world,
   * so a disposed car refuses physics access with a plain error instead.
   */
  private assertLive(): void {
    if (this.disposed) throw new Error('A removed car was used (its physics body is gone)');
  }

  private disposed = false;

  dispose(): void {
    this.disposed = true;
    this.panels.dispose();
    this.lights.dispose();
    this.smoke.dispose();
    for (const piece of this.model.pieces) this.disposeCrack(piece);
    this.world.removeRigidBody(this.body);
    this.scene.remove(this.model.root);
    // Detached parts now belong to Debris; only dispose what is still on the car.
    this.model.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.model.brakeLight.dispose();
    this.model.headLight.dispose();
    for (const material of new Set(this.model.lampGlows.map(({ glow }) => glow.material))) material.dispose();
  }

  private captureTransform(): void {
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    const t = this.body.translation();
    const r = this.body.rotation();
    this.currPos.set(t.x, t.y, t.z);
    this.currQuat.set(r.x, r.y, r.z, r.w);
  }
}

/** Classifies what a contact touched: convex hulls are boulders, other moving bodies cars or debris, cylinders tree trunks. */
function surfaceOf(other: RAPIER.Collider): ContactSurface {
  const shape = other.shapeType();
  // Boulders, bedded or knocked loose, are the only convex hulls.
  if (shape === RAPIER.ShapeType.ConvexPolyhedron) return 'rock';
  if (other.parent()?.isDynamic()) return 'metal';
  return shape === RAPIER.ShapeType.Cylinder ? 'tree' : 'ground';
}
