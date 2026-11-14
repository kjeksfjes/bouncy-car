import * as THREE from 'three';
import { replaceOnce as patchOnce } from '../render/shaderPatch';
import { emptySample, faceEnvironment } from './environment';
import { hash2 } from './noise';
import { buildFarTrees, kindOf, type TreeKind } from './props';
import type { TerrainField } from './terrainField';
import { TREE_CELL, type Tree, type TreeLayout } from './trees';

/**
 * The far view: the ground beyond the streamed chunks, out to the fog's end, as coarse tiles (no
 * colliders, no props), coloured like the chunks. It sits `sink` m lower and is cut away wherever a
 * chunk is loaded (a mask of chunks round the player), so the detailed ground always covers it and
 * the step at the chunks' edge is too small to see from there. Feel values.
 */
const FAR = {
  /** Tile size (m, a whole number of chunks) and grid spacing (m, a multiple of the mesh grid's). */
  tile: 256,
  step: 8,
  /** Tiles are kept whose middle is within this far (m) of the player: past the fog's end at the corners. */
  radius: 1250,
  sink: 1.5,
  /**
   * The trees on a tile come from the tree layout itself (TreeLayout.peek), so they stand exactly
   * where the chunks will put the real ones: ≈9 µs a cell, ≈17 ms a tile, so worked through at most
   * `treeBudget` ms a frame, nearest tile first, checking the clock every `treeSlice` cells.
   */
  treeBudget: 2,
  treeSlice: 32,
};

/** Chunks round the player's chunk the mask covers, each way: the loaded radius plus the unload margin and one spare. */
const MASK_REACH = 7;
const MASK_SIZE = 2 * MASK_REACH + 1;

interface Tile {
  mesh: THREE.Mesh;
  /** Its trees, one instanced mesh per kind; null until worked out (see FAR.treeBudget). */
  trees: THREE.InstancedMesh[] | null;
  /** Rebuild pending: the biomes changed under it. */
  stale: boolean;
}

/** A tile's trees being worked out, a slice of cells a frame. */
interface TreeJob {
  key: string;
  tx: number;
  tz: number;
  /** The next cell to look at, counting row by row over the tile's cells. */
  next: number;
  found: Tree[];
}

const _env = emptySample();

/** Streams the far view's tiles round the player and keeps its chunk mask up to date. */
export class FarTerrain {
  private readonly tiles = new Map<string, Tile>();
  private readonly maskData = new Uint8Array(MASK_SIZE * MASK_SIZE);
  private readonly mask = new THREE.DataTexture(this.maskData, MASK_SIZE, MASK_SIZE, THREE.RedFormat);
  private readonly maskOrigin = new THREE.Vector2();
  private readonly material: THREE.MeshStandardMaterial;
  private readonly treeGeometries = buildFarTrees();
  private job: TreeJob | null = null;

