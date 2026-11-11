/**
 * The car body scraping along things, after van den Doel, Kry & Pai 2001 (FoleyAutomatic; see the
 * game-sound skill). A scrape is a force that excites the scraped object's own modes, so:
 *
 * - **Grinding** (rock, trees, other cars): a rough surface profile with sharp asperities, played
 *   back faster the faster it slides (the phonograph-needle model), rings the car body's sheet
 *   metal modes. Plus the raw contact rasp, a low rumble for the car's weight, and saturation.
 * - **Dragging** (grass, snow, dirt): soft ground barely rings the body, so it's filtered noise
 *   through a speed-following resonance, with grains for rustle, crunch and grit.
 *
 * Loudness ∝ √speed (frictional power ∝ speed · force). Kept free of game types so it can be
 * rendered offline and measured.
 */

/** A kind of short grain in a scrape's chatter. */
export interface ScrapeGrain {
  /** Grains per second at full slide speed. */
  rate: number;
  /** Frequency range (Hz), picked evenly in pitch. */
  band: readonly [number, number];
  /** Filter Q: low is gritty noise, high (≥ 20) rings like a small stone. */
  q: number;
  /** Strike length range (s). */
  length: readonly [number, number];
  level: number;
}

export interface GrindSound {
  /** Profile playback rate at full speed: how fast the asperities go by (pitch and density). */
  rate: number;
  /**
   * 1: the spiky, juddering rough profile (rock, bark); 0: smooth noise, as when two smooth metal
   * surfaces rub (other cars).
   */
  rough: number;
  /** Low-pass on the contact (Hz): rock is hard and sharp, bark softer. */
  sharp: number;
  /** How hard the contact rings the body's metal modes. */
  ring: number;
  /** How long they ring, as a share of BODY.q: a panel pressed flat against rock is damped. */
  damping: number;
  /** The raw contact noise: grit and rasp. */
  rasp: number;
  /** The car's weight dragging: low rumble. */
  rumble: number;
  /** Drive into the saturator: higher is harsher. */
  drive: number;
  level: number;
  grains: readonly ScrapeGrain[];
}

export interface DragSound {
  /** Resonance frequency at standstill (Hz), 0 if not given. */
  base?: number;
  /** Resonance frequency per m/s of slide: the surface's dominant bump spacing (f = v / spacing). */
  hzPerMs: number;
  /** Resonance Q: low is noisy and rough, high is more pitched. */
  q: number;
  /** Raw noise past the resonance (0..1). */
  grit: number;
  /** Low-pass ceiling (Hz) at full speed. */
  top: number;
  level: number;
  /** Speed (m/s) at full loudness and brightness; SCRAPE.full if not given. */
  full?: number;
  grains: readonly ScrapeGrain[];
}

/**
 * The car body's sheet-metal modes (Hz): dense, with near-pairs a few percent apart that beat
 * against each other (the roughness that reads as metal, Aramaki et al. 2011). Q: panel damping.
 */
const BODY = {
  // Mid to high: low modes sound like a hollow barrel; none above ~4 kHz keeps it from turning tinny.
  modes: [
    [520, 0.5],
    [780, 0.7],
    [815, 0.55],
    [1120, 0.9],
    [1180, 0.7],
    [1610, 0.9],
    [1690, 0.7],
    [2250, 0.8],
    [2380, 0.6],
    [3050, 0.6],
    [3260, 0.45],
    [4100, 0.35],
  ],
  // Metal is low damping (Klatzky et al.): too damped reads as plastic, too low and long as a barrel.
  // Each sound scales it (GrindSound.damping).
  q: 140,
} as const;

/** White noise level that matches the rough profile's loudness, so `rough` only changes the character. */
const SMOOTH_LEVEL = 0.22;

