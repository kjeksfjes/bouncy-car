import RAPIER from '@dimforge/rapier3d-compat';
import type { NoiseFunction2D } from 'simplex-noise';
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { PHYSICS_STEP } from '../constants';
import { GROUND } from './biome';
import { emptySample, type EnvGrid, type EnvSample } from './environment';
import { hash2, makeNoise, mulberry32, smoothstep } from './noise';
import type { ChunkProps } from './props';
import type { TerrainField } from './terrainField';
import type { TreeLayout } from './trees';

/**
 * Small-scale detail: boulders (solid; the AI steers around them like trees), shrubs and grass
 * clumps (looks only). Placed by the ground's environment, sparse. Feel values.
 */
export const ROCKS = {
  /** Candidate cell (m): at most one boulder per cell. */
  cell: 10,
  /** Chance per cell on bare rock (boulders lying about on rocky ground). */
  onRock: 0.18,
  /** On grass: convex, sloping ground (curvature past `convexFrom`, landform steeper than `slopeFrom`°) gets up to `onEdge`. */
  onEdge: 0.06,
  convexFrom: 0.3,
  slopeFrom: 12,
  /** The odd boulder out in the open anywhere. */
  stray: 0.005,
  /** Boulders lie in loose clusters: chance × 0.3..1.7 by noise at `clusterScale` m. */
  clusterScale: 70,
  /** Radius (m): `minRadius` plus up to `extra` (`extraOnRock` on bare rock), small ones far more common. */
  minRadius: 0.45,
  extra: 1.0,
  extraOnRock: 1.9,
  /** Kept clear of the spawn pad (m from the origin) and off drop walls and launch humps (they'd wreck the jumps). */
  spawnClear: 60,
  cliffBelow: 0.1,
  lipBelow: 0.05,
  /**
   * How deep a boulder is bedded (× its height) below the lowest ground under its edge: most of
   * its rounded underside, so it sits in the ground rather than on it.
   */
  bury: 0.22,
  /**
   * Rock density (kg/m³; granite ≈ 2700): mass is the hull's volume × this. A 0.9 m stone weighs
   * ≈ 0.7 t, a 2.4 m one ≈ 14 t, the biggest ≈ 100 t (the car is 1.6 t).
   */
  density: 2700,
  /**
   * Bedded in the ground, a boulder breaks loose only from a hit whose impulse in one physics step
   * (N·s) would set it moving at this speed (m/s) or more: ≈ 1–2 m/s of car speed for the smallest
   * stones, ≈ 80 km/h for a 2.4 m one, never for the biggest.
   */
  breakout: 2.5,
};

const SHRUBS = {
  /** Candidate cell (m). */
  cell: 5,
  /** Chance per cell just outside a wood (copse noise within `edgeBand` below where the wood starts), and out in the open. */
  edge: 0.3,
  edgeBand: 0.08,
  open: 0.008,
  /** Size multiplier range. */
  minScale: 0.7,
  maxScale: 1.3,
};

const GRASS = {
  /** Candidate cell (m). */
  cell: 3,
  /** Chance per cell where it's moist (moisture from `moistFrom` to `moistTo`) and green. */
  chance: 0.4,
  moistFrom: 0.5,
  moistTo: 0.8,
  /** Clumps gather in patches: chance × 0..1 by noise at `patchScale` m past `patchFrom`. */
  patchScale: 22,
  patchFrom: -0.1,
  minScale: 0.7,
  maxScale: 1.4,
};

/** Rock shape variants (and their snowy twins). */
const ROCK_SHAPES = 4;
/** Cache cap; the cache is simply cleared when full (lookups are cheap to redo). */
const CACHE_LIMIT = 20000;

export interface Rock {
  /** Its cell's key (see RockLayout.inCell). */
  cell: number;
  x: number;
  /** Height of the rock's lowest point: bedded below the lowest ground under its edge (ROCKS.bury). */
  y: number;
  z: number;
  /** Horizontal radius (m), for the AI and spacing. */
  radius: number;
  /** Scale per axis applied to the unit shape. */
  sx: number;
  sy: number;
  sz: number;
  yaw: number;
  shape: number;
  snowy: boolean;
}

