import * as THREE from 'three';
import type { Rock, RockShape } from './details';

/** What a boulder lay bedded in: grass, bare soil (in the snow, the earth under it), or rock. */
export type BedGround = 'grass' | 'soil' | 'rock';

/** The hollows boulders leave in the ground when knocked loose. Feel values. */
export const IMPRINT = {
  /**
   * Ground cells (2 m) under an imprint are rebuilt this many times finer per side: 0.125 m, so the
   * hollow's rim follows the boulder's outline closely.
   */
  subdivisions: 16,
  /**
   * The hollow is worked out once, on a `grid` m grid over the boulder's footprint, and its walls
   * held to at most `wallSlope` deeper per m in from its rim (≈50°): a boulder bedded below its
   * widest point would leave sheer walls, undercut even, where in soil they slump in. The ground's
   * faces are cut along the rim (see the terrain's rimCutter), so it follows the boulder's outline.
   */
  grid: 0.1,
  wallSlope: 1.2,
  /**
   * In rock the hollow is the rock's own colour, darker deeper in: × `rockShade` at its edge
   * down to × `rockDeep` at its deepest.
   */
  rockShade: 0.85,
  rockDeep: 0.6,
  /** Bare soil colours: the hollow's sides and its deepest part. */
  soil: new THREE.Color('#5e4330'),
  soilDark: new THREE.Color('#3f2d20'),
};

const UP = new THREE.Vector3(0, 1, 0);
const _origin = new THREE.Vector3();
const _hits: THREE.Intersection[] = [];
// Both sides: a ray up through the boulder meets its top from inside.
const RAY_MATERIAL = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });

/**
 * The hollow one boulder left: its own underside pressed into the ground (traced with rays
 * against its shape, posed as it lay bedded) within its outline at ground level, its walls sloped
 * in from there where they'd be too steep (see IMPRINT.wallSlope). Nothing changes outside the boulder's footprint, so while it
 * still lies there it hides the whole of it: the ground can take the hollow the moment it breaks
 * loose, and rolling away it uncovers a hollow that seems always to have been there.
 */
export class Imprint {
  /** Nothing changes farther than this (m) from the boulder's middle: past its widest point. */
  readonly reach: number;
  /** Deepest the hollow goes (m), for shading it. */
  readonly depth: number;
  /**
   * At each grid point, from (x0, z0) on, `n` points a side: how deep the boulder's underside lay
   * (m, ≥ 0; 0 outside its outline), and how far it lies inside its outline at ground level (m;
   * negative outside), the rim lying where that's 0.
   */
  private readonly under: Float32Array;
  private readonly inside: Float32Array;
  private readonly x0: number;
  private readonly z0: number;
  private readonly n: number;

