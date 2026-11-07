import * as THREE from 'three';
import type { Car, CarEvents } from '../vehicle/car';

/** Mix levels. Everything is synthesised; these are by-ear starting points. */
const MIX = {
  master: 0.7,
  engine: 0.16,
  /** AI engines sit under the player's own. */
  aiEngine: 0.45,
  tyres: 0.3,
  scrape: 0.35,
  wind: 0.35,
  crunch: 0.9,
  glass: 0.6,
  clank: 0.5,
  thud: 0.8,
};

/** Simulated gearbox for engine pitch: upper speed (m/s) of each gear. */
const GEAR_TOPS = [11, 20, 30, 41, 60];
const IDLE_RPM = 800;
const SHIFT_RPM = 5800;
/** A V8 fires four times per crank revolution. */
const FIRINGS_PER_REV = 4;

/** Panners: full volume within `ref` metres, fading with distance. */
const PANNER: PannerOptions = {
  panningModel: 'equalpower',
  distanceModel: 'inverse',
  refDistance: 10,
  maxDistance: 250,
  rolloffFactor: 1.2,
};

/** Minimum gap between crunches from the same car, so scraping contacts don't machine-gun. */
const CRUNCH_GAP = 0.09;

/** Engine, tyre and scrape loops for one car. */
class CarVoice {
  readonly panner: PannerNode;
  private readonly oscs: OscillatorNode[];
  private readonly engineFilter: BiquadFilterNode;
  private readonly engineGain: GainNode;
  private readonly tyreGain: GainNode;
  private readonly scrapeGain: GainNode;
  private readonly sources: AudioBufferSourceNode[] = [];
  private rpm = IDLE_RPM;
  lastCrunch = 0;

  constructor(private readonly ctx: AudioContext, out: AudioNode, noise: AudioBuffer, private readonly level: number) {
    this.panner = new PannerNode(ctx, PANNER);
    this.panner.connect(out);

    // Engine: saw + sub-octave saw + square, soft-clipped and low-passed. Pitch follows RPM.
    this.engineGain = new GainNode(ctx, { gain: 0 });
    this.engineFilter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 400, Q: 2 });
    const shaper = new WaveShaperNode(ctx, { curve: softClip(), oversample: '2x' });
    const mix = new GainNode(ctx, { gain: 0.5 });
    this.oscs = [
      new OscillatorNode(ctx, { type: 'sawtooth' }),
      new OscillatorNode(ctx, { type: 'sawtooth', detune: -8 }),
      new OscillatorNode(ctx, { type: 'square', detune: 5 }),
    ];
    const oscLevels = [0.6, 0.8, 0.25];
    this.oscs.forEach((o, i) => {
      o.connect(new GainNode(ctx, { gain: oscLevels[i] })).connect(mix);
      o.start();
    });
    mix.connect(shaper).connect(this.engineFilter).connect(this.engineGain).connect(this.panner);

    // Tyres on snow: a low, crunchy band of noise. Scrape: a harsh, higher band.
    this.tyreGain = new GainNode(ctx, { gain: 0 });
    this.loop(noise, new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 650, Q: 0.9 }), this.tyreGain);
    this.scrapeGain = new GainNode(ctx, { gain: 0 });
    this.loop(noise, new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 2600, Q: 2.5 }), this.scrapeGain);
  }

  private loop(noise: AudioBuffer, filter: BiquadFilterNode, gain: GainNode): void {
    const src = new AudioBufferSourceNode(this.ctx, { buffer: noise, loop: true });
    src.start(0, Math.random() * noise.duration);
    src.connect(filter).connect(gain).connect(this.panner);
    this.sources.push(src);
  }

  update(dt: number, car: Car): void {
    const now = this.ctx.currentTime;
    const p = car.position;
    this.panner.positionX.setTargetAtTime(p.x, now, 0.02);
    this.panner.positionY.setTargetAtTime(p.y, now, 0.02);
    this.panner.positionZ.setTargetAtTime(p.z, now, 0.02);

    const speed = Math.abs(car.forwardSpeed);
    const throttle = Math.max(car.lastInput.throttle, car.forwardSpeed < 1 ? car.lastInput.brake : 0);
    const airborne = car.groundedWheels === 0;
    // Free-revving in the air, otherwise RPM follows road speed through the gears.
    const target = !car.engineAlive ? 0 : airborne && throttle > 0 ? SHIFT_RPM : gearRpm(speed, throttle);
    this.rpm += (target - this.rpm) * Math.min(1, dt * (target > this.rpm ? 6 : 3));
    const alive = car.engineAlive ? 1 : 0;
    const freq = Math.max(20, (this.rpm / 60) * FIRINGS_PER_REV);
    const ratios = [1, 0.5, 1];
    this.oscs.forEach((o, i) => o.frequency.setTargetAtTime(freq * ratios[i], now, 0.03));
    const load = throttle * alive;
    this.engineFilter.frequency.setTargetAtTime(250 + (this.rpm / SHIFT_RPM) * 1400 + load * 1500, now, 0.05);
    this.engineGain.gain.setTargetAtTime(MIX.engine * this.level * alive * (0.55 + 0.45 * load), now, 0.08);

    const grounded = car.groundedWheels / 4;
    const rolling = Math.min(1, speed / 20) * 0.15;
    const sliding = Math.min(1, car.slip / 6);
    this.tyreGain.gain.setTargetAtTime(MIX.tyres * this.level * grounded * (rolling + sliding), now, 0.05);
    const scrape = car.scraping ? Math.min(1, speed / 15) : 0;
    this.scrapeGain.gain.setTargetAtTime(MIX.scrape * this.level * scrape, now, 0.04);
  }

  dispose(): void {
    const now = this.ctx.currentTime;
    this.panner.disconnect();
    this.oscs.forEach((o) => o.stop(now + 0.05));
    this.sources.forEach((s) => s.stop(now + 0.05));
  }
}