/** Feel values; tune by ear. */
export const SCRAPE = {
  /**
   * Silent below this slide speed (m/s), full loudness and brightness at `full`. Body slides on
   * this mountain measured 24–37 m/s on autopilot (median ~26), mostly brief touches on landing.
   */
  from: 0.6,
  full: 30,
  /**
   * A fender's edge scratching rock: a free panel edge rings more. Not wired yet: telling which
   * panel touches needs the contact's piece.
   */
  fenderRock: {
    rough: 1,
    rate: 0.9,
    sharp: 12000,
    ring: 1.2,
    damping: 1,
    rasp: 0.35,
    rumble: 3,
    drive: 3,
    level: 1,
    grains: [
      // Pebbles kicked loose: tiny stone clacks (stone Q, see ROCK in audio.ts).
      { rate: 10, band: [2000, 5000], q: 30, length: [0.001, 0.003], level: 0.9 },
    ],
  },
  /** The body on stone: the car's weight grinding, the pressed panels ringing less than a free edge. */
  rock: {
    rough: 1,
    rate: 0.9,
    sharp: 5000,
    ring: 0.6,
    damping: 0.45,
    rasp: 0.15,
    rumble: 3,
    drive: 3,
    level: 0.5,
    grains: [
      // Pebbles kicked loose: tiny stone clacks (stone Q, see ROCK in audio.ts).
      { rate: 10, band: [2000, 5000], q: 30, length: [0.001, 0.003], level: 0.5 },
    ],
  },
  /** Metal on metal: both ring, smoother contact, more screech than rumble. */
  metal: {
    rough: 0,
    rate: 0.8,
    sharp: 5000,
    ring: 0.8,
    damping: 0.55,
    rasp: 0.15,
    rumble: 2.5,
    drive: 2.6,
    level: 0.5,
    grains: [
      // Panels snagging and catching on each other.
      { rate: 9, band: [400, 1800], q: 3, length: [0.02, 0.06], level: 0.6 },
    ],
  },
  /** Bark: soft, fibrous contact that barely rings the metal; more tearing than grinding. */
  tree: {
    rough: 1,
    rate: 0.7,
    sharp: 2500,
    ring: 0.35,
    damping: 0.5,
    rasp: 0.6,
    rumble: 0.25,
    drive: 1.6,
    level: 1,
    grains: [
      // Bark crackling and tearing.
      { rate: 16, band: [1500, 5000], q: 1, length: [0.004, 0.012], level: 0.5 },
    ],
  },
  grass: {
    hzPerMs: 45,
    q: 0.6,
    grit: 0.6,
    top: 4500,
    level: 0.6,
    grains: [
      // Blades swishing past.
      { rate: 12, band: [2500, 7000], q: 0.8, length: [0.03, 0.08], level: 0.25 },
    ],
  },
  snow: {
    hzPerMs: 25,
    q: 0.6,
    grit: 0.4,
    top: 1600,
    level: 0.75,
    grains: [
      // Snow compacting: short crunches.
      { rate: 18, band: [900, 3500], q: 1.2, length: [0.01, 0.025], level: 0.35 },
    ],
  },
  dirt: {
    hzPerMs: 35,
    q: 0.8,
    grit: 0.6,
    top: 3000,
    level: 0.7,
    grains: [
      // Grit and small stones in the soil.
      { rate: 16, band: [1500, 4000], q: 1.5, length: [0.005, 0.015], level: 0.35 },
    ],
  },
} satisfies Record<string, GrindSound | DragSound | number>;

/** Loudness 0..1 for a slide speed: ∝ √speed (frictional power ∝ speed · force). */
export function scrapeLoudness(speed: number, full: number = SCRAPE.full): number {
  if (speed < SCRAPE.from) return 0;
  return Math.sqrt(Math.min(1, speed / full));
}

/**
 * A rough surface as a sliding edge feels it (played back at the slide speed): a slow, uneven
 * undulation, and sharp asperities (mostly small, a few big) whose strength comes and goes in
 * patches, so the grind judders instead of hissing evenly.
 */
