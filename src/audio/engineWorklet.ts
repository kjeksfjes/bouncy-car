/**
 * AudioWorklet processor for a V8: instead of an oscillator, it fires eight
 * combustion pulses per engine cycle (two crank revolutions). Each pulse is a
 * short, noisy pressure burst; slightly different strength per cylinder and a
 * little timing jitter give the lumpy V8 burble. The caller shapes the pulse
 * train with exhaust/muffler filters.
 *
 * Loaded from a Blob URL (see loadEngineWorklet), so it's plain JavaScript in a string.
 */
const SOURCE = /* js */ `
class V8Engine extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 800, minValue: 0, maxValue: 9000, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.alive = true;
    this.port.onmessage = () => (this.alive = false);
    this.phase = Math.random();
    this.cylinder = 0;
    this.env = 0;
    // Per-cylinder pulse strength: the unevenness is what makes it burble instead of buzz.
    this.strength = [1.0, 0.74, 0.95, 0.68, 1.06, 0.8, 0.9, 0.71];
  }

  process(_inputs, outputs, parameters) {
    const out = outputs[0][0];
    const rpm = parameters.rpm[0];
    const load = parameters.load[0];
    // 8 cylinders, 4-stroke: 4 firings per crank revolution.
    const step = ((rpm / 60) * 4) / sampleRate;
    // Pulses ring longer off-throttle (softer), shorter and punchier under load.
    const decay = Math.exp(-1 / (sampleRate * (0.0022 + 0.0035 * (1 - load))));
    for (let i = 0; i < out.length; i++) {
      this.phase += step * (1 + (Math.random() - 0.5) * 0.05);
      if (this.phase >= 1) {
        this.phase -= 1;
        this.cylinder = (this.cylinder + 1) % 8;
        let amp = this.strength[this.cylinder] * (0.55 + 0.45 * load);
        // Overrun: lifting off at high revs pops now and then.
        if (load < 0.05 && rpm > 2800 && Math.random() < 0.035) amp = 2.4;
        this.env += amp;
      }
      this.env *= decay;
      out[i] = this.env * (0.6 + 0.4 * (Math.random() * 2 - 1));
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
