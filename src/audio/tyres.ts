import { type DragSound, type GrindSound } from './scrape';

/**
 * Tyre sounds by ground. Feel values; the squeal is tuned by ear, the rest only first impressions.
 *
 * What drives them (after van den Doel et al. 2001 and the driving-game patent US 8078300):
 * - Road speed: rolling. Sideways slip: sliding and squeal.
 * - Load on the tyres (Car.tyreLoad): loudness of everything (∝ √load), silent when they carry
 *   next to nothing; and the squeal's pitch (more load, lower). Speed doesn't set the pitch.
 * - Slip angle: how aggressive a slide is: the squeal rougher and brighter, other grounds
 *   brighter and grittier with more grains (SLIDE_WILD).
 *
 * Rolling is the tread going over the ground's roughness: the rough surface profile played at
 * road speed (see GrindChain), low-passed because rubber rings nothing, mostly weight, plus
 * crunch and gravel grains. A speed-following resonance instead sounds like breathy whistling.
 *
 * Sliding follows the sideways slip: snow hisses and crunches as it's ploughed, grass tears,
 * dirt sprays gravel, and rubber squeals on stone.
 */
const ROLLING = { rough: 1, ring: 0, damping: 1, drive: 1.5 } as const;

export const TYRE_ROLL = {
  snow: {
    ...ROLLING,
    rate: 0.5,
    sharp: 1200,
    rasp: 0.1,
    rumble: 1.5,
    level: 0.25,
    grains: [{ rate: 40, band: [900, 3000], q: 1.5, length: [0.008, 0.02], level: 0.35 }],
  },
  grass: {
    ...ROLLING,
    rate: 0.4,
    sharp: 900,
    rasp: 0.05,
    rumble: 1.2,
    level: 0.2,
    grains: [{ rate: 8, band: [2500, 6000], q: 0.8, length: [0.03, 0.07], level: 0.15 }],
  },
  dirt: {
    ...ROLLING,
    rate: 0.7,
    sharp: 2000,
    rasp: 0.2,
    rumble: 1.5,
    level: 0.3,
    grains: [{ rate: 50, band: [1500, 5000], q: 4, length: [0.003, 0.01], level: 0.35 }],
  },
  stone: {
    ...ROLLING,
    rate: 0.9,
    sharp: 2500,
    rasp: 0.25,
    rumble: 2,
    level: 0.35,
    grains: [{ rate: 12, band: [2000, 5000], q: 20, length: [0.001, 0.003], level: 0.4 }],
  },
} satisfies Record<string, GrindSound>;

/** Slides: a wide, barely moving band (no sweep, which whistles), the texture in the grains. */
export const TYRE_SLIDE = {
  snow: {
    base: 700,
    hzPerMs: 20,
    q: 0.5,
    grit: 0.4,
    top: 2500,
    level: 0.5,
    full: 8,
    grains: [{ rate: 70, band: [900, 3500], q: 1.2, length: [0.01, 0.025], level: 0.45 }],
  },
  grass: {
    base: 900,
    hzPerMs: 20,
    q: 0.5,
    grit: 0.5,
    top: 3500,
    level: 0.4,
    full: 8,
    grains: [{ rate: 30, band: [1500, 5000], q: 1, length: [0.01, 0.04], level: 0.35 }],
  },
  dirt: {
    base: 800,
    hzPerMs: 25,
    q: 0.5,
    grit: 0.6,
    top: 4000,
    level: 0.5,
    full: 8,
    grains: [{ rate: 80, band: [1500, 5000], q: 4, length: [0.003, 0.01], level: 0.45 }],
  },
  // Rubber on stone: a little coarse rubbing under the squeal (see Squeal).
  stone: {
    base: 600,
    hzPerMs: 20,
    q: 0.6,
    grit: 0.3,
    top: 3000,
    level: 0.25,
    full: 8,
    grains: [],
  },
} satisfies Record<string, DragSound>;