export function surfaceProfile(ctx: BaseAudioContext, seconds = 3): AudioBuffer {
  const sr = ctx.sampleRate;
  const buffer = ctx.createBuffer(1, Math.round(sr * seconds), sr);
  const data = buffer.getChannelData(0);
  let wave = 0;
  for (let i = 0; i < data.length; i++) {
    wave = wave * 0.996 + (Math.random() * 2 - 1) * 0.05;
    // Gentle next to the knocks: it's the rumble's source, not the grind's.
    data[i] = wave * 0.12;
  }
  // Patches: the contact's grip changes every 20–80 ms.
  let patch = 1;
  let patchEnd = 0;
  let i = 0;
  while (true) {
    i += Math.ceil((-Math.log(1 - Math.random()) * sr) / 1500);
    if (i >= data.length - 8) break;
    if (i >= patchEnd) {
      patch = 0.2 + 0.8 * Math.random() ** 0.7;
      patchEnd = i + Math.round(sr * (0.02 + Math.random() * 0.06));
    }
    const a = patch * Math.random() ** 2.5 * (Math.random() < 0.5 ? -1 : 1);
    // A sharp knock, a few samples long.
    for (let k = 0; k < 8; k++) data[i + k] += a * 0.6 ** k;
  }
  let peak = 0;
  for (const v of data) peak = Math.max(peak, Math.abs(v));
  for (let k = 0; k < data.length; k++) data[k] /= peak;
  return buffer;
}

/** Metal grinding on something hard: the profile rings the body modes, with rasp, rumble and saturation. */
export class GrindChain {
  private readonly src: AudioBufferSourceNode;
  private readonly sharp: BiquadFilterNode;
  private readonly smooth: AudioBufferSourceNode;
  private readonly roughGain: GainNode;
  private readonly smoothGain: GainNode;
  private readonly ring: GainNode;
  /** The body modes and their own Q at full ring. */
  private readonly modes: [BiquadFilterNode, number][] = [];
  private readonly rasp: GainNode;
  private readonly rumble: GainNode;
  private readonly drive: GainNode;
  private readonly gain: GainNode;

  constructor(ctx: BaseAudioContext, profile: AudioBuffer, noise: AudioBuffer, out: AudioNode) {
    this.src = new AudioBufferSourceNode(ctx, { buffer: profile, loop: true });
    this.smooth = new AudioBufferSourceNode(ctx, { buffer: noise, loop: true });
    // The contact: rough profile and smooth noise, mixed by GrindSound.rough.
    const contact = new GainNode(ctx, { gain: 1 });
    this.roughGain = new GainNode(ctx, { gain: 1 });
    this.smoothGain = new GainNode(ctx, { gain: 0 });
    this.src.connect(this.roughGain).connect(contact);
    this.smooth.connect(this.smoothGain).connect(contact);
    // Lowpass Q is in dB: −3 is flat, no resonant bump.
    this.sharp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 12000, Q: -3 });
    contact.connect(this.sharp);
    this.drive = new GainNode(ctx, { gain: 1 });

    this.ring = new GainNode(ctx, { gain: 0 });
    this.sharp.connect(this.ring);
    for (const [f, level] of BODY.modes) {
      const q = BODY.q * (0.8 + Math.random() * 0.4);
      const mode = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: f * (0.97 + Math.random() * 0.06), Q: q });
      this.modes.push([mode, q]);
      // A bandpass peaks at 0 dB: make up for how little of the contact a narrow band passes.
      this.ring.connect(mode).connect(new GainNode(ctx, { gain: level * Math.sqrt(q) * 0.5 })).connect(this.drive);
    }
    this.rasp = new GainNode(ctx, { gain: 0 });
    this.sharp.connect(new BiquadFilterNode(ctx, { type: 'highpass', frequency: 1200, Q: -3 })).connect(this.rasp).connect(this.drive);
    this.rumble = new GainNode(ctx, { gain: 0 });
    contact.connect(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 420, Q: -3 }))
      // Weight lives at 100–400 Hz; below that small speakers can't play it and it turns to mud.
      .connect(new BiquadFilterNode(ctx, { type: 'highpass', frequency: 100, Q: -3 }))
      .connect(this.rumble).connect(this.drive);

    this.gain = new GainNode(ctx, { gain: 0 });
    this.drive.connect(new WaveShaperNode(ctx, { curve: saturation(), oversample: '2x' })).connect(this.gain).connect(out);
    this.src.start(ctx.currentTime, Math.random() * profile.duration);
    this.smooth.start(ctx.currentTime, Math.random() * noise.duration);
  }

  /**
   * @param speed slide speed (m/s); `level` the overall gain at full loudness; `pitch` slow motion
   * @param at context time to reach the new values from (smoothed over ~30 ms)
   */
  set(sound: GrindSound, speed: number, level: number, pitch: number, at: number): void {
    const k = scrapeLoudness(speed);
    const share = Math.min(1.5, speed / SCRAPE.full);
    this.src.playbackRate.setTargetAtTime(Math.max(0.1, share * sound.rate) * pitch, at, 0.03);
    this.sharp.frequency.setTargetAtTime(sound.sharp * pitch, at, 0.03);
    this.roughGain.gain.setTargetAtTime(sound.rough, at, 0.03);
    this.smoothGain.gain.setTargetAtTime((1 - sound.rough) * SMOOTH_LEVEL, at, 0.03);
    this.smooth.playbackRate.setTargetAtTime(pitch, at, 0.03);
    this.ring.gain.setTargetAtTime(sound.ring, at, 0.03);
    for (const [mode, q] of this.modes) mode.Q.setTargetAtTime(q * sound.damping, at, 0.03);
    this.rasp.gain.setTargetAtTime(sound.rasp, at, 0.03);
    this.rumble.gain.setTargetAtTime(sound.rumble, at, 0.03);
    this.drive.gain.setTargetAtTime(sound.drive * (0.5 + 0.5 * k), at, 0.03);
    this.gain.gain.setTargetAtTime(k * sound.level * level, at, 0.03);
  }

  stop(at: number): void {
    this.src.stop(at);
    this.smooth.stop(at);
  }
}

