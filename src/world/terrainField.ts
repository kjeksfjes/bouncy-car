import * as THREE from 'three';
import type { NoiseFunction2D } from 'simplex-noise';
import { SUN_DIR } from '../render/stage';
import { Biome, treeSuitability, type Stand } from './biome';
import type { EnvSample } from './environment';
import { Environment } from './environment';
import { DescentFeatures, type TerrainPreset } from './features';
import { Landform } from './landform';
import { LandmarkLayout } from './landmarks';
import { makeNoise, smoothstep } from './noise';

/**
 * Shape of the mountain. These are hand-tuned feel values, not physical
 * constants: tweak them to change how the slope rides.
 */
const SHAPE = {
  /** Downhill gradient along −Z (rise over run). 0.32 ≈ 18°. */
  slope: 0.32,
  /** Gentle rolling hills under the ridges and valleys (see Landform), so not every rise runs with the fall line. */
  largeScale: 260,
  largeAmp: 5,
  /** Weight of the second, smaller rolling-hill octave. */
  largeDetail: 0.3,
  /**
   * Varied preset only: a broad swell along the fall line, so some stretches run steeper and
   * faster, others gentler (±swellAmp / swellScale ≈ ±0.08 on the slope, more where it turns).
   * Stretched across the slope.
   */
  swellScale: 420,
  swellScaleX: 1600,
  swellAmp: 22,
  /** Moguls – the bumps you bounce over. */
  midScale: 38,
  midAmp: 2.0,
  /** Varied preset only: bumpy and smooth stretches, the moguls swinging between these multiples over `roughScale` m. */
  roughScale: 650,
  roughMin: 0.45,
  roughMax: 1.5,
  /** Fine surface roughness – kept subtle so facets read smooth. */
  smallScale: 9,
  smallAmp: 0.06,
  /**
   * Kicker ridges running across the slope (stretched along X). Must stay
   * several car lengths wide: narrow ridges become spikes that high-centre the car.
   */
  ridgeScaleX: 140,
  ridgeScaleZ: 75,
  ridgeAmp: 2.6,
  ridgeSharpness: 3,
  ridgeMaskScale: 180,
  /**
   * Some kicker ridges come up bigger, for an extra launch: up to `bigKickerMax` × as tall where
   * noise at the ridges' own scale passes `bigKickerFrom` (full by `bigKickerTo`), about one in
   * five ridges. Broader too (their shape's sharpness divided by 1 + `bigKickerWiden` × the extra
   * height), so they stay ramps, not spikes.
   */
  bigKickerFrom: 0.2,
  bigKickerTo: 0.55,
  bigKickerMax: 1.7,
  bigKickerWiden: 0.5,
  /** No rocky knolls (see Landform) within this many metres of the start, or of a set piece. */
  knollSpawnClear: 100,
  knollFeatureClear: 30,
  /** Around the origin the ground blends into a plain downhill start pad. */
  spawnPadInner: 15,
  spawnPadOuter: 45,
};

/**
 * Like a real treeline: bare snow at the top, then sparse small trees that
 * grow denser and taller further down, up to a cap.
 * Distance is measured downhill (−Z) from the spawn.
 */
const TREES = {
  rampStart: 400,
  rampEnd: 2500,
  /**
   * Max chance a candidate cell gets a tree, in the densest forest: 0.55 per 9 m cell, scaled to
   * the 6 m cells (× (6/9)², the same trees per area).
   */
  maxChance: 0.245,
  /** Tree size multiplier at the treeline; reaches 1 at rampEnd. */
  treelineScale: 0.4,
  /** Forest patchiness: smaller groves and gaps. */
  patchScale: 160,
  /**
   * Large open meadows inside the forest zone. Where the meadow noise rises
   * past `meadowFrom`, trees fade out, fully gone by `meadowTo`. Lower
   * thresholds = more open land (noise is roughly −1..1).
   */
  meadowScale: 480,
  meadowFrom: 0.05,
  meadowTo: 0.3,
  /** How far the forest patches' noise thresholds move per unit of tree suitability (see treeSuitability). */
  suitabilityShift: 0.3,
};