/**
 * A tyre squealing on stone: rubber rubbing on a hard, smooth surface, a rough whistle. The tone is
 * read from a recording of a real slide: nearly a pure tone (2nd harmonic 11–20 dB down)
 * whose pitch jitters randomly by a few percent from cycle to cycle, mostly fast (80–500 Hz), with
 * about 2 dB of loudness shimmer, as the rubber grips and slips a little differently every cycle.
 * After the driving-game patent US 8078300: the load on the tyres sets loudness and pitch (more
 * load: louder and lower), the slip angle sets its character (small: quiet, medium: loud, large:
 * rougher), and it's silent when the tyres carry next to nothing or far too much.
 */
export const SQUEAL = {
  /** Sideways slip (m/s) below which it's silent, whatever the angle (at a crawl the angle is noise). */
  from: 1.5,
  /** Slip angle (rad) where it starts, is fully loud, and is fully aggressive. */
  angleFrom: 0.06,
  angleLoud: 0.25,
  angleWild: 0.7,
  /** Load on the tyres (car weights, see Car.tyreLoad): silent outside [loadFrom, loadMax]. */
  loadFrom: 0.15,
  loadMax: 3,
  /** Pitch (Hz) at a load of 1, how strongly load lowers it (pitch ∝ load^−loadPitch), and its limits. */
  pitch: 1100,
  loadPitch: 0.2,
  pitchRange: [950, 1300] as const,
  /**
   * How slowly the squeal follows the load (s): pitch only to a held load (a long corner, a
   * compression), loudness a little quicker. Following every suspension bounce on rough ground
   * swoops the pitch up and down like air let out of a balloon.
   */
  loadPitchLag: 0.6,
  loadLoudLag: 0.2,
  /**
   * Vibrato from the wheels' own movement: as the suspension bounces, the load swings around its
   * held value and the pitch with it, by this share per car weight of swing, at most `wobbleMax`.
   * Small: a lot of it is the balloon again.
   */
  wobble: 0.02,
  wobbleMax: 0.03,
  /** Harmonic amplitudes, fundamental first (from the recording: −20, −28, −35 dB). Stronger ones buzz. */
  harmonics: [1, 0.2, 0.05, 0.02, 0.006],
  /**
   * Pitch jitter (share of the pitch, RMS), from a gentle slide to a hard one (fast or at a wild
   * angle), as random movement below `jitterRate` Hz. None is a clean whistle (a crying dolphin);
   * this is what makes it rubber.
   */
  jitter: [0.035, 0.05] as const,
  jitterRate: 500,
  /** Loudness shimmer (share, RMS) below `shimmerRate` Hz: about 2 dB from cycle to cycle. */
  shimmer: 0.25,
  shimmerRate: 400,
  /** Rubbing noise under the tone (share of its level), from a gentle slide to a hard one. */
  rub: [0.12, 0.4] as const,
  level: 0.2,
  /**
   * Sliding speed (m/s) where the slide is at its hardest. Friction power ∝ sliding speed · load,
   * heard ∝ its square root (as loadLoudness), so loudness ∝ √(slip / slipFull) up to it. A harder
   * slide is also rougher (jitter), hissier (rub) and up to `slipPitch` lower: in the recording the
   * hardest, loudest stretch sits ~20 % below the gentler ones. 8 m/s matches the other grounds'
   * slides (TYRE_SLIDE `full`).
   */
  slipFull: 8,
  slipPitch: 0.15,
  /**
   * How the grip comes and goes (times in seconds, scaled by slow motion):
   * - The whole squeal swells by up to ± `swellDb` dB every `swell` s.
   * - At `grips` times a second on average a tyre grips for `gripLength` s and the squeal falls to
   *   `gripLevel`.
   * - It builds up over about `attack` s and dies away over about `release` s (time constants).
   */
  swell: [0.25, 0.8] as const,
  swellDb: 5,
  grips: 0.4,
  gripLength: [0.15, 0.35] as const,
  gripLevel: 0.2,
  attack: 0.1,
  release: 0.08,
};

