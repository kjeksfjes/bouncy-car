import * as THREE from 'three';
import type { NoiseFunction2D } from 'simplex-noise';
import { makeNoise, smoothstep } from './noise';
import type { Species } from './trees';

/**
 * Biomes along the descent (distance downhill from the spawn, −Z): snowy mountain and snowy
 * forest, then a thaw where the snow breaks up into patches, then grassland. Feel values.
 */
const BIOME = {
  /** The thaw: snow starts breaking up here (m downhill) and is all gone by `thawEnd`. */
  thawStart: 3500,
  thawEnd: 5000,
  /** Snow patches: noise scales (m) and how much they shift where the snow lingers. */
  patchScale: 46,
  patchDetailScale: 13,
  patchDetail: 0.35,
  patchWeight: 0.7,
  /** Half width of a patch's edge in that noise: small, so each face is snow or bare. */
  patchEdge: 0.025,
  /** Snow lingers longest on flatter ground and on faces turned away from the sun. */
  flatBonus: 0.25,
  shadeBonus: 0.3,
  /**
   * Trees: spruce only in the snow; broadleaf trees join from `broadleafFrom` m and pines from
   * `pineFrom` m. In the grassland each copse is mostly one kind (kind noise at `kindScale` m,
   * larger than a copse so a whole copse shares its kind), with `mixing` of its trees picked at
   * random instead.
   */
  broadleafFrom: 4300,
  pineFrom: 4800,
  kindScale: 260,
  mixing: 0.06,
  /**
   * Kind noise below `pineBelow` = pine copse, above `broadleafAbove` = broadleaf, between = spruce:
   * roughly 45 % pine, 40 % spruce and 15 % broadleaf groves.
   */
  pineBelow: -0.05,
  broadleafAbove: 0.4,
  /**
   * Grassland woods: noise at `copseScale` m; trees fill cells where it passes `copseFrom` (fully
   * by `copseTo`, at `copseDensity`). Out in the open, small groups of a few trees (finer noise
   * at `groupScale` m past `groupFrom`, at `groupDensity`) and the odd lone tree. The edges are
   * narrow on purpose: a wide fade rings every wood with scattered single trees.
   */
  /** Where (m into the thaw) the trees switch from the snow forest's layout to woods and groups. */
  layoutFrom: 400,
  layoutTo: 1000,
  copseScale: 85,
  copseFrom: 0.56,
  copseTo: 0.59,
  copseDensity: 0.7,
  groupScale: 30,
  groupFrom: 0.72,
  groupTo: 0.75,
  groupDensity: 0.8,
  loneTrees: 0.006,
  /** Bare ground is dry and brown just after the snow, lush green from `greenAt` m further down. */
  greenAt: 900,
  /**
   * Stone by steepness (normal.y, cos of the slope angle): from ≈37° to full at ≈50°. Steeper than
   * the drop walls' snow-to-ice range, since bare ground holds steeper than packed snow looks.
   */
  stoneFrom: 0.8,
  stoneTo: 0.64,
};

/**
 * The biomes in order down the mountain, with where each begins (m downhill), for jumping
 * between them (B). The forest begins where the trees have grown in a little (the treeline
 * starts at 400 m, see TerrainField); the thaw and grassland follow BIOME.
 */
export const BIOMES: readonly { name: string; from: number }[] = [
  { name: 'Snowy mountain', from: 0 },
  { name: 'Snowy forest', from: 1200 },
  { name: 'Thaw', from: BIOME.thawStart },
  { name: 'Grassland', from: BIOME.thawEnd },
];

/** Ground colours. */
export const GROUND = {
  snow: new THREE.Color('#eef3f9'),
  snowShade: new THREE.Color('#dde6f0'),
  /** Wind-packed snow on steep faces (drop walls): a cooler blue hint, still light. */
  ice: new THREE.Color('#c4d7ea'),
  rock: new THREE.Color('#646872'),
  grass: new THREE.Color('#6b9a48'),
  grassDry: new THREE.Color('#a49a63'),
  dirt: new THREE.Color('#7b5b3f'),
  stone: new THREE.Color('#7f7b74'),
};

