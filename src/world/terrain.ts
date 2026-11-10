import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { emptySample, type EnvGrid, type EnvSample } from './environment';
import { inspectColour, type InspectMode } from './inspect';
import { hash2 } from './noise';
import { DetailScatter, type Rock, type RockLayout, type RockShape } from './details';
import { IMPRINT, Imprints, type BedGround, type Imprint } from './imprints';
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
  /** Boulders, shrubs and grass on the chunks (and the bedded boulders' colliders). */
  readonly details: DetailScatter;
  private inspectMode: InspectMode | null = null;
  /** Hollows left by boulders knocked loose, pressed into the ground of every chunk they reach. */
  private readonly imprints = new Imprints();

  constructor(
    private readonly field: TerrainField,
    private readonly scene: THREE.Scene,
    private readonly world: RAPIER.World,
    trees: TreeLayout,
    rocks: RockLayout,
  ) {
    this.props = new PropScatter(trees, world);
    this.details = new DetailScatter(field, trees, rocks, world);
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

  /**
   * Presses the hollow a boulder leaves into the ground where it lay bedded (looks and collider),
   * rebuilding the loaded chunks it reaches right away (≈7 ms each), so the loose boulder never
   * meets the old ground. Their bedded boulders get new colliders: call it between physics steps,
   * never while holding one of them.
   */
  imprint(rock: Rock, shape: RockShape, ground: BedGround): void {
    const m = this.imprints.add(rock, shape, ground);
    for (let cz = Math.floor((rock.z - m.reach) / CHUNK_SIZE); cz <= Math.floor((rock.z + m.reach) / CHUNK_SIZE); cz++) {
      for (let cx = Math.floor((rock.x - m.reach) / CHUNK_SIZE); cx <= Math.floor((rock.x + m.reach) / CHUNK_SIZE); cx++) {
        const k = key(cx, cz);
        const old = this.chunks.get(k);
        if (!old) continue;
        this.chunks.set(k, this.build(cx, cz));
        this.dispose(old);
        this.stale.delete(k);
      }
    }
  }

  /** The drawn ground's height at (x, z), imprints included (see meshHeight), for things laid on it. */
  surfaceHeight(x: number, z: number): number {
    const ground = meshHeight(this.field, x, z);
    let h = ground;
    for (const m of this.imprints.within(x, z, 0)) h += m.offset(x, z, ground);
    return h;
  }

  /** The chunk's grid cells (by j × CHUNK_RES + i) that imprints reach into, with those imprints. */
  private imprintCells(x0: number, z0: number, step: number): Map<number, Imprint[]> {
    const cells = new Map<number, Imprint[]>();
    for (const m of this.imprints.within(x0, z0, CHUNK_SIZE)) {
      const { x, z } = m.rock;
      const i0 = Math.max(0, Math.floor((x - m.reach - x0) / step));
      const i1 = Math.min(CHUNK_RES - 1, Math.floor((x + m.reach - x0) / step));
      const j0 = Math.max(0, Math.floor((z - m.reach - z0) / step));
      const j1 = Math.min(CHUNK_RES - 1, Math.floor((z + m.reach - z0) / step));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const list = cells.get(j * CHUNK_RES + i);
          if (list) list.push(m);
          else cells.set(j * CHUNK_RES + i, [m]);
        }
      }
    }
    return cells;
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
    // Cells a boulder's imprint reaches into are split finer (see addImprintCell); every face
    // remembers the grid triangle it lies in (`coarse`), which sets its colour.
    const cells = this.imprintCells(x0, z0, step);
    const points: number[] = Array.from(verts);
    const offsets: number[] = new Array(n * n).fill(0);
    const faces: number[] = [];
    const coarse: number[] = [];
    /** Finer faces in a cell with a hollow in rock. */
    const inRock = new Set<number>();
    /** The imprints over each finer face (by face index), for colouring it by its centre. */
    const faceImprints = new Map<number, readonly Imprint[]>();
    for (let j = 0; j < CHUNK_RES; j++) {
      for (let i = 0; i < CHUNK_RES; i++) {
        const a = j * n + i; // (x0, z0)
        const b = (j + 1) * n + i; // (x0, z1)
        const c = j * n + i + 1; // (x1, z0)
        const d = (j + 1) * n + i + 1; // (x1, z1)
        const t = (j * CHUNK_RES + i) * 2;
        // Random diagonal per cell breaks up the grid for a more organic low-poly look.
        // Both windings are counter-clockwise seen from above, so normals point up.
        const bc = diagonalBC(cx * CHUNK_RES + i, cz * CHUNK_RES + j, this.field.seed);
        const imprints = cells.get(j * CHUNK_RES + i);
        if (imprints) {
          const first = faces.length / 3;
          addImprintCell(imprints, bc, [a, b, c, d], t, x0 + i * step, z0 + j * step, step, env.heights, points, offsets, faces, coarse);
          // Hollows in rock stay rock-coloured (see IMPRINT.rockShade).
          if (imprints.some((m) => m.ground === 'rock')) for (let k = first; k < faces.length / 3; k++) inRock.add(k);
          for (let k = first; k < faces.length / 3; k++) faceImprints.set(k, imprints);
        } else if (bc) {
          faces.push(a, b, c, c, b, d);
          coarse.push(t, t + 1);
        } else {
          faces.push(a, b, d, a, d, c);
          coarse.push(t, t + 1);
        }
      }
    }
    const coarseCorners = (t: number): [number, number, number] => {
      const cell = t >> 1;
      const i = cell % CHUNK_RES;
      const j = (cell - i) / CHUNK_RES;
      const a = j * n + i;
      const b = (j + 1) * n + i;
      const c = a + 1;
      const d = b + 1;
      const first = (t & 1) === 0;
      return diagonalBC(cx * CHUNK_RES + i, cz * CHUNK_RES + j, this.field.seed) ? (first ? [a, b, c] : [c, b, d]) : first ? [a, b, d] : [a, d, c];
    };

    const indices = new Uint32Array(faces);
    const vertices = new Float32Array(points);
    const positions = new Float32Array(indices.length * 3);
    const colors = new Float32Array(indices.length * 3);
    const va = new THREE.Vector3();
    const vb = new THREE.Vector3();
    const vc = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const col = new THREE.Color();
    const ground = new THREE.Color();
    let groundOf = -1;
    for (let f = 0; f < indices.length; f += 3) {
      const t = coarse[f / 3];
      // The grid triangle's own look (its middle, its slope), shared by the finer faces inside it.
      if (t !== groundOf) {
        groundOf = t;
        // A face below the first finer vertex is a grid triangle itself.
        const own = indices[f] < n * n && indices[f + 1] < n * n && indices[f + 2] < n * n;
        const [ia, ib, ic] = own ? [indices[f], indices[f + 1], indices[f + 2]] : coarseCorners(t);
        va.fromArray(verts, ia * 3);
        vb.fromArray(verts, ib * 3);
        vc.fromArray(verts, ic * 3);
        normal.subVectors(vb, va).cross(vc.clone().sub(va)).normalize();
        faceEnvironment(env, ia, ib, ic, _env);
        if (this.inspectMode) {
          inspectColour(this.field, this.inspectMode, va, vb, vc, normal, _env, ground);
        } else {
          // Coloured by the ground at the face's middle (snow, thaw patches, grass, rock).
          this.field.biome.colour((va.x + vb.x + vc.x) / 3, (va.z + vb.z + vc.z) / 3, normal, _env, ground);
          const jitter = 1 + (hash2(t * 3, cx * 7919 + cz, this.field.seed + 7) - 0.5) * 0.06;
          ground.multiplyScalar(jitter);
        }
      }
      col.copy(ground);
      // Imprints: bare soil in the hollow (darker deeper), or darker rock in rock. A face is in the
      // hollow, and shaded, by the depth at its centre, measured against the boulder's shape (by its
      // corners' average instead, long faces with one corner inside the rim reached far out past it);
      // a face sloping down into it (any corner pushed down) is its wall, bare soil too.
      const over = faceImprints.get(f / 3);
      let moved = 0;
      let wall = false;
      if (over) {
        wall = Math.min(offsets[indices[f]], offsets[indices[f + 1]], offsets[indices[f + 2]]) < -0.01;
        const ia = indices[f] * 3, ib = indices[f + 1] * 3, ic = indices[f + 2] * 3;
        const x = (vertices[ia] + vertices[ib] + vertices[ic]) / 3;
        const z = (vertices[ia + 2] + vertices[ib + 2] + vertices[ic + 2]) / 3;
        // The ground there before the imprint: the corners' heights less how far they were moved.
        const before = (vertices[ia + 1] + vertices[ib + 1] + vertices[ic + 1] - offsets[indices[f]] - offsets[indices[f + 1]] - offsets[indices[f + 2]]) / 3;
        for (const m of over) moved += m.offset(x, z, before);
      }
      if ((moved < -0.01 || wall) && inRock.has(f / 3)) {
        col.multiplyScalar(IMPRINT.rockShade + (IMPRINT.rockDeep - IMPRINT.rockShade) * Math.min(1, -moved / 0.25));
      } else if (moved < -0.01 || wall) {
        col.copy(IMPRINT.soil).lerp(IMPRINT.soilDark, Math.min(1, -moved / 0.25));
      }

      va.fromArray(vertices, indices[f] * 3);
      vb.fromArray(vertices, indices[f + 1] * 3);
      vc.fromArray(vertices, indices[f + 2] * 3);
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
      RAPIER.ColliderDesc.trimesh(vertices, indices, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES).setFriction(0.6),
      body,
    );

    const trees = this.props.populate(x0, z0, CHUNK_SIZE, body);
    const details = this.details.populate(x0, z0, CHUNK_SIZE, step, env, body);
    const props: ChunkProps = {
      objects: [...trees.objects, ...details.objects],
      dispose: () => {
        trees.dispose();
        details.dispose();
      },
    };
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
  out.knoll = (env.knoll[a] + env.knoll[b] + env.knoll[c]) / 3;
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

