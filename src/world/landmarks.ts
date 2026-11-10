import * as THREE from 'three';
import { ROCK_SHAPES, UNIT_HEIGHT, type Rock } from './details';
import type { EnvSample } from './environment';
import { hash2 } from './noise';
import type { TerrainField } from './terrainField';
import { OAK, type Tree } from './trees';

/**
 * Landmarks: features to steer by, standing where they're seen. Vardes (cairns of stacked stones)
 * on the tops of cliffs and knolls, and now and then a great old oak alone on a rise in the
 * grassland. Each kind has its own grid of candidate cells, with at most one per cell, at the best
 * of a few spots near the cell's middle. Feel values.
 */
export const LANDMARKS = {
  /**
   * Spots tried per cell, up to `spread` × cell from its middle, so a landmark and what it keeps
   * clear stay well inside its cell (lookups only search the cells around a spot).
   */
  spread: 0.3,
  /** Prominence is measured against the smooth ground this far (m) around (see lieOfLand). */
  ring: 40,
  /** Kept clear of the spawn (m from the origin) and of set pieces (m). */
  spawnClear: 250,
  featureClear: 60,
  /** Never on a valley floor (the open lane down it, see EnvSample.floor). */
  floorBelow: 0.2,
  /**
   * Vardes: on a cliff top, ground level enough to stand on (under `maxSlope`) with the smooth
   * ground falling away at `dropFrom` (rise over run) or more within `dropRing` m on some side, or
   * on a knoll's crown; then moved up to the very top (`climbStep` m at a time, up to `climbSteps`).
   * `stones` stacked (min..max), the bottom one `baseRadius` m (min..max), each one up `shrink`
   * narrower; `flat` is a stone's height over its radius, `offset` how far (× its radius) it sits
   * off the one below. A few `footStones` lean round its foot.
   */
  varde: {
    cell: 200,
    samples: 32,
    chance: 0.9,
    maxSlope: 0.45,
    dropRing: 10,
    dropFrom: 0.45,
    /** A rocky knoll's crown (EnvSample.knoll past this) counts as a cliff top too: its downhill face drops away. */
    knollFrom: 0.85,
    climbStep: 2,
    climbSteps: 15,
    stones: [7, 10] as const,
    baseRadius: [0.45, 0.6] as const,
    shrink: 0.07,
    flat: 0.6,
    offset: 0.12,
    footStones: [2, 4] as const,
    /** Trees and boulders keep this far (m) off. How hard a knock brings one down: ROCKS.looseBreakout. */
    clear: 5,
  },
  /** Great oaks: on a rise in the grassland (past `grasslandFrom`, see Biome.grassland), on gentle, snow-free ground. */
  oak: {
    cell: 600,
    samples: 24,
    chance: 0.22,
    maxSlope: 0.3,
    grasslandFrom: 0.5,
    /** Trees and boulders keep this far (m) off: the crown's reach. */
    clear: 16,
  },
};

export type Varde = { kind: 'varde'; key: number; x: number; z: number; clear: number; radius: number; stones: Rock[] };
export type Oak = { kind: 'oak'; key: number; x: number; z: number; clear: number; tree: Tree };
export type Landmark = Oak | Varde;

/** A candidate spot and how well it suits. */
type Spot = { x: number; z: number; score: number; env: EnvSample };

/** Cache cap per kind; cleared when full (lookups are cheap to redo). */
const CACHE_LIMIT = 5000;
const UP = new THREE.Vector3(0, 1, 0);

/** Landmark cells of one kind: a grid, and what stands in each cell (cached). */
class Cells<T extends Landmark> {
  private readonly cache = new Map<number, T | null>();

  constructor(
    readonly size: number,
    private readonly place: (cellX: number, cellZ: number, key: number) => T | null,
  ) {}

  at(cellX: number, cellZ: number): T | null {
    const key = (cellX + 1048576) * 2097152 + (cellZ + 1048576);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const landmark = this.place(cellX, cellZ, key);
    if (this.cache.size >= CACHE_LIMIT) this.cache.clear();
    this.cache.set(key, landmark);
    return landmark;
  }

  /** The landmark whose clear area reaches within `margin` m of (x, z), if any. */
  near(x: number, z: number, margin: number): T | null {
    const cx = Math.floor(x / this.size);
    const cz = Math.floor(z / this.size);
    for (let j = cz - 1; j <= cz + 1; j++) {
      for (let i = cx - 1; i <= cx + 1; i++) {
        const l = this.at(i, j);
        if (l && Math.hypot(l.x - x, l.z - z) < l.clear + margin) return l;
      }
    }
    return null;
  }