const UP = new THREE.Vector3(0, 1, 0);
const _env = emptySample();

/**
 * Deterministic boulder placement, the single source of truth for where boulders are: chunks build
 * meshes and colliders from it, the AI sees boulders anywhere through it. Like TreeLayout.
 */
export class RockLayout {
  private readonly cache = new Map<number, Rock | null>();
  /** Boulders knocked loose from their beds: gone from their cells for good. */
  private readonly gone = new Map<number, Rock>();
  private readonly cluster: NoiseFunction2D;

  constructor(
    private readonly field: TerrainField,
    private readonly trees: TreeLayout,
  ) {
    this.cluster = makeNoise(field.seed + 40);
  }

  /** The boulder in cell (cellX, cellZ), if there is one; `grid`, a chunk's, saves sampling its environment. */
  inCell(cellX: number, cellZ: number, grid?: EnvGrid): Rock | null {
    const key = (cellX + 1048576) * 2097152 + (cellZ + 1048576);
    if (this.gone.has(key)) return null;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const rock = this.place(cellX, cellZ, key, grid);
    if (this.cache.size >= CACHE_LIMIT) this.cache.clear();
    this.cache.set(key, rock);
    return rock;
  }

  /**
   * Whether a boulder was knocked loose from within `clearance` of (x, z): its hollow is there.
   * Only where it lay (its radius), so nothing that grew round it goes when it does.
   */
  scarred(x: number, z: number, clearance: number): boolean {
    for (const rock of this.gone.values()) if (Math.hypot(rock.x - x, rock.z - z) < rock.radius + clearance) return true;
    return false;
  }

  /** Takes a boulder out of its cell for good (it was knocked loose). */
  dislodge(rock: Rock): void {
    this.gone.set(rock.cell, rock);
  }

  /** Forgets every cached boulder (after the biomes change: snow on them). */
  invalidate(): void {
    this.cache.clear();
  }

  /** Nearest boulder whose edge comes within `clearance` of (x, z), or null. */
  blocking(x: number, z: number, clearance: number): Rock | null {
    const R = ROCKS;
    const reach = clearance + R.minRadius + R.extraOnRock;
    let best: Rock | null = null;
    let bestGap = Infinity;
    for (let cz = Math.floor((z - reach) / R.cell); cz <= Math.floor((z + reach) / R.cell); cz++) {
      for (let cx = Math.floor((x - reach) / R.cell); cx <= Math.floor((x + reach) / R.cell); cx++) {
        const r = this.inCell(cx, cz);
        if (!r) continue;
        const gap = Math.hypot(r.x - x, r.z - z) - r.radius;
        if (gap < clearance && gap < bestGap) {
          best = r;
          bestGap = gap;
        }
      }
    }
    return best;
  }

  private place(cellX: number, cellZ: number, cell: number, grid: EnvGrid | undefined): Rock | null {
    const R = ROCKS;
    const f = this.field;
    const seed = f.seed;
    const x = (cellX + hash2(cellX, cellZ, seed + 41)) * R.cell;
    const z = (cellZ + hash2(cellX, cellZ, seed + 42)) * R.cell;
    if (Math.hypot(x, z) < R.spawnClear) return null;
    const env = f.environment.atNode(x, z, grid, _env);
    if (env.cliff > R.cliffBelow || f.features.parts(x, z).lip > R.lipBelow) return null;
    const onRock = f.biome.isRock(x, z, env);
    const slope = (Math.atan(env.slope) * 180) / Math.PI;
    const edge = R.onEdge * smoothstep(R.convexFrom, R.convexFrom + 0.4, env.curvature) * smoothstep(R.slopeFrom, R.slopeFrom + 12, slope);
    const cluster = 0.3 + 1.4 * smoothstep(0.1, 0.5, this.cluster(x / R.clusterScale, z / R.clusterScale));
    const chance = Math.max(onRock ? R.onRock : 0, edge, R.stray) * cluster;
    if (hash2(cellX, cellZ, seed + 43) >= chance) return null;

    const size = hash2(cellX, cellZ, seed + 44);
    const radius = R.minRadius + size * size * (onRock ? R.extraOnRock : R.extra);
    if (this.trees.blocking(x, z, radius + 0.5)) return null;
    const flat = 0.55 + 0.3 * hash2(cellX, cellZ, seed + 45);
    const stretch = 0.8 + 0.4 * hash2(cellX, cellZ, seed + 46);
    // Bedded below the lowest ground under its edge, so no side floats on a slope.
    let y = f.height(x, z);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) y = Math.min(y, f.height(x + dx * radius, z + dz * radius));
    const sy = radius * flat * 1.4;
    return {
      cell,
      x,
      y: y - R.bury * UNIT_HEIGHT * sy,
      z,
      radius: radius * Math.max(stretch, 1 / stretch),
      sx: radius * stretch,
      sy,
      sz: radius / stretch,
      yaw: hash2(cellX, cellZ, seed + 47) * Math.PI * 2,
      shape: Math.floor(hash2(cellX, cellZ, seed + 48) * ROCK_SHAPES),
      snowy: f.biome.snowCover(x, z, UP, env) > 0.5,
    };
  }
}

