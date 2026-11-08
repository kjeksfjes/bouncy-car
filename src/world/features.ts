import type { NoiseFunction2D } from 'simplex-noise';
import { hash2, smoothstep } from './noise';

type Kind = 'drop' | 'kicker' | 'valley' | 'hill';

/**
 * Set pieces along the descent, at most one per slot, each spanning the whole slope (its line
 * wiggles across it): drops (some huge, some with a ski-jump lip), kickers (a ramp and a landing
 * slope), valleys to dive into and climb out of, and hills to crest. Feel values, tune freely.
 */
const FEATURES = {
  /** Metres of descent (−Z) per feature slot; at most one feature per slot. */
  slot: 380,
  /** Distance kept from slot edges: covers the line's wiggle (`waveAmp`) with room to spare. */
  margin: 35,
  chance: 0.85,
  /** Slot 0 (the start) stays plain. */
  firstSlot: 1,
  /** How often each kind comes up (relative weights). */
  weights: { drop: 0.3, kicker: 0.25, valley: 0.25, hill: 0.2 } satisfies Record<Kind, number>,
  /** Drops: height (m), with a share of them big; their length keeps the face under `maxExtraSlope`. */
  dropMin: 15,
  dropMax: 45,
  bigDropChance: 0.25,
  bigDropMin: 50,
  bigDropMax: 75,
  lengthMin: 45,
  lengthMax: 90,
  /** Cap on a drop's extra gradient (peak of a smoothstep is 1.5 × drop / length): ≈47° with the base slope. */
  maxExtraSlope: 0.75,
  /** A share of drops get a ski-jump lip: height, run-up and back (m). */
  lipChance: 0.4,
  lipMin: 1.6,
  lipMax: 2.8,
  lipUp: 10,
  lipDown: 5,
  /**
   * Kickers: a curved ramp, steepest at its lip so it launches, a steep back, and a landing slope
   * dropping away behind it. At 2.5 m over 14 m the lip kicks ≈20° up from the slope.
   */
  kickerMin: 1.8,
  kickerMax: 3.4,
  kickerUp: [12, 18],
  kickerDown: 3,
  kickerDrop: [5, 14],
  kickerLength: [30, 55],
  /** Ramp shapes: height rises as t^power along the run-up (2 = steepest at the lip). */
  kickerPower: 2,
  lipPower: 1.5,
  /** Valleys (m deep) and hills (m high), as a cos² bell across the slope. */
  valleyDepth: [12, 35],
  hillHeight: [8, 25],
  /**
   * Half width of a valley or hill relative to its depth: wide enough that its steepest side
   * (π/2 × depth / half width, ≈0.87) leaves the climb out at most ≈29° against the base slope,
   * which the car can manage even from a standstill. Plus up to `bellExtra` × depth wider.
   */
  bellWidth: 1.8,
  bellExtra: 2,
  /** The feature line wiggles across the slope instead of running dead straight. */
  waveAmp: 25,
  waveScale: 220,
};

/** Slots beyond this (≈ 3800 km downhill) are treated as a bug, not terrain. */
const MAX_SLOT = 10_000;

interface Feature {
  kind: Kind;
  /** Z where the feature is anchored, before the wave offset: a drop's top, a bell's middle. */
  z: number;
  /** Drops and kickers: the height lost (it carries on into every later slot) and over what length. */
  drop: number;
  length: number;
  /** Lip or kicker ramp: height, run-up and back lengths, and ramp shape (0 height = none). */
  lip: number;
  lipUp: number;
  lipDown: number;
  lipPower: number;
  /** Valleys (negative) and hills (positive): height at the middle, and half width. */
  bell: number;
  halfWidth: number;
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
    // The drop sum walks every slot up to k: refuse absurd positions (a body that blew
    // up) loudly instead of looping for ever.
    if (!(k <= MAX_SLOT)) throw new Error(`Terrain height requested at z=${z}, outside the playable range`);
    let h = -this.cumulativeDrop(k);
    const f = this.feature(k);
    if (!f) return h;

    const zs = f.z + F.waveAmp * this.wave(x / F.waveScale, k * 7.31);
    if (f.drop > 0) h -= f.drop * smoothstep(0, 1, (zs - z) / f.length);
    if (f.lip > 0) {
      // Peak just uphill of the drop's top: a run-up rising as t^power, then a short steep back.
      const peak = zs + f.lipDown;
      if (z >= peak && z < peak + f.lipUp) h += f.lip * ((peak + f.lipUp - z) / f.lipUp) ** f.lipPower;
      else if (z < peak && z > zs) h += f.lip * smoothstep(0, 1, (z - zs) / f.lipDown);
    }
    if (f.bell !== 0) {
      const u = (z - zs) / f.halfWidth;
      if (Math.abs(u) < 1) h += f.bell * Math.cos((u * Math.PI) / 2) ** 2;
    }
    return h;
  }

  private feature(k: number): Feature | null {
    let f = this.features.get(k);
    if (f !== undefined) return f;
    const F = FEATURES;
    const r = (i: number) => hash2(k, i, this.seed + 101);
    const range = ([a, b]: readonly number[], i: number) => a + r(i) * (b - a);
    f = null;
    if (k >= F.firstSlot && r(0) < F.chance) {
      const kind = pick(F.weights, r(1));
      const base: Feature = { kind, z: 0, drop: 0, length: 1, lip: 0, lipUp: 1, lipDown: 1, lipPower: 1, bell: 0, halfWidth: 1 };
      // How far the feature reaches uphill and downhill of its anchor.
      let up = 0;
      let down = 0;
      if (kind === 'drop') {
        const big = r(2) < F.bigDropChance;
        base.drop = big ? range([F.bigDropMin, F.bigDropMax], 3) : range([F.dropMin, F.dropMax], 3);
        base.length = Math.max(range([F.lengthMin, F.lengthMax], 4), (1.5 * base.drop) / F.maxExtraSlope);
        if (r(5) < F.lipChance) {
          Object.assign(base, { lip: range([F.lipMin, F.lipMax], 6), lipUp: F.lipUp, lipDown: F.lipDown, lipPower: F.lipPower });
        }
        up = base.lipUp + base.lipDown;
        down = base.length;
      } else if (kind === 'kicker') {
        base.drop = range(F.kickerDrop, 3);
        base.length = range(F.kickerLength, 4);
        Object.assign(base, { lip: range([F.kickerMin, F.kickerMax], 5), lipUp: range(F.kickerUp, 6), lipDown: F.kickerDown, lipPower: F.kickerPower });
        up = base.lipUp + base.lipDown;
        down = base.length;
      } else {
        const size = kind === 'valley' ? range(F.valleyDepth, 3) : range(F.hillHeight, 3);
        base.bell = kind === 'valley' ? -size : size;
        base.halfWidth = size * (F.bellWidth + r(4) * F.bellExtra);
        up = down = base.halfWidth;
      }
      // Anchor somewhere in the slot with the whole feature inside its margins.
      const room = F.slot - 2 * F.margin - up - down;
      base.z = -k * F.slot - F.margin - up - r(7) * Math.max(0, room);
      f = base;
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

/** Picks a key with probability proportional to its weight, from `r` in 0..1. */
function pick<K extends string>(weights: Record<K, number>, r: number): K {
  const entries = Object.entries(weights) as [K, number][];
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let acc = 0;
  for (const [key, w] of entries) {
    acc += w / total;
    if (r < acc) return key;
  }
  return entries[entries.length - 1][0];
}
