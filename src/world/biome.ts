import * as THREE from 'three';
import type { NoiseFunction2D } from 'simplex-noise';
import type { EnvSample } from './environment';
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
   * Kind noise below `pineBelow` = pine, above `broadleafAbove` = broadleaf, between = spruce. With
   * the ground's shifts below, that came out at ≈43 % pine, 33 % spruce, 24 % broadleaf (measured
   * over 5.5–10 km, seed 1977).
   */
  pineBelow: 0.02,
  broadleafAbove: 0.48,
  /**
   * The ground moves those boundaries, so kinds sort by the land: pine gains on dry, high and sunny
   * ground, broadleaf on low, sheltered ground, and spruce keeps the moist, shaded hollows. Each is
   * a shift in kind noise per unit of the environment's measure away from its middle.
   */
  pineDry: 0.6,
  pineHigh: 0.5,
  pineSun: 1.0,
  broadleafLow: 0.5,
  broadleafSheltered: 0.2,
  /**
   * Grassland woods: noise at `copseScale` m; trees fill cells where it passes `copseFrom` (fully
   * by `copseTo`, at `copseDensity`). Out in the open, small groups of a few trees (finer noise
   * at `groupScale` m past `groupFrom`, at `groupDensity`, see `groupMaskScale`) and the rare lone tree. The edges are
   * narrow on purpose: a wide fade rings every wood with scattered single trees.
   */
  /** Where (m into the thaw) the trees switch from the snow forest's layout to woods and groups. */
  layoutFrom: 400,
  layoutTo: 1000,
  copseScale: 150,
  copseFrom: 0.45,
  copseTo: 0.48,
  copseDensity: 0.7,
  groupScale: 60,
  groupFrom: 0.68,
  groupTo: 0.7,
  groupDensity: 0.9,
  /**
   * Groups only come up where a sparse mask allows (noise at `groupMaskScale` m past
   * `groupMaskFrom`): so there are few of them, each big enough to be a group. A high threshold on
   * the group noise alone gives few groups too, but mostly as single trees (the noise's tips).
   */
  groupMaskScale: 300,
  groupMaskFrom: 0.25,
  loneTrees: 0.0006,
  /**
   * Woods at their edge: a narrow fringe (this much copse noise below `copseFrom`) of sparser,
   * young trees, so a wood thins out instead of stopping dead. Kept narrow: a wide one rings every
   * wood with scattered single trees.
   */
  fringe: 0.035,
  fringeDensity: 0.3,
  /** Inside a wood, trees grow old and big over this much noise past `copseTo`. */
  matureSpan: 0.12,
  /** Groups out in the open are middle-aged; lone trees are old. */
  groupMaturity: 0.4,
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
  /**
   * Drop walls (falling away steeper than `cliffFrom`, rise over run on top of the landform): rock
   * in rocky country (past `cliffRocky`). Elsewhere they're grassy banks, with rock outcrops only on
   * their steepest part (past `outcropFrom`) in patches: noise at `outcropScale` m past
   * `outcropAbove`, about a third of the wall's length. A wall of rock straight across the slope
   * looks laid on, not grown.
   */
  cliffFrom: 0.3,
  cliffRocky: 0.5,
  outcropFrom: 0.5,
  outcropScale: 40,
  outcropAbove: 0.25,
  /** Grass: lush where moisture passes `lushFrom` (full by `lushTo`); parched where it's under `parchedFrom` (fully by `parchedTo`) on sunny faces, at most `parchedMax`. */
  lushFrom: 0.6,
  lushTo: 0.9,
  parchedFrom: 0.35,
  parchedTo: 0.15,
  parchedMax: 0.5,
  /** Sunny: exposure from `sunnyFrom` to `sunnyTo` (the plain slope faces the sun at ≈0.7). */
  sunnyFrom: 0.68,
  sunnyTo: 0.85,
  /**
   * Rock shifts slowly between two greys (noise at `toneScale` m): per-face tones on the 2 m mesh
   * read as a noisy checkerboard.
   */
  toneScale: 30,
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

