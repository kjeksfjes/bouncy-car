import * as THREE from 'three';
import { SUN_DIR } from '../render/stage';
import { emptySample, faceEnvironment } from './environment';
import { inspectColour, type InspectMode } from './inspect';
import type { TerrainField } from './terrainField';
import { ROCKS, type RockLayout } from './details';
import { TREE_CELL, type TreeLayout } from './trees';

/**
 * Dev 2D map: `size` px square at `step` m a pixel (a multiple of the 2 m mesh grid), built `tile`
 * px square at a time. Hill shading lights it from the game's sun (from the top right, as it
 * lies on the map), by `shade` at most, so the relief reads and the shade falls where it does in the game.
 */
export const TERRAIN_MAP = { size: 512, step: 8, tile: 32, light: SUN_DIR, shade: 0.45 };

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _colour = new THREE.Color();
const _rgb = { r: 0, g: 0, b: 0 };
const _env = emptySample();

/**
 * A top-down map of the ground round a centre, downhill (−z) up, coloured the way the terrain
 * chunks colour their faces (by an inspection view, or by ground cover with null), from the same
 * functions, sampled coarser. Built a tile per `build` call, from the middle out.
 */
export class TerrainMap {
  readonly image: ImageData;
  /** The map's top left corner (m): pixel (0, 0). */
  readonly x0: number;
  readonly z0: number;
  /** Tiles left to build, nearest the middle first. */
  private readonly todo: [number, number][] = [];
  private readonly tiles: number;

  constructor(
    private readonly field: TerrainField,
    centre: { x: number; z: number },
    readonly mode: InspectMode | null,
  ) {
    const M = TERRAIN_MAP;
    const half = (M.size * M.step) / 2;
    // On the mesh grid, as Environment.grid needs.
    this.x0 = Math.round((centre.x - half) / M.step) * M.step;
    this.z0 = Math.round((centre.z - half) / M.step) * M.step;
    this.image = new ImageData(M.size, M.size);
    const per = M.size / M.tile;
    for (let ty = 0; ty < per; ty++) for (let tx = 0; tx < per; tx++) this.todo.push([tx, ty]);
    const mid = (per - 1) / 2;
    this.todo.sort((p, q) => Math.hypot(q[0] - mid, q[1] - mid) - Math.hypot(p[0] - mid, p[1] - mid));
    this.tiles = this.todo.length;
  }

  /** 0..1 of the map built. */
  get progress(): number {
    return 1 - this.todo.length / this.tiles;
  }

  /** Builds the next tile; returns its corner (px), or null once the map is done. */
  build(): { x: number; y: number } | null {
    const next = this.todo.pop();
    if (!next) return null;
    const M = TERRAIN_MAP;
    const px = next[0] * M.tile;
    const py = next[1] * M.tile;
    // One node more each way, for each pixel's face to reach its right and lower neighbours.
    const n = M.tile + 1;
    const grid = this.field.environment.grid(this.x0 + px * M.step, this.z0 + py * M.step, n, M.step);
    const node = (i: number, j: number, out: THREE.Vector3) => {
      const o = j * n + i;
      return out.set(grid.x0 + i * M.step, grid.heights[o], grid.z0 + j * M.step);
    };
    const data = this.image.data;
    for (let j = 0; j < M.tile; j++) {
      for (let i = 0; i < M.tile; i++) {
        // The pixel as one face, its corners wound like the chunks' (normal up).
        node(i, j, _a);
        node(i, j + 1, _b);
        node(i + 1, j, _c);
        _n.subVectors(_b, _a).cross(_c.clone().sub(_a)).normalize();
        faceEnvironment(grid, j * n + i, (j + 1) * n + i, j * n + i + 1, _env);
        if (this.mode) inspectColour(this.field, this.mode, _a, _b, _c, _n, _env, _colour);
        else this.field.biome.colour((_a.x + _b.x + _c.x) / 3, (_a.z + _b.z + _c.z) / 3, _n, _env, _colour);
        _colour.multiplyScalar(1 - M.shade + M.shade * Math.max(0, _n.dot(M.light)) / M.light.y);
        _colour.getRGB(_rgb, THREE.SRGBColorSpace);
        const o = ((py + j) * M.size + px + i) * 4;
        data[o] = _rgb.r * 255;
        data[o + 1] = _rgb.g * 255;
        data[o + 2] = _rgb.b * 255;
        data[o + 3] = 255;
      }
    }
    return { x: px, y: py };
  }
}