  /** @param groundAt the drawn ground's height at (x, z) before the hollow */
  constructor(
    readonly rock: Rock,
    shape: RockShape,
    readonly ground: BedGround,
    groundAt: (x: number, z: number) => number,
  ) {
    // Shares the boulder's geometry (owned by DetailScatter): only ever raycast, never drawn.
    const mesh = new THREE.Mesh(shape.geometry, RAY_MATERIAL);
    mesh.position.set(rock.x, rock.y, rock.z);
    mesh.quaternion.setFromAxisAngle(UP, rock.yaw);
    mesh.scale.set(rock.sx, rock.sy, rock.sz);
    mesh.updateMatrixWorld(true);
    // Its unit shape reaches up to 1.22 out (vertex jitter), × its larger horizontal scale.
    this.reach = rock.radius * 1.25;
    this.depth = Math.max(0.05, rock.sy * 0.35);

    const G = IMPRINT.grid;
    const n = (this.n = Math.ceil((2 * this.reach) / G) + 1);
    this.x0 = rock.x - this.reach;
    this.z0 = rock.z - this.reach;
    const under = (this.under = new Float32Array(n * n));
    const stood = new Uint8Array(n * n);
    const raycaster = new THREE.Raycaster();
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = this.x0 + i * G;
        const z = this.z0 + j * G;
        // Its underside and top here: the lowest and highest faces a ray up through it meets. The
        // hollow opens only where the boulder stood through the ground (its outline at ground
        // level, as it was seen), not under a bulge it had below the ground: that earth falls in.
        raycaster.set(_origin.set(x, rock.y - rock.sy * 2, z), UP);
        _hits.length = 0;
        mesh.raycast(raycaster, _hits);
        let low = Infinity;
        let top = -Infinity;
        for (const h of _hits) {
          low = Math.min(low, h.point.y);
          top = Math.max(top, h.point.y);
        }
        const ground = groundAt(x, z);
        if (low < ground && top > ground) {
          stood[j * n + i] = 1;
          under[j * n + i] = ground - low;
        }
      }
    }
    // How far inside the outline: the distance to the nearest point outside it (inside) or in it
    // (outside), less half a grid step, as the outline runs between the two.
    const toOut = gridDistance(stood, n, 0);
    const toIn = gridDistance(stood, n, 1);
    const inside = (this.inside = new Float32Array(n * n));
    for (let o = 0; o < n * n; o++) inside[o] = (stood[o] ? toOut[o] - 0.5 : 0.5 - toIn[o]) * G;
  }

  /**
   * How far the ground at (x, z) is moved (m): down into the hollow, ≤ 0. Down to the boulder's
   * underside, but its walls held to IMPRINT.wallSlope from the rim.
   */
  offset(x: number, z: number): number {
    const wall = IMPRINT.wallSlope * Math.max(0, this.sample(this.inside, x, z, -1));
    return wall > 0 ? -Math.min(this.sample(this.under, x, z, 0), wall) : 0;
  }

  /** How far (x, z) lies inside the boulder's outline at ground level (m; negative outside). */
  rimSide(x: number, z: number): number {
    return this.sample(this.inside, x, z, -1);
  }

  /** `grid` at (x, z), blended between its points; `outside` off the grid. */
  private sample(grid: Float32Array, x: number, z: number, outside: number): number {
    const u = (x - this.x0) / IMPRINT.grid;
    const v = (z - this.z0) / IMPRINT.grid;
    const n = this.n;
    if (u < 0 || v < 0 || u >= n - 1 || v >= n - 1) return outside;
    const i = Math.floor(u);
    const j = Math.floor(v);
    const fu = u - i;
    const fv = v - j;
    const o = j * n + i;
    const top = grid[o] + (grid[o + 1] - grid[o]) * fu;
    const bottom = grid[o + n] + (grid[o + n + 1] - grid[o + n]) * fu;
    return top + (bottom - top) * fv;
  }
}

/**
 * For each point of an n × n grid, how far (in grid steps) the nearest point whose `mask` is
 * `target` is: a chamfer pass each way (diagonals √2), close enough for a rim.
 */
function gridDistance(mask: Uint8Array, n: number, target: number): Float32Array {
  const d = new Float32Array(n * n);
  for (let o = 0; o < n * n; o++) d[o] = mask[o] === target ? 0 : 1e6;
  const pull = (o: number, from: number, by: number) => {
    if (d[from] + by < d[o]) d[o] = d[from] + by;
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const o = j * n + i;
      if (i > 0) pull(o, o - 1, 1);
      if (j > 0) {
        pull(o, o - n, 1);
        if (i > 0) pull(o, o - n - 1, Math.SQRT2);
        if (i < n - 1) pull(o, o - n + 1, Math.SQRT2);
      }
    }
  }
  for (let j = n - 1; j >= 0; j--) {
    for (let i = n - 1; i >= 0; i--) {
      const o = j * n + i;
      if (i < n - 1) pull(o, o + 1, 1);
      if (j < n - 1) {
        pull(o, o + n, 1);
        if (i < n - 1) pull(o, o + n + 1, Math.SQRT2);
        if (i > 0) pull(o, o + n - 1, Math.SQRT2);
      }
    }
  }
  return d;
}

/** Every imprint left so far (they stay for good: the ground keeps them across chunk rebuilds). */
export class Imprints {
  private readonly all: Imprint[] = [];

  add(rock: Rock, shape: RockShape, ground: BedGround, groundAt: (x: number, z: number) => number): Imprint {
    const imprint = new Imprint(rock, shape, ground, groundAt);
    this.all.push(imprint);
    return imprint;
  }

  /** Imprints reaching into the square from (x0, z0), `size` m a side. */
  within(x0: number, z0: number, size: number): Imprint[] {
    return this.all.filter((m) => {
      const { x, z } = m.rock;
      return x + m.reach > x0 && x - m.reach < x0 + size && z + m.reach > z0 && z - m.reach < z0 + size;
    });
  }
}