/** Trees and boulders together: what the AI and the traffic spawner keep clear of. */
export class Obstacles {
  constructor(
    private readonly trees: TreeLayout,
    private readonly rocks: RockLayout,
  ) {}

  /** Whether a tree or a boulder comes within `clearance` of (x, z). */
  blocking(x: number, z: number, clearance: number): boolean {
    return this.trees.blocking(x, z, clearance) !== null || this.rocks.blocking(x, z, clearance) !== null;
  }
}

/** Unit rock shapes stand about this tall (× sy), lowest point at y = 0. */
const UNIT_HEIGHT = 1.35;
/** How much flatter a rock is below its middle than above (a boulder's underside is rounded but squat). */
const UNDERSIDE = 0.65;

/** Unit rock shapes: jittered, faceted blobs rounded all round, lowest point at y = 0, radius ≈1, ≈ UNIT_HEIGHT tall. */
function buildRockShapes(): RockShape[] {
  const shapes = [];
  for (let i = 0; i < ROCK_SHAPES; i++) {
    const random = mulberry32(911 + i * 17);
    const base = new THREE.IcosahedronGeometry(1, i % 2);
    // Jitter shared vertices (merge first so faces stay closed), squash the underside a little.
    base.deleteAttribute('normal');
    base.deleteAttribute('uv');
    const merged = mergeVertices(base);
    const pos = merged.getAttribute('position') as THREE.BufferAttribute;
    let low = Infinity;
    let high = -Infinity;
    for (let v = 0; v < pos.count; v++) {
      const k = 0.78 + random() * 0.44;
      const y = pos.getY(v) * k * (pos.getY(v) < 0 ? UNDERSIDE : 1);
      pos.setXYZ(v, pos.getX(v) * k, y, pos.getZ(v) * k);
      low = Math.min(low, y);
      high = Math.max(high, y);
    }
    // Lowest point to y = 0, scaled to UNIT_HEIGHT tall.
    for (let v = 0; v < pos.count; v++) pos.setY(v, ((pos.getY(v) - low) * UNIT_HEIGHT) / (high - low));
    const hull = new Float32Array(pos.array as Float32Array);
    const flat = merged.toNonIndexed();
    flat.computeVertexNormals();
    const paint = (snowy: boolean) => {
      const g = flat.clone();
      const n = g.getAttribute('normal');
      const colours = new Float32Array(n.count * 3);
      const c = new THREE.Color();
      for (let f = 0; f < n.count; f += 3) {
        const ny = n.getY(f);
        if (snowy && ny > 0.55) c.copy(GROUND.snow);
        else c.copy(GROUND.stone).lerp(GROUND.stoneDark, ny < -0.2 ? 0.9 : random() * 0.6);
        for (let k = 0; k < 3; k++) c.toArray(colours, (f + k) * 3);
      }
      g.setAttribute('color', new THREE.BufferAttribute(colours, 3));
      return g;
    };
    shapes.push({ geometry: paint(false), snowy: paint(true), hull });
  }
  return shapes;
}

