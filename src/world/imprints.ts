import * as THREE from 'three';
import type { Rock, RockShape } from './details';
import { smoothstep } from './noise';

/** What a boulder lay bedded in: grass, bare soil (in the snow, the earth under it), or rock. */
export type BedGround = 'grass' | 'soil' | 'rock';

/** The hollows boulders leave in the ground when knocked loose. Feel values. */
export const IMPRINT = {
  /** Ground cells (2 m) under an imprint are rebuilt this many times finer per side: 0.25 m. */
  subdivisions: 8,
  /**
   * The lip of soil pushed up round the hollow: up to `lip` × the boulder's radius high, from
   * `lipFrom` out to `lipTo` × its footprint (crest at `lipAt`). The footprint is the boulder's
   * width at the ground line: `footprint` × its sx and sz (its unit shape is ≈0.9 across there).
   */
  lip: 0.07,
  lipFrom: 0.8,
  lipAt: 1.05,
  lipTo: 1.45,
  footprint: 0.9,
  /**
   * In rock the hollow is the rock's own colour, darker deeper in: × `rockShade` at its edge
   * down to × `rockDeep` at its deepest. Rock has no lip: nothing gets pushed up.
   */
  rockShade: 0.85,
  rockDeep: 0.6,
  /** Bare soil colours: the lip, the hollow's sides, and its deepest part. */
  soilLight: new THREE.Color('#77583d'),
  soil: new THREE.Color('#5e4330'),
  soilDark: new THREE.Color('#3f2d20'),
};

const UP = new THREE.Vector3(0, 1, 0);
const _origin = new THREE.Vector3();
const _hits: THREE.Intersection[] = [];
const RAY_MATERIAL = new THREE.MeshBasicMaterial();

/**
 * The hollow one boulder left: its own underside pressed into the ground (traced with rays
 * against its shape, posed as it lay bedded), with a lip of soil round it.
 */
export class Imprint {
  /** Nothing changes farther than this (m) from the boulder's middle. */
  readonly reach: number;
  /** Deepest the hollow goes (m), for shading it. */
  readonly depth: number;
  private readonly mesh: THREE.Mesh;
  private readonly raycaster = new THREE.Raycaster();
  private readonly cos: number;
  private readonly sin: number;

  constructor(
    readonly rock: Rock,
    shape: RockShape,
    readonly ground: BedGround,
  ) {
    // Shares the boulder's geometry (owned by DetailScatter): only ever raycast, never drawn.
    this.mesh = new THREE.Mesh(shape.geometry, RAY_MATERIAL);
    this.mesh.position.set(rock.x, rock.y, rock.z);
    this.mesh.quaternion.setFromAxisAngle(UP, rock.yaw);
    this.mesh.scale.set(rock.sx, rock.sy, rock.sz);
    this.mesh.updateMatrixWorld(true);
    this.reach = rock.radius * IMPRINT.lipTo;
    this.cos = Math.cos(rock.yaw);
    this.sin = Math.sin(rock.yaw);
    this.depth = Math.max(0.05, rock.sy * 0.35);
  }

  /** How the ground at (x, z), at height `ground` before, is moved (m): down into the hollow, up on the lip. */
  offset(x: number, z: number, ground: number): number {
    const I = IMPRINT;
    const r = this.rock;
    const dx = x - r.x;
    const dz = z - r.z;
    if (dx * dx + dz * dz >= this.reach * this.reach) return 0;
    // Into the boulder's own frame (it was turned by its yaw about the vertical).
    const u = dx * this.cos - dz * this.sin;
    const v = dx * this.sin + dz * this.cos;
    const e = Math.hypot(u / (r.sx * I.footprint), v / (r.sz * I.footprint));
    const lip = this.ground === 'rock' ? 0 : I.lip * r.radius * (smoothstep(I.lipFrom, I.lipAt, e) - smoothstep(I.lipAt, I.lipTo, e));
    // Its underside here: the first face a ray from below meets.
    this.raycaster.set(_origin.set(x, r.y - 1, z), UP);
    _hits.length = 0;
    this.mesh.raycast(this.raycaster, _hits);
    let under = Infinity;
    for (const h of _hits) under = Math.min(under, h.point.y);
    const dent = under === Infinity ? 0 : Math.max(0, ground - under);
    return lip - dent;
  }
}

/** Every imprint left so far (they stay for good: the ground keeps them across chunk rebuilds). */
export class Imprints {
  private readonly all: Imprint[] = [];

  add(rock: Rock, shape: RockShape, ground: BedGround): Imprint {
    const imprint = new Imprint(rock, shape, ground);
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
