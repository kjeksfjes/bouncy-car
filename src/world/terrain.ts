import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { emptySample, type EnvGrid, type EnvSample } from './environment';
import { inspectColour, type InspectMode } from './inspect';
import { hash2 } from './noise';
import { PropScatter, type ChunkProps } from './props';
import type { TerrainField } from './terrainField';
import type { TreeLayout } from './trees';

export const CHUNK_SIZE = 64;
const CHUNK_RES = 32; // cells per side → 2 m grid
/** Chunks loaded in each direction around the car. Keep fog far below LOAD_RADIUS * CHUNK_SIZE. */
export const LOAD_RADIUS = 4;

/** A point the terrain must exist around, e.g. the player (full view) or an AI car (physics only). */
export interface StreamCenter {
  position: THREE.Vector3;
  /** In chunks. */
  radius: number;
}

interface Chunk {
  mesh: THREE.Mesh;
  body: RAPIER.RigidBody;
  props: ChunkProps;
}

/** Streams terrain chunks (render mesh + trimesh collider + props) around a moving point. */
export class Terrain {
  private readonly chunks = new Map<string, Chunk>();
  /** Loaded chunks whose look is out of date (the biomes changed under them), rebuilt in place. */
  private readonly stale = new Set<string>();
  private readonly material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.95,
  });
  private readonly props: PropScatter;
  private inspectMode: InspectMode | null = null;

  constructor(
    private readonly field: TerrainField,
    private readonly scene: THREE.Scene,
    private readonly world: RAPIER.World,
    trees: TreeLayout,
  ) {
    this.props = new PropScatter(trees, world);
  }

  /**
   * Keeps chunks loaded within `radius` chunks of each center: builds up to
   * `budget` missing ones (nearest to any center first) and unloads chunks
   * more than radius + 1 from every center.
   */
  update(centers: StreamCenter[], budget: number): void {
    const cells = centers.map((c) => ({
      cx: Math.floor(c.position.x / CHUNK_SIZE),
      cz: Math.floor(c.position.z / CHUNK_SIZE),
      radius: c.radius,
    }));

    const missing = new Map<string, [number, number, number]>();
    for (const c of cells) {
      for (let dz = -c.radius; dz <= c.radius; dz++) {
        for (let dx = -c.radius; dx <= c.radius; dx++) {
          const k = key(c.cx + dx, c.cz + dz);
          if (this.chunks.has(k)) continue;
          const dist = dx * dx + dz * dz;
          const prev = missing.get(k);
          if (!prev || dist < prev[2]) missing.set(k, [c.cx + dx, c.cz + dz, dist]);
        }
      }
    }
    const queue = [...missing.values()].sort((a, b) => a[2] - b[2]);
    for (const [cx, cz] of queue.slice(0, budget)) this.chunks.set(key(cx, cz), this.build(cx, cz));
    // Stale chunks, nearest the first center first: the new one is built before the old goes, so
    // there's never a hole in the ground.
    const near = cells[0];
    const order = [...this.stale].sort((a, b) => chunkDistance(a, near) - chunkDistance(b, near));
    let rebuilds = budget;
    for (const k of order) {
      if (rebuilds-- <= 0) break;
      this.stale.delete(k);
      const old = this.chunks.get(k);
      if (!old) continue;
      const [cx, cz] = k.split(',').map(Number);
      this.chunks.set(k, this.build(cx, cz));
      this.dispose(old);
    }

    for (const [k, chunk] of this.chunks) {
      const [cx, cz] = k.split(',').map(Number);
      const keep = cells.some((c) => Math.max(Math.abs(cx - c.cx), Math.abs(cz - c.cz)) <= c.radius + 1);
      if (!keep) {
        this.dispose(chunk);
        this.chunks.delete(k);
        this.stale.delete(k);
      }
    }
  }

  /** Marks every loaded chunk reaching downhill of `z` for rebuilding (its colours and trees changed). */
  refreshBeyond(z: number): void {
    for (const k of this.chunks.keys()) {
      const cz = Number(k.split(',')[1]);
      if (cz * CHUNK_SIZE < z) this.stale.add(k);
    }
  }

  /** Dev: colours the ground by what shapes it (see InspectMode), or by its cover again with null. */
  set inspect(mode: InspectMode | null) {
    this.inspectMode = mode;
    for (const k of this.chunks.keys()) this.stale.add(k);
  }

  /** Whether ground (with colliders) currently exists at (x, z). */
  isLoadedAt(x: number, z: number): boolean {
    return this.chunks.has(key(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)));
  }

  private build(cx: number, cz: number): Chunk {
    const n = CHUNK_RES + 1;
    const step = CHUNK_SIZE / CHUNK_RES;
    const x0 = cx * CHUNK_SIZE;
    const z0 = cz * CHUNK_SIZE;

    // Heights and the ground's environment in one pass (see Environment.grid).
    const env = this.field.environment.grid(x0, z0, n, step);
    const verts = new Float32Array(n * n * 3);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const o = (j * n + i) * 3;
        verts[o] = x0 + i * step;
        verts[o + 1] = env.heights[j * n + i];
        verts[o + 2] = z0 + j * step;
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

      faceEnvironment(env, indices[f], indices[f + 1], indices[f + 2], _env);
      if (this.inspectMode) {
        inspectColour(this.field, this.inspectMode, va, vb, vc, normal, _env, col);
      } else {
        // Coloured by the ground at the face's middle (snow, thaw patches, grass, rock).
        this.field.biome.colour((va.x + vb.x + vc.x) / 3, (va.z + vb.z + vc.z) / 3, normal, _env, col);
        const jitter = 1 + (hash2(f, cx * 7919 + cz, this.field.seed + 7) - 0.5) * 0.06;
        col.multiplyScalar(jitter);
      }

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

const _env = emptySample();

/** A face's environment: the average of its three corners'. */
function faceEnvironment(env: EnvGrid, a: number, b: number, c: number, out: EnvSample): EnvSample {
  out.slope = (env.slope[a] + env.slope[b] + env.slope[c]) / 3;
  out.curvature = (env.curvature[a] + env.curvature[b] + env.curvature[c]) / 3;
  out.moisture = (env.moisture[a] + env.moisture[b] + env.moisture[c]) / 3;
  out.exposure = (env.exposure[a] + env.exposure[b] + env.exposure[c]) / 3;
  out.elevation = (env.elevation[a] + env.elevation[b] + env.elevation[c]) / 3;
  out.cliff = (env.cliff[a] + env.cliff[b] + env.cliff[c]) / 3;
  return out;
}

/** Chessboard distance (in chunks) from a chunk key to a cell, or 0 without one. */
function chunkDistance(k: string, cell: { cx: number; cz: number } | undefined): number {
  if (!cell) return 0;
  const [cx, cz] = k.split(',').map(Number);
  return Math.max(Math.abs(cx - cell.cx), Math.abs(cz - cell.cz));
}

function key(cx: number, cz: number): string {
  return `${cx},${cz}`;
}
