import * as THREE from 'three';
import { GRAVITY } from '../constants';
import type { TerrainField } from './terrainField';

const CAPACITY = 400;
const LIFETIME = 6;
/** The last part of a shard's life is spent shrinking away. */
const FADE_TIME = 1;

interface Shard {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  rotation: THREE.Quaternion;
  spinAxis: THREE.Vector3;
  spin: number;
  size: number;
  age: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

/**
 * Glass shards: visual-only particles (one instanced draw call) that fly,
 * tumble and bounce on the analytic terrain, then shrink away. No physics
 * bodies, so a shattered windshield costs next to nothing.
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
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({
      color: '#d3e6f2',
      roughness: 0.05,
      metalness: 0.7,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, CAPACITY);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  /** Bursts shards from `points` (world space), carried along with `velocity`. */
  burst(points: readonly THREE.Vector3[], velocity: THREE.Vector3): void {
    for (const p of points) {
      if (this.shards.length >= CAPACITY) this.shards.shift();
      this.shards.push({
        position: p.clone(),
        velocity: velocity.clone().add(new THREE.Vector3((Math.random() - 0.5) * 4, Math.random() * 3, (Math.random() - 0.5) * 4)),
        rotation: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6)),
        spinAxis: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
        spin: 6 + Math.random() * 14,
        size: 0.03 + Math.random() * 0.06,
        age: 0,
      });
    }
  }

  update(dt: number): void {
    let n = 0;
    for (let i = 0; i < this.shards.length; i++) {
      const s = this.shards[i];
      s.age += dt;
      if (s.age >= LIFETIME) continue;
      s.velocity.y -= GRAVITY * dt;
      s.position.addScaledVector(s.velocity, dt);
      const ground = this.field.height(s.position.x, s.position.z) + 0.01;
      if (s.position.y < ground) {
        s.position.y = ground;
        s.velocity.set(s.velocity.x * 0.5, Math.abs(s.velocity.y) * 0.3, s.velocity.z * 0.5);
        s.spin *= 0.5;
      }
      s.rotation.multiply(_q.setFromAxisAngle(s.spinAxis, s.spin * dt));
      const fade = Math.min(1, (LIFETIME - s.age) / FADE_TIME);
      this.mesh.setMatrixAt(n, _m.compose(s.position, s.rotation, _s.setScalar(s.size * fade)));
      this.shards[n++] = s;
    }
    this.shards.length = n;
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
