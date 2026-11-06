import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { hash2, smoothstep } from './noise';
import { PropScatter, type ChunkProps } from './props';
import type { TerrainField } from './terrainField';

export const CHUNK_SIZE = 64;
const CHUNK_RES = 32; // cells per side → 2 m grid
/** Chunks loaded in each direction around the car. Keep fog far below LOAD_RADIUS * CHUNK_SIZE. */
export const LOAD_RADIUS = 4;

const SNOW = new THREE.Color('#eef3f9');
const SNOW_SHADE = new THREE.Color('#dde6f0');
const ROCK = new THREE.Color('#646872');

interface Chunk {
  mesh: THREE.Mesh;
  body: RAPIER.RigidBody;
  props: ChunkProps;
}

/** Streams terrain chunks (render mesh + trimesh collider + props) around a moving point. */
export class Terrain {
  private readonly chunks = new Map<string, Chunk>();
  private readonly material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.95,
  });
  private readonly props: PropScatter;

  constructor(
    private readonly field: TerrainField,
    private readonly scene: THREE.Scene,
    private readonly world: RAPIER.World,
  ) {
    this.props = new PropScatter(field, world);
  }

  /** Builds up to `budget` missing chunks (nearest first) and unloads distant ones. */
  update(center: THREE.Vector3, budget: number): void {
    const ccx = Math.floor(center.x / CHUNK_SIZE);
    const ccz = Math.floor(center.z / CHUNK_SIZE);

    const missing: [number, number, number][] = [];
    for (let dz = -LOAD_RADIUS; dz <= LOAD_RADIUS; dz++) {
      for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) {
        if (!this.chunks.has(key(ccx + dx, ccz + dz))) missing.push([ccx + dx, ccz + dz, dx * dx + dz * dz]);
      }
    }
    missing.sort((a, b) => a[2] - b[2]);
    for (const [cx, cz] of missing.slice(0, budget)) this.chunks.set(key(cx, cz), this.build(cx, cz));

    for (const [k, chunk] of this.chunks) {
      const [cx, cz] = k.split(',').map(Number);
      if (Math.max(Math.abs(cx - ccx), Math.abs(cz - ccz)) > LOAD_RADIUS + 1) {
        this.dispose(chunk);
        this.chunks.delete(k);
      }
    }
  }

  private build(cx: number, cz: number): Chunk {
    const n = CHUNK_RES + 1;
    const step = CHUNK_SIZE / CHUNK_RES;
    const x0 = cx * CHUNK_SIZE;
    const z0 = cz * CHUNK_SIZE;

    const verts = new Float32Array(n * n * 3);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = x0 + i * step;
        const z = z0 + j * step;
        const o = (j * n + i) * 3;
        verts[o] = x;
        verts[o + 1] = this.field.height(x, z);
        verts[o + 2] = z;
      }
    }

    // Same triangulation for physics (indexed) and render (non-indexed, one colour per face).
    const indices = new Uint32Array(CHUNK_RES * CHUNK_RES * 6);
    let t = 0;
    for (let j = 0; j < CHUNK_RES; j++) {
      for (let i = 0; i < CHUNK_RES; i++) {
        const a = j * n + i; // (x0, z0)
        const b = (j + 1) * n + i; // (x0, z1)
        const c = j * n + i + 1; // (x1, z0)
        const d = (j + 1) * n + i + 1; // (x1, z1)
        // Random diagonal per cell breaks up the grid for a more organic low-poly look.
        // Both windings are counter-clockwise seen from above, so normals point up.
        if (hash2(cx * CHUNK_RES + i, cz * CHUNK_RES + j, this.field.seed) < 0.5) {
          indices.set([a, b, c, c, b, d], t);
        } else {
          indices.set([a, b, d, a, d, c], t);
        }
        t += 6;
      }
    }

    const positions = new Float32Array(indices.length * 3);
    const colors = new Float32Array(indices.length * 3);
    const va = new THREE.Vector3();
    const vb = new THREE.Vector3();
    const vc = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const col = new THREE.Color();
    for (let f = 0; f < indices.length; f += 3) {
      va.fromArray(verts, indices[f] * 3);
      vb.fromArray(verts, indices[f + 1] * 3);
      vc.fromArray(verts, indices[f + 2] * 3);
      normal.subVectors(vb, va).cross(vc.clone().sub(va)).normalize();

      const snowiness = smoothstep(0.66, 0.8, normal.y);
      col.copy(SNOW_SHADE).lerp(SNOW, smoothstep(0.85, 0.97, normal.y));
      col.lerp(ROCK, 1 - snowiness);
      const jitter = 1 + (hash2(f, cx * 7919 + cz, this.field.seed + 7) - 0.5) * 0.06;
      col.multiplyScalar(jitter);

      va.toArray(positions, f * 3);
      vb.toArray(positions, f * 3 + 3);
      vc.toArray(positions, f * 3 + 6);
      for (let k = 0; k < 3; k++) col.toArray(colors, (f + k) * 3);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);

    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.world.createCollider(
      RAPIER.ColliderDesc.trimesh(verts, indices, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES).setFriction(0.6),
      body,
    );

    const props = this.props.populate(x0, z0, CHUNK_SIZE, body);
    props.objects.forEach((o) => this.scene.add(o));

    return { mesh, body, props };
  }

  private dispose(chunk: Chunk): void {
    this.scene.remove(chunk.mesh);
    chunk.mesh.geometry.dispose();
    chunk.props.objects.forEach((o) => this.scene.remove(o));
    chunk.props.dispose();
    this.world.removeRigidBody(chunk.body);
  }
}

function key(cx: number, cz: number): string {
  return `${cx},${cz}`;
}
