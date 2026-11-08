import * as THREE from 'three';
import type { NoiseFunction2D } from 'simplex-noise';
import { SUN_DIR } from '../render/stage';
import { Biome } from './biome';
import { DescentFeatures, type TerrainPreset } from './features';
import { makeNoise, smoothstep } from './noise';

/**
 * Shape of the mountain. These are hand-tuned feel values, not physical
 * constants: tweak them to change how the slope rides.
 */
const SHAPE = {
  /** Downhill gradient along −Z (rise over run). 0.32 ≈ 18°. */
  slope: 0.32,
  /** Big rolling hills that bend the fall line. */
  largeScale: 260,
  largeAmp: 12,
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
};

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
  private readonly features: DescentFeatures;
  private readonly spawnHeight: number;
  /** Ground cover (snow, thaw, grassland) along the descent. */
  readonly biome: Biome;

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
    this.features = new DescentFeatures(seed, makeNoise(seed + 6), preset);
    this.spawnHeight = this.rawHeight(0, 0);
  }

  height(x: number, z: number): number {
    const raw = this.rawHeight(x, z);
    const pad = smoothstep(SHAPE.spawnPadOuter, SHAPE.spawnPadInner, Math.hypot(x, z));
    if (pad <= 0) return raw;
    return raw + (this.spawnHeight + z * SHAPE.slope - raw) * pad;
  }

  private rawHeight(x: number, z: number): number {
    const s = SHAPE;
    const large =
      (this.large(x / s.largeScale, z / s.largeScale) +
        s.largeDetail * this.large(x / (s.largeScale * 0.42) + 31.7, z / (s.largeScale * 0.42) - 12.3)) *
      s.largeAmp;
    const varied = this.preset === 'varied';
    const swell = varied ? this.swell(x / s.swellScaleX, z / s.swellScale) * s.swellAmp : 0;
    const roughness = varied
      ? s.roughMin + (s.roughMax - s.roughMin) * smoothstep(-0.4, 0.6, this.rough(x / s.roughScale, z / s.roughScale))
      : 1;
    const mid = this.mid(x / s.midScale, z / s.midScale) * s.midAmp * roughness;
    const small = this.small(x / s.smallScale, z / s.smallScale) * s.smallAmp;
    const ridgeShape = 1 - Math.abs(this.ridge(x / s.ridgeScaleX, z / s.ridgeScaleZ));
    const ridgeMask = smoothstep(-0.1, 0.5, this.ridgeMask(x / s.ridgeMaskScale, z / s.ridgeMaskScale));
    const ridge = Math.pow(ridgeShape, s.ridgeSharpness) * s.ridgeAmp * ridgeMask;
    return z * s.slope + swell + large + mid + small + ridge + this.features.height(x, z);
  }

  /** Surface normal via central differences. */
  normal(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const e = 0.5;
    const dx = this.height(x + e, z) - this.height(x - e, z);
    const dz = this.height(x, z + e) - this.height(x, z - e);
    return out.set(-dx, 2 * e, -dz).normalize();
  }

  /** 0..1: probability that a candidate cell here holds a tree. */
  treeDensity(x: number, z: number): number {
    const T = TREES;
    const patches = smoothstep(-0.25, 0.45, this.forest(x / T.patchScale, z / T.patchScale));
    const open = smoothstep(T.meadowFrom, T.meadowTo, this.meadow(x / T.meadowScale, z / T.meadowScale));
    const forest = patches * (1 - open) * this.treeline(z) * T.maxChance;
    // In the grassland the trees gather into copses instead.
    const g = this.biome.grassland(z);
    return g > 0 ? forest + (this.biome.copseDensity(x, z) - forest) * g : forest;
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
