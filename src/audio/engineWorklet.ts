/**
 * AudioWorklet processor for a V8: instead of an oscillator, it fires eight
 * combustion pulses per engine cycle (two crank revolutions). Each pulse is a
 * short pressure burst, a dull thump off-throttle and noisier under load;
 * uneven strength and timing per cylinder (a cross-plane V8's banks) and a
 * loping idle give the burble. A failing engine (health < 1) misfires, runs
 * rough, backfires and knocks. Output channel 0 is the exhaust pulses, for the
 * caller's exhaust/muffler filters; channel 1 the mechanical knock, unfiltered.
 *
 * Loaded from a Blob URL (see loadEngineWorklet), so it's plain JavaScript in a string.
 */
const SOURCE = /* js */ `
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
    this.env = 0;
    this.knockEnv = 0;
    this.crank = 0;
    this.lope = 0;
    this.pop = 0;
    // Per-cylinder pulse strength and timing (share of a firing interval): a cross-plane V8 fires
    // its two banks unevenly, and that unevenness is the burble instead of a buzz.
    this.strength = [1.0, 0.74, 0.95, 0.68, 1.06, 0.8, 0.9, 0.71];
    this.offset = [0, 0.07, -0.05, 0.06, -0.07, 0.04, -0.03, 0.05];
    this.next = 1 + this.offset[1];
  }

  process(_inputs, outputs, parameters) {
    const exhaust = outputs[0][0];
    const mech = outputs[0][1];
    const rpm = parameters.rpm[0];
    const load = parameters.load[0];
    const health = parameters.health[0];
    const sick = 1 - health;
    // Idle lope: a slow random wander in the revs, strongest at idle (a cam that idles rough).
    const idle = Math.max(0, 1 - (rpm - 600) / 900);
    this.lope += ((Math.random() - 0.5) * 0.02 - this.lope * 0.002) * (0.3 + idle);
    const rate = rpm * (1 + this.lope * (0.06 * idle + 0.15 * sick));
    // 8 cylinders, 4-stroke: 4 firings per crank revolution.
    const step = ((rate / 60) * 4) / sampleRate;
    // Pulses ring longer off-throttle (softer), shorter and punchier under load.
    const decay = Math.exp(-1 / (sampleRate * (0.003 + 0.004 * (1 - load))));
    const knockDecay = Math.exp(-1 / (sampleRate * 0.0006));
    // Off-throttle pulses are dull thumps; under load they get noisy and raspy.
    const noisy = 0.2 + 0.4 * load;
    const misfire = sick * sick * 0.45;
    const jitter = 0.04 + 0.25 * sick;
    for (let i = 0; i < exhaust.length; i++) {
      this.phase += step * (1 + (Math.random() - 0.5) * jitter);
      if (this.phase >= this.next) {
        this.phase -= this.next;
        this.cylinder = (this.cylinder + 1) % 8;
        this.next = 1 + this.offset[(this.cylinder + 1) % 8];
        let amp = this.strength[this.cylinder] * (0.55 + 0.45 * load) * (1 + (Math.random() - 0.5) * 0.3 * idle);
        if (Math.random() < misfire) {
          amp = 0;
          // Unburnt fuel sometimes goes off in the hot exhaust a moment later: a backfire.
          if (Math.random() < 0.25) this.pop = Math.round(sampleRate * (0.01 + Math.random() * 0.03));
        }
        // Overrun: lifting off at high revs pops now and then.
        if (load < 0.05 && rpm > 2800 && Math.random() < 0.035) amp = 2.4;
        this.env += amp;
        // A worn rod bearing knocks once per crank revolution (every 4 firings).
        if (++this.crank % 4 === 0 && sick > 0.3) this.knockEnv += (sick - 0.3) * (0.7 + Math.random() * 0.6);
      }
      if (this.pop > 0 && --this.pop === 0) this.env += 2.2 + Math.random();
      this.env *= decay;
      this.knockEnv *= knockDecay;
      exhaust[i] = this.env * (1 - noisy + noisy * (Math.random() * 2 - 1));
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
