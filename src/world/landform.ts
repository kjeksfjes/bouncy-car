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

/**
 * Ledges: shoulders along a valley's flank where it levels off for a stretch, steeper above and
 * below to make up the height. Each side of each valley has its own ledge height, and ledges come
 * and go along the valley. Feel values.
 */
const LEDGES = {
  /** Where up the flank (0 floor .. 1 crest) a side's ledge sits: per side, between these. */
  at: [0.3, 0.65] as const,
  /**
   * Half width of the ledge, as a share of the flank (× VALLEYS.flank m: ≈22 m). At full strength
   * its middle is level and the rest of the flank steepens by 1 / (1 − width): ≈14 %.
   */
  width: 0.12,
  /** Ledges come and go along the valley: strength from noise at `scale` m of descent, full past `fullAt`. */
  scale: 450,
  from: -0.1,
  fullAt: 0.35,
};

/**
 * Gullies: grooves cut down the valley flanks, following the ground's own fall line (so they run
 * slantwise into the valleys and bend with them), forking and joining. An analytic erosion filter:
 * stripes along the fall line, blended between jittered points so their phase wanders. Feel values.
 */
const GULLIES = {
  /** Roughly the distance (m) between neighbouring gullies. */
  cell: 55,
  /**
   * Groove depth scale (m). Blending the stripes averages them down, so actual grooves come out
   * around a third of this below the ribs, more where several line up.
   */
  depth: 14,
  /**
   * The fall line the gullies follow is worked out on a grid of this spacing (m) and blended in
   * between: it turns smoothly over ridge lines (no notches where it swings round) and is cached.
   */
  directionGrid: 16,
  /**
   * Where the fall line turns sharply from one grid node to the next (ridge lines, ledges, floor
   * edges) the stripes would spin round and leave notches: gullies fade out as neighbouring
   * directions part from `turnFrom`° to `turnTo`°.
   */
  turnFrom: 10,
  turnTo: 80,
  /** How quickly a jittered point's stripes fade with distance (per cell², Gaussian). */
  falloff: 2.5,
  /** On a valley's flank: grow in over this share above the floor, fade out above `crestFade`. */
  floorFade: 0.15,
  crestFade: [0.6, 1] as const,
  /**
   * Gullies start below a ridge line between two valleys: they fade in until the ground lies this
   * far (m) below where the two valleys' flanks meet. At the line itself the fall line flips side,
   * and the stripes would jump with it.
   */
  ridgeFade: 10,
  /** Valleys shallower than `openBelow` m count as open slope, where gullies are this much weaker. */
  open: 0.3,
  openBelow: [8, 25] as const,
  /** Some stretches gully up more than others: patches of noise at `patchScale` m. */
  patchScale: 350,
  patchMin: 0.4,
};

/** Where a spot sits among the valleys and what shapes it (see Landform.sample). */
export interface LandformSpot {
  /** How far (m) the ground lies below the ridge tops. */
  below: number;
  /** Position across the lowest valley's flank: < 0 on its floor, 0..1 up the flank, ≥ 1 at the top. */
  flank: number;
  /** Distance (m) from that valley's line. */
  fromLine: number;
  /** That valley's depth here (m): little where the country is open, and it fades in and out along its length. */
  depth: number;
  /** Ledge strength here (0..1): 1 in the level middle of a full ledge. */
  ledge: number;
  /** How far (m) the ground lies below the next-lowest valley's flank: 0 on a ridge line between two valleys. */
  ridgeGap: number;
  /** The gullies' height offset (m): negative in a groove, positive on the rib between two. */
  gully: number;
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
  private readonly patch: NoiseFunction2D;
  private readonly ledgeNoise: NoiseFunction2D;
  private readonly scratch: LandformSpot = emptySpot();
  /** Fall-line direction at directionGrid nodes, by node key: pure, so safe to keep. */
  private readonly directions = new Map<string, [number, number]>();
  private readonly coherences = new Map<string, number>();

  /**
   * @param base the smooth ground the landforms are laid on (the downhill slope and gentle hills),
   *   which the gullies follow down along with the valleys
   */
  constructor(
    private readonly seed: number,
    private readonly base: (x: number, z: number) => number,
  ) {
    this.meander = makeNoise(seed + 20);
    this.bend = makeNoise(seed + 21);
    this.fade = makeNoise(seed + 22);
    this.relief = makeNoise(seed + 23);
    this.patch = makeNoise(seed + 24);
    this.ledgeNoise = makeNoise(seed + 25);
  }

  /** The smooth lie of the land at (x, z): the base with valleys and gullies cut into it. */
  height(x: number, z: number): number {
    return this.evaluate(x, z, this.scratch);
  }

  /** The landform's height at (x, z), filling `spot` with what shapes it there. */
  sample(x: number, z: number, spot: LandformSpot): number {
    return this.evaluate(x, z, spot);
  }

