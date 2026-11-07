import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Visibility } from '../render/visibility';
import type { TerrainField } from './terrainField';

/**
 * Cleanup policy: never pop a piece out of existence in view. Hidden pieces
 * are removed outright; visible ones sink into the snow first.
 */
const CLEANUP = {
  /** Live pieces above this count make the oldest one sink. */
  maxPieces: 40,
  /** A hidden piece is removed once it has rested this long (s)... */
  hiddenRestTime: 8,
  /** ...or once it's this far from the player (m). */
  hiddenMaxDistance: 350,
  /** A piece resting in plain view sinks after this long (s). */
  visibleRestTime: 90,
  /** Below linear (m/s) and angular (rad/s) speed, a piece counts as resting. */
  restLinear: 0.3,
  restAngular: 0.5,
  /** Further below the terrain than this (m) = fell through unloaded ground. */
  underground: 3,
  sinkDepth: 1.5,
  sinkTime: 2,
  /** Bounding radius used for the in-view test (m); larger than any part. */
  viewRadius: 2,
};

interface DebrisItem {
  body: RAPIER.RigidBody | null;
  object: THREE.Object3D;
  restTime: number;
  /** Seconds into the sink animation; null while still a physics body. */
  sinking: number | null;
}

const _p = new THREE.Vector3();

/** Loose car parts tumbling around as simple rigid bodies. */
export class Debris {
  private items: DebrisItem[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: RAPIER.World,
    private readonly field: TerrainField,
  ) {}

  /** `object` must already be a direct child of the scene, placed in world space. */
  spawn(object: THREE.Object3D, colliders: RAPIER.ColliderDesc[], linvel: THREE.Vector3, angvel: THREE.Vector3): void {
    const p = object.position;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(p.x, p.y, p.z)
        .setRotation(object.quaternion)
        .setLinvel(linvel.x, linvel.y, linvel.z)
        .setAngvel(angvel)
        .setCcdEnabled(true),
    );
    for (const desc of colliders) this.world.createCollider(desc, body);
    this.items.push({ body, object, restTime: 0, sinking: null });
    this.enforceCap();
  }

  /** Takes over an existing body (e.g. a panel torn off its hinge); `object` must be in world space. */
  adopt(object: THREE.Object3D, body: RAPIER.RigidBody): void {
    this.items.push({ body, object, restTime: 0, sinking: null });
    this.enforceCap();
  }

  private enforceCap(): void {
    const live = this.items.filter((i) => i.sinking === null);
    if (live.length > CLEANUP.maxPieces) this.startSinking(live[0]);
  }

  /** @param player cleanup distances are measured from here */
  update(dt: number, player: THREE.Vector3, view: Visibility): void {
    const C = CLEANUP;

    this.items = this.items.filter((item) => {
      if (item.sinking !== null) {
        item.sinking += dt;
        item.object.position.y -= (C.sinkDepth / C.sinkTime) * dt;
        if (item.sinking < C.sinkTime) return true;
        this.removeObject(item);
        return false;
      }

      const body = item.body!;
      const t = body.translation();
      const r = body.rotation();
      item.object.position.set(t.x, t.y, t.z);
      item.object.quaternion.set(r.x, r.y, r.z, r.w);

      const v = body.linvel();
      const w = body.angvel();
      const resting = Math.hypot(v.x, v.y, v.z) < C.restLinear && Math.hypot(w.x, w.y, w.z) < C.restAngular;
      item.restTime = resting ? item.restTime + dt : 0;

      _p.set(t.x, t.y, t.z);
      const underground = t.y < this.field.height(t.x, t.z) - C.underground;
      const visible = !underground && view.canSee(_p, C.viewRadius);

      if (!visible && (underground || item.restTime > C.hiddenRestTime || player.distanceTo(_p) > C.hiddenMaxDistance)) {
        this.world.removeRigidBody(body);
        this.removeObject(item);
        return false;
      }
      if (visible && item.restTime > C.visibleRestTime) this.startSinking(item);
      return true;
    });
  }

  /** Freezes a piece and lets it slide down into the snow before it's removed. */
  private startSinking(item: DebrisItem): void {
    if (item.body) this.world.removeRigidBody(item.body);
    item.body = null;
    item.sinking = 0;
  }

  private removeObject(item: DebrisItem): void {
    this.scene.remove(item.object);
    // Geometry belongs to the detached piece; materials are shared and stay alive.
    item.object.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
  }
}
