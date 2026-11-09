import * as THREE from 'three';
import type { Rock, RockShape } from './details';

/** What a boulder lay bedded in: grass, bare soil (in the snow, the earth under it), or rock. */
export type BedGround = 'grass' | 'soil' | 'rock';

/** The hollows boulders leave in the ground when knocked loose. Feel values. */
export const IMPRINT = {
  /** Ground cells (2 m) under an imprint are rebuilt this many times finer per side: 0.25 m. */
  subdivisions: 8,
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
const RAY_MATERIAL = new THREE.MeshBasicMaterial();

/**
 * The hollow one boulder left: its own underside pressed into the ground (traced with rays
 * against its shape, posed as it lay bedded). Nothing changes outside the boulder's footprint,
 * so while it still lies there it hides the whole of it: the ground can take the hollow the
 * moment it breaks loose, and rolling away it uncovers a hollow that seems always to have been there.
 */
export class Imprint {
  /** Nothing changes farther than this (m) from the boulder's middle: past its widest point. */
  readonly reach: number;
  /** Deepest the hollow goes (m), for shading it. */
  readonly depth: number;
  private readonly mesh: THREE.Mesh;
  private readonly raycaster = new THREE.Raycaster();

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
    // Its unit shape reaches up to 1.22 out (vertex jitter), × its larger horizontal scale.
    this.reach = rock.radius * 1.25;
    this.depth = Math.max(0.05, rock.sy * 0.35);
  }

  /** How far the ground at (x, z), at height `ground` before, is moved (m): down into the hollow, ≤ 0. */
  offset(x: number, z: number, ground: number): number {
    const r = this.rock;
    const dx = x - r.x;
    const dz = z - r.z;
    if (dx * dx + dz * dz >= this.reach * this.reach) return 0;
    // Its underside here: the first face a ray from below meets.
    this.raycaster.set(_origin.set(x, r.y - 1, z), UP);
    _hits.length = 0;
    this.mesh.raycast(this.raycaster, _hits);
    let under = Infinity;
    for (const h of _hits) under = Math.min(under, h.point.y);
    return under === Infinity ? 0 : -Math.max(0, ground - under);
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
