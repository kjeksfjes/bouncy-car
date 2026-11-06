import * as THREE from 'three';
import type { NoiseFunction2D } from 'simplex-noise';
import { makeNoise, smoothstep } from './noise';

/**
 * Shape of the mountain. These are hand-tuned feel values, not physical
 * constants: tweak them to change how the slope rides.
 */
const SHAPE = {
  /** Downhill gradient along −Z (rise over run). 0.2 ≈ 11°. */
  slope: 0.2,
  /** Big rolling hills that bend the fall line. */
  largeScale: 260,
  largeAmp: 12,
  /** Weight of the second, smaller rolling-hill octave. */
  largeDetail: 0.3,
  /** Moguls – the bumps you bounce over. */
  midScale: 38,
  midAmp: 2.6,
  /** Fine surface roughness. */
  smallScale: 9,
  smallAmp: 0.3,
  /** Kicker ridges running across the slope (stretched along X). */
  ridgeScaleX: 110,
  ridgeScaleZ: 30,
  ridgeAmp: 3.2,
  ridgeSharpness: 6,
  ridgeMaskScale: 180,
  /** Around the origin the ground blends into a plain downhill start pad. */
  spawnPadInner: 15,
  spawnPadOuter: 45,
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
  private readonly spawnHeight: number;

  constructor(readonly seed: number) {
    this.large = makeNoise(seed);
    this.mid = makeNoise(seed + 1);
    this.small = makeNoise(seed + 2);
    this.ridge = makeNoise(seed + 3);
    this.ridgeMask = makeNoise(seed + 4);
    this.forest = makeNoise(seed + 5);
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
    return z * s.slope + large + mid + small + ridge;
  }

  /** Surface normal via central differences. */
  normal(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const e = 0.5;
    const dx = this.height(x + e, z) - this.height(x - e, z);
    const dz = this.height(x, z + e) - this.height(x, z - e);
    return out.set(-dx, 2 * e, -dz).normalize();
  }

  /** 0..1 how forested an area is. */
  forestDensity(x: number, z: number): number {
    return smoothstep(-0.25, 0.45, this.forest(x / 160, z / 160));
  }
}
