import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { PHYSICS_STEP } from '../constants';
import type { Debris } from '../world/debris';
import type { TerrainField } from '../world/terrainField';
import type { CarConfig } from './carConfig';
import { buildCarModel, type CarModel, type CarPiece, type WheelVisual } from './carModel';
import { applyDent, inwardDirection } from './damage';

export interface CarInput {
  throttle: number;
  brake: number;
  /** +1 = left, −1 = right. */
  steer: number;
  handbrake: boolean;
}

interface Wheel {
  /** Suspension top mount, car-local. */
  anchor: THREE.Vector3;
  front: boolean;
  driven: boolean;
  attached: boolean;
  hp: number;
  grounded: boolean;
  compression: number;
  /** Current spring length, also drives the visual wheel position. */
  suspLen: number;
  spinSpeed: number;
  visual: WheelVisual;
}

interface PendingImpact {
  own: RAPIER.Collider;
  other: RAPIER.Collider;
  dv: number;
}

const UP = new THREE.Vector3(0, 1, 0);
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
const _contactLocal = new THREE.Vector3();

/** Contacts closer than this (m) count as touching. */
const CONTACT_TOUCH_DIST = 0.02;

export class Car {
  readonly body: RAPIER.RigidBody;
  readonly model: CarModel;
  private readonly colliders = new Map<number, RAPIER.Collider>();
  /** Each collider's offset from the body origin (car-local); colliders are unrotated. */
  private readonly colliderOffsets = new Map<number, THREE.Vector3>();
  private readonly wheels: Wheel[] = [];
  private readonly pending = new Map<number, PendingImpact>();
  /** Envelope used to aim dents inward. */
  private readonly hullCenter: THREE.Vector3;
  private readonly hullHalf: THREE.Vector3;

  steer = 0;
  integrity = 1;
  airTime = 0;
  groundedWheels = 0;
  /** Increments on every landing after a real jump; HUD watches it. */
  jumpCount = 0;
  lastJumpAirTime = 0;
  forwardSpeed = 0;
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

