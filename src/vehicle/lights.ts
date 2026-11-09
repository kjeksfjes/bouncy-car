import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { GRAVITY, PHYSICS_STEP } from '../constants';
import type { Debris } from '../world/debris';
import type { TerrainField } from '../world/terrainField';
import type { Crush } from './crush';
import type { BodyOutline } from './outline';

/** Light fixture feel values (part of the car's damage config). */
export interface LightTuning {
  /** Hits further than this (m) from a fixture don't touch it. */
  lightReach: number;
  /** Accumulated damage (hit points) at which the lens smashes, the fixture drops out to dangle, and the wire snaps. */
  lightLensHp: number;
  lightMountHp: number;
  lightWireHp: number;
  /** A fixture pushed this far (m) by crush and dents together is squeezed out of its socket. */
  lightDropAtCrush: number;
  /**
   * Chance a fixture that comes out of its socket snaps off at once instead of dangling: when it
   * only just comes out, rising to `lightSnapChanceHard` for one knocked out hard (pushed in three
   * times `lightDropAtCrush`, or a single hit dealing its whole `lightMountHp`). The crash that
   * knocks it out can't snap the wire later (see WIRE_GRACE), so this is where a crash tears it off.
   */
  lightSnapChance: number;
  lightSnapChanceHard: number;
  /** Wire length (m) and air drag on a dangling fixture (1/s). */
  wireLength: number;
  wireDrag: number;
  /** Pull on the wire (as the acceleration it gives the lamp, m/s²; hanging still ≈ g) that snaps it. */
  wireTearAccel: number;
}

export type LightKind = 'head' | 'tail' | 'marker';

/** A light as built by the car model: a rigid group on the car root, with a dark socket behind it. */
export interface LightFixtureDef {
  name: string;
  kind: LightKind;
  /** Child of the car root, at the mount point; its children are posed in car-local orientation. */
  group: THREE.Group;
  /** The glowing part; goes dark when smashed. */
  lens: THREE.Mesh;
  /**
   * Dark patch left behind where the body has no real opening (side markers); child of the car
   * root, hidden by the fixture while it's there. Head- and taillights sit in real openings instead.
   */
  socket?: THREE.Mesh;
  /** Car-local direction the light faces. */
  normal: THREE.Vector3;
}

interface Fixture extends LightFixtureDef {
  state: 'intact' | 'smashed' | 'dangling' | 'gone';
  damage: number;
  /** Car-local rest positions of the fixture and its socket. */
  mountRest: THREE.Vector3;
  /**
   * Car-local rest positions of the fixture's two ends along its long axis (x for head- and
   * taillights, z for side markers), and where they are now. A wide fixture follows the body
   * at both ends, so it tilts with a crumpled panel and pops out when either end is pushed in.
   */
  endsRest: [THREE.Vector3, THREE.Vector3];
  endsNow: [THREE.Vector3, THREE.Vector3];
  socketRest: THREE.Vector3;
  /** Dent displacement picked up by the mount (car-local), on top of the crush. */
  dent: THREE.Vector3;
  /** Car-local socket position now (crushed and dented): where the wire is tied. */
  socketNow: THREE.Vector3;
  /** Dangling state, world space: Verlet position pair, the socket's last position, and the wire. */
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  socketPrev: THREE.Vector3;
  wire: THREE.Line | null;
  /** Re-hang at rest on the next update (after a teleport). */
  snap: boolean;
  /** The socket's previous position isn't known yet (first update after dropping out). */
  fresh: boolean;
  /** Seconds spent dangling. */
  hangTime: number;
  /** Damage taken since it started dangling; the wire has its own budget (lightWireHp). */
  wireDamage: number;
  /** Smoothed pull on the wire (m/s²). */
  tension: number;
  /** World direction from the socket to the lamp at the last update (unit), for turning it with the swing. */
  wireDir: THREE.Vector3;
  /** Collision box for when it is ripped off (group-local). */
  half: THREE.Vector3;
  /** Size of the sphere kept outside the body while dangling (m). */
  radius: number;
}

