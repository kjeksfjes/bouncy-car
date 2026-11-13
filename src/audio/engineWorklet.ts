/**
 * AudioWorklet processor for a muscle-car V8: instead of an oscillator, it fires eight exhaust
 * pulses per engine cycle (two crank revolutions) into two exhaust pipes, one per cylinder bank.
 *
 * - **Banks**: a cross-plane V8 fires evenly overall, but each bank's pipe gets its four pulses
 *   unevenly (the GM firing order 1-8-4-3-6-5-7-2 gives each bank gaps of 90°, 180°, 270° and 180°).
 *   Each pipe rings at its own length (a delay line with an inverting, low-passed reflection at the
 *   open end), so the two banks sound slightly different: that unevenness is the burble.
 * - **Pulses** kick up fast as the exhaust valve opens and blow down over a fixed share of crank
 *   rotation, so they're long and dull at idle and short and sharp at high revs, plus a little crack
 *   as the valve opens; off throttle they're clean thumps, under load noisier.
 * - **Lumpy cam**: a long-overlap cam idles rough. The firing strength surges a couple of times a
 *   second (the revs only a little: a big swing in pitch sounds like a synth's vibrato), and in the
 *   lull between surges some cylinders fire weak; it fades out with revs and throttle.
 * - A failing engine (health < 1) misfires, runs rough, backfires and knocks.
 *
 * Output channel 0 is the exhaust, for the caller's chest/muffler filters; channel 1 the mechanical
 * knock, unfiltered. Loaded from a Blob URL (see loadEngineWorklet), so it's plain JavaScript in a string.
 */