/** See TerrainField.surface. */
export interface SurfaceLayers {
  moguls: number;
  kickers: number;
}

const _surface: SurfaceLayers = { moguls: 0, kickers: 0 };
const _stand: Stand = { chance: 0, maturity: 0 };

/** Kicker ridges at full height (m), for scaling them in the dev inspection view. */
export const KICKER_HEIGHT = SHAPE.ridgeAmp;

/**
 * Analytic terrain height h(x, z). Everything (meshes, colliders, props,
 * camera clamping, spawning) reads from this one function, so it stays the
 * single source of truth for the ground.
 */
export class TerrainField {
  private readonly large: NoiseFunction2D;
  private readonly mid: NoiseFunction2D;
  private readonly small: NoiseFunction2D;
  private readonly ridge: NoiseFunction2D;
  private readonly ridgeMask: NoiseFunction2D;
  private readonly forest: NoiseFunction2D;
  private readonly meadow: NoiseFunction2D;
  private readonly swell: NoiseFunction2D;
  private readonly rough: NoiseFunction2D;
  private readonly bigKicker: NoiseFunction2D;
  readonly features: DescentFeatures;
  readonly landforms: Landform;
  /** What the ground is like (slope, curvature, moisture, sun exposure, elevation), for whatever grows on it. */
  readonly environment: Environment;
  private readonly spawnHeight: number;
  /** Ground cover (snow, thaw, grassland) along the descent. */
  readonly biome: Biome;
  /** Giant trees and tors to steer by (trees and boulders keep clear of them). */
  readonly landmarks: LandmarkLayout;

  /** @param preset which terrain generator to use (see TerrainPreset) */
  constructor(
    readonly seed: number,
    private readonly preset: TerrainPreset = 'classic',
  ) {
    this.biome = new Biome(seed, SUN_DIR);
    this.large = makeNoise(seed);
    this.mid = makeNoise(seed + 1);
    this.small = makeNoise(seed + 2);
    this.ridge = makeNoise(seed + 3);
    this.ridgeMask = makeNoise(seed + 4);
    this.forest = makeNoise(seed + 5);
    this.meadow = makeNoise(seed + 7);
    this.swell = makeNoise(seed + 8);
    this.rough = makeNoise(seed + 9);
    this.bigKicker = makeNoise(seed + 10);
    this.features = new DescentFeatures(seed, makeNoise(seed + 6), preset);
    this.landforms = new Landform(seed, (x, z) => this.baseGround(x, z), {
      rockiness: (x, z) => this.biome.rockiness(x, z),
      clear: (x, z, reach) => Math.hypot(x, z) > SHAPE.knollSpawnClear + reach && this.features.clearOf(z, SHAPE.knollFeatureClear + reach),
    });
    this.environment = new Environment(this, SUN_DIR);
    this.landmarks = new LandmarkLayout(this);
    this.spawnHeight = this.rawHeight(0, 0);
  }

  height(x: number, z: number): number {
    return this.heightOver(x, z, this.landform(x, z));
  }

  /**
   * The ground's height at (x, z) given the landform there (see landform): adds the moguls, kicker
   * ridges and set pieces, and the spawn pad. For callers that already have the landform.
   */
  heightOver(x: number, z: number, landform: number): number {
    const raw = this.rawHeight(x, z, landform);
    const pad = smoothstep(SHAPE.spawnPadOuter, SHAPE.spawnPadInner, Math.hypot(x, z));
    if (pad <= 0) return raw;
    return raw + (this.spawnHeight + z * SHAPE.slope - raw) * pad;
  }

  /**
   * The smooth lie of the land: the downhill slope, ridges and valleys with gullies down their
   * flanks, gentle hills (and the varied preset's swell), without the moguls, kicker ridges and set pieces laid over it.
   */
  landform(x: number, z: number): number {
    return this.landforms.height(x, z);
  }

