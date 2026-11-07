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
  /** Chance a fixture that comes out of its socket snaps off at once instead of dangling. */
  lightSnapChance: number;
  /** Wire length (m), air drag on a dangling fixture (1/s), and the swing speed (m/s, relative to its socket) that snaps the wire. */
  wireLength: number;
  wireDrag: number;
  wireTearSpeed: number;
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
  /** Dark recess left behind as a hole; child of the car root, hidden by the fixture while it's there. */
  socket: THREE.Mesh;
  /** Car-local direction the light faces. */
  normal: THREE.Vector3;
}

interface Fixture extends LightFixtureDef {
  state: 'intact' | 'smashed' | 'dangling' | 'gone';
  damage: number;
  /** Car-local rest positions of the fixture and its socket. */
  mountRest: THREE.Vector3;
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
/** Seconds after dropping out before a swing can snap the wire: the pop out of the socket isn't a yank. */
const WIRE_GRACE = 0.25;

const wireMaterial = new THREE.LineBasicMaterial({ color: '#141416' });
const _w = new THREE.Vector3();
const _local = new THREE.Vector3();
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
  ) {
    this.fixtures = defs.map((def) => {
      _box.setFromObject(def.group, true);
      const half = _box.getSize(new THREE.Vector3()).multiplyScalar(0.5).max(new THREE.Vector3(0.02, 0.02, 0.02));
      return {
        ...def,
        state: 'intact',
        damage: 0,
        mountRest: def.group.position.clone(),
        socketRest: def.socket.position.clone(),
        dent: new THREE.Vector3(),
        socketNow: def.socket.position.clone(),
        pos: new THREE.Vector3(),
        prev: new THREE.Vector3(),
        socketPrev: new THREE.Vector3(),
        wire: null,
        snap: false,
        fresh: false,
        hangTime: 0,
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
      if (f.state === 'gone') continue;
      f.socketNow.copy(crush.displace(_v.copy(f.socketRest))).add(f.dent);
      f.socket.position.copy(f.socketNow);
      if (!this.mounted(f)) continue;
      f.group.position.copy(crush.displace(_v.copy(f.mountRest))).add(f.dent);
      // Pushed far by crush or dent, a light would sink into the panel around it (the panel is
      // coarser than the fixture follows): it pops out of its socket instead.
      if (f.group.position.distanceTo(f.mountRest) > this.tuning.lightDropAtCrush) this.dropOut(f, velocityAt);
    }
  }

  /** Damages fixtures near a car-local hit point. */
  hit(local: THREE.Vector3, damage: number, velocityAt: (world: THREE.Vector3) => THREE.Vector3): void {
    const T = this.tuning;
    for (const f of this.fixtures) {
      if (f.state === 'gone') continue;
      const d = (f.state === 'dangling' ? f.socketNow : f.group.position).distanceTo(local);
      if (d >= T.lightReach) continue;
      f.damage += damage * (1 - d / T.lightReach);
      if (f.state === 'intact' && f.damage >= T.lightLensHp) this.smash(f, velocityAt);
      if (this.mounted(f) && f.damage >= T.lightMountHp) this.dropOut(f, velocityAt);
      if (f.state === 'dangling' && f.damage >= T.lightWireHp) this.rip(f, f.pos.clone().sub(f.prev).divideScalar(PHYSICS_STEP));
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
      // The wire only pulls, it doesn't push.
      _d.subVectors(f.pos, socket);
      const len = _d.length();
      if (len > T.wireLength) f.pos.copy(socket).addScaledVector(_d, T.wireLength / len);
      this.keepOutside(f);

      // Swing speed relative to the socket: a violent yank snaps the wire.
      _v.subVectors(f.pos, f.prev).divideScalar(dt);
      const swing = _d.subVectors(socket, f.socketPrev).divideScalar(dt).sub(_v).length();
      f.socketPrev.copy(socket);
      if (f.hangTime > WIRE_GRACE && swing > T.wireTearSpeed) {
        this.rip(f, _v.clone());
        continue;
      }

      // Hang lens-out along the wire.
      _d.subVectors(f.pos, socket);
      if (_d.lengthSq() > 1e-8) f.group.quaternion.setFromUnitVectors(f.normal, _d.normalize());
      f.group.position.copy(f.pos);
      const wire = f.wire!.geometry.getAttribute('position') as THREE.BufferAttribute;
      wire.setXYZ(0, socket.x, socket.y, socket.z);
      wire.setXYZ(1, f.pos.x, f.pos.y, f.pos.z);
      wire.needsUpdate = true;
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

  private dropOut(f: Fixture, velocityAt: (world: THREE.Vector3) => THREE.Vector3): void {
    if (f.state === 'intact') this.smash(f, velocityAt);
    f.state = 'dangling';
    this.root.updateMatrixWorld();
    this.scene.attach(f.group);
    // Starts just outside the body, leaving with the car's velocity there plus a small pop.
    const out = f.normal.clone().transformDirection(this.root.matrixWorld);
    const socket = this.root.localToWorld(new THREE.Vector3().copy(f.socketNow));
    f.pos.copy(socket).addScaledVector(out, f.radius + 0.01);
    this.keepOutside(f);
    const v = velocityAt(f.pos).addScaledVector(out, 1.5);
    if (Math.random() < this.tuning.lightSnapChance) {
      // Not every light hangs on: some snap clean off.
      f.group.position.copy(f.pos);
      this.rip(f, v);
      return;
    }
    f.prev.copy(f.pos).addScaledVector(v, -PHYSICS_STEP);
    f.socketPrev.copy(socket);
    f.fresh = true;
    f.hangTime = 0;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([...f.socketPrev.toArray(), ...f.pos.toArray()], 3));
    f.wire = new THREE.Line(geometry, wireMaterial);
    f.wire.frustumCulled = false;
    this.scene.add(f.wire);
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