  /** What shapes the ground at (x, z): for the dev inspection view. */
  inspect(x: number, z: number): LandformSpot {
    const spot = emptySpot();
    this.evaluate(x, z, spot);
    return spot;
  }

  /** The ledge on one side of valley k at descent z, applied to flank position t. */
  private ledge(k: number, right: boolean, z: number, t: number): { t: number; here: number } {
    const L = LEDGES;
    if (t <= 0 || t >= 1) return { t, here: 0 };
    const side = right ? 1 : 0;
    const at = L.at[0] + (L.at[1] - L.at[0]) * hash2(k, side, this.seed + 251);
    const strength = smoothstep(L.from, L.fullAt, this.ledgeNoise(k * 7.7 + side * 3.1, z / L.scale));
    return ledgeShift(t, at, L.width, strength);
  }

  private evaluate(x: number, z: number, spot: LandformSpot): number {
    const valleys = this.valleys(x, z, spot);
    spot.below = VALLEYS.depth - valleys;
    spot.gully = this.gullies(x, z, spot);
    return this.base(x, z) + valleys + spot.gully;
  }

  /**
   * The ground's gradient (base and valleys) at (x, z), blended from the direction grid, and how
   * steady the direction is around here (see gridCoherence), blended the same way.
   */
  private fallLine(x: number, z: number): [number, number, number] {
    const n = GULLIES.directionGrid;
    const fx = x / n;
    const fz = z / n;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const a = this.gridGradient(ix, iz);
    const b = this.gridGradient(ix + 1, iz);
    const c = this.gridGradient(ix, iz + 1);
    const d = this.gridGradient(ix + 1, iz + 1);
    const gx = (a[0] * (1 - tx) + b[0] * tx) * (1 - tz) + (c[0] * (1 - tx) + d[0] * tx) * tz;
    const gz = (a[1] * (1 - tx) + b[1] * tx) * (1 - tz) + (c[1] * (1 - tx) + d[1] * tx) * tz;
    const ca = this.gridCoherence(ix, iz);
    const cb = this.gridCoherence(ix + 1, iz);
    const cc = this.gridCoherence(ix, iz + 1);
    const cd = this.gridCoherence(ix + 1, iz + 1);
    const coherence = (ca * (1 - tx) + cb * tx) * (1 - tz) + (cc * (1 - tx) + cd * tx) * tz;
    return [gx, gz, coherence];
  }