  /** The ground under the landforms: the downhill slope, gentle hills and the varied preset's swell. */
  private baseGround(x: number, z: number): number {
    const s = SHAPE;
    const large =
      (this.large(x / s.largeScale, z / s.largeScale) +
        s.largeDetail * this.large(x / (s.largeScale * 0.42) + 31.7, z / (s.largeScale * 0.42) - 12.3)) *
      s.largeAmp;
    const swell = this.preset === 'varied' ? this.swell(x / s.swellScaleX, z / s.swellScale) * s.swellAmp : 0;
    return z * s.slope + swell + large;
  }

  /** The small-scale layers laid over the landform: moguls (with the fine roughness) and kicker ridges, in m. */
  surface(x: number, z: number, out: SurfaceLayers = { moguls: 0, kickers: 0 }): SurfaceLayers {
    const s = SHAPE;
    const roughness =
      this.preset === 'varied'
        ? s.roughMin + (s.roughMax - s.roughMin) * smoothstep(-0.4, 0.6, this.rough(x / s.roughScale, z / s.roughScale))
        : 1;
    const mid = this.mid(x / s.midScale, z / s.midScale) * s.midAmp * roughness;
    const small = this.small(x / s.smallScale, z / s.smallScale) * s.smallAmp;
    const big = smoothstep(s.bigKickerFrom, s.bigKickerTo, this.bigKicker(x / s.ridgeScaleX, z / s.ridgeScaleZ));
    const size = 1 + (s.bigKickerMax - 1) * big;
    const ridgeShape = 1 - Math.abs(this.ridge(x / s.ridgeScaleX, z / s.ridgeScaleZ));
    const ridgeMask = smoothstep(-0.1, 0.5, this.ridgeMask(x / s.ridgeMaskScale, z / s.ridgeMaskScale));
    out.moguls = mid + small;
    out.kickers = Math.pow(ridgeShape, s.ridgeSharpness / (1 + (size - 1) * s.bigKickerWiden)) * s.ridgeAmp * size * ridgeMask;
    return out;
  }

  private rawHeight(x: number, z: number, landform = this.landform(x, z)): number {
    const layers = this.surface(x, z, _surface);
    return landform + layers.moguls + layers.kickers + this.features.height(x, z);
  }

  /** Surface normal via central differences. */
  normal(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const e = 0.5;
    const dx = this.height(x + e, z) - this.height(x - e, z);
    const dz = this.height(x, z + e) - this.height(x, z - e);
    return out.set(-dx, 2 * e, -dz).normalize();
  }

  /**
   * The tree stand at (x, z) on this ground: the chance a candidate cell holds a tree, and how
   * mature its trees are (see Stand). The snow forest's patches spread where the ground suits trees,
   * old in their dense middles.
   */
  treeStand(x: number, z: number, env: EnvSample, out: Stand = { chance: 0, maturity: 0 }): Stand {
    const T = TREES;
    // The snow forest is spruce.
    const shift = T.suitabilityShift * treeSuitability(env, 'spruce') - this.biome.woodsShift(x, z, env);
    const patches = smoothstep(-0.25 - shift, 0.45 - shift, this.forest(x / T.patchScale, z / T.patchScale));
    const open = smoothstep(T.meadowFrom, T.meadowTo, this.meadow(x / T.meadowScale, z / T.meadowScale));
    // Lanes keep a way open through every wood (see Biome.lane).
    const keep = 1 - this.biome.lane(x, z);
    const forest = patches * (1 - open) * this.treeline(z) * T.maxChance * keep;
    // In the grassland the trees gather into woods and groups instead.
    const g = this.biome.grassland(z);
    if (g <= 0) return Object.assign(out, { chance: forest, maturity: patches });
    const copse = this.biome.copseStand(x, z, env, _stand);
    out.chance = forest + (copse.chance * keep - forest) * g;
    out.maturity = patches + (copse.maturity - patches) * g;
    return out;
  }

  /** Tree size multiplier: small near the treeline, full size further down. */
  treeScale(z: number): number {
    return TREES.treelineScale + (1 - TREES.treelineScale) * this.treeline(z);
  }

  /** 0 above the treeline, rising to 1 at TREES.rampEnd. */
  private treeline(z: number): number {
    return smoothstep(TREES.rampStart, TREES.rampEnd, this.biome.distance(z));
  }
}