/**
 * All game sound, synthesised with the Web Audio API: per-car engine/tyre/scrape
 * loops, wind for the listener, and positional one-shots for car events.
 *
 * Browsers only allow an AudioContext after a user gesture, so the real engine is
 * created on the first key press or click; until then every call is a no-op.
 */
export class GameAudio implements CarEvents {
  private engine: AudioEngine | null = null;
  private muted = false;

  constructor() {
    const start = () => {
      if (this.engine) return;
      this.engine = new AudioEngine();
      this.engine.setMuted(this.muted);
    };
    window.addEventListener('keydown', start, { once: true });
    window.addEventListener('pointerdown', start, { once: true });
  }

  toggleMute(): void {
    this.muted = !this.muted;
    this.engine?.setMuted(this.muted);
  }

  update(dt: number, camera: THREE.Camera, cars: readonly Car[]): void {
    this.engine?.update(dt, camera, cars);
  }

  impact(car: Car, at: THREE.Vector3, severity: number): void {
    this.engine?.impact(car, at, severity);
  }

  glass(car: Car, at: THREE.Vector3, shattered: boolean): void {
    this.engine?.glass(car, at, shattered);
  }

  clank(car: Car, at: THREE.Vector3, size: number): void {
    this.engine?.clank(car, at, size);
  }

  land(car: Car, at: THREE.Vector3, strength: number): void {
    this.engine?.land(car, at, strength);
  }
}

class AudioEngine {
  private readonly ctx = new AudioContext();
  private readonly master: GainNode;
  private readonly noise: AudioBuffer;
  private readonly voices = new Map<Car, CarVoice>();
  private readonly windGain: GainNode;
  private readonly windFilter: BiquadFilterNode;

