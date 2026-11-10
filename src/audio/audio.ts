import * as THREE from 'three';
import type { Car, CarEvents, ContactSurface } from '../vehicle/car';
import { ENGINE_PROCESSOR, loadEngineWorklet } from './engineWorklet';

/** Mix levels. Everything is synthesised; these are by-ear starting points. */
/** The slow-motion low-pass: wide open at normal speed, and the lowest it closes down to (Hz). */
const SLOW_OPEN = 20000;
const SLOW_FLOOR = 300;

const MIX = {
  master: 0.7,
  engine: 0.2,
  /** AI engines sit under the player's own. */
  aiEngine: 0.45,
  tyres: 0.3,
  scrape: 0.35,
  wind: 0.35,
  crunch: 1,
  /** How far engine and wind dip under a full-strength hit (0..1). */
  duck: 0.6,
  glass: 0.6,
  clank: 0.5,
  thud: 0.8,
  /** Rocks: knocked loose, clacking on each other, landing. */
  rock: 0.7,
};

/** At most this many rock clacks and thuds start within ROCK_WINDOW s: a collapsing heap would otherwise pile up voices. */
const ROCK_VOICES = 6;
/**
 * Stone strikes (see modalStrike): the lowest mode at `stoneFrom` Hz for a mid-sized stone (higher
 * for smaller ones), modes at irregular ratios like an irregular stone's, filter Q (1 / tan φ: the
 * stone's internal friction) and the strike's length (s; stone on stone is a hard, instant contact).
 * Feel values, after modal synthesis of impact sounds: material is heard mostly in how fast each
 * frequency dies out.
 */
const ROCK = {
  stoneFrom: 1100,
  q: 40,
  strike: 0.003,
  /** Make-up gain: a 3 ms burst through narrow filters comes out quiet; this brings its peak up to the other one-shots'. */
  gain: 3.5,
  modes: [
    { ratio: 1, level: 1 },
    { ratio: 1.47, level: 0.8 },
    { ratio: 2.09, level: 0.65 },
    { ratio: 2.83, level: 0.5 },
    { ratio: 3.9, level: 0.35 },
    { ratio: 5.2, level: 0.25 },
  ],
};const ROCK_WINDOW = 0.1;

/** Simulated gearbox for engine pitch: upper speed (m/s) of each gear. */
const GEAR_TOPS = [9, 17, 27, 40, 70];
const IDLE_RPM = 800;
const SHIFT_RPM = 5800;

/** Panners: full volume within `ref` metres, fading with distance. */
const PANNER: PannerOptions = {
  panningModel: 'equalpower',
  distanceModel: 'inverse',
  refDistance: 10,
  maxDistance: 250,
  rolloffFactor: 1.2,
};

/**
 * Landing speeds (m/s downward) mapped onto the thunk's strength: on this steep,
 * fast mountain ordinary jumps land at 10–20 m/s.
 */
const LANDING = { from: 3, full: 22 };

/** Minimum gap between crunches from the same car, so scraping contacts don't machine-gun. */
const CRUNCH_GAP = 0.09;

/** Engine, tyre and scrape loops for one car. */
class CarVoice {
  readonly panner: PannerNode;
  private readonly engine: AudioWorkletNode;
  private readonly rasp: BiquadFilterNode;
  private readonly muffler: BiquadFilterNode;
  private readonly engineGain: GainNode;
  private readonly tyreGain: GainNode;
  private readonly scrapeGain: GainNode;
  private readonly sources: AudioBufferSourceNode[] = [];
  private rpm = IDLE_RPM;
  lastCrunch = 0;