  /** The landmarks standing in the square from (x0, z0), `size` m across. */
  within(x0: number, z0: number, size: number): T[] {
    const out: T[] = [];
    for (let j = Math.floor(z0 / this.size); j <= Math.floor((z0 + size) / this.size); j++) {
      for (let i = Math.floor(x0 / this.size); i <= Math.floor((x0 + size) / this.size); i++) {
        const l = this.at(i, j);
        if (l && l.x >= x0 && l.x < x0 + size && l.z >= z0 && l.z < z0 + size) out.push(l);
      }
    }
    return out;
  }

  clear(): void {
    this.cache.clear();
  }
}

/** Deterministic landmark placement: one source of truth for chunks (meshes, colliders), trees, boulders and the AI. */
export class LandmarkLayout {
  private readonly vardes = new Cells<Varde>(LANDMARKS.varde.cell, (x, z, key) => this.placeVarde(x, z, key));
  private readonly oaks = new Cells<Oak>(LANDMARKS.oak.cell, (x, z, key) => this.placeOak(x, z, key));
  /** Vardes knocked over: their stones are loose debris now, gone from their cells for good. */
  private readonly fallen = new Set<number>();

  constructor(private readonly field: TerrainField) {}

  /** The landmark whose clear area reaches within `margin` m of (x, z), if any (a fallen varde's spot stays clear). */
  near(x: number, z: number, margin = 0): Landmark | null {
    return this.oaks.near(x, z, margin) ?? this.vardes.near(x, z, margin);
  }

  /** Whether a standing varde comes within `clearance` of (x, z) (oaks are trees: see TreeLayout.blocking). */
  blocking(x: number, z: number, clearance: number): boolean {
    const l = this.vardes.near(x, z, clearance);
    return l !== null && !this.fallen.has(l.key) && Math.hypot(l.x - x, l.z - z) < l.radius + clearance;
  }

  /** The standing vardes in the square from (x0, z0), `size` m across. */
  vardesWithin(x0: number, z0: number, size: number): Varde[] {
    return this.vardes.within(x0, z0, size).filter((v) => !this.fallen.has(v.key));
  }

  /** The great oaks in the square from (x0, z0), `size` m across. */
  oaksWithin(x0: number, z0: number, size: number): Oak[] {
    return this.oaks.within(x0, z0, size);
  }

  /** Marks a varde as knocked over (its stones carry on as loose debris). */
  knockOver(varde: Varde): void {
    this.fallen.add(varde.key);
  }

  /** Forgets every cached landmark (after the biomes change: snow, grassland). Fallen vardes stay fallen. */
  invalidate(): void {
    this.vardes.clear();
    this.oaks.clear();
  }

  /** The cell's spots, each with its environment, that are fit for a landmark at all (see LANDMARKS). */
  private spots(cellX: number, cellZ: number, cell: number, samples: number, salt: number, fit: (env: EnvSample) => boolean): { x: number; z: number; env: EnvSample }[] {
    const L = LANDMARKS;
    const f = this.field;
    const seed = f.seed + salt;
    const out = [];
    for (let s = 0; s < samples; s++) {
      const x = (cellX + 0.5 + (hash2(cellX * 31 + s, cellZ, seed + 1) * 2 - 1) * L.spread) * cell;
      const z = (cellZ + 0.5 + (hash2(cellX * 31 + s, cellZ, seed + 2) * 2 - 1) * L.spread) * cell;
      if (Math.hypot(x, z) < L.spawnClear || !f.features.clearOf(z, L.featureClear)) continue;
      const env = f.environment.at(x, z);
      if (env.floor > L.floorBelow || env.cliff > 0 || !fit(env)) continue;
      out.push({ x, z, env });
    }
    return out;
  }