  constructor() {
    const limiter = new DynamicsCompressorNode(this.ctx, { threshold: -10, knee: 6, ratio: 12, attack: 0.003, release: 0.2 });
    this.master = new GainNode(this.ctx, { gain: MIX.master });
    this.master.connect(limiter).connect(this.ctx.destination);
    this.noise = whiteNoise(this.ctx, 2);

    this.windGain = new GainNode(this.ctx, { gain: 0 });
    this.windFilter = new BiquadFilterNode(this.ctx, { type: 'lowpass', frequency: 500, Q: 0.5 });
    const wind = new AudioBufferSourceNode(this.ctx, { buffer: this.noise, loop: true });
    wind.connect(this.windFilter).connect(this.windGain).connect(this.master);
    wind.start();
  }

  setMuted(muted: boolean): void {
    this.master.gain.setTargetAtTime(muted ? 0 : MIX.master, this.ctx.currentTime, 0.05);
  }

  /** Call once per frame with every car that should be heard; the first is the player's. */
  update(dt: number, camera: THREE.Camera, cars: readonly Car[]): void {
    if (this.ctx.state !== 'running') return;
    this.placeListener(camera);

    for (const [car, voice] of this.voices) {
      if (!cars.includes(car)) {
        voice.dispose();
        this.voices.delete(car);
      }
    }
    cars.forEach((car, i) => {
      let voice = this.voices.get(car);
      if (!voice) this.voices.set(car, (voice = new CarVoice(this.ctx, this.master, this.noise, i === 0 ? 1 : MIX.aiEngine)));
      voice.update(dt, car);
    });

    const player = cars[0];
    const speed = player.velocity.length();
    const now = this.ctx.currentTime;
    this.windGain.gain.setTargetAtTime(MIX.wind * Math.min(1, (speed / 45) ** 2), now, 0.1);
    this.windFilter.frequency.setTargetAtTime(350 + speed * 25, now, 0.1);
  }

  // --- Positional one-shots for car events.

  impact(car: Car, at: THREE.Vector3, severity: number): void {
    const voice = this.voices.get(car);
    const now = this.ctx.currentTime;
    if (!voice || now - voice.lastCrunch < CRUNCH_GAP) return;
    voice.lastCrunch = now;
    const k = Math.min(1, severity / 10);
    const out = this.oneShotOut(at, MIX.crunch * (0.35 + 0.65 * k));
    // Body of the crunch: band of noise; crackle on top; a low thump; a short metallic ring.
    this.noiseBurst(out, 'bandpass', 700 + Math.random() * 700, 0.8, 1, 0.2 + 0.4 * k);
    this.noiseBurst(out, 'highpass', 3000, 0.7, 0.35, 0.1);
    this.sweep(out, 'sine', 120, 38, 0.9 * k + 0.2, 0.3);
    for (let i = 0; i < 3; i++) this.tone(out, 'triangle', 300 + Math.random() * 700, 0.12 * k, 0.25 + 0.3 * k);
  }

  glass(_car: Car, at: THREE.Vector3, shattered: boolean): void {
    const out = this.oneShotOut(at, MIX.glass);
    if (!shattered) {
      this.noiseBurst(out, 'highpass', 2500, 1, 0.6, 0.07);
      this.tone(out, 'sine', 2800 + Math.random() * 1500, 0.2, 0.12);
      return;
    }
    this.noiseBurst(out, 'highpass', 4000, 0.8, 0.9, 0.45);
    // Tinkling pieces landing over the next half second.
    for (let i = 0; i < 14; i++) this.tone(out, 'sine', 3000 + Math.random() * 6000, 0.12, 0.06 + Math.random() * 0.08, Math.random() * 0.5);
  }

  clank(_car: Car, at: THREE.Vector3, size: number): void {
    const out = this.oneShotOut(at, MIX.clank * (0.5 + 0.5 * size));
    this.tone(out, 'triangle', 200 + Math.random() * 120, 0.5, 0.35);
    this.tone(out, 'triangle', 430 + Math.random() * 200, 0.3, 0.25);
    this.noiseBurst(out, 'bandpass', 1500, 1.5, 0.5, 0.12);
  }

