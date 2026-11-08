import * as THREE from 'three';
import type { NoiseFunction2D } from 'simplex-noise';
import type { EnvSample } from './environment';
import { hash2, makeNoise, smoothstep } from './noise';
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
  /** Snow lingers longest on flatter ground, on faces turned away from the sun and in hollows; ridges melt first. */
  flatBonus: 0.25,
  shadeBonus: 0.3,
  hollowBonus: 0.3,
  ridgePenalty: 0.3,
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
};

/**
 * Bare ground (no snow): rock or grass, decided by the landforms, not by single faces, so cliffs
 * read as cliffs and hills as hills. Some country is rocky: there the upper flanks and ridge tops
 * are rock above a wobbling line, the lower flanks and floors green. Anywhere, drop walls and very
 * steep ground are rock. Feel values.
 */
const COVER = {
  /** Rocky and grassy country: noise at `geologyScale` m (stretched along the fall line), rocky past `rockyFrom` (fully by `rockyTo`). */
  geologyScale: 600,
  rockyFrom: 0.05,
  rockyTo: 0.25,
  /**
   * In rocky country, rock from this elevation up (0 valley floor, 1 ridge top; open slope is
   * 0.5), the line wobbling ±`lineWobble` (noise at `lineWobbleScale` m).
   */
  rockLine: 0.55,
  lineWobble: 0.12,
  lineWobbleScale: 90,
  /** Steeper ground goes rocky lower down: the line drops by `steepLower` per 10° of landform slope over `steepFrom`°. */
  steepFrom: 20,
  steepLower: 0.1,
  /** Rock anywhere on landform steeper than this (°). */
  steepRock: 36,
  /** Drop walls are rock where they fall away steeper than this (rise over run, on top of the landform). */
  cliffFrom: 0.3,
  /** Grass: lush where moisture passes `lushFrom` (full by `lushTo`); parched where it's under `parchedFrom` (fully by `parchedTo`) on sunny faces, at most `parchedMax`. */
  lushFrom: 0.6,
  lushTo: 0.9,
  parchedFrom: 0.35,
  parchedTo: 0.15,
  parchedMax: 0.5,
  /** Sunny: exposure from `sunnyFrom` to `sunnyTo` (the plain slope faces the sun at ≈0.7). */
  sunnyFrom: 0.68,
  sunnyTo: 0.85,
  /** Rock faces pick one of the rock tones at random, like facets catching different light. */
  rockToneSeed: 37,
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
  /** Grass in moist ground, and on dry, sunny ground. */
  grassLush: new THREE.Color('#5a8e3e'),
  grassParched: new THREE.Color('#9ea05c'),
  /** Bare rock, in tones the faces pick from. */
  stoneTones: [new THREE.Color('#7f7b74'), new THREE.Color('#716d67'), new THREE.Color('#8b867e'), new THREE.Color('#67635e')],
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
  /**
   * Wind scours convex ground: rock pokes through up to `scouredRock` (in normal.y, ≈8°) sooner,
   * and the snow there takes up to `scouredIce` of the packed, icy tint. Hollows hold drifts: no
   * icy tint at full concavity.
   */
  scouredRock: 0.12,
  scouredIce: 0.6,
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
  private readonly geology: NoiseFunction2D;
  private readonly rockLine: NoiseFunction2D;
  private readonly shifts: Shift[] = [];

  constructor(
    private readonly seed: number,
    private readonly sun: THREE.Vector3,
  ) {
    this.patch = makeNoise(seed + 20);
    this.kind = makeNoise(seed + 22);
    this.copse = makeNoise(seed + 23);
    this.geology = makeNoise(seed + 30);
    this.rockLine = makeNoise(seed + 31);
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
  snowCover(x: number, z: number, normal: THREE.Vector3, env: EnvSample): number {
    const B = BIOME;
    const d = this.distance(z);
    if (d <= B.thawStart) return 1;
    if (d >= B.thawEnd + 200) return 0;
    // Where the thaw has got to (+1.2 before it, −1.2 after), shifted by patches, flat ground and shade.
    const thaw = (1 - smoothstep(B.thawStart, B.thawEnd, d)) * 2.4 - 1.2;
    const patch = this.patch(x / B.patchScale, z / B.patchScale) + B.patchDetail * this.patch(x / B.patchDetailScale + 40, z / B.patchDetailScale);
    const flat = smoothstep(0.9, 1, normal.y);
    const shade = smoothstep(0.3, -0.1, normal.dot(this.sun));
    const hollow = B.hollowBonus * Math.max(0, -env.curvature) - B.ridgePenalty * Math.max(0, env.curvature);
    // A narrow edge: low-poly faces read best as snow or bare, a half-blend looks washed out.
    return smoothstep(-B.patchEdge, B.patchEdge, thaw + B.patchWeight * patch + B.flatBonus * flat + B.shadeBonus * shade + hollow);
  }

  /** What the ground is made of at (x, z), for a surface with this normal (see GroundMix). */
  mix(x: number, z: number, normal: THREE.Vector3, env: EnvSample, out: GroundMix = { snow: 0, grass: 0, dirt: 0, stone: 0 }): GroundMix {
    const snow = this.snowCover(x, z, normal, env);
    const bare = 1 - snow;
    const rock = bare > 0 && this.isRock(x, z, env);
    out.snow = snow;
    out.stone = rock ? bare : 0;
    // `dirt` stays in the mix (always 0 here) so the ground effects keep handling it.
    out.dirt = 0;
    out.grass = rock ? 0 : bare;
    return out;
  }

  /** The ground's colour for a terrain face centred on (x, z) with this normal. */
  colour(x: number, z: number, normal: THREE.Vector3, env: EnvSample, out: THREE.Color): THREE.Color {
    const B = BIOME;
    const S = SNOW_SURFACE;
    const C = COVER;
    const snow = this.snowCover(x, z, normal, env);
    const convex = Math.max(0, env.curvature);
    if (snow > 0) {
      out.copy(GROUND.snowShade).lerp(GROUND.snow, smoothstep(S.shadeFrom, S.shadeTo, normal.y));
      // Packed and icy on steep faces and wind-scoured crests; drifts in hollows stay bright.
      const ice = Math.max(smoothstep(S.iceFrom, S.iceTo, normal.y), S.scouredIce * convex);
      out.lerp(GROUND.ice, ice * (1 - Math.max(0, -env.curvature)));
    }
    if (snow < 1) {
      if (this.isRock(x, z, env)) {
        const tones = GROUND.stoneTones;
        _bare.copy(tones[Math.floor(hash2(Math.round(x * 4), Math.round(z * 4), this.seed + C.rockToneSeed) * tones.length)]);
      } else {
        const green = smoothstep(B.thawStart, B.thawEnd + B.greenAt, this.distance(z));
        _bare.copy(GROUND.grassDry).lerp(GROUND.grass, green);
        // Moisture and sun only show once the grass has greened up.
        _bare.lerp(GROUND.grassLush, green * smoothstep(C.lushFrom, C.lushTo, env.moisture));
        const sunny = smoothstep(C.sunnyFrom, C.sunnyTo, env.exposure);
        _bare.lerp(GROUND.grassParched, C.parchedMax * green * sunny * smoothstep(C.parchedFrom, C.parchedTo, env.moisture));
      }
      if (snow > 0) out.lerp(_bare, 1 - snow);
      else out.copy(_bare);
    }
    const rockFrom = S.rockFrom + (snow > 0 ? S.scouredRock * convex : 0);
    return out.lerp(GROUND.rock, smoothstep(rockFrom, S.rockTo, normal.y));
  }

  /** Whether bare ground at (x, z) is rock (see COVER): from the landforms, so whole forms go rocky together. */
  isRock(x: number, z: number, env: EnvSample): boolean {
    const C = COVER;
    if (env.cliff > C.cliffFrom) return true;
    const land = (Math.atan(env.slope) * 180) / Math.PI;
    if (land > C.steepRock) return true;
    const rocky = smoothstep(C.rockyFrom, C.rockyTo, this.geology(x / C.geologyScale, z / (C.geologyScale * 1.5)));
    if (rocky <= 0) return false;
    const line = C.rockLine + C.lineWobble * this.rockLine(x / C.lineWobbleScale, z / C.lineWobbleScale) - (C.steepLower * Math.max(0, land - C.steepFrom)) / 10;
    // Fading into grassy country, the line climbs out of reach rather than the rock thinning out.
    return env.elevation > line + (1 - rocky);
  }

}

