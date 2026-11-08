import { smoothstep } from './noise';
import { emptySpot, type LandformSpot } from './landform';
import type { TerrainField } from './terrainField';

/**
 * What the ground is like at a spot, from the smooth landform (moguls, kicker ridges and set pieces
 * left out). Ground cover, trees and small details read these instead of their own noise, so they
 * follow the land. Pure functions of position, independent of the biomes.
 */
export interface EnvSample {
  /** Rise over run of the smooth ground. */
  slope: number;
  /** −1 (concave: valley floors' edges, gully grooves, hollows) .. 1 (convex: ridges, edges, ribs). */
  curvature: number;
  /** 0 (dry: ridge tops, convex edges) .. 1 (wet: valley floors, gully bottoms, hollows). */
  moisture: number;
  /** −1 (facing away from the sun) .. 1 (facing it), for the smooth ground. */
  exposure: number;
  /** 0 on a valley floor .. 1 on the ridge tops above it; 0.5 out on open slope. */
  elevation: number;
  /** How steeply a set piece's drop falls away here (rise over run, on top of the landform): 0 off the drop walls. */
  cliff: number;
}

/**
 * Feel values. Curvature and moisture are blends of shapes the landform already knows (where the
 * valleys, gullies and ledges are), not a water-flow simulation: cheap, exact, and in step with
 * the landforms by construction.
 */
const ENV = {
  /**
   * Curvature is measured over ± this many metres (a Laplacian), so it sees gullies, floor edges
   * and crests, not moguls. Keep it a multiple of the 2 m mesh grid (see grid).
   */
  reach: 4,
  /**
   * The Laplacian (m per m²) that counts as fully curved (measured: half the ground is under
   * ≈0.009 either way; the deepest gully grooves and floor edges pass 0.03).
   */
  curvatureFull: 0.03,
  /** Valleys shallower than this (m) don't count: open slope. */
  valleyFrom: 8,
  valleyTo: 25,
  moisture: {
    base: 0.4,
    /** Valley floors and the low flanks, fading out by `lowTo` up the flank. */
    floor: 0.45,
    lowTo: 0.5,
    /** Gully grooves, fully by `gullyFull` m deep. */
    gully: 0.25,
    gullyFull: 2,
    /** Concave ground gathers water, convex ground sheds it. */
    hollow: 0.25,
    edge: 0.25,
    /** Level ledges hold a little. */
    ledge: 0.1,
    /** Upper flanks and ridge tops dry out, from `ridgeFrom` up the flank. */
    ridge: 0.2,
    ridgeFrom: 0.7,
  },
};

/** The environment of a chunk's mesh grid, with the ground heights that go with it. */
export interface EnvGrid {
  /** Points per side; point (i, j) is at (x0 + i × step, z0 + j × step), row-major by j. */
  n: number;
  heights: Float32Array;
  slope: Float32Array;
  curvature: Float32Array;
  moisture: Float32Array;
  exposure: Float32Array;
  elevation: Float32Array;
  cliff: Float32Array;
}

export class Environment {
  private readonly spot: LandformSpot = emptySpot();

  constructor(
    private readonly field: TerrainField,
    /** Unit vector toward the sun. */
    private readonly sun: { x: number; y: number; z: number },
  ) {}

  /** The environment at one spot (5 landform samples: for trees and props, not whole chunks). */
  at(x: number, z: number, out: EnvSample = emptySample()): EnvSample {
    const r = ENV.reach;
    const f = this.field.landforms;
    const xm = f.height(x - r, z);
    const xp = f.height(x + r, z);
    const zm = f.height(x, z - r);
    const zp = f.height(x, z + r);
    const h = f.sample(x, z, this.spot);
    this.combine(this.spot, h, xm, xp, zm, zp, out);
    out.cliff = this.cliff(x, z);
    return out;
  }