  land(_car: Car, at: THREE.Vector3, strength: number): void {
    const k = Math.min(1, strength / 10);
    if (k < 0.1) return;
    const out = this.oneShotOut(at, MIX.thud * k);
    this.sweep(out, 'sine', 90, 32, 1, 0.28);
    this.noiseBurst(out, 'lowpass', 300, 0.7, 0.8, 0.18);
  }

  // --- Building blocks.

  private placeListener(camera: THREE.Camera): void {
    const l = this.ctx.listener;
    const now = this.ctx.currentTime;
    const p = camera.getWorldPosition(new THREE.Vector3());
    const f = camera.getWorldDirection(new THREE.Vector3());
    const u = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    l.positionX.setTargetAtTime(p.x, now, 0.02);
    l.positionY.setTargetAtTime(p.y, now, 0.02);
    l.positionZ.setTargetAtTime(p.z, now, 0.02);
    l.forwardX.setTargetAtTime(f.x, now, 0.02);
    l.forwardY.setTargetAtTime(f.y, now, 0.02);
    l.forwardZ.setTargetAtTime(f.z, now, 0.02);
    l.upX.setTargetAtTime(u.x, now, 0.02);
    l.upY.setTargetAtTime(u.y, now, 0.02);
    l.upZ.setTargetAtTime(u.z, now, 0.02);
  }

  /** A short-lived panner at `at` feeding the master bus; disconnects itself when done. */
  private oneShotOut(at: THREE.Vector3, level: number): GainNode {
    const gain = new GainNode(this.ctx, { gain: level });
    const panner = new PannerNode(this.ctx, { ...PANNER, positionX: at.x, positionY: at.y, positionZ: at.z });
    gain.connect(panner).connect(this.master);
    setTimeout(() => panner.disconnect(), 2000);
    return gain;
  }

  private noiseBurst(out: AudioNode, type: BiquadFilterType, freq: number, q: number, peak: number, decay: number): void {
    const t = this.ctx.currentTime;
    const src = new AudioBufferSourceNode(this.ctx, { buffer: this.noise });
    const env = envelope(this.ctx, t, peak, decay);
    src.connect(new BiquadFilterNode(this.ctx, { type, frequency: freq, Q: q })).connect(env).connect(out);
    src.start(t, Math.random() * (this.noise.duration - decay - 0.1), decay + 0.05);
  }

  private tone(out: AudioNode, type: OscillatorType, freq: number, peak: number, decay: number, delay = 0): void {
    const t = this.ctx.currentTime + delay;
    const osc = new OscillatorNode(this.ctx, { type, frequency: freq });
    osc.connect(envelope(this.ctx, t, peak, decay)).connect(out);
    osc.start(t);
    osc.stop(t + decay + 0.05);
  }

  private sweep(out: AudioNode, type: OscillatorType, from: number, to: number, peak: number, decay: number): void {
    const t = this.ctx.currentTime;
    const osc = new OscillatorNode(this.ctx, { type, frequency: from });
    osc.frequency.exponentialRampToValueAtTime(to, t + decay);
    osc.connect(envelope(this.ctx, t, peak, decay)).connect(out);
    osc.start(t);
    osc.stop(t + decay + 0.05);
  }
}

/** Gain node with a fast attack and exponential decay starting at `t`. */
function envelope(ctx: AudioContext, t: number, peak: number, decay: number): GainNode {
  const g = new GainNode(ctx, { gain: 0 });
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  return g;
}

function gearRpm(speed: number, throttle: number): number {
  let lo = 0;
  for (const hi of GEAR_TOPS) {
    if (speed <= hi) {
      const t = (speed - lo) / (hi - lo);
      // First gear starts from idle; higher gears pick up where the last shift dropped them.
      const floor = lo === 0 ? IDLE_RPM : SHIFT_RPM * 0.6;
      return floor + t * (SHIFT_RPM - floor) + throttle * 300;
    }
    lo = hi;
  }
  return SHIFT_RPM;
}

function whiteNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function softClip(): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 2.5);
  }
  return curve;
}