  constructor(private readonly ctx: AudioContext, out: AudioNode, noise: AudioBuffer, private readonly level: number) {
    this.panner = new PannerNode(ctx, PANNER);
    this.panner.connect(out);

    // Engine: combustion pulses (worklet) → exhaust resonances → soft saturation → muffler.
    this.engine = new AudioWorkletNode(ctx, ENGINE_PROCESSOR, { numberOfInputs: 0, outputChannelCount: [1] });
    this.rasp = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 750, Q: 1.2, gain: 0 });
    this.muffler = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 600, Q: 0.8 });
    this.engineGain = new GainNode(ctx, { gain: 0 });
    this.engine
      .connect(new BiquadFilterNode(ctx, { type: 'highpass', frequency: 30 }))
      // Chest: the big, low exhaust resonance that makes a V8 rumble.
      .connect(new BiquadFilterNode(ctx, { type: 'peaking', frequency: 130, Q: 1.1, gain: 8 }))
      .connect(this.rasp)
      .connect(new GainNode(ctx, { gain: 0.6 }))
      .connect(new WaveShaperNode(ctx, { curve: softClip(), oversample: '2x' }))
      .connect(this.muffler)
      .connect(this.engineGain)
      .connect(this.panner);

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

  /** @param pitch slow motion lowers the engine (see AudioEngine.setTimeScale) */
  update(dt: number, car: Car, pitch: number): void {
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
    const load = throttle * alive;
    const revs = this.rpm / SHIFT_RPM;
    this.engine.parameters.get('rpm')!.setTargetAtTime(this.rpm * pitch, now, 0.03);
    this.engine.parameters.get('load')!.setTargetAtTime(load, now, 0.05);
    // Open throttle brings out the rasp; revs and throttle open the muffler up.
    this.rasp.gain.setTargetAtTime(-4 + load * 10, now, 0.06);
    this.muffler.frequency.setTargetAtTime((350 + revs * 1800 + load * 1400) * pitch, now, 0.05);
    this.engineGain.gain.setTargetAtTime(MIX.engine * this.level * alive * (0.7 + 0.3 * load), now, 0.08);

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
    this.engine.port.postMessage('stop');
    this.engine.disconnect();
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
  private paused = false;

  constructor() {
    const start = () => {
      if (this.engine) return;
      this.engine = new AudioEngine();
      this.engine.setMuted(this.muted || this.paused);
    };
    window.addEventListener('keydown', start, { once: true });
    window.addEventListener('pointerdown', start, { once: true });
  }

  toggleMute(): void {
    this.muted = !this.muted;
    this.engine?.setMuted(this.muted || this.paused);
  }

  /** Slow motion (game time per real time, 1 = normal): sounds drop in pitch and stretch out. */
  setTimeScale(scale: number): void {
    this.engine?.setTimeScale(scale);
  }

  /** Silences everything while the game is paused (the mute setting is kept apart). */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.engine?.setMuted(this.muted || this.paused);
  }

  update(dt: number, camera: THREE.Camera, cars: readonly Car[]): void {
    this.engine?.update(dt, camera, cars);
  }

  impact(car: Car, at: THREE.Vector3, severity: number, surface: ContactSurface): void {
    this.engine?.impact(car, at, severity, surface);
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

  /** A rock knocked loose (a boulder, a varde's stones) at `at`, `size` m across its radius. */
  rockKnock(at: THREE.Vector3, size: number): void {
    this.engine?.rockKnock(at, size);
  }

  /** Loose rocks striking each other (`stone`) or the ground, `k` 0..1 how hard, the smaller rock `size` m in radius. */
  rockHit(at: THREE.Vector3, k: number, size: number, stone: boolean): void {
    this.engine?.rockHit(at, k, size, stone);
  }
}

class AudioEngine {
  private readonly ctx = new AudioContext();
  private readonly master: GainNode;
  private readonly noise: AudioBuffer;
  private readonly voices = new Map<Car, CarVoice>();
  private readonly windGain: GainNode;
  private readonly windFilter: BiquadFilterNode;
  /** Engines, tyres and wind; ducked under hits so impacts punch through. */
  private readonly loops: GainNode;
  /** The car the listener is following (first in `update`'s list). */
  private player: Car | null = null;
  /** Car voices need the engine worklet, which loads asynchronously. */
  private engineReady = false;
  /**
   * Slow motion's pitch factor: √(time scale), so ¼ speed sounds an octave down and 1/16 two,
   * rather than dropping to an inaudible rumble. One-shots stretch by its inverse.
   */
  private pitch = 1;
  /** Closes down in slow motion for a muffled, underwater feel. */
  private readonly slowFilter: BiquadFilterNode;
  /** When the latest rock clacks and thuds started (see ROCK_VOICES). */
  private rockTimes: number[] = [];