const SOURCE = /* js */ `
// Bank of each firing, in firing order 1-8-4-3-6-5-7-2 (odd cylinders on the left bank).
const BANK = [0, 1, 1, 0, 1, 0, 0, 1];
// Feel values, tuned by ear.
const PIPE = {
  // Round trip down each pipe and back (s): ~2.7 m of hot exhaust (~450 m/s). Different lengths
  // colour the two banks differently; the resonances sit at odd multiples of 1 / (2 · delay).
  delay: [0.0118, 0.0134],
  // How much of the pulse the open end sends back up the pipe (inverted), and how fast the
  // reflection loses its highs (one-pole coefficient: lower is darker).
  reflect: 0.3,
  damp: 0.2,
  // The right bank's tailpipe is a little further from the listener.
  level: [1, 0.85],
};
const PULSE = {
  // The blowdown's length in crank degrees: off throttle, and how much load shortens it.
  degrees: 40,
  loadShortens: 30,
  // Its decay time (s) is clamped so a stalling or screaming engine stays sane.
  minDecay: 0.0005,
  maxDecay: 0.008,
  // How fast the pulse kicks up (s): a slower kick is rounder and more like a pure hum.
  kick: 0.0003,
  // The valve's crack: a short noise tick on top of the hump.
  crack: 0.25,
  crackLoad: 0.3,
  crackTime: 0.0004,
};
const LOPE = {
  // Surges per second (each lope picks a new rate in this range) and how deep they go.
  rate: [1.5, 2.3],
  rpm: 0.025,
  strength: 0.5,
  // In the lull between surges a cylinder fires weak this often, at this strength.
  weakChance: 0.2,
  weak: 0.3,
};

class V8Engine extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 800, minValue: 0, maxValue: 9000, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      // 1 running clean, 0 dying (the caller sets it as the engine stalls): misfires, rough
      // running, backfires and a knocking rod.
      { name: 'health', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.alive = true;
    this.port.onmessage = () => (this.alive = false);
    this.phase = Math.random();
    this.cylinder = 0;
    // Per bank: the pulse's kick and blowdown, the crack, and the pipe (delay line + its damping).
    this.kick = [0, 0];
    this.blowdown = [0, 0];
    this.crack = [0, 0];
    this.pipe = PIPE.delay.map((d) => new Float32Array(Math.ceil(d * sampleRate) + 1));
    this.pipeLength = PIPE.delay.map((d) => Math.round(d * sampleRate));
    this.reflection = [0, 0];
    this.write = 0;
    this.noiseLow = 0;
    this.knockEnv = 0;
    this.crank = 0;
    this.drift = 0;
    this.lope = Math.random();
    this.lopeRate = LOPE.rate[0];
    this.lopeDepth = 1;
    this.pop = 0;
    // Seconds since the throttle was lifted (overrun pops only come just after).
    this.lifted = 99;
    // A little unevenness per cylinder, in strength and timing (share of a firing interval).
    this.strength = [1.0, 0.9, 0.96, 0.86, 1.04, 0.92, 0.97, 0.88];
    this.offset = [0, 0.02, -0.015, 0.02, -0.02, 0.01, -0.01, 0.015];
    this.next = 1 + this.offset[1];
  }

  process(_inputs, outputs, parameters) {
    const exhaust = outputs[0][0];
    const mech = outputs[0][1];
    const rpm = parameters.rpm[0];
    const load = parameters.load[0];
    const health = parameters.health[0];
    const sick = 1 - health;
    const block = exhaust.length / sampleRate;
    // How lumpy the idle is: full at idle, gone by ~1500 rpm, smoothed out partly by throttle.
    const idle = Math.max(0, Math.min(1, 1 - (rpm - 600) / 900));
    const lumpy = idle * (1 - 0.6 * load);
    this.lope += block * this.lopeRate;
    if (this.lope >= 1) {
      this.lope -= 1;
      this.lopeRate = LOPE.rate[0] + Math.random() * (LOPE.rate[1] - LOPE.rate[0]);
      this.lopeDepth = 0.7 + Math.random() * 0.6;
    }
    // A short surge each lope, then a lull (0..1, peaky).
    const surge = Math.pow(0.5 - 0.5 * Math.cos(2 * Math.PI * this.lope), 2);
    // A slow random wander on top, mostly for a dying engine.
    this.drift += ((Math.random() - 0.5) * 0.02 - this.drift * 0.002) * (0.3 + idle);
    const rate = Math.max(0, rpm * (1 + lumpy * LOPE.rpm * this.lopeDepth * (surge - 0.35) + this.drift * (0.02 * idle + 0.15 * sick)));
    // 8 cylinders, 4-stroke: 4 firings per crank revolution.
    const step = ((rate / 60) * 4) / sampleRate;
    // The blowdown lasts a share of the crank's rotation: long at idle, short at high revs and under load.
    const degrees = PULSE.degrees - PULSE.loadShortens * load;
    const decayTime = Math.min(PULSE.maxDecay, Math.max(PULSE.minDecay, degrees / (6 * Math.max(rate, 1)) / 3));
    const decay = Math.exp(-1 / (sampleRate * decayTime));
    const kick = Math.exp(-1 / (sampleRate * PULSE.kick));
    const crackDecay = Math.exp(-1 / (sampleRate * PULSE.crackTime));
    const crackLevel = PULSE.crack + PULSE.crackLoad * load;
    const knockDecay = Math.exp(-1 / (sampleRate * 0.0006));
    // Off-throttle pulses are clean thumps; under load they get noisy.
    const noisy = 0.1 + 0.35 * load;
    const misfire = sick * sick * 0.45;
    const jitter = 0.03 + 0.25 * sick;
    this.lifted = load < 0.05 ? this.lifted + block : 0;
    // Overrun: lifting off from high revs pops for a moment, then it settles (not for as long as you coast).
    const overrun = rpm > 3500 && this.lifted < 1.2 ? 0.03 * (1 - this.lifted / 1.2) : 0;
    for (let i = 0; i < exhaust.length; i++) {
      this.phase += step * (1 + (Math.random() - 0.5) * jitter);
      if (this.phase >= this.next) {
        this.phase -= this.next;
        this.cylinder = (this.cylinder + 1) % 8;
        this.next = 1 + this.offset[(this.cylinder + 1) % 8];
        let amp = this.strength[this.cylinder] * (0.55 + 0.45 * load) * (1 + (Math.random() - 0.5) * 0.3 * idle);
        amp *= 1 + lumpy * LOPE.strength * this.lopeDepth * (surge - 0.4);
        if (surge < 0.2 && Math.random() < LOPE.weakChance * lumpy) amp *= LOPE.weak;
        if (Math.random() < misfire) {
          amp = 0;
          // Unburnt fuel sometimes goes off in the hot exhaust a moment later: a backfire.
          if (Math.random() < 0.25) this.pop = Math.round(sampleRate * (0.01 + Math.random() * 0.03));
        }
        if (Math.random() < overrun) amp = 2.4;
        const bank = BANK[this.cylinder];
        this.kick[bank] += amp;
        this.crack[bank] += amp;
        // A worn rod bearing knocks once per crank revolution (every 4 firings).
        if (++this.crank % 4 === 0 && sick > 0.3) this.knockEnv += (sick - 0.3) * (0.7 + Math.random() * 0.6);
      }
      if (this.pop > 0 && --this.pop === 0) {
        const bank = Math.random() < 0.5 ? 0 : 1;
        this.kick[bank] += 2.2 + Math.random();
        this.crack[bank] += 2;
      }
      // Exhaust turbulence: noise with its fizz taken off.
      this.noiseLow += ((Math.random() * 2 - 1) - this.noiseLow) * 0.5;
      let out = 0;
      for (let b = 0; b < 2; b++) {
        // The kick feeds the blowdown quickly, so the pulse rises in a fraction of a millisecond.
        const fed = this.kick[b] * (1 - kick);
        this.kick[b] -= fed;
        this.blowdown[b] = this.blowdown[b] * decay + fed;
        this.crack[b] *= crackDecay;
        const pulse = this.blowdown[b] * (1 - noisy + noisy * this.noiseLow) + crackLevel * this.crack[b] * (Math.random() * 2 - 1);
        // The pipe: what went down it comes back from the open end inverted and duller.
        const line = this.pipe[b];
        const length = this.pipeLength[b];
        const back = line[(this.write + line.length - length) % line.length];
        this.reflection[b] += (back - this.reflection[b]) * PIPE.damp;
        const y = pulse - PIPE.reflect * this.reflection[b];
        line[this.write % line.length] = y;
        out += y * PIPE.level[b];
      }
      this.write++;
      this.knockEnv *= knockDecay;
      exhaust[i] = out;
      mech[i] = this.knockEnv * (Math.random() * 2 - 1);
    }
    return this.alive;
  }
}
registerProcessor('v8-engine', V8Engine);
`;

export const ENGINE_PROCESSOR = 'v8-engine';

export function loadEngineWorklet(ctx: AudioContext): Promise<void> {
  const url = URL.createObjectURL(new Blob([SOURCE], { type: 'application/javascript' }));
  return ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
}
