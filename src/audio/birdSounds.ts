/**
 * Rook sounds, as pure functions of an AudioContext, an output and a few parameters (so they can be
 * rendered and measured offline). `pitch` is slow motion's pitch factor (see AudioEngine): lower and
 * longer below 1.
 */

/**
 * Wingbeats: air rushing past the feathers, not a hit. Each bird is one voice: noise through a broad
 * band round its own centre in `band` (min..max Hz) with a little low `body` under it, puffing with
 * each stroke at its own `rate` (beats/s, min..max). A downstroke swells over `swell` of a beat and
 * fades by `stroke` of it, leaving a gap, so single flaps stand out; the upstroke is a weaker puff
 * (`upstroke`) in the gap. Each bird has its own loudness (`near`, min..max: nearer and further off)
 * and lasts its own `length` s (min..max), dying away as it climbs off; they set off over
 * `ripple.base` s plus `ripple.perBird` s a bird, up to `ripple.max`. At most `voices` are heard (more
 * birds only make it louder). Loudness grows with the birds as noise from many sources adds, by the
 * root of their number: a group of `reference` birds sounds at `level`.
 */
const WINGS = {
  rate: [3.8, 6.5] as const,
  band: [700, 3000] as const,
  q: 0.7,
  body: { freq: 500, q: 0.9, level: 0.45 },
  swell: 0.12,
  stroke: 0.42,
  upstroke: 0.3,
  near: [0.5, 1] as const,
  length: [0.9, 1.8] as const,
  ripple: { base: 0.15, perBird: 0.04, max: 1 },
  voices: 10,
  reference: 8,
  level: 1.4,
};

/**
 * A rook's "kaah": a rattle of pulses ringing one narrow resonance, nearly all of it between 1 and
 * 2 kHz. The resonances, their rise, the length and the shape are measured from recordings
 * (xeno-canto XC845012, four calls that agree); the pulse rate is set by ear, faster and more even
 * than the recording's ≈50–75 a second, for a lighter, less rough call. The pulses come ≈`rate` a
 * second (min..max per call, each interval `jitter` irregular), each a burst of noise `pulse` s long
 * and of random strength, with a little `breath` between them. They ring a band-pass of Q `ring.q`
 * rising from `ring.from` to `ring.to` Hz over most of the call, over a weaker one fixed at
 * `under.freq`; the call's whole voice is `vary` higher or lower each time. It lasts `length` s
 * (min..max): starting at `start` of full strength, full by `rise` of the way, then fading over the
 * last `release` of it.
 */
const CAW = {
  rate: [150, 200] as const,
  jitter: 0.2,
  pulse: 0.0015,
  breath: 0.05,
  ring: { from: 1190, to: 1420, q: 10, level: 1 },
  under: { freq: 1130, q: 10, level: 0.8 },
  vary: 0.05,
  length: [0.25, 0.37] as const,
  start: 0.4,
  rise: 0.25,
  release: 0.3,
};

const between = (range: readonly [number, number]) => range[0] + Math.random() * (range[1] - range[0]);

/** A group of `count` birds lifting off together: their wingbeats, out of step, dying away. */
export function wingFlutter(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, count: number, pitch = 1): void {
  const W = WINGS;
  const voices = Math.min(W.voices, count);
  // The whole group at its loudness for `count` birds, shared over the voices (which add by the root).
  const level = (W.level * Math.sqrt(count / W.reference)) / Math.sqrt(voices);
  const ripple = Math.min(W.ripple.max, W.ripple.base + W.ripple.perBird * count);
  for (let i = 0; i < voices; i++) {
    const t = ctx.currentTime + (Math.random() * ripple) / pitch;
    const length = between(W.length) / pitch;
    const src = new AudioBufferSourceNode(ctx, { buffer: noise, loop: true, playbackRate: pitch });
    const env = new GainNode(ctx, { gain: 0 });
    env.gain.setValueCurveAtTime(beatCurve(between(W.rate) * pitch, length, level * between(W.near)), t, length);
    src.connect(new BiquadFilterNode(ctx, { type: 'bandpass', frequency: between(W.band) * pitch, Q: W.q })).connect(env);
    src.connect(new BiquadFilterNode(ctx, { type: 'bandpass', frequency: W.body.freq * pitch, Q: W.body.q })).connect(new GainNode(ctx, { gain: W.body.level })).connect(env);
    env.connect(out);
    src.start(t, Math.random() * noise.duration, length + 0.05);
  }
}