/** Whether the mesh cell at grid (gi, gj) is split from (x0, z1) to (x1, z0), else from (x0, z0) to (x1, z1). */
function diagonalBC(gi: number, gj: number, seed: number): boolean {
  return hash2(gi, gj, seed) < 0.5;
}

/**
 * The height of the drawn ground mesh at (x, z): the terrain's triangles between the 2 m grid
 * points, with the same diagonals as Terrain.build, rather than the analytic height in between.
 * For things laid flat on the ground that mustn't sink into a face or float over it.
 */
export function meshHeight(field: TerrainField, x: number, z: number): number {
  const step = CHUNK_SIZE / CHUNK_RES;
  const gi = Math.floor(x / step);
  const gj = Math.floor(z / step);
  const tx = x / step - gi;
  const tz = z / step - gj;
  const a = field.height(gi * step, gj * step);
  const b = field.height(gi * step, (gj + 1) * step);
  const c = field.height((gi + 1) * step, gj * step);
  const d = field.height((gi + 1) * step, (gj + 1) * step);
  return planeHeight(diagonalBC(gi, gj, field.seed), a, b, c, d, tx, tz);
}

/**
 * Height inside one grid cell at (tx, tz) (0..1 across it) on its two triangles, from its corner
 * heights a (x0, z0), b (x0, z1), c (x1, z0), d (x1, z1), split from b to c if `bc`, else a to d.
 */