/** What MapObjects finds: a tree or a boulder at (x, z), `radius` m (the collider's: the trunk, or the boulder). */
export interface MapObject {
  kind: 'tree' | 'oak' | 'boulder';
  x: number;
  z: number;
  radius: number;
}

/**
 * Strips the trees are looked up in (m along z): a few ms each (a tree cell takes ≈10 µs, measured),
 * so a frame can take one without stalling.
 */
const TREE_STRIP = 64;

/**
 * The trees and boulders on a TerrainMap's ground (the same corner and size), from the layouts the
 * chunks build them from, a piece per `find` call, from the middle out. Apart from the ground, as
 * they don't change with the inspection view.
 */
export class MapObjects {
  private readonly todo: { kind: 'trees' | 'boulders'; x: number; z: number; w: number; h: number }[] = [];
  private readonly jobs: number;

  constructor(
    private readonly trees: TreeLayout,
    private readonly rocks: RockLayout,
    x0: number,
    z0: number,
  ) {
    const M = TERRAIN_MAP;
    const span = M.tile * M.step;
    const per = M.size / M.tile;
    const mid = (per - 1) / 2;
    const tiles: [number, number][] = [];
    for (let ty = 0; ty < per; ty++) for (let tx = 0; tx < per; tx++) tiles.push([tx, ty]);
    // Nearest the middle last, as jobs are taken from the end.
    tiles.sort((p, q) => Math.hypot(q[0] - mid, q[1] - mid) - Math.hypot(p[0] - mid, p[1] - mid));
    for (const [tx, ty] of tiles) {
      const x = x0 + tx * span;
      const z = z0 + ty * span;
      this.todo.push({ kind: 'boulders', x, z, w: span, h: span });
      for (let s = span - TREE_STRIP; s >= 0; s -= TREE_STRIP) this.todo.push({ kind: 'trees', x, z: z + s, w: span, h: TREE_STRIP });
    }
    this.jobs = this.todo.length;
  }

  /** 0..1 of the map looked through. */
  get progress(): number {
    return 1 - this.todo.length / this.jobs;
  }

  /** Looks through the next piece; returns what's in it, or null once all is found. */
  find(): MapObject[] | null {
    const job = this.todo.pop();
    if (!job) return null;
    const found: MapObject[] = [];
    // A cell belongs to the piece its corner lies in, so neighbouring pieces never share one.
    const cells = (from: number, length: number, cell: number) => [Math.ceil(from / cell), Math.ceil((from + length) / cell)];
    if (job.kind === 'trees') {
      const [cx0, cx1] = cells(job.x, job.w, TREE_CELL);
      const [cz0, cz1] = cells(job.z, job.h, TREE_CELL);
      for (let cz = cz0; cz < cz1; cz++) {
        for (let cx = cx0; cx < cx1; cx++) {
          const t = this.trees.peek(cx, cz);
          if (t) found.push({ kind: t.oak ? 'oak' : 'tree', x: t.x, z: t.z, radius: t.radius });
        }
      }
    } else {
      const [cx0, cx1] = cells(job.x, job.w, ROCKS.cell);
      const [cz0, cz1] = cells(job.z, job.h, ROCKS.cell);
      for (let cz = cz0; cz < cz1; cz++) {
        for (let cx = cx0; cx < cx1; cx++) {
          const r = this.rocks.peek(cx, cz);
          if (r) found.push({ kind: 'boulder', x: r.x, z: r.z, radius: r.radius });
        }
      }
    }
    return found;
  }
}
