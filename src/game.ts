import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { GRAVITY, PHYSICS_STEP } from './constants';
import { GameAudio } from './audio/audio';
import { Hud } from './hud';
import { Input } from './input';
import { OrbitCamera } from './render/orbitCamera';
import { HeliCamera } from './render/heliCamera';
import { PointerOrbit } from './render/pointerOrbit';
import { Juice } from './render/juice';
import { Stage } from './render/stage';
import { Visibility } from './render/visibility';
import { Traffic } from './traffic';
import { AiDriver } from './vehicle/aiDriver';
import { Car, type CarEvents, type CarInput } from './vehicle/car';
import { COUPE_70S } from './vehicle/carConfig';
import { Debris } from './world/debris';
import { LOAD_RADIUS, Terrain, type StreamCenter } from './world/terrain';
import { TerrainField } from './world/terrainField';
import { TreeLayout } from './world/trees';

const CAMERA_MODES = ['orbit', 'heli'] as const;
/** Slow-motion speeds (game time per real time) and their HUD labels; it starts at ¼. */
const SLOW_SPEEDS = [1 / 2, 1 / 4, 1 / 8, 1 / 16];
const SLOW_LABELS = ['½×', '¼×', '⅛×', '1/16×'];
/** How quickly slow motion eases in and out (1/s): about 0.3 s. */
const SLOW_RAMP = 10;
type CameraMode = (typeof CAMERA_MODES)[number];

/** No car legitimately goes this fast (m/s); beyond it the physics has blown up. */
const SANE_SPEED = 400;
/** Avoid a spiral of death after a long stall (tab switch, breakpoint). */
const MAX_STEPS_PER_FRAME = 5;
/** Chunks built per frame while streaming; the first batch is built up front. */
const STREAM_BUDGET = 2;
const INITIAL_CHUNKS = 25;
/** AI cars only need ground under them (they're beyond the fog when far away). */
const AI_STREAM_RADIUS = 1;