  constructor() {
    loadEngineWorklet(this.ctx).then(
      () => (this.engineReady = true),
      (error) => console.error('Engine sound failed to load', error),
    );
    // Safety limiter only: set high so it catches peaks without flattening every hit.
    const limiter = new DynamicsCompressorNode(this.ctx, { threshold: -4, knee: 4, ratio: 8, attack: 0.002, release: 0.15 });
    this.master = new GainNode(this.ctx, { gain: MIX.master });
    this.slowFilter = new BiquadFilterNode(this.ctx, { type: 'lowpass', frequency: SLOW_OPEN, Q: 0.7 });
    this.master.connect(this.slowFilter).connect(limiter).connect(this.ctx.destination);
    this.loops = new GainNode(this.ctx, { gain: 1 });
    this.loops.connect(this.master);
    this.noise = whiteNoise(this.ctx, 2);

    this.windGain = new GainNode(this.ctx, { gain: 0 });
    this.windFilter = new BiquadFilterNode(this.ctx, { type: 'lowpass', frequency: 500, Q: 0.5 });
    const wind = new AudioBufferSourceNode(this.ctx, { buffer: this.noise, loop: true });
    wind.connect(this.windFilter).connect(this.windGain).connect(this.loops);
    wind.start();
  }

  setMuted(muted: boolean): void {
    this.master.gain.setTargetAtTime(muted ? 0 : MIX.master, this.ctx.currentTime, 0.05);
  }

  setTimeScale(scale: number): void {
    this.pitch = Math.sqrt(THREE.MathUtils.clamp(scale, 0.01, 1));
    // Fully open at normal speed, ≈2.5 kHz at ¼, closing to SLOW_FLOOR further down.
    const cutoff = Math.max(SLOW_FLOOR, SLOW_OPEN * this.pitch ** 3);
    this.slowFilter.frequency.setTargetAtTime(cutoff, this.ctx.currentTime, 0.05);
  }

  /** Call once per frame with every car that should be heard; the first is the player's. */
  update(dt: number, camera: THREE.Camera, cars: readonly Car[]): void {
    if (this.ctx.state !== 'running' || !this.engineReady) return;
    this.placeListener(camera);

    for (const [car, voice] of this.voices) {
      if (!cars.includes(car)) {
        voice.dispose();
        this.voices.delete(car);
      }
    }
    cars.forEach((car, i) => {
      let voice = this.voices.get(car);
      if (!voice) this.voices.set(car, (voice = new CarVoice(this.ctx, this.loops, this.noise, i === 0 ? 1 : MIX.aiEngine)));
      voice.update(dt, car, this.pitch);
    });

    const player = cars[0];
    this.player = player;
    const speed = player.velocity.length();
    const now = this.ctx.currentTime;
    this.windGain.gain.setTargetAtTime(MIX.wind * Math.min(1, (speed / 45) ** 2), now, 0.1);
    this.windFilter.frequency.setTargetAtTime((350 + speed * 25) * this.pitch, now, 0.1);
  }

  // --- Positional one-shots for car events.