/** Dragging over soft ground: loops noise through the surface resonance and a speed-following low-pass. */
export class DragChain {
  private readonly src: AudioBufferSourceNode;
  private readonly reson: BiquadFilterNode;
  private readonly grit: GainNode;
  private readonly lowpass: BiquadFilterNode;
  private readonly gain: GainNode;

  constructor(ctx: BaseAudioContext, noise: AudioBuffer, out: AudioNode) {
    this.src = new AudioBufferSourceNode(ctx, { buffer: noise, loop: true });
    this.reson = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 200, Q: 1 });
    this.grit = new GainNode(ctx, { gain: 0 });
    this.lowpass = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 1000, Q: -3 });
    this.gain = new GainNode(ctx, { gain: 0 });
    this.src.connect(this.reson).connect(this.lowpass);
    this.src.connect(this.grit).connect(this.lowpass);
    this.lowpass.connect(this.gain).connect(out);
    this.src.start(ctx.currentTime, Math.random() * noise.duration);
  }

  set(sound: DragSound, speed: number, level: number, pitch: number, at: number): void {
    const full = sound.full ?? SCRAPE.full;
    const k = scrapeLoudness(speed, full);
    const v = Math.min(speed, full * 1.5);
    this.reson.frequency.setTargetAtTime(Math.max(40, (sound.base ?? 0) + v * sound.hzPerMs) * pitch, at, 0.03);
    this.reson.Q.setTargetAtTime(sound.q, at, 0.03);
    // The resonance is narrow; the raw grit is broadband and much louder per unit gain.
    this.grit.gain.setTargetAtTime(sound.grit * 0.15, at, 0.03);
    this.lowpass.frequency.setTargetAtTime(Math.min(sound.top, 300 + (v * sound.top) / full) * pitch, at, 0.03);
    this.gain.gain.setTargetAtTime(k * sound.level * level, at, 0.03);
  }

  stop(at: number): void {
    this.src.stop(at);
  }
}

/**
 * Blends drag sounds by weight (weights needn't sum to 1): ground that is part grass, part snow,
 * part dirt. Grains are kept per kind, scaled by weight.
 */