export class Game {
  readonly stage: Stage;
  readonly world: RAPIER.World;
  readonly field: TerrainField;
  car: Car;
  readonly traffic: Traffic;
  private readonly view = new Visibility();
  private readonly events = new RAPIER.EventQueue(true);
  private readonly terrain: Terrain;
  private readonly debris: Debris;
  private readonly orbit: OrbitCamera;
  private readonly heli: HeliCamera;
  /** Active camera; C cycles through CAMERA_MODES. */
  private cameraMode: CameraMode = 'orbit';
  /** Esc pauses: the simulation stops, the camera keeps running. */
  private paused = false;
  /** T toggles slow motion; ' picks its speed from SLOW_SPEEDS. timeScale eases toward it. */
  private slowMotion = false;
  private slowLevel = 1;
  private timeScale = 1;
  private readonly input = new Input();
  private readonly hud = new Hud();
  private readonly audio = new GameAudio();
  private readonly juice: Juice;
  /** Remaining hit-stop: the simulation is frozen while this is above zero. */
  private hitStop = 0;
  /** Last sane position of the player's car, where N respawns if the physics blew up. */
  private readonly lastSafe = new THREE.Vector3();
  private readonly bufferSize = new THREE.Vector2();
  private readonly trees: TreeLayout;
  /** Drives the player's car while the autopilot is on. */
  private readonly ai: AiDriver;
  /** Shows the AI's chosen heading while the autopilot drives. */
  private readonly aiArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(), 6, 0x2b7de9, 1.2, 0.7);
  private autopilot = false;
  private showAiHeading = false;
  private accumulator = 0;
  private lastTime = 0;

  constructor(container: HTMLElement, seed: number) {
    this.stage = new Stage(container);
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = PHYSICS_STEP;
    this.field = new TerrainField(seed);
    this.trees = new TreeLayout(this.field);
    this.terrain = new Terrain(this.field, this.stage.scene, this.world, this.trees);
    this.ai = new AiDriver(this.trees);
    this.aiArrow.visible = false;
    this.stage.scene.add(this.aiArrow);
    this.debris = new Debris(this.stage.scene, this.world, this.field);
    this.traffic = new Traffic(this.field, this.trees, this.terrain, (at, yaw, paint) => this.newCar(at, yaw, paint));
    // Both cameras orbit with the mouse; only the active one takes the input.
    const pointer = new PointerOrbit();
    pointer.attach(this.stage.renderer.domElement);
    this.orbit = new OrbitCamera(this.stage.camera, this.field, pointer);
    this.heli = new HeliCamera(this.stage.camera, this.field, pointer);
    this.juice = new Juice(
      this.stage.scene, this.field, this.orbit, this.stage.camera,
      (car) => car === this.car,
      (seconds) => (this.hitStop = Math.max(this.hitStop, seconds)),
    );

    const spawn = new THREE.Vector3(0, this.field.height(0, 0) + 1.5, 0);
    this.terrain.update([{ position: spawn, radius: LOAD_RADIUS }], INITIAL_CHUNKS);
    this.car = this.newCar(spawn, 0);
  }

  start(): void {
    requestAnimationFrame((t) => {
      this.lastTime = t;
      requestAnimationFrame(this.frame);
    });
  }

  private newCar(position: THREE.Vector3, yaw: number, paint?: string): Car {
    const car = new Car(COUPE_70S, this.world, this.stage.scene, this.debris, position, yaw, paint);
    car.events = fanOut(this.audio, this.juice);
    return car;
  }

  private get allCars(): Car[] {
    return [this.car, ...this.traffic.cars.map((a) => a.car)];
  }

  /**
   * One frame. Errors are shown on screen and logged (once per message) instead of
   * silently killing the loop, so a crash leaves something to report.
   */
  private frame = (now: number): void => {
    try {
      this.tick(now);
    } catch (error) {
      this.reportError(error);
    }
    requestAnimationFrame(this.frame);
  };

  private readonly reportedErrors = new Set<string>();

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.reportedErrors.has(message)) return;
    this.reportedErrors.add(message);
    console.error(error);
    const box = document.getElementById('error')!;
    // A Rapier (WebAssembly) panic leaves the physics world unusable; only a reload helps.
    const fatal = error instanceof WebAssembly.RuntimeError || /recursive use of an object/.test(message);
    box.textContent = `Something broke: ${message}${fatal ? ' – please reload the page' : ''} (details in the browser console)`;
    box.hidden = false;
  }

  private tick(now: number): void {
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;

    if (this.input.consume('Escape')) this.togglePause();
    // While paused, only the camera and mute keys act; the rest are dropped, not queued.
    const reset = this.input.consume('KeyR');
    const replace = this.input.consume('KeyN');
    const autopilot = this.input.consume('KeyP');
    if (!this.paused) {
      if (reset) this.car.resetUpright(this.field);
      if (replace) this.replaceCar();
      if (autopilot) this.toggleAutopilot(this.input.shift);
    }
    if (this.input.consume('KeyM')) this.audio.toggleMute();
    if (this.input.consume('KeyC')) this.cycleCamera();
    if (this.input.consume('KeyT')) this.slowMotion = !this.slowMotion;
    if (this.input.consume("char:'")) {
      // Cycles the slow-motion speed; from normal speed it first switches to the current one.
      if (this.slowMotion) this.slowLevel = (this.slowLevel + 1) % SLOW_SPEEDS.length;
      this.slowMotion = true;
    }
    this.input.endFrame();
    const slowTarget = this.slowMotion ? SLOW_SPEEDS[this.slowLevel] : 1;
    this.timeScale += (slowTarget - this.timeScale) * (1 - Math.exp(-SLOW_RAMP * dt));
    if (Math.abs(slowTarget - this.timeScale) < 0.002) this.timeScale = slowTarget;
    this.hud.setSlowMotion(this.slowMotion ? SLOW_LABELS[this.slowLevel] : null);
    this.audio.setTimeScale(this.timeScale);
    /** Game time this frame: slowed down in slow motion. */
    const gt = dt * this.timeScale;

    if (this.paused) {
      // Everything stands still except the camera, which runs on real time so the frozen
      // scene can be looked around.
      (this.cameraMode === 'orbit' ? this.orbit : this.heli).update(dt, this.car.model.root, this.car.velocity, true);
      this.view.update(this.stage.camera, this.stage.viewDistance);
      this.stage.follow(this.car.position);
      this.stage.render();
      return;
    }

    const controls = new Map<Car, CarInput>();
    controls.set(this.car, this.autopilot ? this.drive(this.ai, this.car, gt) : this.input.car());
    for (const a of this.traffic.cars) controls.set(a.car, this.drive(a.driver, a.car, gt));

    const cars = this.allCars;
    // Hit-stop freezes the simulation; the camera (and its shake) keeps running. Slow motion
    // feeds physics less time: it still steps at PHYSICS_STEP (damage and the rest are tuned
    // per step), just less often, and everything is drawn interpolated between steps.
    const simDt = this.hitStop > 0 ? 0 : gt;
    this.hitStop = Math.max(0, this.hitStop - dt);
    this.accumulator = Math.min(this.accumulator + simDt, PHYSICS_STEP * MAX_STEPS_PER_FRAME);
    while (this.accumulator >= PHYSICS_STEP) {
      for (const car of cars) car.step(PHYSICS_STEP, controls.get(car)!);
      this.world.step(this.events);
      this.events.drainContactForceEvents((e) => {
        for (const car of cars) car.handleContactForce(e.collider1(), e.collider2(), e.totalForceMagnitude());
      });
      for (const car of cars) car.afterStep();
      this.debris.afterStep();
      this.accumulator -= PHYSICS_STEP;
    }

    this.checkPhysicsSanity(cars);

    const alpha = this.accumulator / PHYSICS_STEP;
    // The sanity check can remove cars, so take a fresh list: touching a removed car's
    // physics body is a fatal Rapier panic.
    for (const car of this.allCars) car.syncVisual(alpha, gt);
    const pos = this.car.position;
    const centers: StreamCenter[] = [
      { position: pos, radius: LOAD_RADIUS },
      ...this.traffic.cars.map((a) => ({ position: a.car.position, radius: AI_STREAM_RADIUS })),
    ];
    this.terrain.update(centers, STREAM_BUDGET);
    const camera = this.cameraMode === 'orbit' ? this.orbit : this.heli;
    camera.update(dt, this.car.model.root, this.car.velocity, false, this.timeScale);
    this.view.update(this.stage.camera, this.stage.viewDistance);
    this.debris.update(gt, pos, this.view, alpha);
    this.traffic.update(gt, pos, this.view);
    this.stage.follow(pos);
    this.aiArrow.visible = this.autopilot && this.showAiHeading;
    if (this.aiArrow.visible) {
      this.aiArrow.position.copy(pos).setY(pos.y + 1.6);
      this.aiArrow.setDirection(this.ai.heading);
    }
    // Traffic may have despawned cars just now; again use a fresh list.
    const live = this.allCars;
    this.juice.update(gt, live, this.stage.renderer.getDrawingBufferSize(this.bufferSize).y / 2);
    this.audio.update(gt, this.stage.camera, live);
    this.hud.update(gt, this.car, this.autopilot);
    this.stage.render();
  }

  private togglePause(): void {
    this.paused = !this.paused;
    this.hud.setPaused(this.paused);
    this.audio.setPaused(this.paused);
  }

  private cycleCamera(): void {
    this.cameraMode = CAMERA_MODES[(CAMERA_MODES.indexOf(this.cameraMode) + 1) % CAMERA_MODES.length];
    (this.cameraMode === 'orbit' ? this.orbit : this.heli).reset();
  }

  /** P toggles the autopilot; Shift+P toggles its heading arrow (switching the autopilot on if needed). */
  private toggleAutopilot(withHeading: boolean): void {
    if (withHeading) {
      this.showAiHeading = !this.autopilot || !this.showAiHeading;
      this.autopilot = true;
    } else {
      this.autopilot = !this.autopilot;
      this.showAiHeading = false;
    }
  }

  /**
   * Catches a car whose simulation blew up (non-finite or absurd speed) before its
   * garbage position reaches terrain, AI or audio code. AI cars are removed; the
   * player's car is reported on screen.
   */
  private checkPhysicsSanity(cars: readonly Car[]): void {
    for (const car of cars) {
      const v = car.body.linvel();
      const t = car.body.translation();
      const speed = Math.hypot(v.x, v.y, v.z);
      if (speed < SANE_SPEED && Number.isFinite(t.x + t.y + t.z)) {
        if (car === this.car) this.lastSafe.set(t.x, t.y, t.z);
        continue;
      }
      console.error('Car physics blew up', { player: car === this.car, position: { ...t }, velocity: { ...v } });
      if (car !== this.car) this.traffic.remove(car);
      else throw new Error(`Your car's physics blew up (speed ${speed.toFixed(0)} m/s). Press N for a new car.`);
    }
  }

  private drive(driver: AiDriver, car: Car, dt: number): CarInput {
    const others = this.allCars.filter((c) => c !== car).map((c) => c.position);
    const decision = driver.update(dt, car, others);
    if (decision.reset) car.resetUpright(this.field);
    return decision.input;
  }

  private replaceCar(): void {
    const t = this.lastSafe;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.car.model.root.quaternion);
    const yaw = Math.atan2(-fwd.x, -fwd.z);
    this.car.dispose();
    this.car = this.newCar(new THREE.Vector3(t.x, this.field.height(t.x, t.z) + 2, t.z), yaw);
    this.hud.reset();
  }
}

/** Forwards every car event to several listeners (sound, visual effects). */
function fanOut(...targets: CarEvents[]): CarEvents {
  return {
    impact: (...args) => targets.forEach((t) => t.impact(...args)),
    glass: (...args) => targets.forEach((t) => t.glass(...args)),
    clank: (...args) => targets.forEach((t) => t.clank(...args)),
    land: (...args) => targets.forEach((t) => t.land(...args)),
  };
}