  impact(car: Car, at: THREE.Vector3, severity: number, surface: ContactSurface): void {
    const voice = this.voices.get(car);
    const now = this.ctx.currentTime;
    if (!voice || now - voice.lastCrunch < CRUNCH_GAP) return;
    voice.lastCrunch = now;
    const k = Math.min(1, severity / 10);
    const out = this.oneShotOut(at, MIX.crunch * (0.2 + 0.8 * k), true);
    if (surface === 'ground') {
      // Belly-flopping into snow: a muffled whumpf. Metal only joins in on violent hits.
      this.bodyHit(out, 0.3 * k, 0.4 + 0.5 * k, 0.12 + 0.15 * k);
      this.noiseBurst(out, 'lowpass', 500, 0.7, 0.9, 0.12 + 0.15 * k);
      if (k > 0.5) this.crumple(out, (k - 0.5) * 2);
      this.duck(car, k * 0.5);
      return;
    }
    // Trees and cars: click for the attack, a heavy body hit, sheet metal crumpling,
    // then the panels ringing.
    this.noiseBurst(out, 'highpass', 1800, 0.7, 0.9, 0.025);
    this.bodyHit(out, k, 0.5 + 0.7 * k, 0.25 + 0.35 * k);
    this.crumple(out, k);
    this.panelRing(out, k);
    this.duck(car, k);
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

  land(car: Car, at: THREE.Vector3, strength: number): void {
    const k = THREE.MathUtils.clamp((strength - LANDING.from) / (LANDING.full - LANDING.from), 0, 1);
    if (k <= 0) return;
    const out = this.oneShotOut(at, MIX.thud * (0.3 + 0.7 * k), true);
    // A firm suspension thunk, never a sub boom: landings happen constantly.
    this.bodyHit(out, 0, 0.3 + 0.4 * k, 0.1 + 0.08 * k);
    this.noiseBurst(out, 'bandpass', 320, 1, 0.7, 0.09);
    this.tone(out, 'triangle', 210 + Math.random() * 40, 0.35, 0.08);
    this.duck(car, k * k * 0.4);
  }

  rockKnock(at: THREE.Vector3, size: number): void {
    const s = THREE.MathUtils.clamp(size / 1.5, 0, 1);
    const out = this.oneShotOut(at, MIX.rock, true);
    // A solid stony knock (noise only: a pitched thump reads as rubber), deeper for a bigger rock,
    // with grit over it and the stones' clack.
    this.noiseBurst(out, 'lowpass', 450 - 200 * s, 0.7, 0.9, 0.08 + 0.06 * s);
    this.noiseBurst(out, 'bandpass', 1000 - 400 * s, 1.2, 0.7, 0.07);
    this.noiseBurst(out, 'highpass', 3000, 0.8, 0.35, 0.05);
    this.rockHit(at, 1, size * 0.6, true);
  }

  rockHit(at: THREE.Vector3, k: number, size: number, stone: boolean): void {
    const now = this.ctx.currentTime;
    this.rockTimes = this.rockTimes.filter((t) => now - t < ROCK_WINDOW);
    if (this.rockTimes.length >= ROCK_VOICES) return;
    this.rockTimes.push(now);
    // Smaller stones ring higher; each strike lands a little differently.
    const pitch = THREE.MathUtils.clamp(0.4 / Math.max(0.15, size), 0.5, 2) * (0.85 + Math.random() * 0.3);
    if (stone) {
      // Stone on stone: a near-instant, bright strike rings the stones' modes briefly (see ROCK).
      const out = this.oneShotOut(at, MIX.rock * (0.25 + 0.75 * k));
      this.modalStrike(out, ROCK.stoneFrom * pitch, ROCK.q, ROCK.strike, 1);
      return;
    }
    // On the ground: the earth takes the hit, so the strike is soft and long, a dull thump with no ring.
    const out = this.oneShotOut(at, MIX.rock * (0.2 + 0.6 * k), true);
    this.noiseBurst(out, 'lowpass', 380 * pitch, 0.7, 1, 0.05);
    this.noiseBurst(out, 'bandpass', 160 * pitch, 1.2, 0.7, 0.035);
  }

  /**
   * Filter-based modal synthesis: a burst of noise `strike` s long rings a bank of resonant
   * bandpass filters at irregular ratios (ROCK.modes) from `from` Hz. One Q for all of them is one
   * internal friction (tan φ = 1 / Q), so higher modes die out faster, as in a real material.
   */
  private modalStrike(out: AudioNode, from: number, q: number, strike: number, peak: number): void {
    from *= this.pitch;
    strike /= this.pitch;
    const t = this.ctx.currentTime;
    // Long enough for the lowest mode to ring out (its decay time is Q / (π f)).
    const ring = (q / (Math.PI * from)) * 8;
    const src = new AudioBufferSourceNode(this.ctx, { buffer: this.noise, playbackRate: this.pitch });
    // An instant strike (envelope's 5 ms attack is longer than a hard contact).
    const hit = new GainNode(this.ctx, { gain: 0 });
    hit.gain.setValueAtTime(peak, t);
    hit.gain.exponentialRampToValueAtTime(0.0001, t + strike);
    src.connect(hit);
    for (const m of ROCK.modes) {
      const filter = new BiquadFilterNode(this.ctx, { type: 'bandpass', frequency: from * m.ratio * (0.92 + Math.random() * 0.16), Q: q });
      // A narrow band passes little of a noise burst: make up for it (∝ √Q).
      hit.connect(filter).connect(new GainNode(this.ctx, { gain: ROCK.gain * m.level * Math.sqrt(q) })).connect(out);
    }
    // A little of the strike itself, unfiltered, for the click of contact.
    hit.connect(new BiquadFilterNode(this.ctx, { type: 'highpass', frequency: 1500 })).connect(new GainNode(this.ctx, { gain: ROCK.gain * 0.25 })).connect(out);
    src.start(t, Math.random() * (this.noise.duration - 1), strike + ring);
  }

  // --- Impact layers.

  /**
   * The weight of a hit: a falling thump plus an octave above it (so small speakers
   * hear it). `depth` 0..1: light hits stay a higher thunk, heavy ones drop to a sub boom.
   */
  private bodyHit(out: AudioNode, depth: number, peak: number, decay: number): void {
    // Floor at ~45 Hz: lower is felt more than heard, and just sounds odd on headphones.
    const from = THREE.MathUtils.lerp(150, 100, depth);
    const to = THREE.MathUtils.lerp(85, 45, depth);
    this.sweep(out, 'sine', from, to, peak, decay);
    this.sweep(out, 'triangle', from * 1.8, to * 1.8, peak * 0.45, decay * 0.7);
  }

  /** Sheet metal folding: a cluster of short, differently pitched noise grains. */
  private crumple(out: AudioNode, k: number): void {
    const grains = 3 + Math.round(7 * k);
    const spread = 0.08 + 0.2 * k;
    for (let i = 0; i < grains; i++) {
      this.noiseBurst(out, 'bandpass', 400 + Math.random() * 2200, 1.6, 0.5 + Math.random() * 0.5, 0.02 + Math.random() * 0.05, Math.random() * spread);
    }
  }

  /** Body panels ringing after the hit: a few inharmonic partials. */
  private panelRing(out: AudioNode, k: number): void {
    for (const f of [173, 281, 397, 563, 811]) {
      this.tone(out, 'triangle', f * (0.85 + Math.random() * 0.3), 0.06 + 0.1 * k, 0.3 + 0.6 * k * Math.random());
    }
  }

  /**
   * Dips engines and wind for a moment so a hit punches through the mix. Only the
   * player's own car ducks: other cars' hits pumping your engine sounds like a fault.
   */
  private duck(car: Car, k: number): void {
    if (car !== this.player || k < 0.05) return;
    const g = this.loops.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(1 - MIX.duck * k, t + 0.01);
    g.setTargetAtTime(1, t + 0.06, 0.15);
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

  /**
   * A short-lived panner at `at` feeding the master bus; disconnects itself when done.
   * `saturate` drives the layers through a soft clipper, which glues them and adds
   * harmonics so low thumps are audible on small speakers.
   */
  private oneShotOut(at: THREE.Vector3, level: number, saturate = false): GainNode {
    const gain = new GainNode(this.ctx, { gain: level });
    const panner = new PannerNode(this.ctx, { ...PANNER, positionX: at.x, positionY: at.y, positionZ: at.z });
    if (saturate) gain.connect(new WaveShaperNode(this.ctx, { curve: softClip(), oversample: '2x' })).connect(panner);
    else gain.connect(panner);
    panner.connect(this.master);
    // Slow motion stretches the one-shots, so they need longer before the panner goes.
    setTimeout(() => panner.disconnect(), 2000 / this.pitch);
    return gain;
  }

  private noiseBurst(out: AudioNode, type: BiquadFilterType, freq: number, q: number, peak: number, decay: number, delay = 0): void {
    // Slow motion: lower and longer.
    freq *= this.pitch;
    decay /= this.pitch;
    delay /= this.pitch;
    const t = this.ctx.currentTime + delay;
    const src = new AudioBufferSourceNode(this.ctx, { buffer: this.noise, playbackRate: this.pitch });
    const env = envelope(this.ctx, t, peak, decay);
    src.connect(new BiquadFilterNode(this.ctx, { type, frequency: freq, Q: q })).connect(env).connect(out);
    src.start(t, Math.random() * (this.noise.duration - decay - 0.1), decay + 0.05);
  }

  private tone(out: AudioNode, type: OscillatorType, freq: number, peak: number, decay: number, delay = 0): void {
    freq *= this.pitch;
    decay /= this.pitch;
    delay /= this.pitch;
    const t = this.ctx.currentTime + delay;
    const osc = new OscillatorNode(this.ctx, { type, frequency: freq });
    osc.connect(envelope(this.ctx, t, peak, decay)).connect(out);
    osc.start(t);
    osc.stop(t + decay + 0.05);
  }

  private sweep(out: AudioNode, type: OscillatorType, from: number, to: number, peak: number, decay: number): void {
    from *= this.pitch;
    to *= this.pitch;
    decay /= this.pitch;
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
