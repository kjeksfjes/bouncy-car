import type { NoiseFunction2D } from 'simplex-noise';
import { hash2, smoothstep } from './noise';

/**
 * Occasional set pieces along the descent: steep drops, half of them with a
 * launch lip at the top (ski-jump style, so the long flight lands on a slope
 * instead of flat ground). Feel values, tune freely.
 */
const FEATURES = {
  /** Metres of descent (−Z) per feature slot; at most one feature per slot. */
  slot: 450,
  /** Distance kept from slot edges; must cover the lip, the wave and the drop length. */
  margin: 120,
  chance: 0.65,
  /** Slot 0 (the start) stays plain. */
  firstSlot: 1,
  dropMin: 12,
  dropMax: 40,
  lengthMin: 45,
  lengthMax: 90,
  /** Cap on the drop's extra gradient (peak of a smoothstep is 1.5 × drop / length). */
  maxExtraSlope: 0.75,
  jumpChance: 0.5,
  lipMin: 1.6,
  lipMax: 2.8,
  lipWidth: 16,
  /** The drop line wiggles across the slope instead of running dead straight. */
  waveAmp: 25,
  waveScale: 220,
};

interface Feature {
  /** Z where the drop begins (before the wave offset). */
  zStart: number;
  drop: number;
  length: number;
  /** Launch lip height; 0 = plain drop. */
  lip: number;
}

/** Height offsets from descent features. Deterministic per seed. */
export class DescentFeatures {
  private readonly features = new Map<number, Feature | null>();
  /** cumulative[k] = total drop of all slots before slot k. */
  private readonly cumulative: number[] = [0];

  constructor(
    private readonly seed: number,
    private readonly wave: NoiseFunction2D,
  ) {}

  height(x: number, z: number): number {
    if (z >= 0) return 0;
    const F = FEATURES;
    const k = Math.floor(-z / F.slot);
    let h = -this.cumulativeDrop(k);
    const f = this.feature(k);
    if (!f) return h;

    const zs = f.zStart + F.waveAmp * this.wave(x / F.waveScale, k * 7.31);
    h -= f.drop * smoothstep(0, 1, (zs - z) / f.length);
    if (f.lip > 0) {
      // Smooth hump just uphill of the drop; its back side runs into the drop.
      const u = (z - (zs + F.lipWidth * 0.35)) / (F.lipWidth / 2);
      if (Math.abs(u) < 1) h += f.lip * (1 - u * u) ** 2;
    }
    return h;
  }

  private feature(k: number): Feature | null {
    let f = this.features.get(k);
    if (f !== undefined) return f;
    const F = FEATURES;
    const r = (i: number) => hash2(k, i, this.seed + 101);
    f = null;
    if (k >= F.firstSlot && r(0) < F.chance) {
      const drop = F.dropMin + r(1) * (F.dropMax - F.dropMin);
      const length = Math.max(F.lengthMin + r(2) * (F.lengthMax - F.lengthMin), (1.5 * drop) / F.maxExtraSlope);
      const room = F.slot - 2 * F.margin - length;
      f = {
        zStart: -k * F.slot - F.margin - r(3) * Math.max(0, room),
        drop,
        length,
        lip: r(4) < F.jumpChance ? F.lipMin + r(5) * (F.lipMax - F.lipMin) : 0,
      };
    }
    this.features.set(k, f);
    return f;
  }

  private cumulativeDrop(k: number): number {
    while (this.cumulative.length <= k) {
      const j = this.cumulative.length - 1;
      this.cumulative.push(this.cumulative[j] + (this.feature(j)?.drop ?? 0));
    }
    return this.cumulative[k];
  }
}
