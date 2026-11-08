import * as THREE from 'three';
import { GRAVITY } from '../constants';
import { SUN_DIR } from '../render/stage';
import type { TerrainField } from './terrainField';

/** Feel values for glass shards. Tuned for readability on snow, not realism (tempered glass is ~1 cm crumbs). */
const SHARDS = {
  capacity: 600,
  /** Seconds a shard lives; the last `fadeTime` of it is spent shrinking away. */
  lifetime: 10,
  fadeTime: 1.5,
  /** Scale of the unit triangle (≈1 m across), so shards are 6–16 cm. */
  sizeMin: 0.06,
  sizeMax: 0.16,
  /** Speed (m/s) thrown out from the pane, on top of the car's own velocity, plus random scatter. */
  eject: 3,
  scatter: 3,
  /**
   * Air drag (1/s): shards lose the car's speed quickly, so at speed they spray back past
   * the orbit camera instead of travelling along with the car.
   */
  drag: 1.4,
  /** Glass-edge tint; lit by a fake sun term since the material is unlit. */
  tint: new THREE.Color('#5fa3b3'),
  /** Sun glint: sharpness (higher = shorter flashes) and strength (how fully it whitens the tint). */
  glintPower: 24,
  glint: 1.6,
};

interface Shard {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  rotation: THREE.Quaternion;
  spinAxis: THREE.Vector3;
  spin: number;
  size: number;
  age: number;
  tint: THREE.Color;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _n = new THREE.Vector3();
const _h = new THREE.Vector3();
const _c = new THREE.Color();
const WHITE = new THREE.Color(1, 1, 1);

/**
 * Glass shards: visual-only particles (one instanced draw call) that fly,
 * tumble and bounce on the analytic terrain, then shrink away. No physics
 * bodies, so a shattered windshield costs next to nothing. Unlit, with
 * per-shard colour from a fake sun glint, so they sparkle as they turn.
 */
export class Shards {
  private readonly mesh: THREE.InstancedMesh;
  private readonly shards: Shard[] = [];

  constructor(
    scene: THREE.Scene,
    private readonly field: TerrainField,
  ) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0.2, 0.3, 0, 0.9], 3));
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    this.mesh = new THREE.InstancedMesh(geometry, material, SHARDS.capacity);
    this.mesh.setColorAt(0, WHITE); // allocates instanceColor
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  /**
   * Bursts shards from `points` (world space), carried along with `velocity` and
   * thrown out along `outward` (unit vector away from the car body). `tint` defaults to window glass.
   */
  burst(points: readonly THREE.Vector3[], velocity: THREE.Vector3, outward: THREE.Vector3, tint = SHARDS.tint): void {
    const S = SHARDS;
    for (const p of points) {
      if (this.shards.length >= S.capacity) this.shards.shift();
      const v = velocity
        .clone()
        .addScaledVector(outward, S.eject * (0.5 + Math.random()))
        .add(new THREE.Vector3((Math.random() - 0.5) * S.scatter, Math.random() * S.scatter, (Math.random() - 0.5) * S.scatter));
      this.shards.push({
        position: p.clone(),
        velocity: v,
        rotation: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6)),
        spinAxis: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
        spin: 6 + Math.random() * 14,
        size: THREE.MathUtils.lerp(S.sizeMin, S.sizeMax, Math.random()),
        age: 0,
        tint,
      });
    }
  }

  /** @param eye camera position, for the sun glint */
  update(dt: number, eye: THREE.Vector3): void {
    const S = SHARDS;
    const drag = Math.exp(-S.drag * dt);
    let n = 0;
    for (let i = 0; i < this.shards.length; i++) {
      const s = this.shards[i];
      s.age += dt;
      if (s.age >= S.lifetime) continue;
      s.velocity.multiplyScalar(drag);
      s.velocity.y -= GRAVITY * dt;
      s.position.addScaledVector(s.velocity, dt);
      const ground = this.field.height(s.position.x, s.position.z) + 0.01;
      if (s.position.y < ground) {
        s.position.y = ground;
        s.velocity.set(s.velocity.x * 0.5, Math.abs(s.velocity.y) * 0.3, s.velocity.z * 0.5);
        s.spin *= 0.5;
      }
      s.rotation.multiply(_q.setFromAxisAngle(s.spinAxis, s.spin * dt));
      const fade = Math.min(1, (S.lifetime - s.age) / S.fadeTime);
      this.mesh.setMatrixAt(n, _m.compose(s.position, s.rotation, _s.setScalar(s.size * fade)));

      // Double-sided flat shard: light and glint use |n·x|.
      _n.set(0, 1, 0).applyQuaternion(s.rotation);
      _h.subVectors(eye, s.position).normalize().add(SUN_DIR).normalize();
      const lit = 0.6 + 0.4 * Math.abs(_n.dot(SUN_DIR));
      const glint = Math.abs(_n.dot(_h)) ** S.glintPower * S.glint;
      this.mesh.setColorAt(n, _c.copy(s.tint).multiplyScalar(lit).lerp(WHITE, Math.min(1, glint)));
      this.shards[n++] = s;
    }
    this.shards.length = n;
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }
}
