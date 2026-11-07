import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Debris } from '../world/debris';
import type { CarPiece, HingeSpec } from './carModel';

export interface PanelTuning {
  /** A hinged panel tears off once its hp drops this far below zero. */
  tearHp: number;
  /** ...or when it flaps faster than this relative to the car (rad/s). */
  tearSwingSpeed: number;
  /** Air drag on loose panels (N per (m/s)²): shuts open doors and flips hoods up at speed. */
  panelAeroDrag: number;
}

interface HingedPanel {
  piece: CarPiece;
  body: RAPIER.RigidBody;
  joint: RAPIER.ImpulseJoint;
}

const _m = new THREE.Matrix4();
const _rel = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

/**
 * Panels that have broken loose but still hang on their hinges: each is its
 * own rigid body, tied to the car by a revolute joint with limits, until it
 * tears off and becomes debris.
 */
export class HingedPanels {
  private readonly panels: HingedPanel[] = [];
  private readonly bodies = new Set<number>();

  constructor(
    private readonly world: RAPIER.World,
    private readonly scene: THREE.Scene,
    private readonly debris: Debris,
    private readonly carBody: RAPIER.RigidBody,
    private readonly tuning: PanelTuning,
  ) {}

  get count(): number {
    return this.panels.length;
  }

  /** True for colliders of this car's hinged panels (the wheel rays ignore them). */
  owns(collider: RAPIER.Collider): boolean {
    const parent = collider.parent();
    return parent !== null && this.bodies.has(parent.handle);
  }

  /**
   * Swings a closed panel open on its hinge. The car's visual root must sit at the
   * physics pose (the panel leaves from where its mesh is).
   * @param impact car-local hit point; a bumper's struck end is the one that breaks free
   */
  hinge(piece: CarPiece, spec: HingeSpec, impact: THREE.Vector3, velocityAt: (world: THREE.Vector3) => THREE.Vector3): void {
    const hinge = spec.mirrorable && impact.x > 0 ? mirrored(spec) : spec;
    piece.state = 'hinged';
    const mesh = piece.mesh;
    // Both anchors are in their bodies' local frames, which coincide in orientation right now.
    const anchorOnPanel = hinge.anchor.clone().sub(mesh.position);
    const swing = new THREE.Vector3().crossVectors(hinge.axis, mesh.position.clone().sub(hinge.anchor));
    this.scene.attach(mesh);

    const body = createPanelBody(this.world, mesh, hinge.mass, velocityAt(mesh.position));
    const params = RAPIER.JointData.revolute(hinge.anchor, anchorOnPanel, hinge.axis);
    const joint = this.world.createImpulseJoint(params, this.carBody, body, true) as RAPIER.RevoluteImpulseJoint;
    // Limits must be set on the created joint: JointData.limits is ignored for revolute joints.
    joint.setLimits(hinge.min, hinge.max);
    joint.setContactsEnabled(false);
    // A motor holding zero speed acts as hinge friction, so panels don't flap forever.
    joint.configureMotorVelocity(0, hinge.damping);

    // Nudge it open in its allowed direction so the break is visible.
    const r = this.carBody.rotation();
    swing.applyQuaternion(_q.set(r.x, r.y, r.z, r.w)).normalize().multiplyScalar(hinge.max > 0 ? 1 : -1);
    body.applyImpulse(swing.multiplyScalar(hinge.mass * 2), true);

    this.panels.push({ piece, body, joint });
    this.bodies.add(body.handle);
  }

  /** Air drag on every hanging panel. Call before world.step(). */
  step(dt: number): void {
    for (const { body } of this.panels) {
      const v = body.linvel();
      const k = -Math.hypot(v.x, v.y, v.z) * this.tuning.panelAeroDrag * dt;
      body.applyImpulse({ x: v.x * k, y: v.y * k, z: v.z * k }, true);
    }
  }

  /** Tears off panels that are too damaged or flapping too hard. Call after world.step(). */
  afterStep(): void {
    const w = this.carBody.angvel();
    for (let i = this.panels.length - 1; i >= 0; i--) {
      const p = this.panels[i];
      const a = p.body.angvel();
      const swing = Math.hypot(a.x - w.x, a.y - w.y, a.z - w.z);
      if (p.piece.hp <= -this.tuning.tearHp || swing > this.tuning.tearSwingSpeed) this.tear(i);
    }
  }

  sync(): void {
    for (const { piece, body } of this.panels) {
      const t = body.translation();
      const r = body.rotation();
      piece.mesh.position.set(t.x, t.y, t.z);
      piece.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  /** Carries hanging panels along when the car is teleported (reset). */
  teleport(before: THREE.Matrix4, after: THREE.Matrix4): void {
    const inverse = before.clone().invert();
    for (const { body } of this.panels) {
      const t = body.translation();
      const r = body.rotation();
      _m.compose(_p.set(t.x, t.y, t.z), _q.set(r.x, r.y, r.z, r.w), _s.set(1, 1, 1));
      _rel.multiplyMatrices(inverse, _m);
      _m.multiplyMatrices(after, _rel).decompose(_p, _q, _s);
      body.setTranslation(_p, true);
      body.setRotation(_q, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  dispose(): void {
    for (const { piece, body } of this.panels) {
      this.world.removeRigidBody(body);
      this.scene.remove(piece.mesh);
      piece.mesh.geometry.dispose();
    }
    this.panels.length = 0;
    this.bodies.clear();
  }

  private tear(index: number): void {
    const [{ piece, body, joint }] = this.panels.splice(index, 1);
    this.world.removeImpulseJoint(joint, true);
    this.bodies.delete(body.handle);
    piece.state = 'gone';
    this.debris.adopt(piece.mesh, body);
  }
}

/** Dynamic body for a panel mesh already in world space, with a box collider from its bounds. */
export function createPanelBody(world: RAPIER.World, mesh: THREE.Mesh, mass: number, velocity: THREE.Vector3): RAPIER.RigidBody {
  const box = mesh.geometry.boundingBox!;
  const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5).max(new THREE.Vector3(0.03, 0.03, 0.03));
  const center = box.getCenter(new THREE.Vector3());
  const p = mesh.position;
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(p.x, p.y, p.z)
      .setRotation(mesh.quaternion)
      .setLinvel(velocity.x, velocity.y, velocity.z)
      .setCcdEnabled(true),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setTranslation(center.x, center.y, center.z).setMass(mass).setFriction(0.7),
    body,
  );
  return body;
}

/** The same hinge at the opposite end (bumpers can break loose at either end). */
function mirrored(spec: HingeSpec): HingeSpec {
  return { ...spec, anchor: spec.anchor.clone().setX(-spec.anchor.x), min: -spec.max, max: -spec.min };
}