/** Shards per smashed lens and their tint by kind. */
const SHARD_COUNT = 10;
const SHARD_TINT: Record<LightKind, THREE.Color> = {
  head: new THREE.Color('#9fc4d6'),
  tail: new THREE.Color('#b3121c'),
  marker: new THREE.Color('#e08a1e'),
};
/** Longest frame step the pendulum takes (s): a stalled frame shouldn't fling a light off. */
const MAX_DT = 1 / 30;
/** Seconds after dropping out before a yank can snap the wire: the pop out of the socket isn't a yank. */
const WIRE_GRACE = 0.25;
/**
 * A dangling lamp turns with its wire only once it hangs this far out (× wire length): fully from
 * SLACK_TO, not at all inside SLACK_FROM.
 */
const SLACK_FROM = 0.25;
const SLACK_TO = 0.5;
const IDENTITY = new THREE.Quaternion();
/** Time constant (s) the wire's pull is smoothed over, so one uneven frame isn't a yank. */
const TENSION_SMOOTHING = 0.05;

/** How far outside the socket's rest spot a surface ray starts (m): more than the deepest dent or crush wrinkle. */
const SOCKET_RAY_START = 0.4;
/** An empty socket sits this far (m) proud of the surface it's snapped to. */
const SOCKET_LIFT = 0.004;

const wireMaterial = new THREE.LineBasicMaterial({ color: '#141416' });
const raycaster = new THREE.Raycaster();
const _w = new THREE.Vector3();
const _turn = new THREE.Quaternion();
const _w2 = new THREE.Vector3();
const _local = new THREE.Vector3();
const _n = new THREE.Vector3();
const _seg = new THREE.Line3();
const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _box = new THREE.Box3();

/**
 * Head-, tail- and marker lights as rigid fixtures that ride on the (crushed, dented)
 * body without deforming. Damage first smashes the lens (it goes dark and sheds
 * shards), then drops the fixture out of its socket to dangle on its wire, then snaps
 * the wire and leaves it to Debris. The dangling is a visual-only pendulum.
 */
export class CarLights {
  private readonly fixtures: Fixture[];

  constructor(
    defs: readonly LightFixtureDef[],
    private readonly root: THREE.Object3D,
    private readonly scene: THREE.Scene,
    private readonly debris: Debris,
    private readonly tuning: LightTuning,
    private readonly smashedLens: Record<LightKind, THREE.Material>,
    private readonly outline: BodyOutline,
    private readonly field: TerrainField,
    /** The body panel the sockets sit in; empty sockets are snapped onto its surface. */
    private readonly shell: THREE.Mesh,
  ) {
    this.fixtures = defs.map((def) => {
      // The root still sits at the origin here, so the box is in car-local space.
      _box.setFromObject(def.group, true);
      const half = _box.getSize(new THREE.Vector3()).multiplyScalar(0.5).max(new THREE.Vector3(0.02, 0.02, 0.02));
      const centre = _box.getCenter(new THREE.Vector3());
      const along = half.x >= half.z ? new THREE.Vector3(half.x, 0, 0) : new THREE.Vector3(0, 0, half.z);
      const endsRest: [THREE.Vector3, THREE.Vector3] = [centre.clone().sub(along), centre.clone().add(along)];
      return {
        ...def,
        state: 'intact',
        damage: 0,
        mountRest: def.group.position.clone(),
        endsRest,
        endsNow: [endsRest[0].clone(), endsRest[1].clone()],
        // Without a socket patch the wire is tied at the mount: the centre of the body's opening.
        socketRest: (def.socket ?? def.group).position.clone(),
        dent: new THREE.Vector3(),
        socketNow: (def.socket ?? def.group).position.clone(),
        pos: new THREE.Vector3(),
        prev: new THREE.Vector3(),
        socketPrev: new THREE.Vector3(),
        wire: null,
        snap: false,
        fresh: false,
        hangTime: 0,
        wireDamage: 0,
        tension: 0,
        wireDir: new THREE.Vector3(0, -1, 0),
        half,
        // Vertical half size: the lamp hangs face-down, so this is roughly its footprint.
        radius: half.y,
      };
    });
  }

  /** Mounted fixtures pick up a body dent like the panels around them (same falloff and cap as applyDent). */
  dent(point: THREE.Vector3, dir: THREE.Vector3, depth: number, radius: number, maxDent: number): void {
    for (const f of this.fixtures) {
      if (!this.mounted(f)) continue;
      const d = f.mountRest.distanceTo(point);
      if (d >= radius) continue;
      f.dent.addScaledVector(dir, depth * (1 - d / radius) ** 2);
      if (f.dent.length() > maxDent) f.dent.setLength(maxDent);
    }
  }