/** How a wilder slide changes the other grounds' slides: brighter, grittier, more grains (shares added at full). */
const SLIDE_WILD = { top: 0.6, grit: 0.5, grains: 1 };

/** How aggressive a slide is (0..1), from the slip angle (see SQUEAL.angleLoud and angleWild). */
export function slideWildness(slip: number, speed: number): number {
  return smoothstep(SQUEAL.angleLoud, SQUEAL.angleWild, Math.atan2(slip, Math.abs(speed)));
}

/**
 * How loud the tyres can be for the load they carry (0..~1.2): friction power ∝ speed · load,
 * heard ∝ its square root (van den Doel et al. 2001), and silent outside the squeal's load range.
 */
export function loadLoudness(load: number): number {
  return load < SQUEAL.loadFrom || load > SQUEAL.loadMax ? 0 : Math.sqrt(Math.min(1.5, load));
}

/** A slide made more aggressive by its slip angle (see SLIDE_WILD). */
export function wilder(slide: DragSound, wild: number): DragSound {
  if (wild <= 0) return slide;
  const W = SLIDE_WILD;
  return {
    ...slide,
    top: slide.top * (1 + W.top * wild),
    grit: Math.min(1, slide.grit * (1 + W.grit * wild)),
    grains: slide.grains.map((g) => ({ ...g, rate: g.rate * (1 + W.grains * wild) })),
  };
}

export class Squeal {
  private readonly tone: OscillatorNode;
  private readonly jitterNoise: AudioBufferSourceNode;
  private readonly jitterDepth: GainNode;
  private readonly shimmerNoise: AudioBufferSourceNode;
  private readonly rubNoise: AudioBufferSourceNode;
  private readonly rubGain: GainNode;
  private readonly gain: GainNode;
  /** The load followed slowly, for pitch and for loudness (see SQUEAL.loadPitchLag). */
  private pitchLoad = 1;
  private loudLoad = 1;
  private lastAt = -1;
  /** The slow swell (gain) and when it next changes, until when a tyre grips, and the last target loudness. */
  private swellGain = 1;
  private swellNext = 0;
  private gripUntil = 0;
  private lastTarget = 0;

