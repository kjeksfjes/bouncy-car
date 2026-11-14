/**
 * Car glass breaking. A car's panes are toughened glass, which doesn't break into ringing shards
 * like a house window: the stress in it lets go all at once with a sharp pop, and it bursts into
 * thousands of small cubes that pour out in a dense, crunchy rush and then patter down. The cubes
 * are small and lie against each other, so each one barely rings: a click high up, not a tinkle.
 *
 * Feel values: change freely.
 * - `pop`: the burst's pop, white noise dying away in `decay` s, with a duller body (low-passed at
 *   `bodyHz`, dying away in `bodyDecay` s) as the pane gives way.
 * - `rush`: the cubes pouring out: `rate` clicks a second at first, halving every `halfLife` s.
 *   Each click rings at `band` Hz (spread evenly in pitch) with a Q in `q` (low: a dry click).
 * - `patter`: the cubes landing on the sill, the seats and the ground: fewer, a little lower and
 *   ringier (still far short of a shard's ring), from `delay` s on.
 * - `crack`: a crack without a burst: a smaller pop and a few clicks within `spread` s.
 * - `level`: the burst's peak, and a crack's.
 */
export const GLASS = {
  pop: { decay: 0.0018, bodyHz: 900, bodyDecay: 0.022, body: 0.5 },
  rush: { rate: 1600, halfLife: 0.09, band: [2600, 9500], q: [5, 14], amp: 0.55 },
  patter: { delay: 0.06, rate: 55, halfLife: 0.28, band: [1700, 6000], q: [18, 40], amp: 0.4 },
  crack: { pop: 0.6, clicks: 7, spread: 0.035 },
  level: { shatter: 0.9, crack: 0.55 },
  seconds: 1.4,
};

type Stream = { rate: number; halfLife: number; band: number[]; q: number[]; amp: number };

/**
 * Plays a pane breaking into `out`: bursting (`shattered`) or only cracking. `pitch` below 1 is
 * slow motion: lower and longer. Rendered sample by sample into a buffer (a few hundred clicks
 * would be a few hundred nodes each), which takes about a millisecond.
 */
export function glassBreak(ctx: BaseAudioContext, out: AudioNode, shattered: boolean, pitch = 1): void {
  const G = GLASS;
  const rate = ctx.sampleRate;
  const data = new Float32Array(Math.ceil((shattered ? G.seconds : 0.25) * rate));
  const popLevel = shattered ? 1 : G.crack.pop;
  addPop(data, rate, popLevel);
  if (shattered) {
    addStream(data, rate, 0, G.rush);
    addStream(data, rate, G.patter.delay, G.patter);
  } else {
    for (let i = 0; i < G.crack.clicks; i++) {
      const at = Math.random() * G.crack.spread;
      addClick(data, rate, at, G.rush.band, G.rush.q, G.rush.amp * (0.4 + Math.random() * 0.6));
    }
  }
  let peak = 0;
  for (const v of data) peak = Math.max(peak, Math.abs(v));
  const scale = (shattered ? G.level.shatter : G.level.crack) / Math.max(peak, 1e-6);
  for (let i = 0; i < data.length; i++) data[i] *= scale;

  const buffer = new AudioBuffer({ length: data.length, sampleRate: rate });
  buffer.copyToChannel(data, 0);
  const src = new AudioBufferSourceNode(ctx, { buffer, playbackRate: pitch });
  src.connect(out);
  src.start();
}

/** The stress letting go: a near-instant crack of white noise, and the pane's duller give under it. */
function addPop(data: Float32Array, rate: number, level: number): void {
  const P = GLASS.pop;
  const n = Math.min(data.length, Math.ceil(P.bodyDecay * 6 * rate));
  // One-pole low-pass for the body.
  const k = 1 - Math.exp((-2 * Math.PI * P.bodyHz) / rate);
  let low = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const white = Math.random() * 2 - 1;
    low += (Math.random() * 2 - 1 - low) * k;
    data[i] += level * (white * Math.exp(-t / P.decay) + P.body * 4 * low * Math.exp(-t / P.bodyDecay));
  }
}

/**
 * Clicks at random times from `start` s, `stream.rate` a second at first, thinning and quietening
 * as the stream's energy halves every `halfLife` s (after Cook's PhISEM).
 */
function addStream(data: Float32Array, rate: number, start: number, stream: Stream): void {
  let t = start;
  for (;;) {
    const energy = 0.5 ** ((t - start) / stream.halfLife);
    if (energy < 0.03) break;
    // Waiting time to the next click: exponential, longer as the energy runs out.
    t += -Math.log(1 - Math.random()) / (stream.rate * Math.max(0.1, energy));
    addClick(data, rate, t, stream.band, stream.q, stream.amp * energy * (0.3 + Math.random() * 0.7));
  }
}

/** One cube's click: a damped ring at a random pitch in `band`, struck by a sample or two of noise. */
function addClick(data: Float32Array, rate: number, at: number, band: number[], q: number[], amp: number): void {
  const f = band[0] * (band[1] / band[0]) ** Math.random();
  const tau = (q[0] + Math.random() * (q[1] - q[0])) / (Math.PI * f);
  const from = Math.floor(at * rate);
  const n = Math.min(data.length - from, Math.ceil(tau * 6 * rate));
  const w = (2 * Math.PI * f) / rate;
  const phase = Math.random() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const strike = i < 3 ? (Math.random() * 2 - 1) * 0.8 : 0;
    data[from + i] += amp * (Math.exp(-i / (tau * rate)) * Math.sin(w * i + phase) + strike);
  }
}