  constructor(
    private readonly field: TerrainField,
    private readonly scene: THREE.Scene,
    private readonly trees: TreeLayout,
    /** Chunk size (m): the mask's cell. */
    private readonly chunk: number,
  ) {
    this.mask.magFilter = THREE.NearestFilter;
    this.mask.minFilter = THREE.NearestFilter;
    this.mask.needsUpdate = true;
    const uniforms = {
      farMask: { value: this.mask },
      farMaskOrigin: { value: this.maskOrigin },
      farMaskSize: { value: MASK_SIZE },
      farChunk: { value: chunk },
    };
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 });
    // Cut away wherever a chunk is loaded (see MASK_REACH): the chunks draw the ground there. A far
    // tree goes as a whole when the chunk its trunk stands in is loaded, as that chunk draws it then.
    // One material for both: three compiles the instanced (trees) and plain (ground) shaders apart.
    this.material.onBeforeCompile = (shader, renderer) => {
      // The haze's shared uniforms come through the prototype's hook (see installFogFade).
      THREE.Material.prototype.onBeforeCompile.call(this.material, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = replaceOnce(
        replaceOnce(shader.vertexShader, 'void main() {', 'varying vec2 vFarWorld;\nvoid main() {'),
        '#include <project_vertex>',
        [
          '#include <project_vertex>',
          '#ifdef USE_INSTANCING',
          '\tvFarWorld = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xz;',
          '#else',
          '\tvFarWorld = (modelMatrix * vec4(transformed, 1.0)).xz;',
          '#endif',
        ].join('\n'),
      );
      shader.fragmentShader = replaceOnce(
        shader.fragmentShader,
        'void main() {',
        [
          'varying vec2 vFarWorld;',
          'uniform sampler2D farMask;',
          'uniform vec2 farMaskOrigin;',
          'uniform float farMaskSize;',
          'uniform float farChunk;',
          'void main() {',
          '\tvec2 farCell = floor((vFarWorld - farMaskOrigin) / farChunk);',
          '\tif (all(greaterThanEqual(farCell, vec2(0.0))) && all(lessThan(farCell, vec2(farMaskSize))) && texture2D(farMask, (farCell + 0.5) / farMaskSize).r > 0.5) discard;',
        ].join('\n'),
      );
    };
  }

  /**
   * Keeps the tiles round `center` (the player) and the chunk mask current, and drops the tiles out
   * of range. In a frame that's otherwise `idle` (no chunks built), also builds the nearest missing
   * or stale tile and works on the nearest tile's trees (FAR.treeBudget).
   * @param loaded whether chunk (cx, cz) is loaded
   */
  update(center: { x: number; z: number }, loaded: (cx: number, cz: number) => boolean, idle: boolean): void {
    const F = FAR;
    const pcx = Math.floor(center.x / this.chunk);
    const pcz = Math.floor(center.z / this.chunk);
    this.maskOrigin.set((pcx - MASK_REACH) * this.chunk, (pcz - MASK_REACH) * this.chunk);
    let changed = false;
    for (let j = 0; j < MASK_SIZE; j++) {
      for (let i = 0; i < MASK_SIZE; i++) {
        const v = loaded(pcx - MASK_REACH + i, pcz - MASK_REACH + j) ? 255 : 0;
        if (this.maskData[j * MASK_SIZE + i] !== v) {
          this.maskData[j * MASK_SIZE + i] = v;
          changed = true;
        }
      }
    }
    if (changed) this.mask.needsUpdate = true;

    const wanted: [string, number, number, number][] = [];
    const reach = Math.ceil(F.radius / F.tile);
    const ptx = Math.floor(center.x / F.tile);
    const ptz = Math.floor(center.z / F.tile);
    for (let tz = ptz - reach; tz <= ptz + reach; tz++) {
      for (let tx = ptx - reach; tx <= ptx + reach; tx++) {
        const d = Math.hypot((tx + 0.5) * F.tile - center.x, (tz + 0.5) * F.tile - center.z);
        if (d <= F.radius) wanted.push([`${tx},${tz}`, tx, tz, d]);
      }
    }
    const keep = new Set(wanted.map((w) => w[0]));
    for (const [k, tile] of this.tiles) {
      if (keep.has(k)) continue;
      this.dispose(tile);
      this.tiles.delete(k);
    }
    // A tile wholly under loaded chunks is never seen: skip drawing it.
    const per = F.tile / this.chunk;
    for (const [k, tx, tz] of wanted) {
      const tile = this.tiles.get(k);
      if (!tile) continue;
      let covered = true;
      for (let j = 0; j < per && covered; j++) for (let i = 0; i < per && covered; i++) covered = loaded(tx * per + i, tz * per + j);
      tile.mesh.visible = !covered;
      for (const m of tile.trees ?? []) m.visible = !covered;
    }
    const todo = wanted.filter(([k]) => !this.tiles.has(k) || this.tiles.get(k)!.stale).sort((a, b) => a[3] - b[3]);
    for (const [k, tx, tz] of todo.slice(0, idle ? 1 : 0)) {
      const old = this.tiles.get(k);
      if (old) this.dispose(old);
      this.tiles.set(k, { mesh: this.build(tx, tz), trees: null, stale: false });
      if (this.job?.key === k) this.job = null;
    }
    if (idle) this.workOnTrees(wanted, F.treeBudget);
  }

  /** Works out trees for the nearest tile without them, for up to `ms` ms (see FAR.treeBudget). */
  private workOnTrees(wanted: [string, number, number, number][], ms: number): void {
    const F = FAR;
    if (this.job && !this.tiles.has(this.job.key)) this.job = null;
    if (!this.job) {
      const next = wanted.filter(([k]) => this.tiles.get(k)?.trees === null).sort((a, b) => a[3] - b[3])[0];
      if (!next) return;
      this.job = { key: next[0], tx: next[1], tz: next[2], next: 0, found: [] };
    }
    const job = this.job;
    const x0 = job.tx * F.tile;
    const z0 = job.tz * F.tile;
    // Cells don't align with tiles (256 / 6): scan one extra and keep the trees standing inside.
    const cx0 = Math.floor(x0 / TREE_CELL);
    const cz0 = Math.floor(z0 / TREE_CELL);
    const across = Math.floor((x0 + F.tile) / TREE_CELL) - cx0 + 1;
    const total = across * (Math.floor((z0 + F.tile) / TREE_CELL) - cz0 + 1);
    const until = performance.now() + ms;
    while (job.next < total) {
      for (let k = 0; k < F.treeSlice && job.next < total; k++, job.next++) {
        const t = this.trees.peek(cx0 + (job.next % across), cz0 + Math.floor(job.next / across));
        if (t && t.x >= x0 && t.x < x0 + F.tile && t.z >= z0 && t.z < z0 + F.tile) job.found.push(t);
      }
      if (performance.now() > until) return;
    }
    this.job = null;
    const tile = this.tiles.get(job.key);
    if (tile) tile.trees = this.plant(job.found);
  }

  /** The far trees for a tile: one instanced mesh per kind, sunk with the far ground. */
  private plant(trees: Tree[]): THREE.InstancedMesh[] {
    const byKind = new Map<TreeKind, Tree[]>();
    for (const t of trees) {
      const kind = kindOf(t);
      const list = byKind.get(kind);
      if (list) list.push(t);
      else byKind.set(kind, [t]);
    }
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const m = new THREE.Matrix4();
    const up = new THREE.Vector3(0, 1, 0);
    const meshes: THREE.InstancedMesh[] = [];
    for (const [kind, list] of byKind) {
      const mesh = new THREE.InstancedMesh(this.treeGeometries[kind], this.material, list.length);
      list.forEach((t, i) => mesh.setMatrixAt(i, m.compose(p.set(t.x, t.y - FAR.sink, t.z), q.setFromAxisAngle(up, t.yaw), s.setScalar(t.scale))));
      mesh.computeBoundingSphere();
      this.scene.add(mesh);
      meshes.push(mesh);
    }
    return meshes;
  }

  /** Marks every tile reaching downhill of `z` for rebuilding (its colours changed: see Terrain.refreshBeyond). */
  refreshBeyond(z: number): void {
    for (const [k, tile] of this.tiles) if (Number(k.split(',')[1]) * FAR.tile < z) tile.stale = true;
  }

  private build(tx: number, tz: number): THREE.Mesh {
    const F = FAR;
    const n = F.tile / F.step + 1;
    const x0 = tx * F.tile;
    const z0 = tz * F.tile;
    const env = this.field.environment.grid(x0, z0, n, F.step);
    const cells = n - 1;
    const positions = new Float32Array(cells * cells * 18);
    const colors = new Float32Array(cells * cells * 18);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const col = new THREE.Color();
    let o = 0;
    const corner = (i: number, j: number, v: THREE.Vector3) => v.set(x0 + i * F.step, env.heights[j * n + i] - F.sink, z0 + j * F.step);
    const face = (ia: number, ja: number, ib: number, jb: number, ic: number, jc: number) => {
      corner(ia, ja, a);
      corner(ib, jb, b);
      corner(ic, jc, c);
      normal.subVectors(b, a).cross(c.clone().sub(a)).normalize();
      faceEnvironment(env, ja * n + ia, jb * n + ib, jc * n + ic, _env);
      this.field.biome.colour((a.x + b.x + c.x) / 3, (a.z + b.z + c.z) / 3, normal, _env, col);
      for (const v of [a, b, c]) {
        v.toArray(positions, o);
        col.toArray(colors, o);
        o += 3;
      }
    };
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        // A random diagonal per cell, like the chunks', so the grid doesn't show; both wind
        // counter-clockwise seen from above.
        if (hash2(tx * cells + i, tz * cells + j, this.field.seed + 3) < 0.5) {
          face(i, j, i, j + 1, i + 1, j);
          face(i + 1, j, i, j + 1, i + 1, j + 1);
        } else {
          face(i, j, i, j + 1, i + 1, j + 1);
          face(i, j, i + 1, j + 1, i + 1, j);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, this.material);
    this.scene.add(mesh);
    return mesh;
  }

  private dispose(tile: Tile): void {
    this.scene.remove(tile.mesh);
    tile.mesh.geometry.dispose();
    for (const m of tile.trees ?? []) {
      this.scene.remove(m);
      m.dispose();
    }
  }
}


function replaceOnce(source: string, find: string, replace: string): string {
  return patchOnce(source, find, replace, 'Far terrain');
}