  /**
   * The environment and ground heights for an n × n grid of points `step` m apart from (x0, z0):
   * one landform sample per point (plus a margin for curvature), so a chunk pays once for both.
   * Values match `at` and `TerrainField.height` at the same points.
   */
  grid(x0: number, z0: number, n: number, step: number): EnvGrid {
    const m = ENV.reach / step;
    if (!Number.isInteger(m)) throw new Error(`Environment reach ${ENV.reach} m is not a multiple of the grid step ${step} m`);
    const w = n + 2 * m;
    const land = new Float64Array(w * w);
    const spots: LandformSpot[] = new Array(n * n);
    const f = this.field.landforms;
    for (let j = 0; j < w; j++) {
      for (let i = 0; i < w; i++) {
        const x = x0 + (i - m) * step;
        const z = z0 + (j - m) * step;
        const inside = i >= m && i < m + n && j >= m && j < m + n;
        if (inside) {
          const spot = emptySpot();
          land[j * w + i] = f.sample(x, z, spot);
          spots[(j - m) * n + (i - m)] = spot;
        } else {
          land[j * w + i] = f.height(x, z);
        }
      }
    }
    const size = n * n;
    const grid: EnvGrid = {
      n,
      heights: new Float32Array(size),
      slope: new Float32Array(size),
      curvature: new Float32Array(size),
      moisture: new Float32Array(size),
      exposure: new Float32Array(size),
      elevation: new Float32Array(size),
      cliff: new Float32Array(size),
    };
    const s = emptySample();
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = (j + m) * w + (i + m);
        const o = j * n + i;
        const h = land[k];
        this.combine(spots[o], h, land[k - m], land[k + m], land[k - m * w], land[k + m * w], s);
        grid.heights[o] = this.field.heightOver(x0 + i * step, z0 + j * step, h);
        grid.slope[o] = s.slope;
        grid.curvature[o] = s.curvature;
        grid.moisture[o] = s.moisture;
        grid.exposure[o] = s.exposure;
        grid.elevation[o] = s.elevation;
        grid.cliff[o] = this.cliff(x0 + i * step, z0 + j * step);
      }
    }
    return grid;
  }

  /** How steeply the set pieces' drops fall away at (x, z) (their lips and humps don't count). */
  private cliff(x: number, z: number): number {
    const features = this.field.features;
    return Math.max(0, (features.parts(x, z + 1).drop - features.parts(x, z - 1).drop) / 2);
  }

  /** From the landform here (h, with its spot) and ENV.reach m to either side along x and z. */
  private combine(spot: LandformSpot, h: number, xm: number, xp: number, zm: number, zp: number, out: EnvSample): EnvSample {
    const r = ENV.reach;
    const M = ENV.moisture;
    const gx = (xp - xm) / (2 * r);
    const gz = (zp - zm) / (2 * r);
    out.slope = Math.hypot(gx, gz);
    const laplacian = (xm + xp + zm + zp - 4 * h) / (r * r);
    // Concave ground (positive Laplacian, a hollow) is negative curvature.
    out.curvature = Math.max(-1, Math.min(1, -laplacian / ENV.curvatureFull));
    const nl = Math.hypot(gx, 1, gz);
    out.exposure = (-gx * this.sun.x + this.sun.y - gz * this.sun.z) / nl;

    const valley = smoothstep(ENV.valleyFrom, ENV.valleyTo, spot.depth);
    const flank = Math.max(0, Math.min(1, spot.flank));
    out.elevation = 0.5 + (flank - 0.5) * valley;
    const moisture =
      M.base +
      M.floor * valley * (1 - smoothstep(0, M.lowTo, spot.flank)) +
      M.gully * smoothstep(0, M.gullyFull, -spot.gully) +
      M.hollow * Math.max(0, -out.curvature) -
      M.edge * Math.max(0, out.curvature) +
      M.ledge * spot.ledge -
      M.ridge * valley * smoothstep(M.ridgeFrom, 1, spot.flank);
    out.moisture = Math.max(0, Math.min(1, moisture));
    return out;
  }
}

export function emptySample(): EnvSample {
  return { slope: 0, curvature: 0, moisture: 0, exposure: 0, elevation: 0, cliff: 0 };
}
