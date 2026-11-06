import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

const MAX_PIECES = 40;
const LIFETIME = 45;
const MAX_DISTANCE = 350;

const _p = new THREE.Vector3();

interface DebrisItem {
  body: RAPIER.RigidBody;
  object: THREE.Object3D;
  age: number;
}

/** Loose car parts tumbling around as simple rigid bodies. */
export class Debris {
  private items: DebrisItem[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: RAPIER.World,
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
    this.items.push({ body, object, age: 0 });
    while (this.items.length > MAX_PIECES) this.remove(this.items.shift()!);
  }

  update(dt: number, center: THREE.Vector3): void {
    this.items = this.items.filter((item) => {
      item.age += dt;
      const t = item.body.translation();
      if (item.age > LIFETIME || center.distanceTo(_p.set(t.x, t.y, t.z)) > MAX_DISTANCE) {
        this.remove(item);
        return false;
      }
      const r = item.body.rotation();
      item.object.position.copy(_p);
      item.object.quaternion.set(r.x, r.y, r.z, r.w);
      return true;
    });
  }

  private remove(item: DebrisItem): void {
    this.world.removeRigidBody(item.body);
    this.scene.remove(item.object);
    // Geometry belongs to the detached piece; materials are shared and stay alive.
    item.object.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
  }
}