  private placeVarde(cellX: number, cellZ: number, key: number): Varde | null {
    const V = LANDMARKS.varde;
    const f = this.field;
    const r = (i: number) => hash2(cellX * 7 + i, cellZ, f.seed + 504);
    if (r(0) >= V.chance) return null;
    // The most prominent cliff top among the cell's spots...
    let best: Spot | null = null;
    for (const { x, z, env } of this.spots(cellX, cellZ, V.cell, V.samples, 501, (env) => env.slope < V.maxSlope)) {
      const { prominence, drop } = this.lieOfLand(x, z);
      if ((drop >= V.dropFrom || env.knoll >= V.knollFrom) && (!best || prominence > best.score)) best = { x, z, score: prominence, env };
    }
    if (!best) return null;
    // ...then up to the very top of it.
    let { x, z } = best;
    let h = f.landform(x, z);
    for (let step = 0; step < V.climbSteps; step++) {
      let up: [number, number, number] | null = null;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const nx = x + Math.cos(a) * V.climbStep;
        const nz = z + Math.sin(a) * V.climbStep;
        const nh = f.landform(nx, nz);
        if (nh > (up ? up[2] : h)) up = [nx, nz, nh];
      }
      if (!up) break;
      [x, z, h] = up;
    }
    return this.buildVarde(x, z, f.environment.at(x, z), key, r);
  }

  private placeOak(cellX: number, cellZ: number, key: number): Oak | null {
    const O = LANDMARKS.oak;
    const f = this.field;
    const r = (i: number) => hash2(cellX * 7 + i, cellZ, f.seed + 505);
    if (r(0) >= O.chance) return null;
    // The most prominent rise among the cell's spots on open, grassy ground.
    let best: Spot | null = null;
    for (const { x, z, env } of this.spots(cellX, cellZ, O.cell, O.samples, 502, (env) => env.slope < O.maxSlope)) {
      if (f.biome.grassland(z) < O.grasslandFrom || f.biome.isRock(x, z, env) || f.biome.snowCover(x, z, UP, env) >= 0.5) continue;
      const { prominence } = this.lieOfLand(x, z);
      if (!best || prominence > best.score) best = { x, z, score: prominence, env };
    }
    if (!best) return null;
    const { x, z } = best;
    const scale = OAK.scale[0] + (OAK.scale[1] - OAK.scale[0]) * r(2);
    const tree: Tree = { x, y: f.height(x, z) - 0.3, z, scale, yaw: r(3) * Math.PI * 2, species: 'broadleaf', snowy: false, radius: OAK.radius * scale, oak: true };
    return { kind: 'oak', key, x, z, clear: O.clear, tree };
  }

  /** A varde at (x, z): stones stacked into a tapering column, a few more leaning round its foot. */
  private buildVarde(x: number, z: number, env: EnvSample, key: number, r: (i: number) => number): Varde {
    const V = LANDMARKS.varde;
    const f = this.field;
    const snowy = f.biome.snowCover(x, z, UP, env) > 0.5;
    const base = V.baseRadius[0] + (V.baseRadius[1] - V.baseRadius[0]) * r(5);
    const count = V.stones[0] + Math.floor(r(6) * (V.stones[1] - V.stones[0] + 1));
    const stones: Rock[] = [];
    // Bedded a little below the lowest ground under its edge, like a boulder, so no side floats.
    let y = f.height(x, z);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) y = Math.min(y, f.height(x + dx * base, z + dz * base));
    const stone = (sx: number, sy: number, sz: number, at: { x: number; y: number; z: number }, i: number): Rock => ({
      cell: key,
      x: at.x,
      y: at.y,
      z: at.z,
      radius: Math.max(sx, sz),
      sx,
      sy,
      sz,
      yaw: r(30 + i) * Math.PI * 2,
      shape: Math.floor(r(40 + i) * ROCK_SHAPES),
      snowy,
    });
    let at = { x, y: y - 0.15 * V.flat * base * UNIT_HEIGHT, z };
    for (let i = 0; i < count; i++) {
      const rb = base * (1 - V.shrink * i) * (0.92 + 0.16 * r(10 + i));
      const sy = rb * V.flat;
      const stretch = 0.85 + 0.3 * r(20 + i);
      stones.push(stone(rb * stretch, sy, rb / stretch, at, i));
      // The next stone rests on this one's top, a little off its middle.
      const a = r(50 + i) * Math.PI * 2;
      at = { x: at.x + Math.cos(a) * rb * V.offset, y: at.y + sy * UNIT_HEIGHT * 0.95, z: at.z + Math.sin(a) * rb * V.offset };
    }
    const feet = V.footStones[0] + Math.floor(r(7) * (V.footStones[1] - V.footStones[0] + 1));
    for (let k = 0; k < feet; k++) {
      const a = ((k + r(60 + k) * 0.7) / feet) * Math.PI * 2;
      const rb = base * (0.6 + 0.25 * r(70 + k));
      const fx = x + Math.cos(a) * base * 1.25;
      const fz = z + Math.sin(a) * base * 1.25;
      stones.push(stone(rb, rb * V.flat * 1.2, rb, { x: fx, y: f.height(fx, fz) - 0.2 * rb * V.flat * UNIT_HEIGHT, z: fz }, 100 + k));
    }
    return { kind: 'varde', key, x, z, clear: V.clear, radius: base * 2.25, stones };
  }

  /**
   * How the smooth ground at (x, z) lies against its surroundings: how far (m) it stands above
   * them (LANDMARKS.ring m around: a crest or rise scores high), and the steepest fall (rise over
   * run) to any side within LANDMARKS.varde.dropRing m (a cliff top's).
   */
  private lieOfLand(x: number, z: number): { prominence: number; drop: number } {
    const R = LANDMARKS.ring;
    const D = LANDMARKS.varde.dropRing;
    const f = this.field;
    const h = f.landform(x, z);
    let around = 0;
    let drop = 0;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      around += f.landform(x + c * R, z + s * R);
      drop = Math.max(drop, (h - f.landform(x + c * D, z + s * D)) / D);
    }
    return { prominence: h - around / 8, drop };
  }
}