export function blendDrag(parts: readonly (readonly [DragSound, number])[]): DragSound {
  const total = parts.reduce((s, [, w]) => s + w, 0);
  // Nothing weighted (the ground mix can be all zero): take the first, rather than averaging to 0.
  if (!(total > 0)) return parts[0][0];
  const avg = (key: 'hzPerMs' | 'q' | 'grit' | 'top' | 'level') => parts.reduce((s, [p, w]) => s + p[key] * w, 0) / total;
  return {
    hzPerMs: avg('hzPerMs'),
    q: avg('q'),
    grit: avg('grit'),
    top: avg('top'),
    level: avg('level'),
    full: parts.reduce((s, [p, w]) => s + (p.full ?? SCRAPE.full) * w, 0) / total,
    base: parts.reduce((s, [p, w]) => s + (p.base ?? 0) * w, 0) / total,
    grains: parts.flatMap(([p, w]) => (w > 0 ? p.grains.map((g) => ({ ...g, rate: (g.rate * w) / total })) : [])),
  };
}

/** Blends grind sounds by weight, like blendDrag. */
export function blendGrind(parts: readonly (readonly [GrindSound, number])[]): GrindSound {
  const total = parts.reduce((s, [, w]) => s + w, 0);
  if (!(total > 0)) return parts[0][0];
  const avg = (key: 'rough' | 'rate' | 'sharp' | 'ring' | 'damping' | 'rasp' | 'rumble' | 'drive' | 'level') =>
    parts.reduce((s, [p, w]) => s + p[key] * w, 0) / total;
  return {
    rough: avg('rough'),
    rate: avg('rate'),
    sharp: avg('sharp'),
    ring: avg('ring'),
    damping: avg('damping'),
    rasp: avg('rasp'),
    rumble: avg('rumble'),
    drive: avg('drive'),
    level: avg('level'),
    grains: parts.flatMap(([p, w]) => (w > 0 ? p.grains.map((g) => ({ ...g, rate: (g.rate * w) / total })) : [])),
  };
}

/**
 * Emits this frame's chatter grains for a scrape (Poisson: on average rate · dt each), spread
 * over the frame from `at` (context time).
 * @param level overall gain; `pitch` slow motion
 */
export function scrapeGrains(
  ctx: BaseAudioContext,
  noise: AudioBuffer,
  out: AudioNode,
  grains: readonly ScrapeGrain[],
  speed: number,
  level: number,
  pitch: number,
  dt: number,
  at: number,
  full: number = SCRAPE.full,
): void {
  const k = scrapeLoudness(speed, full);
  if (k <= 0) return;
  const share = Math.min(1, speed / full);
  for (const g of grains) {
    let expected = g.rate * share * dt;
    while (expected > 0) {
      if (Math.random() < Math.min(1, expected)) {
        grain(ctx, noise, out, g, k * level * (0.4 + Math.random() * 0.6), pitch, at + Math.random() * dt);
      }
      expected -= 1;
    }
  }
}

function grain(ctx: BaseAudioContext, noise: AudioBuffer, out: AudioNode, g: ScrapeGrain, amp: number, pitch: number, t: number): void {
  const [lo, hi] = g.band;
  const f = lo * (hi / lo) ** Math.random() * pitch;
  const length = (g.length[0] + Math.random() * (g.length[1] - g.length[0])) / pitch;
  // Keep the source playing through the filter's ring, or Chrome cuts it short.
  const ring = (2.2 * g.q) / f;
  const src = new AudioBufferSourceNode(ctx, { buffer: noise, playbackRate: pitch });
  const env = new GainNode(ctx, { gain: 0 });
  // A narrow band passes little of a short burst: make up for it (∝ √Q, see the skill).
  env.gain.setValueAtTime(amp * g.level * Math.sqrt(g.q), t);
  env.gain.exponentialRampToValueAtTime(0.0001, t + length);
  src.connect(env).connect(new BiquadFilterNode(ctx, { type: 'bandpass', frequency: f, Q: g.q })).connect(out);
  src.start(t, Math.random() * (noise.duration - 0.5), length + ring + 0.02);
}

/** A soft clipper: harmonics and harshness, and it glues the layers into one sound. */
function saturation(): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / (curve.length - 1)) * 2 - 1) * 2.5);
  return curve;
}
