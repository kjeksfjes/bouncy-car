import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { FEATURES, GRAVITY, PHYSICS_STEP } from './constants';
import { GameAudio } from './audio/audio';
import { Hud } from './hud';
import { Input } from './input';
import { OrbitCamera } from './render/orbitCamera';
import { HeliCamera } from './render/heliCamera';
import { PhotoCamera } from './render/photoCamera';
import { GroundSection } from './render/groundSection';
import { PointerOrbit } from './render/pointerOrbit';
import { SightCut } from './render/sightCut';
import { Juice } from './render/juice';
import { Stage } from './render/stage';
import { Visibility } from './render/visibility';
import { Traffic } from './traffic';
import { AiDriver } from './vehicle/aiDriver';
import { Car, crashWarmUpObjects, type CarEvents, type CarInput } from './vehicle/car';
import { clearPose, type Pose } from './vehicle/clearPose';
import { COUPE_70S } from './vehicle/carConfig';
import { Debris } from './world/debris';
import { BIOMES } from './world/biome';
import type { TerrainPreset } from './world/features';
import { INSPECT_LEGENDS, INSPECT_MODES, type InspectMode } from './world/inspect';
import { LOAD_RADIUS, Terrain, type StreamCenter } from './world/terrain';
import { TerrainField } from './world/terrainField';
import { Boulders } from './world/boulders';
import { Birds } from './world/birds';
import { Clods } from './world/clods';
import { Obstacles, RockLayout } from './world/details';
import { TreeLayout } from './world/trees';

const CAMERA_MODES = ['orbit', 'heli'] as const;
/** Slow-motion speeds (game time per real time) and their HUD labels; it starts at ¼. */
const SLOW_SPEEDS = [1 / 2, 1 / 4, 1 / 8, 1 / 16];
const SLOW_LABELS = ['½×', '¼×', '⅛×', '1/16×'];
/** How quickly slow motion eases in and out (1/s): about 0.3 s. */
const SLOW_RAMP = 10;
/**
 * B starts the next biome this far ahead (m): just past the fog's end (1000 m from the camera),
 * so the change can't be seen happening; and ramps it in over `ramp` m. Shift+B looks up to
 * `searchRange` m downhill for where the next biome starts.
 */
/** How quickly the sky and fog follow the biome's warmth (1/s): a few seconds. */
const WARMTH_EASE = 0.8;
const BIOME_JUMP = { ahead: 1010, ramp: 400, searchRange: 20_000 };
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

/** Dev only: ?nohood (see newCar). */
const NO_HOOD = import.meta.env.DEV && new URLSearchParams(location.search).has('nohood');

