import { type DragSound, type GrindSound } from './scrape';

/**
 * Tyre sounds by ground. Feel values; only first impressions by ear so far.
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
 * A tyre squealing on stone: stick-slip makes the rubber vibrate periodically, so it's a pitched
 * whine with harmonics (a sawtooth), wavering in pitch and loudness, shaped by the tread's
 * resonance. Filtered noise instead sounds like failed whistling.
 */
export const SQUEAL = {
  /** Sideways slip (m/s) where it starts, and where it's at full strength and pitch. */
  from: 1.5,
  full: 7,
  /** Pitch (Hz) when slow and at `fast` m/s of road speed; a harder slide adds up to `slipRise` on top. */
  low: 750,
  high: 1150,
  fast: 30,
  slipRise: 0.1,
  /** Vibrato rate (Hz) and depth (share of the pitch), plus slow random wander. Much vibrato screams. */
  vibrato: 7,
  depth: 0.003,
  wander: 0.012,
  /** How much of the tone is rough (noise pulsed at the pitch) rather than clean: clean is a toy. */
  rough: 0.9,
  /** The tread's resonance: where the harmonics are loudest. */
  formant: 1400,
  formantQ: 1.5,
  level: 0.8,
  /**
   * Tyres squealing together (up to 4), each slightly off in pitch (share), so they beat against
   * each other like a real car's instead of one clean voice.
   */
  voices: 1,
  detune: 0.015,
  /** Chance per frame that a tyre's grip catches and the squeal drops out for a moment. */
  chop: 0,
};

export class Squeal {
  private readonly oscs: OscillatorNode[] = [];
  private readonly offsets: number[] = [];
  private readonly noise: AudioBufferSourceNode;
  private readonly vibrato: OscillatorNode;
  private readonly depth: GainNode;
  private readonly gain: GainNode;

  constructor(ctx: BaseAudioContext, noise: AudioBuffer, out: AudioNode) {
    const S = SQUEAL;
    this.vibrato = new OscillatorNode(ctx, { type: 'sine', frequency: S.vibrato });
    this.depth = new GainNode(ctx, { gain: 0 });
    this.vibrato.connect(this.depth);
    this.gain = new GainNode(ctx, { gain: 0 });
    // Rough part: noise pulsed by the tone (ring modulation), a buzzy, uneven whine.
    this.noise = new AudioBufferSourceNode(ctx, { buffer: noise, loop: true });
    const pulsed = new GainNode(ctx, { gain: 0 });
    const body = new GainNode(ctx, { gain: 1 });
    this.noise.connect(pulsed).connect(new GainNode(ctx, { gain: S.rough * 2 })).connect(body);
    const clean = new GainNode(ctx, { gain: (1 - S.rough) / Math.sqrt(S.voices) });
    clean.connect(body);
    for (let v = 0; v < S.voices; v++) {
      const osc = new OscillatorNode(ctx, { type: 'sawtooth', frequency: S.low });
      this.depth.connect(osc.frequency);
      osc.connect(new GainNode(ctx, { gain: 1 / S.voices })).connect(pulsed.gain);
      osc.connect(clean);
      osc.start(ctx.currentTime);
      this.oscs.push(osc);
      // Spread evenly around the pitch: one voice is untouched.
      this.offsets.push(S.voices === 1 ? 0 : (v / (S.voices - 1) - 0.5) * 2 * S.detune);
    }
    body
      .connect(new BiquadFilterNode(ctx, { type: 'bandpass', frequency: S.formant, Q: S.formantQ }))
      .connect(new BiquadFilterNode(ctx, { type: 'highpass', frequency: 400, Q: -3 }))
      .connect(this.gain)
      .connect(out);
    this.vibrato.start(ctx.currentTime);
    this.noise.start(ctx.currentTime, Math.random() * noise.duration);
  }

  /**
   * @param slip sideways slip (m/s); `speed` road speed (m/s); `level` the overall gain, already
   * scaled by the stone share
   */
  set(slip: number, speed: number, level: number, pitch: number, at: number): void {
    const S = SQUEAL;
    const k = Math.max(0, Math.min(1, (slip - S.from) / (S.full - S.from)));
    const fast = Math.min(1, speed / S.fast);
    const f = (S.low + (S.high - S.low) * fast) * (1 + S.slipRise * k) * pitch;
    this.oscs.forEach((osc, v) => osc.frequency.setTargetAtTime(f * (1 + this.offsets[v] + (Math.random() - 0.5) * S.wander), at, 0.06));
    this.depth.gain.setTargetAtTime(f * S.depth, at, 0.05);
    // Grip comes and goes: the loudness flutters, and now and then catches and drops out.
    const caught = Math.random() < S.chop ? 0.15 : 1;
    this.gain.gain.setTargetAtTime(k > 0 ? Math.sqrt(k) * S.level * level * caught * (0.6 + Math.random() * 0.8) : 0, at, 0.03);
  }

  stop(at: number): void {
    for (const osc of this.oscs) osc.stop(at);
    this.vibrato.stop(at);
    this.noise.stop(at);
  }
}