/**
 * Snow by face steepness (normal.y). Drop walls peak around 47° (base slope 0.32 + max drop
 * gradient 0.75), so they stay snow with an icy tint; rock only shows on near-vertical faces.
 */
const SNOW_SURFACE = {
  /** snowShade → snow from ≈32° to ≈14°. */
  shadeFrom: 0.85,
  shadeTo: 0.97,
  /** Icy tint fades in from ≈30° and is full at ≈50°. */
  iceFrom: 0.86,
  iceTo: 0.64,
  /** Rock fades in from ≈55° and is full at ≈63°, under snow and bare ground alike. */
  rockFrom: 0.57,
  rockTo: 0.45,
};

/** What the ground is made of at a spot: shares of snow and of bare grass, dirt and stone (summing to 1). */
export interface GroundMix {
  snow: number;
  grass: number;
  dirt: number;
  stone: number;
}

const _bare = new THREE.Color();

/** A jump in the biome progression (see Biome.shift): from this far downhill, ramping in over `length`. */
interface Shift {
  from: number;
  length: number;
  amount: number;
}

/** Ground cover across the biomes. Pure functions of position (and the surface's normal). */
export class Biome {
  private readonly patch: NoiseFunction2D;
  private readonly kind: NoiseFunction2D;
  private readonly copse: NoiseFunction2D;
  private readonly shifts: Shift[] = [];

  constructor(
    seed: number,
    private readonly sun: THREE.Vector3,
  ) {
    this.patch = makeNoise(seed + 20);
    this.kind = makeNoise(seed + 22);
    this.copse = makeNoise(seed + 23);
  }

  /**
   * How far down the biome progression a spot is (m): its distance downhill (−z), plus any jumps
   * made with `shift`. Every biome rule reads this rather than z itself.
   */
  distance(z: number): number {
    const d = -z;
    let out = d;
    for (const s of this.shifts) out += s.amount * THREE.MathUtils.clamp((d - s.from) / s.length, 0, 1);
    return out;
  }

  /**
   * Moves the biome progression on by `amount` metres for everything downhill of `from` (m
   * downhill), ramped in over `length` m so the change unfolds as you drive into it. Ground uphill
   * of `from` is untouched; callers must rebuild whatever is already built beyond it.
   */
  shift(from: number, amount: number, length: number): void {
    this.shifts.push({ from, length, amount });
  }

  /** How warm the air is here (0 in the snow, 1 in the grassland), for the sky and fog. */
  warmth(z: number): number {
    return smoothstep(BIOME.thawStart, BIOME.thawEnd + 500, this.distance(z));
  }

  /** How far into the grassland's tree layout (0 above the thaw, 1 below it). */
  grassland(z: number): number {
    // Short and early: halfway through, the snow forest's even scatter and the grassland's woods
    // average out into trees evenly sprinkled everywhere, so this blend shouldn't linger.
    return smoothstep(BIOME.thawStart + BIOME.layoutFrom, BIOME.thawStart + BIOME.layoutTo, this.distance(z));
  }

  /** Grassland tree density (0..1 chance a cell holds a tree): woods, small groups and lone trees in the open. */
  copseDensity(x: number, z: number): number {
    const B = BIOME;
    const copse = smoothstep(B.copseFrom, B.copseTo, this.copse(x / B.copseScale, z / B.copseScale));
    const group = smoothstep(B.groupFrom, B.groupTo, this.copse(x / B.groupScale + 71.3, z / B.groupScale - 19.7));
    return Math.max(B.loneTrees, B.copseDensity * copse, B.groupDensity * group);
  }

