import type { NoiseFunction2D } from 'simplex-noise';
import { hash2, makeNoise, smoothstep } from './noise';

/**
 * Valleys running roughly with the fall line (−Z), with ridges between them. Each valley follows
 * its own meandering line; the ground rises with the distance from the nearest line, so flank
 * steepness stays under control (see `depth`). Feel values, tuned on relief maps
 * (`node scripts/terrain-map.mjs`).
 */
const VALLEYS = {
  /** Average distance (m) between neighbouring valley lines across the slope. */
  spacing: 360,
  /** How far (× spacing) each line sits off its column's middle, and wanders with `meanderScale` m of descent. */
  jitter: 0.32,
  meanderScale: 700,
  /** All lines bend together: sideways shift (m) from noise at `bendScale` m. */
  bendScale: 900,
  bendAmp: 120,
  /**
   * Ridge tops above the deepest valley floors (m), and the flank's width (m) from a floor's edge
   * to the crest. Exaggerated on purpose, so the valleys read against the base slope (−32 m per
   * 100 m). Steepest flank ≈ 1.5 × depth / flank: 0.5 here (×1.1–1.2 where the lines bend).
   */
  depth: 60,
  flank: 180,
  /**
   * Flank profile: the slope builds up over this share of the flank at the floor's edge and eases
   * off over this share below the crest. A short bottom makes the floor's edge read as one.
   */
  roundFloor: 0.15,
  roundCrest: 0.5,
  /** Flat valley floor either side of the line (m), varying per valley up to + `floorExtra`. */
  floor: 10,
  floorExtra: 20,
  /** Where two flanks meet below their crests, the ridge line is rounded over about this height (m). */
  crestRounding: 3,
  /**
   * Each valley deepens and shallows along its length (fading out entirely where its noise is
   * lowest, so ridges now and then join up), from noise at `fadeScale` m of descent.
   */
  fadeScale: 800,
  /**
   * Some country is deeply cut, some open broad slope: valley depth swings between `reliefMin` and
   * 1 × over `reliefScale` m (stretched along the fall line). The ridge tops stay put, so a
   * shallower valley has a higher floor, never a tilted one.
   */
  reliefScale: 900,
  reliefMin: 0.5,
};

/** Where a spot sits among the valleys (see Landform.inspect), for the dev inspection view. */
export interface LandformSpot {
  /** How far (m) the ground lies below the ridge tops. */
  below: number;
  /** Position across the lowest valley's flank: < 0 on its floor, 0..1 up the flank, ≥ 1 at the top. */
  flank: number;
  /** Distance (m) from that valley's line. */
  fromLine: number;
  /** That valley's depth here (m): little where the country is open, and it fades in and out along its length. */
  depth: number;
}

/**
 * The terrain's large landforms, without the moguls, kicker ridges and set pieces laid over them.
 * A pure function of position, independent of the biomes.
 */
export class Landform {
  private readonly meander: NoiseFunction2D;
  private readonly bend: NoiseFunction2D;
  private readonly fade: NoiseFunction2D;
  private readonly relief: NoiseFunction2D;

  constructor(private readonly seed: number) {
    this.meander = makeNoise(seed + 20);
    this.bend = makeNoise(seed + 21);
    this.fade = makeNoise(seed + 22);
    this.relief = makeNoise(seed + 23);
  }

  /** Height offset (m) of the landforms at (x, z): 0 on the deepest valley floors, up to VALLEYS.depth on a crest. */
  height(x: number, z: number): number {
    return this.valleys(x, z);
  }

  /** What shapes the ground at (x, z): for the dev inspection view. */
  inspect(x: number, z: number): LandformSpot {
    const spot: LandformSpot = { below: 0, flank: Infinity, fromLine: Infinity, depth: 0 };
    spot.below = VALLEYS.depth - this.valleys(x, z, spot);
    return spot;
  }

  private valleys(x: number, z: number, spot?: LandformSpot): number {
    const V = VALLEYS;
    const u = x + V.bendAmp * this.bend(x / (V.bendScale * 2), z / V.bendScale);
    const k0 = Math.floor(u / V.spacing);
    // The ground is as low as the lowest valley profile around it: where two lines come close, the
    // ridge between them sinks and the valleys merge. Lines more than two columns away sit over
    // 2 × spacing off, beyond any floor + flank (keep it so), so they can't lower the ground here.
    let h = V.depth;
    let lowest = V.depth;
    for (let k = k0 - 2; k <= k0 + 2; k++) {
      const line = (k + 0.5 + V.jitter * this.meander(k * 13.7, z / V.meanderScale)) * V.spacing;
      const floor = V.floor + hash2(k, 0, this.seed + 211) * V.floorExtra;
      // Relief read at the valley's line, not here, so the whole valley shares one floor height.
      const relief = V.reliefMin + (1 - V.reliefMin) * smoothstep(-0.4, 0.4, this.relief(line / V.reliefScale, z / (V.reliefScale * 2)));
      const depth = V.depth * relief * smoothstep(-0.8, 0.0, this.fade(k * 9.3, z / V.fadeScale));
      const t = (Math.abs(u - line) - floor) / V.flank;
      const profile = V.depth - depth * (1 - flankProfile(t, V.roundFloor, V.roundCrest));
      h = smoothMin(h, profile, V.crestRounding);
      if (spot && profile < lowest) {
        lowest = profile;
        Object.assign(spot, { flank: t, fromLine: Math.abs(u - line), depth });
      }
    }
    return h;
  }
}

/**
 * 0 on the floor (t ≤ 0) to 1 at the crest (t ≥ 1): a straight flank whose slope builds up over
 * `bottom` of it and eases off over `top`, so both ends are rounded. Steepest: 1 / (1 − (bottom + top) / 2).
 */
function flankProfile(t: number, bottom: number, top: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const m = 1 / (1 - (bottom + top) / 2);
  if (t < bottom) return (m * t * t) / (2 * bottom);
  if (t > 1 - top) return 1 - (m * (1 - t) * (1 - t)) / (2 * top);
  return m * (t - bottom / 2);
}

/** Polynomial smooth minimum: like Math.min, but rounded where a and b are within k of each other. */
function smoothMin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (h * h * k) / 4;
}