/**
 * One bird's wingbeats as a gain curve over `length` s: per beat a downstroke puff (swelling over
 * WINGS.swell of the beat, faded by WINGS.stroke) and a weaker upstroke puff in the gap after it,
 * the whole dying away as it climbs off.
 */
function beatCurve(rate: number, length: number, level: number): Float32Array {
  const W = WINGS;
  const steps = Math.ceil(length * 400);
  const curve = new Float32Array(steps);
  const phase0 = Math.random();
  const puff = (x: number, swell: number, end: number) =>
    x < swell ? Math.sin((Math.PI / 2) * (x / swell)) : x < end ? Math.cos((Math.PI / 2) * ((x - swell) / (end - swell))) ** 2 : 0;
  for (let i = 0; i < steps; i++) {
    const t = (i / (steps - 1)) * length;
    const cycle = (t * rate + phase0) % 1;
    const down = puff(cycle, W.swell, W.stroke);
    const up = W.upstroke * puff(cycle - 0.55, W.swell * 0.8, W.stroke * 0.7);
    const fade = Math.min(1, t / 0.04) * (1 - t / length) ** 1.5;
    curve[i] = level * Math.max(down, up) * fade;
  }
  return curve;
}

/** One rook's caw, `delay` s from now. */
export function caw(ctx: BaseAudioContext, out: AudioNode, pitch = 1, delay = 0): void {
  const C = CAW;
  const t = ctx.currentTime + delay;
  const length = between(C.length) / pitch;
  const voice = new AudioBufferSourceNode(ctx, { buffer: voiceBuffer(ctx, between(C.rate) * pitch, length) });
  const k = pitch * (1 + (Math.random() * 2 - 1) * C.vary);
  const ring = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: C.ring.from * k, Q: C.ring.q });
  ring.frequency.setValueAtTime(C.ring.from * k, t);
  ring.frequency.linearRampToValueAtTime(C.ring.to * k, t + length * 0.8);
  const under = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: C.under.freq * k, Q: C.under.q });
  // A band-pass peaks at 0 dB: make up roughly √Q.
  voice.connect(ring).connect(new GainNode(ctx, { gain: C.ring.level * Math.sqrt(C.ring.q) })).connect(out);
  voice.connect(under).connect(new GainNode(ctx, { gain: C.under.level * Math.sqrt(C.under.q) })).connect(out);
  voice.start(t);
}

/** The rattle of one caw: irregular bursts of noise `rate` a second, with breath between, shaped in and out. */
function voiceBuffer(ctx: BaseAudioContext, rate: number, length: number): AudioBuffer {
  const C = CAW;
  const sampleRate = ctx.sampleRate;
  const n = Math.ceil(length * sampleRate);
  const buffer = ctx.createBuffer(1, n, sampleRate);
  const data = buffer.getChannelData(0);
  const pulse = Math.max(1, Math.round(C.pulse * sampleRate));
  for (let next = 0; next < n; next += Math.max(pulse, Math.round((sampleRate / rate) * (1 + (Math.random() * 2 - 1) * C.jitter)))) {
    const strength = 0.4 + Math.random() * 0.6;
    for (let i = 0; i < pulse && next + i < n; i++) data[next + i] = strength * (Math.random() * 2 - 1);
  }
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const shape = (C.start + (1 - C.start) * smoothstep(0, C.rise, u)) * (1 - smoothstep(1 - C.release, 1, u));
    data[i] = (data[i] + C.breath * (Math.random() * 2 - 1)) * shape;
  }
  return buffer;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