    const B = cfg.body;
    const C = cfg.cabin;
    // Report contacts whose force corresponds to at least ~2 m/s of Δv in one step.
    const forceThreshold = (cfg.mass * 2) / PHYSICS_STEP;
    const shell = RAPIER.ColliderDesc.cuboid(B.width / 2, B.height / 2, B.length / 2 + 0.1);
    const cabin = RAPIER.ColliderDesc.cuboid((C.width / 2) * 0.95, C.height / 2, (C.length / 2) * 0.9).setTranslation(
      0,
      B.height / 2 + C.height / 2,
      C.z,
    );
    for (const desc of [shell, cabin]) {
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
    this.hullCenter = new THREE.Vector3(0, C.height / 2, 0);
    this.hullHalf = new THREE.Vector3(B.width / 2, B.height / 2 + C.height / 2, B.length / 2 + 0.1);

    this.model = buildCarModel(cfg);
    scene.add(this.model.root);

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
          grounded: false,
          compression: 0,
          suspLen: cfg.suspension.restLength,
          spinSpeed: 0,
          visual: this.model.wheels[i++],
        });
      }
    }

    this.captureTransform();
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
  }

  get engineAlive(): boolean {
    return this.integrity > this.cfg.damage.engineDeathAt;
  }

  get wheelsLost(): number {
    return this.wheels.filter((w) => !w.attached).length;
  }

  /** Applies suspension, tyre, engine and air-control impulses. Call before world.step(). */
  step(dt: number, input: CarInput): void {
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
      if (forwardSpeed > 1) braking = true;
      else if (this.engineAlive) drive -= input.brake * E.reverseForce * Math.max(0, 1 + forwardSpeed / E.reverseMaxSpeed);
    }
    const drivenCount = this.wheels.filter((w) => w.attached && w.driven).length;

    const Su = cfg.suspension;
    const Ti = cfg.tire;
    const radius = cfg.wheels.radius;
    const mEff = cfg.mass / 4;
    _down.copy(_up).negate();
    let grounded = 0;

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
      );

      if (!hit) {
        wheel.grounded = false;
        wheel.compression = 0;
        // Let the wheel droop back to full extension smoothly.
        wheel.suspLen += (Su.restLength - wheel.suspLen) * Math.min(1, dt * 12);
        wheel.spinSpeed *= 0.99;
        continue;
      }
      grounded++;

      // --- Suspension: spring + asymmetric damper + bump stop, along the car's up axis.
      const suspLen = Math.max(0, hit.timeOfImpact - radius);
      const compression = Su.restLength - suspLen;
      const compVel = (compression - wheel.compression) / dt;
      const bumpStart = Su.restLength * Su.bumpStopAt;
      if (wheel.grounded && compression > bumpStart && compVel > cfg.damage.bottomOutSpeed) {
        this.damageWheel(wheel, (compVel - cfg.damage.bottomOutSpeed) * cfg.damage.bottomOutDamagePerDv);
        if (!wheel.attached) continue;
      }
      wheel.grounded = true;
      wheel.compression = compression;
      wheel.suspLen = suspLen;

      let spring = Su.stiffness * compression + (compVel > 0 ? Su.dampCompression : Su.dampRebound) * compVel;
      if (compression > bumpStart) spring += Su.bumpStopStiffness * (compression - bumpStart);
      const load = Math.max(0, spring);
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

      const handbrake = input.handbrake && !wheel.front;
      let grip = wheel.front ? Ti.gripFront : Ti.gripRear;
      if (handbrake) grip *= Ti.handbrakeRearGrip;

      let fLat = (-vLat * mEff * grip) / dt;
      let fLong = wheel.driven && drivenCount > 0 ? drive / drivenCount : 0;
      if (braking) fLong -= Math.sign(vLong) * Math.min(E.brakeForce / 4, stopLong);
      if (handbrake) fLong -= Math.sign(vLong) * Math.min(E.handbrakeForce / 2, stopLong);
      fLong -= Math.sign(vLong) * Math.min(Ti.rollingResistance * load, stopLong);

      const maxF = Ti.mu * load;
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
    }

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
      if (this.airTime > 0.6) {
        this.lastJumpAirTime = this.airTime;
        this.jumpCount++;
      }
      this.airTime = 0;
    }

    // --- Aerodynamic drag ∝ v².
    _imp.copy(_lin).multiplyScalar(-_lin.length() * cfg.aeroDrag * dt);
    this.body.applyImpulse(_imp, true);
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
    this.captureTransform();
    this.bodyTouching = false;
    for (const own of this.colliders.values()) {
      this.world.contactPairsWith(own, (other) =>
        this.forEachContact(own, other, () => (this.bodyTouching = true)),
      );
    }
    const d = this.cfg.damage;
    for (const impact of this.pending.values()) {
      if (impact.dv < d.toughness) continue;
      const severity = impact.dv - d.toughness;
      this.integrity = Math.max(0, this.integrity - severity * d.integrityPerDv);

      const sum = new THREE.Vector3();
      let count = 0;
      this.forEachContact(impact.own, impact.other, (local) => {
        sum.add(local);
        count++;
      });
      // The pair can separate within the step (bounce); then there's no point to dent.
      if (count > 0) this.applyImpact(sum.divideScalar(count), severity);
    }
    this.pending.clear();
  }

  /**
   * Calls `fn` with each touching contact point between one of our colliders
   * and `other`, in car-local space. Reads the narrow-phase contacts: solver
   * contacts are already cleared by the time world.step() returns.
   */
  private forEachContact(own: RAPIER.Collider, other: RAPIER.Collider, fn: (local: THREE.Vector3) => void): void {
    const offset = this.colliderOffsets.get(own.handle)!;
    this.world.contactPair(own, other, (m, flipped) => {
      for (let k = 0; k < m.numContacts(); k++) {
        // Positive distances are predictive contacts that aren't touching yet.
        if (m.contactDist(k) > CONTACT_TOUCH_DIST) continue;
        const p = flipped ? m.localContactPoint2(k) : m.localContactPoint1(k);
        if (p) fn(_contactLocal.set(p.x, p.y, p.z).add(offset));
      }
    });
  }

  private applyImpact(local: THREE.Vector3, severity: number): void {
    const d = this.cfg.damage;
    const dir = inwardDirection(local, this.hullCenter, this.hullHalf);
    const radius = d.dentRadius * (1 + Math.min(severity, 10) * 0.05);
    applyDent(this.model.pieces, local, dir, Math.min(d.maxDent, severity * d.dentPerDv), radius, d.maxDent);

    const reach = d.dentRadius * 1.3;
    for (const piece of this.model.pieces) {
      if (!piece.detachable || !piece.attached) continue;
      const dist = piece.bounds.distanceToPoint(local);
      if (dist >= reach) continue;
      piece.hp -= severity * d.partDamagePerDv * (1 - dist / reach);
      if (piece.hp <= 0) this.detachPiece(piece);
    }
    for (const wheel of this.wheels) {
      if (!wheel.attached) continue;
      _tmp.copy(wheel.anchor).setY(wheel.anchor.y - wheel.suspLen);
      const dist = _tmp.distanceTo(local);
      if (dist < 1) this.damageWheel(wheel, severity * d.partDamagePerDv * (1 - dist));
    }
  }

  private damageWheel(wheel: Wheel, amount: number): void {
    wheel.hp -= amount;
    if (wheel.hp > 0) return;
    wheel.attached = false;
    wheel.grounded = false;
    const W = this.cfg.wheels;
    const collider = RAPIER.ColliderDesc.cylinder(W.width / 2, W.radius)
      .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2))
      .setDensity(300)
      .setFriction(0.9);
    this.release(wheel.visual.pivot, [collider]);
  }

  private detachPiece(piece: CarPiece): void {
    piece.attached = false;
    const box = piece.mesh.geometry.boundingBox!;
    const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5).max(new THREE.Vector3(0.03, 0.03, 0.03));
    const center = box.getCenter(new THREE.Vector3());
    const collider = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
      .setTranslation(center.x, center.y, center.z)
      .setDensity(250)
      .setFriction(0.7);
    this.release(piece.mesh, [collider]);
  }

  /** Moves a part from the car into the world as a tumbling debris body. */
  private release(object: THREE.Object3D, colliders: RAPIER.ColliderDesc[]): void {
    // Snap the visual root to the physics pose so the part leaves from where it really is.
    this.model.root.position.copy(this.currPos);
    this.model.root.quaternion.copy(this.currQuat);
    this.model.root.updateMatrixWorld(true);
    this.scene.attach(object);

    const lin = this.body.linvel();
    const ang = this.body.angvel();
    const com = this.body.worldCom();
    _arm.set(object.position.x - com.x, object.position.y - com.y, object.position.z - com.z);
    const vel = new THREE.Vector3(ang.x, ang.y, ang.z).cross(_arm).add(_tmp.set(lin.x, lin.y, lin.z));
    // A little outward kick so parts visibly fly off.
    const outward = _arm.clone().setY(0).normalize().multiplyScalar(1.5 + Math.random() * 1.5);
    vel.add(outward).add(_tmp.set(0, 1.5 + Math.random() * 2, 0));
    const spin = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(8);
    this.debris.spawn(object, colliders, vel, spin);
  }

  /** Puts the car back on its wheels at the current spot, keeping heading and damage. */
  resetUpright(field: TerrainField): void {
    const t = this.body.translation();
    _fwd.set(0, 0, -1).applyQuaternion(this.currQuat).setY(0);
    const yaw = _fwd.lengthSq() > 1e-4 ? Math.atan2(-_fwd.x, -_fwd.z) : 0;
    _q.setFromAxisAngle(UP, yaw);
    // Clear the highest ground under the footprint, so steep slopes don't trap the body.
    const B = this.cfg.body;
    let ground = field.height(t.x, t.z);
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      _tmp.set((x * B.width) / 2, 0, (z * B.length) / 2).applyQuaternion(_q);
      ground = Math.max(ground, field.height(t.x + _tmp.x, t.z + _tmp.z));
    }
    this.body.setTranslation({ x: t.x, y: ground + 1.5, z: t.z }, true);
    this.body.setRotation(_q, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    for (const w of this.wheels) {
      w.compression = 0;
      w.grounded = false;
    }
    this.captureTransform();
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
  }

  /** Interpolates the visual between the last two physics states. */
  syncVisual(alpha: number, frameDt: number): void {
    const root = this.model.root;
    root.position.lerpVectors(this.prevPos, this.currPos, alpha);
    root.quaternion.slerpQuaternions(this.prevQuat, this.currQuat, alpha);
    for (const w of this.wheels) {
      if (!w.attached) continue;
      w.visual.pivot.position.y = w.anchor.y - w.suspLen;
      w.visual.pivot.rotation.y = w.front ? this.steer : 0;
      w.visual.spin.rotation.x -= w.spinSpeed * frameDt;
    }
  }

  get position(): THREE.Vector3 {
    return this.model.root.position;
  }

  get velocity(): THREE.Vector3 {
    const v = this.body.linvel();
    return new THREE.Vector3(v.x, v.y, v.z);
  }

  dispose(): void {
    this.world.removeRigidBody(this.body);
    this.scene.remove(this.model.root);
    // Detached parts now belong to Debris; only dispose what is still on the car.
    this.model.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
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