/** The plain mountain slope's sun exposure (measured median, see EnvSample.exposure). */
const PLAIN_EXPOSURE = 0.7;

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
  stone: new THREE.Color('#827d75'),
  stoneDark: new THREE.Color('#6c6862'),
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

/**
 * What each kind of tree wants from the ground (see treeSuitability), and how densely it stands.
 * Feel values, after how these trees grow: spruce needs moist ground and stands dense and dark;
 * pine copes with dry, poor, exposed ground (ridges, sunny upper slopes) and grows in open stands;
 * broadleaf likes low, sheltered, moderately moist ground.
 */
const PREFERS: Record<Species, {
  /** Weight of moisture away from `moistureMid` (the moisture it's neutral at). */
  moisture: number;
  moistureMid: number;
  /** Penalty on convex crests and edges, and on ridge tops (negative: drawn to them). */
  convex: number;
  ridge: number;
  /** Weight of low ground (elevation under 0.5) and of sunny faces (exposure over the plain slope's). */
  low: number;
  sun: number;
  /** Tree density in its woods and their fringes, × the BIOME densities. */
  density: number;
}> = {
  spruce: { moisture: 1.2, moistureMid: 0.45, convex: 0.6, ridge: 0.7, low: 0, sun: -1, density: 1.2 },
  pine: { moisture: 0.2, moistureMid: 0.3, convex: 0, ridge: -0.2, low: 0, sun: 1, density: 0.65 },
  broadleaf: { moisture: 0.6, moistureMid: 0.5, convex: 0.4, ridge: 0.6, low: 0.5, sun: 0, density: 0.95 },
};

const SUITABILITY = {
  /** Elevation (0 valley floor, 1 ridge top) from which ridge tops start to count. */
  ridgeFrom: 0.75,
  /** How far the woods' noise thresholds move per unit of suitability: more woods where it suits them. */
  shift: 0.2,
};

/**
 * How well a kind of tree takes to the ground here (see PREFERS): roughly −1 (ground it shuns) ..
 * 0.5 (ground it likes). Its woods and forest patches spread or shrink by it.
 */
export function treeSuitability(env: EnvSample, kind: Species): number {
  const P = PREFERS[kind];
  return (
    P.moisture * (env.moisture - P.moistureMid) -
    P.convex * Math.max(0, env.curvature) -
    P.ridge * smoothstep(SUITABILITY.ridgeFrom, 1, env.elevation) +
    P.low * Math.max(0, 0.5 - env.elevation) +
    P.sun * (env.exposure - PLAIN_EXPOSURE)
  );
}

/** A tree stand at a spot: the chance a candidate cell holds a tree, and how mature the trees are (0 young .. 1 old). */
export interface Stand {
  chance: number;
  maturity: number;
}

/** Ground cover across the biomes. Pure functions of position (and the surface's normal). */
export class Biome {
  private readonly patch: NoiseFunction2D;
  private readonly kind: NoiseFunction2D;
  private readonly copse: NoiseFunction2D;
  private readonly geology: NoiseFunction2D;
  private readonly rockLine: NoiseFunction2D;
  private readonly outcrop: NoiseFunction2D;
  private readonly rockTone: NoiseFunction2D;
  private readonly shifts: Shift[] = [];