function planeHeight(bc: boolean, a: number, b: number, c: number, d: number, tx: number, tz: number): number {
  if (bc) return tx + tz <= 1 ? a + (c - a) * tx + (b - a) * tz : d + (b - d) * (1 - tx) + (c - d) * (1 - tz);
  return tz >= tx ? a + (d - b) * tx + (b - a) * tz : a + (c - a) * tx + (d - c) * tz;
}

/**
 * One grid cell rebuilt finer (IMPRINT.subdivisions per side) with the imprints pressed into it.
 * The finer faces split the same way as the cell, so away from the imprints they lie exactly on
 * its two triangles, and its edges stay on the neighbours' (the imprints don't reach them: see
 * Terrain.imprintCells). Appends the vertices to `points` (with how far each was moved to
 * `offsets`), the faces to `faces`, and for each face the grid triangle it lies in (t or t + 1)
 * to `coarse`.
 */
function addImprintCell(
  imprints: readonly Imprint[],
  bc: boolean,
  [a, b, c, d]: readonly [number, number, number, number],
  t: number,
  cellX: number,
  cellZ: number,
  step: number,
  heights: Float32Array,
  points: number[],
  offsets: number[],
  faces: number[],
  coarse: number[],
): void {
  const N = IMPRINT.subdivisions;
  const base = points.length / 3;
  for (let sj = 0; sj <= N; sj++) {
    for (let si = 0; si <= N; si++) {
      const x = cellX + (si / N) * step;
      const z = cellZ + (sj / N) * step;
      const ground = planeHeight(bc, heights[a], heights[b], heights[c], heights[d], si / N, sj / N);
      let moved = 0;
      for (const m of imprints) moved += m.offset(x, z, ground);
      points.push(x, ground + moved, z);
      offsets.push(moved);
    }
  }
  const at = (si: number, sj: number) => base + sj * (N + 1) + si;
  // Which of the cell's triangles a finer face lies in, from its middle (tx, tz in sub-cells, × 3).
  const side = (tx3: number, tz3: number) => {
    const tx = tx3 / (3 * N);
    const tz = tz3 / (3 * N);
    return (bc ? tx + tz <= 1 : tz >= tx) ? t : t + 1;
  };
  for (let sj = 0; sj < N; sj++) {
    for (let si = 0; si < N; si++) {
      const A = at(si, sj);
      const B = at(si, sj + 1);
      const C = at(si + 1, sj);
      const D = at(si + 1, sj + 1);
      if (bc) {
        faces.push(A, B, C, C, B, D);
        coarse.push(side(3 * si + 1, 3 * sj + 1), side(3 * si + 2, 3 * sj + 2));
      } else {
        faces.push(A, B, D, A, D, C);
        coarse.push(side(3 * si + 1, 3 * sj + 2), side(3 * si + 2, 3 * sj + 1));
      }
    }
  }
}