  constructor(ctx: BaseAudioContext, noise: AudioBuffer, out: AudioNode) {
    const S = SQUEAL;
    const start = (src: AudioBufferSourceNode) => src.start(ctx.currentTime, Math.random() * noise.duration);
    this.gain = new GainNode(ctx, { gain: 0 });
    this.gain.connect(out);
    const shimmered = new GainNode(ctx, { gain: 1 });
    shimmered.connect(this.gain);
    this.tone = new OscillatorNode(ctx, {
      frequency: S.pitch,
      periodicWave: new PeriodicWave(ctx, { real: new Float32Array(S.harmonics.length + 1), imag: new Float32Array([0, ...S.harmonics]) }),
    });
    this.tone.connect(shimmered);
    // Pitch jitter and loudness shimmer: lowpassed noise, scaled to an RMS of about 1 (white noise in
    // ±1 has an RMS of 0.58; a lowpass at `rate` keeps about √(2·rate/sampleRate) of it), then to depth.
    const unit = (rate: number) => 1 / (0.58 * Math.sqrt((2 * rate) / ctx.sampleRate));
    this.jitterNoise = new AudioBufferSourceNode(ctx, { buffer: noise, loop: true });
    this.jitterDepth = new GainNode(ctx, { gain: 0 });
    this.jitterNoise
      .connect(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: S.jitterRate, Q: 0.5 }))
      .connect(new GainNode(ctx, { gain: unit(S.jitterRate) }))
      .connect(this.jitterDepth)
      .connect(this.tone.frequency);
    this.shimmerNoise = new AudioBufferSourceNode(ctx, { buffer: noise, loop: true });
    this.shimmerNoise
      .connect(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: S.shimmerRate, Q: 0.5 }))
      .connect(new GainNode(ctx, { gain: unit(S.shimmerRate) * S.shimmer }))
      .connect(shimmered.gain);
    this.rubNoise = new AudioBufferSourceNode(ctx, { buffer: noise, loop: true });
    this.rubGain = new GainNode(ctx, { gain: S.rub[0] });
    this.rubNoise
      .connect(new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 1800, Q: 0.7 }))
      .connect(this.rubGain)
      .connect(this.gain);
    this.tone.start(ctx.currentTime);
    start(this.jitterNoise);
    start(this.shimmerNoise);
    start(this.rubNoise);
  }

  /**
   * @param slip sideways slip (m/s); `speed` road speed (m/s, for the slip angle); `load` what
   * the tyres carry (car weights); `level` the overall gain, already scaled by the stone share
   */
  set(slip: number, speed: number, load: number, level: number, pitch: number, at: number): void {
    const S = SQUEAL;
    const angle = Math.atan2(slip, Math.abs(speed));
    const loud = slip < S.from ? 0 : smoothstep(S.angleFrom, S.angleLoud, angle);
    const wild = smoothstep(S.angleLoud, S.angleWild, angle);
    // How hard the slide is: by sliding speed, or by a wild angle (see SQUEAL.slipFull).
    const fast = smoothstep(S.from, S.slipFull, slip);
    const hard = Math.max(fast, wild);
    const dt = this.lastAt < 0 ? 0 : Math.max(0, at - this.lastAt);
    this.lastAt = at;
    const inRange = load >= S.loadFrom && load <= S.loadMax;
    const held = Math.min(1.5, Math.max(0.05, load));
    if (inRange) this.pitchLoad += (held - this.pitchLoad) * (1 - Math.exp(-dt / S.loadPitchLag));
    this.loudLoad += ((inRange ? held : 0) - this.loudLoad) * (1 - Math.exp(-dt / S.loadLoudLag));
    const f = Math.min(S.pitchRange[1], Math.max(S.pitchRange[0], S.pitch * this.pitchLoad ** -S.loadPitch)) * (1 - S.slipPitch * fast) * pitch;
    // More load than held: lower for a moment, less: higher (see SQUEAL.wobble).
    const swing = inRange ? held - this.pitchLoad : 0;
    const wobble = 1 - Math.max(-S.wobbleMax, Math.min(S.wobbleMax, swing * S.wobble));
    this.tone.frequency.setTargetAtTime(f * wobble, at, 0.03);
    this.jitterDepth.gain.setTargetAtTime(f * (S.jitter[0] + (S.jitter[1] - S.jitter[0]) * hard), at, 0.05);
    this.rubGain.gain.setTargetAtTime(S.rub[0] + (S.rub[1] - S.rub[0]) * hard, at, 0.05);
    // Grip comes and goes (see SQUEAL.swell): the whole swells, and now and then a tyre grips.
    if (at >= this.swellNext) {
      this.swellNext = at + between(S.swell) / pitch;
      this.swellGain = 10 ** (between([-S.swellDb, S.swellDb]) / 20);
    }
    if (at >= this.gripUntil && Math.random() < S.grips * dt * pitch) this.gripUntil = at + between(S.gripLength) / pitch;
    const gripped = at < this.gripUntil ? S.gripLevel : 1;
    const target = loud * Math.sqrt(Math.min(1, slip / S.slipFull)) * this.loudLoad * S.level * level * this.swellGain * gripped;
    this.gain.gain.setTargetAtTime(target, at, (target > this.lastTarget ? S.attack : S.release) / pitch);
    this.lastTarget = target;
  }

  stop(at: number): void {
    this.tone.stop(at);
    this.jitterNoise.stop(at);
    this.shimmerNoise.stop(at);
    this.rubNoise.stop(at);
  }
}

/** A random number in [lo, hi). */
function between([lo, hi]: readonly [number, number]): number {
  return lo + Math.random() * (hi - lo);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