  /**
   * Moves mounted fixtures and sockets with the crush and dents, and drops any that the
   * crumple zone pushed too far. `velocityAt` gives the car's velocity at a world point.
   */
  follow(crush: Crush, velocityAt: (world: THREE.Vector3) => THREE.Vector3): void {
    for (const f of this.fixtures) {
      f.socketNow.copy(crush.displace(_v.copy(f.socketRest))).add(f.dent);
      f.socket?.position.copy(f.socketNow);
      if (!this.mounted(f)) {
        this.snapSocket(f);
        continue;
      }
      // Both ends ride on the body; the fixture sits between them, tilted along the line through them.
      let pushed = 0;
      for (let k = 0; k < 2; k++) {
        f.endsNow[k].copy(crush.displace(_v.copy(f.endsRest[k]))).add(f.dent);
        pushed = Math.max(pushed, f.endsNow[k].distanceTo(f.endsRest[k]));
      }
      _v.addVectors(f.endsNow[0], f.endsNow[1]).multiplyScalar(0.5);
      _d.addVectors(f.endsRest[0], f.endsRest[1]).multiplyScalar(0.5);
      f.group.position.copy(f.mountRest).add(_v.sub(_d));
      _v.subVectors(f.endsRest[1], f.endsRest[0]).normalize();
      _d.subVectors(f.endsNow[1], f.endsNow[0]).normalize();
      f.group.quaternion.setFromUnitVectors(_v, _d);
      // Pushed far at either end, a light would sink into (or stick out of) the crumpled panel
      // around it: it pops out of its socket instead.
      const D = this.tuning.lightDropAtCrush;
      if (pushed > D) this.dropOut(f, velocityAt, THREE.MathUtils.clamp((pushed - D) / (2 * D), 0, 1));
    }
  }

  /** Damages fixtures near a car-local hit point. */
  hit(local: THREE.Vector3, damage: number, velocityAt: (world: THREE.Vector3) => THREE.Vector3): void {
    const T = this.tuning;
    for (const f of this.fixtures) {
      if (f.state === 'gone') continue;
      // Wide fixtures (taillight halves) count hits along their whole length.
      const d = f.state === 'dangling' ? f.socketNow.distanceTo(local) : _seg.set(f.endsNow[0], f.endsNow[1]).closestPointToPoint(local, true, _v).distanceTo(local);
      if (d >= T.lightReach) continue;
      const dealt = damage * (1 - d / T.lightReach);
      if (f.state === 'dangling') {
        f.wireDamage += dealt;
        if (f.wireDamage >= T.lightWireHp) this.rip(f, f.pos.clone().sub(f.prev).divideScalar(PHYSICS_STEP));
        continue;
      }
      f.damage += dealt;
      if (f.state === 'intact' && f.damage >= T.lightLensHp) this.smash(f, velocityAt);
      if (this.mounted(f) && f.damage >= T.lightMountHp) this.dropOut(f, velocityAt, Math.min(1, dealt / T.lightMountHp));
    }
  }

