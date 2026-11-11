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
 * A tyre squealing on stone: rubber rubbing on a hard, smooth surface (sound designers record it
 * by pressing a hot-water bottle onto concrete), a rough whine. After the driving-game patent
 * US 8078300: the load on the tyres sets loudness and pitch (more load: louder and lower), the
 * slip angle sets its character (small: quiet, medium: loud, large: aggressive), and it's silent
 * when the tyres carry next to nothing or far too much.
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
  pitch: 900,
  loadPitch: 0.3,
  pitchRange: [650, 1250] as const,
  /** Vibrato rate (Hz) and depth (share of the pitch), plus slow random wander. Much vibrato screams. */
  vibrato: 7,
  depth: 0.003,
  wander: 0.012,
  /**
   * How much is rough (noise pulsed at the pitch) rather than clean tone, from loud to aggressive.
   * All rough loses the whine and turns sandy.
   */
  rough: [0.5, 0.65] as const,
  /** The tread's resonance (Hz), brighter as it turns aggressive. */
  formant: [1300, 1700] as const,
  formantQ: 2.5,
  level: 1.2,
  /**
   * Tyres squealing together (up to 4), each slightly off in pitch (share), so they beat against
   * each other like a real car's instead of one clean voice.
   */
  voices: 1,
  detune: 0.015,
  /** Chance per frame that a tyre's grip catches and the squeal drops out for a moment. */
  chop: 0,
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
  private readonly oscs: OscillatorNode[] = [];
  private readonly offsets: number[] = [];
  private readonly noise: AudioBufferSourceNode;
  private readonly vibrato: OscillatorNode;
  private readonly depth: GainNode;
  private readonly pulsedMix: GainNode;
  private readonly cleanMix: GainNode;
  private readonly formant: BiquadFilterNode;
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
    this.pulsedMix = new GainNode(ctx, { gain: 0 });
    this.cleanMix = new GainNode(ctx, { gain: 0 });
    this.noise.connect(pulsed).connect(this.pulsedMix).connect(body);
    this.cleanMix.connect(body);
    for (let v = 0; v < S.voices; v++) {
      const osc = new OscillatorNode(ctx, { type: 'sawtooth', frequency: S.pitch });
      this.depth.connect(osc.frequency);
      osc.connect(new GainNode(ctx, { gain: 1 / S.voices })).connect(pulsed.gain);
      osc.connect(new GainNode(ctx, { gain: 1 / Math.sqrt(S.voices) })).connect(this.cleanMix);
      osc.start(ctx.currentTime);
      this.oscs.push(osc);
      // Spread evenly around the pitch: one voice is untouched.
      this.offsets.push(S.voices === 1 ? 0 : (v / (S.voices - 1) - 0.5) * 2 * S.detune);
    }
    this.formant = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: S.formant[0], Q: S.formantQ });
    body
      .connect(this.formant)
      .connect(new BiquadFilterNode(ctx, { type: 'highpass', frequency: 400, Q: -3 }))
      .connect(this.gain)
      .connect(out);
    this.vibrato.start(ctx.currentTime);
    this.noise.start(ctx.currentTime, Math.random() * noise.duration);
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
    const loaded = load >= S.loadFrom && load <= S.loadMax ? Math.min(1.5, load) : 0;
    const f = Math.min(S.pitchRange[1], Math.max(S.pitchRange[0], S.pitch * Math.max(0.05, load) ** -S.loadPitch)) * pitch;
    this.oscs.forEach((osc, v) => osc.frequency.setTargetAtTime(f * (1 + this.offsets[v] + (Math.random() - 0.5) * S.wander), at, 0.06));
    this.depth.gain.setTargetAtTime(f * S.depth, at, 0.05);
    const rough = S.rough[0] + (S.rough[1] - S.rough[0]) * wild;
    this.pulsedMix.gain.setTargetAtTime(rough * 2, at, 0.05);
    this.cleanMix.gain.setTargetAtTime(1 - rough, at, 0.05);
    this.formant.frequency.setTargetAtTime((S.formant[0] + (S.formant[1] - S.formant[0]) * wild) * pitch, at, 0.05);
    // Grip comes and goes: the loudness flutters (more when aggressive), and may catch and drop out.
    const caught = Math.random() < S.chop ? 0.15 : 1;
    const flutter = 1 + (Math.random() - 0.5) * (0.6 + 0.4 * wild);
    this.gain.gain.setTargetAtTime(loud * loaded * S.level * level * caught * flutter, at, 0.03);
  }

  stop(at: number): void {
    for (const osc of this.oscs) osc.stop(at);
    this.vibrato.stop(at);
    this.noise.stop(at);
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