  /** Cosine of the widest angle between a grid node's direction and its four neighbours'. */
  private gridCoherence(ix: number, iz: number): number {
    const key = `${ix},${iz}`;
    let c = this.coherences.get(key);
    if (c !== undefined) return c;
    const unit = (g: [number, number]) => {
      const len = Math.hypot(g[0], g[1]);
      return [g[0] / len, g[1] / len];
    };
    const [ux, uz] = unit(this.gridGradient(ix, iz));
    c = 1;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const [vx, vz] = unit(this.gridGradient(ix + dx, iz + dz));
      c = Math.min(c, ux * vx + uz * vz);
    }
    if (this.coherences.size > 200_000) this.coherences.clear();
    this.coherences.set(key, c);
    return c;
  }

  private gridGradient(ix: number, iz: number): [number, number] {
    const key = `${ix},${iz}`;
    let g = this.directions.get(key);
    if (g) return g;
    const n = GULLIES.directionGrid;
    const x = ix * n;
    const z = iz * n;
    const e = n / 2;
    const ground = (px: number, pz: number) => this.base(px, pz) + this.valleys(px, pz);
    g = [(ground(x + e, z) - ground(x - e, z)) / (2 * e), (ground(x, z + e) - ground(x, z - e)) / (2 * e)];
    // The streamed terrain uses a few thousand nodes; drop them all now and then rather than track use.
    if (this.directions.size > 200_000) this.directions.clear();
    this.directions.set(key, g);
    return g;
  }

  /** Gully height offset at (x, z). */
  private gullies(x: number, z: number, spot: LandformSpot): number {
    const G = GULLIES;
    const onFlank = smoothstep(0, G.floorFade, spot.flank) * smoothstep(G.crestFade[1], G.crestFade[0], spot.flank);
    const valley = smoothstep(G.openBelow[0], G.openBelow[1], spot.depth);
    const patch = G.patchMin + (1 - G.patchMin) * smoothstep(-0.3, 0.3, this.patch(x / G.patchScale, z / G.patchScale));
    const belowRidge = smoothstep(0, G.ridgeFade, spot.ridgeGap);
    // Across a ledge the fall line swings round within metres (as on a ridge line): fade them out.
    const offLedge = 1 - spot.ledge;
    const strength = (G.open + (onFlank - G.open) * valley) * patch * belowRidge * offLedge;
    if (strength <= 0) return 0;
    // Stripes run along the fall line: their phase advances across it.
    const [gx, gz, coherence] = this.fallLine(x, z);
    const steady = smoothstep(Math.cos((G.turnTo * Math.PI) / 180), Math.cos((G.turnFrom * Math.PI) / 180), coherence);
    if (steady <= 0) return 0;
    const len = Math.hypot(gx, gz);
    const ax = gz / len;
    const az = -gx / len;
    const cx = x / G.cell;
    const cz = z / G.cell;
    const ix = Math.floor(cx - 0.5);
    const iz = Math.floor(cz - 0.5);
    let sum = 0;
    let weights = 0;
    // 4 × 4 jittered points around the spot; any point left out is over 1.5 cells away, where its
    // weight is under exp(−2.5 × 1.5²) ≈ 0.4 %, so the seams it leaves are about a centimetre.
    for (let j = -1; j <= 2; j++) {
      for (let i = -1; i <= 2; i++) {
        const dx = cx - (ix + i + hash2(ix + i, iz + j, this.seed + 241));
        const dz = cz - (iz + j + hash2(ix + i, iz + j, this.seed + 242));
        const w = Math.exp(-(dx * dx + dz * dz) * G.falloff);
        sum += w * Math.cos(2 * Math.PI * (dx * ax + dz * az));
        weights += w;
      }
    }
    return (G.depth / 2) * strength * steady * (sum / weights);
  }

  /** Height offset (m) of the valleys: 0 on the deepest floors, up to VALLEYS.depth on a crest. */
  private valleys(x: number, z: number, spot?: LandformSpot): number {
    const V = VALLEYS;
    const u = x + V.bendAmp * this.bend(x / (V.bendScale * 2), z / V.bendScale);
    const k0 = Math.floor(u / V.spacing);
    // The ground is as low as the lowest valley profile around it: where two lines come close, the
    // ridge between them sinks and the valleys merge. Lines more than two columns away sit over
    // 2 × spacing off, beyond any floor + flank (keep it so), so they can't lower the ground here.
    let h = V.depth;
    let lowest = V.depth;
    let second = V.depth;
    // Start from a clean slate: on a crest no valley lies below, and stale values from the last
    // spot would leak in (the gullies read them).
    if (spot) Object.assign(spot, emptySpot());
    for (let k = k0 - 2; k <= k0 + 2; k++) {
      const line = (k + 0.5 + V.jitter * this.meander(k * 13.7, z / V.meanderScale)) * V.spacing;
      const floor = V.floor + hash2(k, 0, this.seed + 211) * V.floorExtra;
      // Relief read at the valley's line, not here, so the whole valley shares one floor height.
      const relief = V.reliefMin + (1 - V.reliefMin) * smoothstep(-0.4, 0.4, this.relief(line / V.reliefScale, z / (V.reliefScale * 2)));
      const depth = V.depth * relief * smoothstep(-0.8, 0.0, this.fade(k * 9.3, z / V.fadeScale));
      const t = (Math.abs(u - line) - floor) / V.flank;
      const ledge = this.ledge(k, u > line, z, t);
      const profile = V.depth - depth * (1 - flankProfile(ledge.t, V.roundFloor, V.roundCrest));
      h = smoothMin(h, profile, V.crestRounding);
      if (spot && profile < lowest) {
        second = lowest;
        lowest = profile;
        Object.assign(spot, { flank: t, fromLine: Math.abs(u - line), depth, ledge: ledge.here });
      } else if (profile < second) {
        second = profile;
      }
    }
    if (spot) spot.ridgeGap = second - lowest;
    return h;
  }
}

export function emptySpot(): LandformSpot {
  return { below: 0, flank: Infinity, fromLine: Infinity, depth: 0, ledge: 0, ridgeGap: Infinity, gully: 0 };
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

/**
 * Moves position `t` along a flank (0..1) so the flank levels off around `at` (half width `w`)
 * with `strength` 0..1, steepening the rest to keep both ends in place. Returns the moved
 * position and how level it is here (0..1).
 */
function ledgeShift(t: number, at: number, w: number, strength: number): { t: number; here: number } {
  if (strength <= 0 || t <= 0 || t >= 1) return { t, here: 0 };
  // A cosine bump of area w around `at`, and its integral up to t.
  const d = t - at;
  const bump = Math.abs(d) < w ? 0.5 * (1 + Math.cos((Math.PI * d) / w)) : 0;
  const area = d <= -w ? 0 : d >= w ? w : 0.5 * (d + w) + (w / (2 * Math.PI)) * Math.sin((Math.PI * d) / w);
  // The slope dt'/dt is 1 − a (bump − w): level at the middle when a = 1 / (1 − w).
  const a = strength / (1 - w);
  return { t: t - a * (area - w * t), here: strength * bump };
}

/** Polynomial smooth minimum: like Math.min, but rounded where a and b are within k of each other. */
function smoothMin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (h * h * k) / 4;
}