  /** Swings dangling fixtures; call every frame after the car root is placed. */
  update(frameDt: number): void {
    const T = this.tuning;
    const dt = Math.min(frameDt, MAX_DT);
    if (dt <= 0) return;
    this.root.updateMatrixWorld();
    for (const f of this.fixtures) {
      if (f.state !== 'dangling') continue;
      const socket = this.root.localToWorld(_w.copy(f.socketNow));
      if (f.snap) {
        // After a teleport: hang straight down, at rest.
        f.pos.copy(socket).y -= T.wireLength;
        f.prev.copy(f.pos);
        f.socketPrev.copy(socket);
        f.snap = false;
      }
      // The drop happens mid-physics, where the root sits at the physics pose; from here on it's
      // the interpolated pose, so the socket's speed is measured between updates only.
      if (f.fresh) {
        f.socketPrev.copy(socket);
        f.fresh = false;
      }
      f.hangTime += dt;
      // Verlet: velocity is implicit in pos − prev; drag bleeds it off.
      _v.subVectors(f.pos, f.prev).multiplyScalar(Math.max(0, 1 - T.wireDrag * dt));
      f.prev.copy(f.pos);
      f.pos.add(_v);
      f.pos.y -= GRAVITY * dt * dt;
      // The wire only pulls, it doesn't push. How far it has to pull the lamp back this step is
      // its pull, as an acceleration: ≈ g hanging still, far more when the car yanks it.
      _d.subVectors(f.pos, socket);
      const len = _d.length();
      let pull = 0;
      if (len > T.wireLength) {
        pull = (len - T.wireLength) / (dt * dt);
        f.pos.copy(socket).addScaledVector(_d, T.wireLength / len);
      }
      f.tension += (pull - f.tension) * (1 - Math.exp(-dt / TENSION_SMOOTHING));
      // Pushed out of the body (or the snow), it rests against it like a contact: a position fix,
      // and its velocity heading into the surface (relative to the body there, which the socket's
      // move this step stands for) is dropped. Otherwise the moving car ran into it again every
      // frame, pushing it out near the box's edges through a different face each time, and the
      // lamp jumped about its socket.
      _v.copy(f.pos);
      this.keepOutside(f);
      _d.subVectors(f.pos, _v);
      if (_d.lengthSq() > 1e-12) {
        f.prev.add(_d);
        _d.normalize();
        const v = _w2.subVectors(f.pos, f.prev);
        const into = (v.x - (socket.x - f.socketPrev.x)) * _d.x + (v.y - (socket.y - f.socketPrev.y)) * _d.y + (v.z - (socket.z - f.socketPrev.z)) * _d.z;
        if (into < 0) f.prev.copy(f.pos).sub(v.addScaledVector(_d, -into));
      }
      f.socketPrev.copy(socket);
      if (f.hangTime > WIRE_GRACE && f.tension > T.wireTearAccel) {
        this.rip(f, _v.subVectors(f.pos, f.prev).divideScalar(dt).clone());
        continue;
      }

      // Turn with the swing: by how the wire's direction changed since the last update. Setting
      // the shortest turn from the lens axis to the wire afresh each frame instead is unstable
      // when the wire points nearly opposite the lens (a headlight trailing back behind its
      // socket as the car drives on): its roll flips about and the lamp spins wildly.
      // Close to its socket the wire is slack and its direction means little (a centimetre swings
      // it round): the turn fades out there, from half the wire's length in.
      _d.subVectors(f.pos, socket);
      const reach = _d.length();
      if (reach > 1e-4) {
        _d.divideScalar(reach);
        const follow = THREE.MathUtils.smoothstep(reach, SLACK_FROM * T.wireLength, SLACK_TO * T.wireLength);
        f.group.quaternion.premultiply(_turn.setFromUnitVectors(f.wireDir, _d).slerp(IDENTITY, 1 - follow));
        f.wireDir.copy(_d);
      }
      f.group.position.copy(f.pos);
      const wire = f.wire!.geometry.getAttribute('position') as THREE.BufferAttribute;
      wire.setXYZ(0, socket.x, socket.y, socket.z);
      wire.setXYZ(1, f.pos.x, f.pos.y, f.pos.z);
      wire.needsUpdate = true;
    }
  }

  /**
   * Moves dangling fixtures by a world-space offset along with the car (see Car.advanceIntoCrush),
   * keeping their swing, so the move isn't a yank on the wire.
   */
  shift(delta: THREE.Vector3): void {
    for (const f of this.fixtures) {
      if (f.state !== 'dangling') continue;
      f.pos.add(delta);
      f.prev.add(delta);
      f.socketPrev.add(delta);
    }
  }

  /** After the car is teleported: dangling fixtures re-hang at rest instead of being yanked off. */
  teleport(): void {
    for (const f of this.fixtures) if (f.state === 'dangling') f.snap = true;
  }

  /** Removes fixtures that hang outside the car root (the rest go with the root). */
  dispose(): void {
    for (const f of this.fixtures) {
      if (f.state !== 'dangling') continue;
      this.scene.remove(f.group);
      f.group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      this.removeWire(f);
    }
  }

  private mounted(f: Fixture): boolean {
    return f.state === 'intact' || f.state === 'smashed';
  }