  /** Which kind of tree grows at (x, z), from two per-tree randoms in 0..1. */
  treeSpecies(x: number, z: number, r: number, r2: number): Species {
    const B = BIOME;
    const d = this.distance(z);
    // The copse's kind, or now and then a random one.
    const n = this.kind(x / B.kindScale, z / B.kindScale);
    let kind: Species = n < B.pineBelow ? 'pine' : n > B.broadleafAbove ? 'broadleaf' : 'spruce';
    if (r2 < B.mixing) kind = (['spruce', 'pine', 'broadleaf'] as const)[Math.floor((r2 / B.mixing) * 3)];
    // Through the thaw the new kinds take over gradually; until then it stays spruce.
    const arrived = kind === 'broadleaf' ? smoothstep(B.broadleafFrom, B.thawEnd + 300, d) : kind === 'pine' ? smoothstep(B.pineFrom, B.thawEnd + 600, d) : 1;
    return r < arrived ? kind : 'spruce';
  }

  /** 1 where it's all snow, 0 where the snow is gone, patchy through the thaw. */
  snowCover(x: number, z: number, normal: THREE.Vector3): number {
    const B = BIOME;
    const d = this.distance(z);
    if (d <= B.thawStart) return 1;
    if (d >= B.thawEnd + 200) return 0;
    // Where the thaw has got to (+1.2 before it, −1.2 after), shifted by patches, flat ground and shade.
    const thaw = (1 - smoothstep(B.thawStart, B.thawEnd, d)) * 2.4 - 1.2;
    const patch = this.patch(x / B.patchScale, z / B.patchScale) + B.patchDetail * this.patch(x / B.patchDetailScale + 40, z / B.patchDetailScale);
    const flat = smoothstep(0.9, 1, normal.y);
    const shade = smoothstep(0.3, -0.1, normal.dot(this.sun));
    // A narrow edge: low-poly faces read best as snow or bare, a half-blend looks washed out.
    return smoothstep(-B.patchEdge, B.patchEdge, thaw + B.patchWeight * patch + B.flatBonus * flat + B.shadeBonus * shade);
  }

  /** What the ground is made of here (see GroundMix). */
  mix(x: number, z: number, normal: THREE.Vector3, out: GroundMix = { snow: 0, grass: 0, dirt: 0, stone: 0 }): GroundMix {
    const B = BIOME;
    const snow = this.snowCover(x, z, normal);
    const stone = smoothstep(B.stoneFrom, B.stoneTo, normal.y);
    // Bare ground is grass and stone only. `dirt` stays in the mix (always 0 here) so the ground
    // effects keep handling it if dirt or mud comes back.
    const dirt = 0;
    const bare = 1 - snow;
    out.snow = snow;
    out.stone = bare * stone;
    out.dirt = bare * dirt;
    out.grass = bare * (1 - stone - dirt);
    return out;
  }

  /** The ground's colour for a terrain face at (x, z) with this normal. */
  colour(x: number, z: number, normal: THREE.Vector3, out: THREE.Color): THREE.Color {
    const B = BIOME;
    const S = SNOW_SURFACE;
    const m = this.mix(x, z, normal, _mix);
    if (m.snow > 0) {
      out.copy(GROUND.snowShade).lerp(GROUND.snow, smoothstep(S.shadeFrom, S.shadeTo, normal.y));
      out.lerp(GROUND.ice, smoothstep(S.iceFrom, S.iceTo, normal.y));
    }
    if (m.snow < 1) {
      const green = smoothstep(B.thawStart, B.thawEnd + B.greenAt, this.distance(z));
      _bare.copy(GROUND.grassDry).lerp(GROUND.grass, green).multiplyScalar(m.grass);
      _bare.add(_c.copy(GROUND.dirt).multiplyScalar(m.dirt)).add(_c.copy(GROUND.stone).multiplyScalar(m.stone));
      _bare.multiplyScalar(1 / (1 - m.snow));
      if (m.snow > 0) out.lerp(_bare, 1 - m.snow);
      else out.copy(_bare);
    }
    return out.lerp(GROUND.rock, smoothstep(S.rockFrom, S.rockTo, normal.y));
  }
}

const _mix: GroundMix = { snow: 0, grass: 0, dirt: 0, stone: 0 };
const _c = new THREE.Color();
