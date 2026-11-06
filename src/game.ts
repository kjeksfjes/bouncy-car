import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { GRAVITY, PHYSICS_STEP } from './constants';
import { Hud } from './hud';
import { Input } from './input';
import { ChaseCamera } from './render/chaseCamera';
import { Stage } from './render/stage';
import { Car } from './vehicle/car';
import { SEDAN_70S } from './vehicle/carConfig';
import { Debris } from './world/debris';
import { Terrain } from './world/terrain';
import { TerrainField } from './world/terrainField';

/** Avoid a spiral of death after a long stall (tab switch, breakpoint). */
const MAX_STEPS_PER_FRAME = 5;
/** Chunks built per frame while streaming; the first batch is built up front. */
const STREAM_BUDGET = 2;
const INITIAL_CHUNKS = 25;

export class Game {
  readonly stage: Stage;
  readonly world: RAPIER.World;
  readonly field: TerrainField;
  car: Car;
  private readonly events = new RAPIER.EventQueue(true);
  private readonly terrain: Terrain;
  private readonly debris: Debris;
  private readonly chase: ChaseCamera;
  private readonly input = new Input();
  private readonly hud = new Hud();
  private accumulator = 0;
  private lastTime = 0;

  constructor(container: HTMLElement, seed: number) {
    this.stage = new Stage(container);
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = PHYSICS_STEP;
    this.field = new TerrainField(seed);
    this.terrain = new Terrain(this.field, this.stage.scene, this.world);
    this.debris = new Debris(this.stage.scene, this.world);
    this.chase = new ChaseCamera(this.stage.camera, this.field);

    const spawn = new THREE.Vector3(0, this.field.height(0, 0) + 1.5, 0);
    this.terrain.update(spawn, INITIAL_CHUNKS);
    this.car = this.newCar(spawn, 0);
  }

  start(): void {
    requestAnimationFrame((t) => {
      this.lastTime = t;
      requestAnimationFrame(this.frame);
    });
  }

  private newCar(position: THREE.Vector3, yaw: number): Car {
    return new Car(SEDAN_70S, this.world, this.stage.scene, this.debris, position, yaw);
  }

  private frame = (now: number): void => {
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;

    if (this.input.consume('KeyR')) this.car.resetUpright(this.field);
    if (this.input.consume('KeyN')) this.replaceCar();
    this.input.endFrame();

    this.accumulator = Math.min(this.accumulator + dt, PHYSICS_STEP * MAX_STEPS_PER_FRAME);
    const controls = this.input.car();
    while (this.accumulator >= PHYSICS_STEP) {
      this.car.step(PHYSICS_STEP, controls);
      this.world.step(this.events);
      this.events.drainContactForceEvents((e) =>
        this.car.handleContactForce(e.collider1(), e.collider2(), e.totalForceMagnitude()),
      );
      this.car.afterStep();
      this.accumulator -= PHYSICS_STEP;
    }

    this.car.syncVisual(this.accumulator / PHYSICS_STEP, dt);
    const pos = this.car.position;
    this.debris.update(dt, pos);
    this.terrain.update(pos, STREAM_BUDGET);
    this.chase.update(dt, this.car.model.root, this.car.velocity);
    this.stage.follow(pos);
    this.hud.update(dt, this.car);
    this.stage.render();
    requestAnimationFrame(this.frame);
  };

  private replaceCar(): void {
    const t = this.car.body.translation();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.car.model.root.quaternion);
    const yaw = Math.atan2(-fwd.x, -fwd.z);
    this.car.dispose();
    this.car = this.newCar(new THREE.Vector3(t.x, this.field.height(t.x, t.z) + 2, t.z), yaw);
    this.hud.reset();
  }
}