  private smash(f: Fixture, velocityAt: (world: THREE.Vector3) => THREE.Vector3): void {
    f.state = 'smashed';
    f.lens.material = this.smashedLens[f.kind];
    this.root.updateMatrixWorld();
    const pos = f.lens.geometry.getAttribute('position');
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < SHARD_COUNT; i++) {
      points.push(new THREE.Vector3().fromBufferAttribute(pos, Math.floor(Math.random() * pos.count)).applyMatrix4(f.lens.matrixWorld));
    }
    const at = f.group.getWorldPosition(new THREE.Vector3());
    const outward = f.normal.clone().transformDirection(this.root.matrixWorld).setY(0.4).normalize();
    this.debris.shatter(points, velocityAt(at), outward, SHARD_TINT[f.kind]);
  }

  /** @param violence how hard it was knocked out, 0 (only just) .. 1 (see lightSnapChanceHard) */
  private dropOut(f: Fixture, velocityAt: (world: THREE.Vector3) => THREE.Vector3, violence: number): void {
    if (f.state === 'intact') this.smash(f, velocityAt);
    f.state = 'dangling';
    this.snapSocket(f);
    this.root.updateMatrixWorld();
    this.scene.attach(f.group);
    // Starts just outside the body, leaving with the car's velocity there plus a small pop.
    const out = f.normal.clone().transformDirection(this.root.matrixWorld);
    const socket = this.root.localToWorld(new THREE.Vector3().copy(f.socketNow));
    f.pos.copy(socket).addScaledVector(out, f.radius + 0.01);
    this.keepOutside(f);
    const v = velocityAt(f.pos).addScaledVector(out, 1.5);
    const T = this.tuning;
    if (Math.random() < T.lightSnapChance + (T.lightSnapChanceHard - T.lightSnapChance) * violence) {
      // Not every light hangs on: some snap clean off.
      f.group.position.copy(f.pos);
      this.rip(f, v);
      return;
    }
    f.prev.copy(f.pos).addScaledVector(v, -PHYSICS_STEP);
    f.socketPrev.copy(socket);
    // Hangs lens-out along the wire to start with; from here on it turns with the swing.
    f.wireDir.subVectors(f.pos, socket).normalize();
    f.group.quaternion.setFromUnitVectors(f.normal, f.wireDir);
    f.fresh = true;
    f.hangTime = 0;
    f.wireDamage = 0;
    f.tension = 0;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([...f.socketPrev.toArray(), ...f.pos.toArray()], 3));
    f.wire = new THREE.Line(geometry, wireMaterial);
    f.wire.frustumCulled = false;
    this.scene.add(f.wire);
  }

  /**
   * Lays an empty socket patch flat on the body surface it belongs to. Following its rest
   * point through crush and dents isn't enough once it's visible: the panel around it is
   * coarser (long side strips, crumple wrinkles), so the patch would sink behind it or float.
   */
  private snapSocket(f: Fixture): void {
    if (!f.socket) return;
    this.root.updateMatrixWorld(true);
    const origin = this.root.localToWorld(_v.copy(f.socketNow).addScaledVector(f.normal, SOCKET_RAY_START));
    const inward = _d.copy(f.normal).negate().transformDirection(this.root.matrixWorld);
    raycaster.set(origin, inward);
    raycaster.far = SOCKET_RAY_START * 2;
    const hit = raycaster.intersectObject(this.shell, false)[0];
    if (!hit?.face) return;
    // The shell is an unrotated child of the root, so its face normals are car-local directions.
    const normal = _n.copy(hit.face.normal);
    if (normal.dot(f.normal) < 0) normal.negate();
    f.socketNow.copy(this.root.worldToLocal(hit.point)).addScaledVector(normal, SOCKET_LIFT);
    f.socket.position.copy(f.socketNow);
    f.socket.quaternion.setFromUnitVectors(f.normal, normal);
  }

  /** Keeps a dangling fixture out of its own car's body and above the snow (it has no collider). */
  private keepOutside(f: Fixture): void {
    const local = this.root.worldToLocal(_local.copy(f.pos));
    this.outline.pushOut(local, f.radius, f.socketNow, this.tuning.wireLength);
    this.root.localToWorld(f.pos.copy(local));
    const ground = this.field.height(f.pos.x, f.pos.z) + f.radius;
    if (f.pos.y < ground) f.pos.y = ground;
  }

  private rip(f: Fixture, velocity: THREE.Vector3): void {
    f.state = 'gone';
    this.removeWire(f);
    const spin = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(10);
    const collider = RAPIER.ColliderDesc.cuboid(f.half.x, f.half.y, f.half.z).setDensity(300).setFriction(0.8);
    this.debris.spawn(f.group, [collider], velocity, spin);
  }

  private removeWire(f: Fixture): void {
    if (!f.wire) return;
    this.scene.remove(f.wire);
    f.wire.geometry.dispose();
    f.wire = null;
  }
}