  constructor(
    seed: number,
    private readonly sun: THREE.Vector3,
  ) {
    this.patch = makeNoise(seed + 20);
    this.kind = makeNoise(seed + 22);
    this.copse = makeNoise(seed + 23);
    this.geology = makeNoise(seed + 30);
    this.rockLine = makeNoise(seed + 31);
    this.outcrop = makeNoise(seed + 32);
    this.rockTone = makeNoise(seed + 33);
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

  /**
   * The grassland's tree stand: woods (old in the core, young at a sparser fringe), small groups out
   * in the open and the odd lone tree, spreading where the ground suits the area's kind of tree and
   * as dense as that kind grows.
   */
  copseStand(x: number, z: number, env: EnvSample, out: Stand = { chance: 0, maturity: 0 }): Stand {
    const B = BIOME;
    const kind = this.areaKind(x, z, env);
    const shift = SUITABILITY.shift * treeSuitability(env, kind);
    const density = PREFERS[kind].density;
    const from = B.copseFrom - shift;
    const to = B.copseTo - shift;
    const n = this.copse(x / B.copseScale, z / B.copseScale);
    const wood = density * B.copseDensity * smoothstep(from, to, n);
    const fringe = n > from - B.fringe && n <= from ? density * B.fringeDensity : 0;
    // Groups at full density whatever the kind: thinned out, they'd mostly come out as single trees.
    const groupMask = smoothstep(B.groupMaskFrom, B.groupMaskFrom + 0.05, this.copse(x / B.groupMaskScale - 41.9, z / B.groupMaskScale + 88.1));
    const group = B.groupDensity * groupMask * smoothstep(B.groupFrom - shift, B.groupTo - shift, this.copse(x / B.groupScale + 71.3, z / B.groupScale - 19.7));
    // The strongest of wood, fringe, group and lone tree decides, with its maturity.
    out.chance = B.loneTrees;
    out.maturity = 1;
    if (fringe > out.chance) Object.assign(out, { chance: fringe, maturity: 0 });
    if (group > out.chance) Object.assign(out, { chance: group, maturity: B.groupMaturity });
    if (wood > out.chance) Object.assign(out, { chance: wood, maturity: smoothstep(to, to + B.matureSpan, n) });
    return out;
  }

  /** The kind of tree an area at (x, z) grows on this ground: the regional kind, sorted by the ground. */
  areaKind(x: number, z: number, env: EnvSample): Species {
    const B = BIOME;
    const n = this.kind(x / B.kindScale, z / B.kindScale);
    const pineBelow = B.pineBelow + B.pineDry * (0.5 - env.moisture) + B.pineHigh * (env.elevation - 0.5) + B.pineSun * (env.exposure - PLAIN_EXPOSURE);
    const broadleafAbove = B.broadleafAbove - B.broadleafLow * (0.5 - env.elevation) - B.broadleafSheltered * Math.max(0, -env.curvature);
    return n < pineBelow ? 'pine' : n > broadleafAbove ? 'broadleaf' : 'spruce';
  }

  /** Which kind of tree grows at (x, z) on this ground, from two per-tree randoms in 0..1. */
  treeSpecies(x: number, z: number, env: EnvSample, r: number, r2: number): Species {
    const B = BIOME;
    const d = this.distance(z);
    // The area's kind, or now and then a random one.
    let kind = this.areaKind(x, z, env);
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
        _bare.copy(GROUND.stone).lerp(GROUND.stoneDark, 0.5 + 0.5 * this.rockTone(x / C.toneScale, z / C.toneScale));
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
    const rocky = smoothstep(C.rockyFrom, C.rockyTo, this.geology(x / C.geologyScale, z / (C.geologyScale * 1.5)));
    if (env.cliff > C.cliffFrom) {
      if (rocky > C.cliffRocky) return true;
      if (env.cliff > C.outcropFrom && this.outcrop(x / C.outcropScale, z / C.outcropScale) > C.outcropAbove) return true;
    }
    const land = (Math.atan(env.slope) * 180) / Math.PI;
    if (land > C.steepRock) return true;
    if (rocky <= 0) return false;
    const line = C.rockLine + C.lineWobble * this.rockLine(x / C.lineWobbleScale, z / C.lineWobbleScale) - (C.steepLower * Math.max(0, land - C.steepFrom)) / 10;
    // Fading into grassy country, the line climbs out of reach rather than the rock thinning out.
    return env.elevation > line + (1 - rocky);
  }

}

