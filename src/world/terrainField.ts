import * as THREE from 'three';
import type { NoiseFunction2D } from 'simplex-noise';
import { DescentFeatures } from './features';
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
  /** Moguls – the bumps you bounce over. */
  midScale: 38,
  midAmp: 2.0,
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
  /** Max chance a candidate cell gets a tree, in the densest forest. */
  maxChance: 0.55,
  /** Tree size multiplier at the treeline; reaches 1 at rampEnd. */
  treelineScale: 0.4,
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
  private readonly features: DescentFeatures;
  private readonly spawnHeight: number;

  constructor(readonly seed: number) {
    this.large = makeNoise(seed);
    this.mid = makeNoise(seed + 1);
    this.small = makeNoise(seed + 2);
    this.ridge = makeNoise(seed + 3);
    this.ridgeMask = makeNoise(seed + 4);
    this.forest = makeNoise(seed + 5);
    this.features = new DescentFeatures(seed, makeNoise(seed + 6));
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
    const mid = this.mid(x / s.midScale, z / s.midScale) * s.midAmp;
    const small = this.small(x / s.smallScale, z / s.smallScale) * s.smallAmp;
    const ridgeShape = 1 - Math.abs(this.ridge(x / s.ridgeScaleX, z / s.ridgeScaleZ));
    const ridgeMask = smoothstep(-0.1, 0.5, this.ridgeMask(x / s.ridgeMaskScale, z / s.ridgeMaskScale));
    const ridge = Math.pow(ridgeShape, s.ridgeSharpness) * s.ridgeAmp * ridgeMask;
    return z * s.slope + large + mid + small + ridge + this.features.height(x, z);
  }

  /** Surface normal via central differences. */
  normal(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const e = 0.5;
    const dx = this.height(x + e, z) - this.height(x - e, z);
    const dz = this.height(x, z + e) - this.height(x, z - e);
    return out.set(-dx, 2 * e, -dz).normalize();
  }

  /** 0..TREES.maxChance: probability that a candidate cell here holds a tree. */
  treeDensity(x: number, z: number): number {
    const patches = smoothstep(-0.25, 0.45, this.forest(x / 160, z / 160));
    return patches * this.treeline(z) * TREES.maxChance;
  }

  /** Tree size multiplier: small near the treeline, full size further down. */
  treeScale(z: number): number {
    return TREES.treelineScale + (1 - TREES.treelineScale) * this.treeline(z);
  }

  /** 0 above the treeline, rising to 1 at TREES.rampEnd. */
  private treeline(z: number): number {
    return smoothstep(TREES.rampStart, TREES.rampEnd, -z);
  }
}