export class Game {
  readonly stage: Stage;
  readonly world: RAPIER.World;
  readonly field: TerrainField;
  car: Car;
  readonly traffic: Traffic;
  private readonly view = new Visibility();
  private readonly events = new RAPIER.EventQueue(true);
  private readonly terrain: Terrain;
  /** The ground cut open when the camera goes under it, if it may (see FEATURES.groundSection). */
  private readonly section: GroundSection | null;
  private readonly debris: Debris;
  private readonly orbit: OrbitCamera;
  private readonly heli: HeliCamera;
  /** Active camera; C cycles through CAMERA_MODES. */
  private cameraMode: CameraMode = 'orbit';
  /** Esc pauses: the simulation stops, the camera keeps running. */
  private paused = false;
  /** Photo mode (while paused, from a right-drag, Shift+drag or Option+drag): a free camera and no UI. */
  private photoMode = false;
  /** T toggles slow motion; ' picks its speed from SLOW_SPEEDS. timeScale eases toward it. */
  private slowMotion = false;
  private slowLevel = 1;
  /** Dev: the terrain inspection view shown (I cycles), or null for the normal ground. */
  private inspectMode: InspectMode | null = null;
  private timeScale = 1;
  /** The atmosphere's warmth (see Stage.setWarmth), eased toward the biome's. */
  private warmth = 0;
  private readonly input = new Input();
  private readonly hud = new Hud();
  private readonly pointer = new PointerOrbit();
  /** Trees hiding most of the car dissolve in front of it, except in photo mode, where the shot shows them whole. */
  private readonly sight = new SightCut();
  /** The terrain's height at (x, z), for the exposure's check on whether a ridge hides the sun. */
  private readonly groundHeight = (x: number, z: number): number => this.field.height(x, z);
  private readonly photo: PhotoCamera;
  private readonly audio = new GameAudio();
  private readonly juice: Juice;
  /** Whether the first frame has drawn the glass shards' warm-up (see Shards.warmUp). */
  private warmedUp = false;
  /** Last sane position of the player's car, where N respawns if the physics blew up. */
  private readonly lastSafe = new THREE.Vector3();
  private readonly bufferSize = new THREE.Vector2();
  private readonly trees: TreeLayout;
  private readonly rocks: RockLayout;
  private readonly boulders: Boulders;
  private readonly clods: Clods;
  /** Rooks, that burst out of rookery trees when a car hits one. */
  private readonly birds: Birds;
  /** Trees, boulders and tors: what resets keep a car clear of. */
  private readonly obstacles: Obstacles;
  /** Drives the player's car while the autopilot is on. */
  private readonly ai: AiDriver;
  /** Shows the AI's chosen heading while the autopilot drives. */
  private readonly aiArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(), 6, 0x2b7de9, 1.2, 0.7);
  private autopilot = false;
  /** The autopilot has asked for a new car (see drive). */
  private autopilotWantsCar = false;
  private showAiHeading = false;
  private accumulator = 0;
  private lastTime = 0;

  /**
   * @param start metres downhill to spawn at (dev: to test the lower biomes)
   * @param terrain which terrain generator to use
   * @param startX metres across the slope to spawn at (dev: to get back to a spot)
   */
  constructor(container: HTMLElement, seed: number, start = 0, terrain: TerrainPreset = 'classic', startX = 0) {
    this.stage = new Stage(container);
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = PHYSICS_STEP;
    this.field = new TerrainField(seed, terrain);
    this.trees = new TreeLayout(this.field);
    this.rocks = new RockLayout(this.field, this.trees);
    const obstacles = new Obstacles(this.trees, this.rocks, this.field.landmarks);
    this.obstacles = obstacles;
    this.terrain = new Terrain(this.field, this.stage.scene, this.world, this.trees, this.rocks);
    this.section = FEATURES.groundSection ? new GroundSection(this.stage.scene, (x, z) => this.terrain.surfaceHeight(x, z)) : null;
    this.ai = new AiDriver(this.field, obstacles);
    this.aiArrow.visible = false;
    this.stage.scene.add(this.aiArrow);
    this.debris = new Debris(this.stage.scene, this.world, this.field);
    this.traffic = new Traffic(this.field, obstacles, this.terrain, (at, yaw, paint) => this.newCar(at, yaw, paint));
    // Both cameras orbit with the mouse; only the active one takes the input.
    this.pointer.attach(this.stage.renderer.domElement);
    this.orbit = new OrbitCamera(this.stage.camera, this.field, this.pointer);
    this.heli = new HeliCamera(this.stage.camera, this.field, this.pointer);
    const ground = (x: number, z: number) => this.terrain.surfaceHeight(x, z);
    this.photo = new PhotoCamera(this.stage.camera, this.pointer, (ndc, out) => this.stage.surfaceAt(ndc, out), FEATURES.groundSection ? null : ground);
    this.clods = new Clods(this.stage.scene, ground);
    this.birds = new Birds(this.stage.scene, this.field, this.trees);
    this.juice = new Juice(
      this.stage.scene, this.field, this.trees, this.orbit, this.stage.camera,
      (car) => car === this.car,
      ground,
      this.clods,
    );
    this.boulders = new Boulders(this.world, this.stage.scene, this.field, this.terrain, this.debris, (at, velocity, radius, ground) => {
      this.juice.uproot(at, velocity, radius, ground === 'rock');
      this.clods.burst(at, velocity, radius, ground);
    }, this.audio);

    const spawn = new THREE.Vector3(startX, this.field.height(startX, -start) + 1.5, -start);
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
    car.events = fanOut(this.audio, this.juice, this.birds);
    // Dev only: ?nohood leaves the hood off (only its look: it still collides), to see into the bay.
    if (import.meta.env.DEV && NO_HOOD) car.model.pieces.find((p) => p.name === 'hood')!.mesh.visible = false;
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

    // Slow motion first: Esc below depends on it.
    if (this.input.consume('KeyT')) {
      this.slowMotion = !this.slowMotion;
      if (this.slowMotion) this.hud.flashSlowMotion();
    }
    if (this.input.consume("char:'")) {
      // Cycles the slow-motion speed; from normal speed it first switches to the current one.
      if (this.slowMotion) this.slowLevel = (this.slowLevel + 1) % SLOW_SPEEDS.length;
      this.slowMotion = true;
      this.hud.flashSlowMotion();
    }
    // Esc pauses and resumes. In photo mode it leaves photo mode, except in slow motion, where it
    // plays the action on (and pauses it again) as seen from the photo camera.
    if (this.input.consume('Escape')) {
      if (this.photoMode && !this.slowMotion) this.setPhotoMode(false);
      else this.togglePause();
    }
    if (this.input.consume('KeyH')) this.hud.toggleLegend();
    // While paused, only the camera and mute keys act; the rest are dropped, not queued.
    const reset = this.input.consume('KeyR');
    const replace = this.input.consume('KeyN');
    const nextBiome = this.input.consume('KeyB');
    const jumpBiome = this.input.consume('shift:KeyB');
    const autopilot = this.input.consume('KeyP');
    const tip = this.input.consume('KeyF');
    if (!this.paused) {
      if (reset) this.resetCar(this.car);
      if (replace || this.autopilotWantsCar) this.replaceCar();
      this.autopilotWantsCar = false;
      if (jumpBiome) this.jumpToNextBiome();
      else if (nextBiome) this.startNextBiome();
      if (autopilot) this.toggleAutopilot(this.input.shift);
      if (tip) this.car.tipOver(135);
    }
    if (this.input.consume('KeyM')) this.audio.toggleMute();
    if (this.input.consume('KeyC')) this.cycleCamera();
    if (import.meta.env.DEV && this.input.consume('KeyI')) this.cycleInspect();
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
      // scene can be looked around. A right-drag, Shift+drag or Option+drag hands it to photo mode's free camera.
      if (!this.photoMode && this.pointer.freeLook) this.setPhotoMode(true);
      if (this.photoMode) {
        const keys = this.input.car();
        this.holdTurning();
        this.photo.update(dt, keys.steer, keys.throttle - keys.brake, this.input.shift, this.car.position);
      } else {
        (this.cameraMode === 'orbit' ? this.orbit : this.heli).update(dt, this.car.model.root, this.car.velocity, true);
      }
      this.view.update(this.stage.camera, this.stage.viewDistance);
      this.stage.follow(this.car.position);
      this.sight.update(dt, this.stage.camera, this.car.model.root, !this.photoMode);
      this.stage.expose(dt, this.groundHeight);
      this.section?.update(this.stage.camera);
      this.stage.render();
      this.section?.restore(this.stage.camera);
      return;
    }

    const controls = new Map<Car, CarInput>();
    controls.set(this.car, this.autopilot ? this.drive(this.ai, this.car, gt) : this.input.car());
    for (const a of this.traffic.cars) controls.set(a.car, this.drive(a.driver, a.car, gt));

    const cars = this.allCars;
    // Slow motion feeds physics less time: it still steps at PHYSICS_STEP (damage and the rest
    // are tuned per step), just less often, and everything is drawn interpolated between steps.
    this.accumulator = Math.min(this.accumulator + gt, PHYSICS_STEP * MAX_STEPS_PER_FRAME);
    while (this.accumulator >= PHYSICS_STEP) {
      for (const car of cars) car.step(PHYSICS_STEP, controls.get(car)!);
      this.world.step(this.events);
      this.events.drainContactForceEvents((e) => {
        // A boulder knocked loose takes its share of the hit (see Boulders).
        const force = this.boulders.contact(e);
        for (const car of cars) car.handleContactForce(e.collider1(), e.collider2(), force);
      });
      for (const car of cars) car.afterStep();
      this.boulders.afterStep();
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
    if (this.photoMode) {
      // While the action runs, the keys drive the car as usual; the photo camera takes the mouse.
      this.holdTurning();
      this.photo.update(dt, 0, 0, false, this.car.position);
    } else {
      const camera = this.cameraMode === 'orbit' ? this.orbit : this.heli;
      camera.update(dt, this.car.model.root, this.car.velocity, false, this.timeScale);
    }
    this.view.update(this.stage.camera, this.stage.viewDistance);
    this.debris.update(gt, pos, this.view, alpha);
    this.clods.update(gt);
    this.birds.update(gt, this.stage.camera.position);
    this.traffic.update(gt, pos, this.view);
    this.stage.follow(pos);
    this.updateWarmth(dt);
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
    if (import.meta.env.DEV) this.hud.setWhere(this.describeWhere());
    // The first frame compiles what a crash first shows (glass shards and their transmission pass,
    // cracked panes, light wires), so the first crash doesn't stall on it.
    if (!this.warmedUp) {
      this.debris.warmUp();
      this.stage.warmUp(crashWarmUpObjects());
      this.warmedUp = true;
    }
    this.sight.update(dt, this.stage.camera, this.car.model.root, !this.photoMode);
    this.stage.expose(dt, this.groundHeight);
    this.section?.update(this.stage.camera);
    this.stage.render();
    this.section?.restore(this.stage.camera);
  }

  /**
   * Dev: where the car is, as the URL params that spawn there (?start= metres downhill, ?x= across),
   * with the biome and whether it's an open or wooded stretch or a great forest.
   */
  private describeWhere(): string {
    const { x, z } = this.car.position;
    const biome = this.field.biome;
    const name = [...BIOMES].reverse().find((b) => b.from <= biome.distance(z))?.name ?? BIOMES[0].name;
    const woods = biome.greatForest(x, z) > 0.5 ? 'great forest' : biome.woodedStretch(x, z) > 0.5 ? 'wooded' : 'open';
    return `start=${Math.round(-z)} x=${Math.round(x)} · ${name} · ${woods}`;
  }

  /** Eases the sky and fog toward the warmth of the biome the car is in (so Shift+B doesn't jump it). */
  private updateWarmth(dt: number): void {
    const target = this.field.biome.warmth(this.car.position.z);
    this.warmth += (target - this.warmth) * (1 - Math.exp(-WARMTH_EASE * dt));
    if (Math.abs(target - this.warmth) < 0.002) this.warmth = target;
    this.stage.setWarmth(this.warmth);
  }

  private togglePause(): void {
    this.paused = !this.paused;
    this.hud.setPaused(this.paused);
    this.audio.setPaused(this.paused);
  }

  /**
   * Photo mode on (from the pause): the free camera takes over from the view as it is, and the UI
   * hides. Off: the field of view and the UI
   * come back. In slow motion the game can run on in photo mode (see Esc in tick).
   */
  /**
   * Under the ground photo mode can't turn (see PhotoCamera.noTurning), and a drag there doesn't
   * mark a point to orbit. Goes by the last frame's look.
   */
  private holdTurning(): void {
    const underground = this.section?.underground ?? false;
    this.photo.noTurning = underground;
    this.pointer.orbitsCursor = !underground;
  }

  private setPhotoMode(on: boolean): void {
    if (on === this.photoMode) return;
    this.photoMode = on;
    this.hud.setPhotoMode(on);
    this.pointer.orbitsCursor = on;
    if (!on) {
      this.photo.end();
      return;
    }
    this.photo.begin();
  }

  /** Dev: off → each inspection view in turn → off. */
  private cycleInspect(): void {
    const i = this.inspectMode === null ? 0 : INSPECT_MODES.indexOf(this.inspectMode) + 1;
    this.inspectMode = INSPECT_MODES[i] ?? null;
    this.terrain.inspect = this.inspectMode;
    this.hud.setInspect(this.inspectMode && INSPECT_LEGENDS[this.inspectMode]);
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
    if (decision.reset) this.resetCar(car, decision.resetTo);
    // The autopilot's wreck is replaced next frame, as N would (traffic wrecks stay where they lie).
    if (decision.newCar && car === this.car) this.autopilotWantsCar = true;
    return decision.input;
  }

  /**
   * B: the next biome starts. From just beyond the fog ahead, the biome progression jumps to where
   * the next biome begins (from the last, back to the top), ramped in so it unfolds as you drive
   * into it. The ground's shape doesn't change; chunks already built out there get rebuilt.
   */
  private startNextBiome(): void {
    const biome = this.field.biome;
    const here = -this.car.body.translation().z;
    const from = here + BIOME_JUMP.ahead;
    // Where the progression ends up past the ramp (earlier jumps included), and what comes next.
    const reached = biome.distance(-(from + BIOME_JUMP.ramp));
    const next = BIOMES.find((b) => b.from > reached + 50) ?? BIOMES[0];
    biome.shift(from, next.from - reached, BIOME_JUMP.ramp);
    this.trees.invalidate();
    this.field.landmarks.invalidate();
    this.rocks.invalidate();
    this.terrain.refreshBeyond(-from);
    this.hud.toast(`${next.name} ahead`);
  }

  /**
   * Shift+B: puts the car at the start of the next biome (from the last, back to the top), facing
   * downhill and keeping its damage, with the terrain there built first. The start is the first
   * spot downhill whose biome distance has reached it, so jumps made with B count.
   */
  private jumpToNextBiome(): void {
    const biome = this.field.biome;
    const t = this.car.body.translation();
    const here = -t.z;
    const next = BIOMES.find((b) => b.from > biome.distance(t.z) + 50) ?? BIOMES[0];
    let target = 0;
    if (next.from > 0) {
      target = here + (next.from - biome.distance(t.z));
      for (let d = here; d < here + BIOME_JUMP.searchRange; d += 10) {
        if (biome.distance(-d) >= next.from) {
          target = d;
          break;
        }
      }
    }
    const to = new THREE.Vector3(t.x, this.field.height(t.x, -target), -target);
    this.terrain.update([{ position: to, radius: LOAD_RADIUS }], INITIAL_CHUNKS);
    this.car.resetUpright(this.field, { x: to.x, z: to.z, yaw: 0 });
    this.lastSafe.copy(to);
    (this.cameraMode === 'orbit' ? this.orbit : this.heli).reset();
    this.hud.reset();
    this.hud.toast(next.name);
  }

  /**
   * Puts a car back on its wheels: clear of a trunk or boulder it's against (the nearest spot it
   * fits, facing the most open way, see clearPose), otherwise at `fallback` or where it is.
   */
  private resetCar(car: Car, fallback?: Pose): void {
    const p = car.position;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(car.model.root.quaternion);
    const yaw = Math.atan2(-fwd.x, -fwd.z);
    car.resetUpright(this.field, clearPose(this.obstacles, p.x, p.z, yaw) ?? fallback);
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

/** Forwards every car event to several listeners (sound, visual effects, birds), each taking the ones it handles. */
function fanOut(...targets: Partial<CarEvents>[]): CarEvents {
  return {
    impact: (...args) => targets.forEach((t) => t.impact?.(...args)),
    glass: (...args) => targets.forEach((t) => t.glass?.(...args)),
    clank: (...args) => targets.forEach((t) => t.clank?.(...args)),
    land: (...args) => targets.forEach((t) => t.land?.(...args)),
  };
}
