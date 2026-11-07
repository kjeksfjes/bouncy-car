import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { GRAVITY, PHYSICS_STEP } from './constants';
import { Hud } from './hud';
import { Input } from './input';
import { ChaseCamera } from './render/chaseCamera';
import { Stage } from './render/stage';
import { Visibility } from './render/visibility';
import { Traffic } from './traffic';
import { AiDriver } from './vehicle/aiDriver';
import { Car, type CarInput } from './vehicle/car';
import { SEDAN_70S } from './vehicle/carConfig';
import { Debris } from './world/debris';
import { LOAD_RADIUS, Terrain, type StreamCenter } from './world/terrain';
import { TerrainField } from './world/terrainField';
import { TreeLayout } from './world/trees';

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
  private readonly chase: ChaseCamera;
  private readonly input = new Input();
  private readonly hud = new Hud();
  private readonly trees: TreeLayout;
  /** Drives the player's car while the autopilot is on. */
  private readonly ai: AiDriver;
  /** Shows the AI's chosen heading while the autopilot drives. */
  private readonly aiArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(), 6, 0x2b7de9, 1.2, 0.7);
  private autopilot = false;
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
    this.chase = new ChaseCamera(this.stage.camera, this.field);

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
    return new Car(SEDAN_70S, this.world, this.stage.scene, this.debris, position, yaw, paint);
  }

  private get allCars(): Car[] {
    return [this.car, ...this.traffic.cars.map((a) => a.car)];
  }

  private frame = (now: number): void => {
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;

    if (this.input.consume('KeyR')) this.car.resetUpright(this.field);
    if (this.input.consume('KeyN')) this.replaceCar();
    if (this.input.consume('KeyP')) this.autopilot = !this.autopilot;
    this.input.endFrame();

    const controls = new Map<Car, CarInput>();
    controls.set(this.car, this.autopilot ? this.drive(this.ai, this.car, dt) : this.input.car());
    for (const a of this.traffic.cars) controls.set(a.car, this.drive(a.driver, a.car, dt));

    const cars = this.allCars;
    this.accumulator = Math.min(this.accumulator + dt, PHYSICS_STEP * MAX_STEPS_PER_FRAME);
    while (this.accumulator >= PHYSICS_STEP) {
      for (const car of cars) car.step(PHYSICS_STEP, controls.get(car)!);
      this.world.step(this.events);
      this.events.drainContactForceEvents((e) => {
        for (const car of cars) car.handleContactForce(e.collider1(), e.collider2(), e.totalForceMagnitude());
      });
      for (const car of cars) car.afterStep();
      this.accumulator -= PHYSICS_STEP;
    }

    const alpha = this.accumulator / PHYSICS_STEP;
    for (const car of cars) car.syncVisual(alpha, dt);
    const pos = this.car.position;
    const centers: StreamCenter[] = [
      { position: pos, radius: LOAD_RADIUS },
      ...this.traffic.cars.map((a) => ({ position: a.car.position, radius: AI_STREAM_RADIUS })),
    ];
    this.terrain.update(centers, STREAM_BUDGET);
    this.chase.update(dt, this.car.model.root, this.car.velocity);
    this.view.update(this.stage.camera, this.stage.viewDistance);
    this.debris.update(dt, pos, this.view);
    this.traffic.update(dt, pos, this.view);
    this.stage.follow(pos);
    this.aiArrow.visible = this.autopilot;
    if (this.autopilot) {
      this.aiArrow.position.copy(pos).setY(pos.y + 1.6);
      this.aiArrow.setDirection(this.ai.heading);
    }
    this.hud.update(dt, this.car, this.autopilot);
    this.stage.render();
    requestAnimationFrame(this.frame);
  };

  private drive(driver: AiDriver, car: Car, dt: number): CarInput {
    const decision = driver.update(dt, car);
    if (decision.reset) car.resetUpright(this.field);
    return decision.input;
  }

  private replaceCar(): void {
    const t = this.car.body.translation();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.car.model.root.quaternion);
    const yaw = Math.atan2(-fwd.x, -fwd.z);
    this.car.dispose();
    this.car = this.newCar(new THREE.Vector3(t.x, this.field.height(t.x, t.z) + 2, t.z), yaw);
    this.hud.reset();
  }
}