/** A shrub: a few leafy clumps, ≈1 m tall. */
function buildShrub(): THREE.BufferGeometry {
  const parts = [
    { r: 0.55, x: 0, y: 0.45, z: 0 },
    { r: 0.42, x: 0.45, y: 0.35, z: 0.15 },
    { r: 0.4, x: -0.35, y: 0.33, z: -0.3 },
  ].map((p, i) => {
    const g = new THREE.IcosahedronGeometry(p.r, 0).toNonIndexed();
    g.scale(1, 0.8, 1).translate(p.x, p.y, p.z);
    g.deleteAttribute('uv');
    g.computeVertexNormals();
    const n = g.getAttribute('normal');
    const colours = new Float32Array(n.count * 3);
    const c = new THREE.Color();
    for (let f = 0; f < n.count; f += 3) {
      c.copy(n.getY(f) < -0.1 || i === 2 ? SHRUB_DARK : SHRUB);
      for (let k = 0; k < 3; k++) c.toArray(colours, (f + k) * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    return g;
  });
  const merged = mergeGeometries(parts);
  merged.computeVertexNormals();
  return merged;
}

const SHRUB = new THREE.Color('#4f7a34');
const SHRUB_DARK = new THREE.Color('#3c6029');

/** A grass clump: a ring of thin blades leaning outward, dark at the root, `tip` at the top. ≈0.6 m tall. */
function buildGrass(tip: THREE.Color): THREE.BufferGeometry {
  const blades = 7;
  const random = mulberry32(331);
  const positions: number[] = [];
  const colours: number[] = [];
  const root = new THREE.Color(GROUND.grassLush).multiplyScalar(0.75);
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + random() * 0.5;
    const lean = 0.15 + random() * 0.25;
    const h = 0.45 + random() * 0.3;
    const w = 0.06;
    const ox = Math.cos(a) * 0.08;
    const oz = Math.sin(a) * 0.08;
    // Base edge across the blade's direction, tip leaning outward.
    const px = -Math.sin(a) * w;
    const pz = Math.cos(a) * w;
    positions.push(ox - px, 0, oz - pz, ox + px, 0, oz + pz, ox + Math.cos(a) * lean, h, oz + Math.sin(a) * lean);
    colours.push(root.r, root.g, root.b, root.r, root.g, root.b, tip.r, tip.g, tip.b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  g.computeVertexNormals();
  return g;
}

type DetailKind = 'shrub' | 'grass' | 'grassDry';

/** A rock shape: its geometry (and snowy twin), and its hull points (unit size). */
export interface RockShape {
  geometry: THREE.BufferGeometry;
  snowy: THREE.BufferGeometry;
  hull: Float32Array;
}

/** A boulder bedded in a loaded chunk: its fixed collider, and the instance that draws it. */
export interface BeddedRock {
  rock: Rock;
  shape: RockShape;
  collider: RAPIER.Collider;
  /** kg, from the hull's volume (ROCKS.density). */
  mass: number;
  mesh: THREE.InstancedMesh | null;
  index: number;
}

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

/** Builds each chunk's boulders (with colliders), shrubs and grass clumps. */
export class DetailScatter {
  readonly rockShapes: RockShape[] = buildRockShapes();
  /** The material boulders are drawn with, for loose ones too. */
  readonly rockMaterial: THREE.Material;
  /** Bedded boulders in the loaded chunks, by collider handle. */
  private readonly bedded = new Map<number, BeddedRock>();
  private readonly geometries: Record<DetailKind, THREE.BufferGeometry> = {
    shrub: buildShrub(),
    grass: buildGrass(GROUND.grass),
    grassDry: buildGrass(GROUND.grassDry),
  };
  private readonly material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 });
  /** Grass blades are single triangles: seen from both sides. */
  private readonly bladeMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, side: THREE.DoubleSide });
  private readonly patch: NoiseFunction2D;

  constructor(
    private readonly field: TerrainField,
    private readonly trees: TreeLayout,
    private readonly rocks: RockLayout,
    private readonly world: RAPIER.World,
  ) {
    this.patch = makeNoise(field.seed + 45);
    this.rockMaterial = this.material;
  }

  /** The bedded boulder with this collider, if it is one. */
  beddedRock(handle: number): BeddedRock | undefined {
    return this.bedded.get(handle);
  }

  /**
   * Takes a bedded boulder out of its chunk (collider and drawn instance) and out of the layout
   * for good, for it to carry on as a loose body.
   */
  release(bed: BeddedRock): void {
    this.bedded.delete(bed.collider.handle);
    this.world.removeCollider(bed.collider, true);
    if (bed.mesh) {
      bed.mesh.setMatrixAt(bed.index, HIDDEN);
      bed.mesh.instanceMatrix.needsUpdate = true;
    }
    this.rocks.dislodge(bed.rock);
  }

  /** Details for the chunk at (x0, z0), `size` m square, using its environment grid (`step` m spacing). */
  populate(x0: number, z0: number, size: number, step: number, env: EnvGrid, body: RAPIER.RigidBody): ChunkProps {
    const meshes: { geometry: THREE.BufferGeometry; material: THREE.Material; shadow: boolean; matrices: THREE.Matrix4[] }[] = [];
    const group = (geometry: THREE.BufferGeometry, material: THREE.Material, shadow: boolean) => {
      let g = meshes.find((m) => m.geometry === geometry);
      if (!g) meshes.push((g = { geometry, material, shadow, matrices: [] }));
      return g.matrices;
    };
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();

    // Boulders: from the layout, with a collider shaped like the rock.
    const R = ROCKS;
    const beds: { bed: BeddedRock; list: THREE.Matrix4[] }[] = [];
    for (let cz = Math.floor(z0 / R.cell); cz <= Math.floor((z0 + size) / R.cell); cz++) {
      for (let cx = Math.floor(x0 / R.cell); cx <= Math.floor((x0 + size) / R.cell); cx++) {
        const r = this.rocks.inCell(cx, cz, env);
        if (!r || r.x < x0 || r.x >= x0 + size || r.z < z0 || r.z >= z0 + size) continue;
        const shape = this.rockShapes[r.shape];
        q.setFromAxisAngle(UP, r.yaw);
        const m = new THREE.Matrix4().compose(p.set(r.x, r.y, r.z), q, s.set(r.sx, r.sy, r.sz));
        const list = group(r.snowy ? shape.snowy : shape.geometry, this.material, true);
        list.push(m);
        const points = new Float32Array(shape.hull.length);
        const v = new THREE.Vector3();
        for (let i = 0; i < points.length; i += 3) v.fromArray(shape.hull, i).applyMatrix4(m).toArray(points, i);
        const desc = RAPIER.ColliderDesc.convexHull(points);
        if (!desc) throw new Error(`Boulder at (${r.x.toFixed(1)}, ${r.z.toFixed(1)}) has no convex hull`);
        const collider = this.world.createCollider(desc.setFriction(0.8), body);
        const mass = collider.volume() * R.density;
        // Reports hits from its break-out force up (see Boulders), whatever the hitter reports on its own.
        collider.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
        collider.setContactForceEventThreshold((mass * R.breakout) / PHYSICS_STEP);
        const bed: BeddedRock = { rock: r, shape, collider, mass, mesh: null, index: list.length - 1 };
        this.bedded.set(collider.handle, bed);
        beds.push({ bed, list });
      }
    }

    // Shrubs and grass: looks only, from the chunk's own environment grid.
    const sample = (x: number, z: number): EnvSample | null => {
      const i = Math.round((x - x0) / step);
      const j = Math.round((z - z0) / step);
      if (i < 0 || j < 0 || i >= env.n || j >= env.n) return null;
      const o = j * env.n + i;
      return Object.assign(_env, {
        slope: env.slope[o],
        curvature: env.curvature[o],
        moisture: env.moisture[o],
        exposure: env.exposure[o],
        elevation: env.elevation[o],
        cliff: env.cliff[o],
        knoll: env.knoll[o],
      });
    };
    this.scatter(x0, z0, size, SHRUBS.cell, 51, (x, z, r) => {
      const e = sample(x, z);
      if (!e || !this.bare(x, z, e)) return;
      const S = SHRUBS;
      const edge = this.field.biome.woodEdge(x, z, e, S.edgeBand);
      if (r() >= Math.max(S.open, S.edge * edge)) return;
      // Not growing through a trunk or a boulder.
      if (this.trees.blocking(x, z, 0.8) || this.rocks.blocking(x, z, 0.5) || this.rocks.scarred(x, z, 0.5)) return;
      const k = S.minScale + r() * (S.maxScale - S.minScale);
      this.put(group(this.geometries.shrub, this.material, true), x, z, k, k * (0.8 + 0.4 * r()), r());
    });
    this.scatter(x0, z0, size, GRASS.cell, 61, (x, z, r) => {
      const e = sample(x, z);
      if (!e || !this.bare(x, z, e)) return;
      if (this.rocks.scarred(x, z, 0)) return;
      const G = GRASS;
      const green = this.field.biome.warmth(z);
      const patch = smoothstep(G.patchFrom, G.patchFrom + 0.3, this.patch(x / G.patchScale, z / G.patchScale));
      if (r() >= G.chance * green * patch * smoothstep(G.moistFrom, G.moistTo, e.moisture)) return;
      const k = G.minScale + r() * (G.maxScale - G.minScale);
      const kind = e.moisture > 0.7 ? 'grass' : 'grassDry';
      this.put(group(this.geometries[kind], this.bladeMaterial, false), x, z, k, k, r());
    });

    const built = new Map<THREE.Matrix4[], THREE.InstancedMesh>();
    const objects: THREE.Object3D[] = meshes.map(({ geometry, material, shadow, matrices }) => {
      const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
      matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      built.set(matrices, mesh);
      return mesh;
    });
    for (const { bed, list } of beds) bed.mesh = built.get(list)!;
    return {
      objects,
      dispose: () => {
        // The chunk's body goes with its colliders: forget its boulders (handles get reused).
        for (const { bed } of beds) if (this.bedded.get(bed.collider.handle) === bed) this.bedded.delete(bed.collider.handle);
        objects.forEach((o) => (o as THREE.InstancedMesh).dispose());
      },
    };
  }

  /** Bare (snow-free, not rock) ground that isn't a drop wall: where shrubs and grass can grow. */
  private bare(x: number, z: number, env: EnvSample): boolean {
    return env.cliff < ROCKS.cliffBelow && this.field.biome.snowCover(x, z, UP, env) < 0.5 && !this.field.biome.isRock(x, z, env);
  }

  /** Calls `each` for one jittered candidate spot per `cell` m inside the chunk, with a seeded random for it. */
  private scatter(x0: number, z0: number, size: number, cell: number, salt: number, each: (x: number, z: number, random: () => number) => void): void {
    const seed = this.field.seed + salt;
    for (let cz = Math.floor(z0 / cell); cz * cell < z0 + size; cz++) {
      for (let cx = Math.floor(x0 / cell); cx * cell < x0 + size; cx++) {
        const x = (cx + hash2(cx, cz, seed)) * cell;
        const z = (cz + hash2(cx, cz, seed + 1)) * cell;
        if (x < x0 || x >= x0 + size || z < z0 || z >= z0 + size) continue;
        each(x, z, mulberry32(Math.floor(hash2(cx, cz, seed + 2) * 4294967296)));
      }
    }
  }

  /** Adds an instance standing on the ground at (x, z), scaled k across and `height` up, turned by `turn` (0..1). */
  private put(list: THREE.Matrix4[], x: number, z: number, k: number, height: number, turn: number): void {
    const q = new THREE.Quaternion().setFromAxisAngle(UP, turn * Math.PI * 2);
    list.push(new THREE.Matrix4().compose(new THREE.Vector3(x, this.field.height(x, z) - 0.05, z), q, new THREE.Vector3(k, height, k)));
  }
}

function mergeVertices(g: THREE.BufferGeometry): THREE.BufferGeometry {
  return BufferGeometryUtils.mergeVertices(g, 1e-4);
}

function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = BufferGeometryUtils.mergeGeometries(parts);
  if (!merged) throw new Error('Detail geometry merge failed: part attributes differ');
  return merged;
}

