import * as THREE from 'three';
import type { Visibility } from './render/visibility';
import { AiDriver } from './vehicle/aiDriver';
import type { Car } from './vehicle/car';
import type { Terrain } from './world/terrain';
import type { TerrainField } from './world/terrainField';
import type { Obstacles } from './world/details';

/**
 * AI traffic that comes and goes around the player. Cars only ever appear or
 * disappear where the camera can't see, so they seem to have been there all along.
 */
const TRAFFIC = {
  maxCars: 4,
  firstSpawnDelay: 5,
  /** Random pause between spawns (s); long gaps mean stretches with no traffic. */
  spawnGapMin: 6,
  spawnGapMax: 20,
  /** Retry delay when no hidden, valid spot was found (s). */
  retryDelay: 0.5,
  spawnDistanceMin: 60,
  spawnDistanceMax: 160,
  spotAttempts: 12,
  /** Keep spawns this far from tree trunks and other cars (m). */
  treeClearance: 4,
  carSpacing: 12,
  /** Minimum ground normal Y at a spawn spot (≈ max 32° slope). */
  minGroundUp: 0.85,
  /** A car is treated as a sphere this big for the "can the camera see it" test (m). */
  carViewRadius: 4,
  /** Hidden cars further away than this are removed (m). */
  despawnDistance: 220,
  /** Hidden wrecks (dead engine) are removed sooner. */
  wreckDespawnDistance: 60,
  /** Per-car cruise speed range (m/s), so some overtake the player and some fall behind. */
  cruiseMin: 20,
  cruiseMax: 31,
  /** Underground by more than this (m) = fell through unloaded ground. */
  underground: 3,
  paints: ['#c8552b', '#6f8f3a', '#4f7fb0', '#e6dcc2', '#8b5a2b', '#a83232', '#3f6f6a'],
};

export interface AiCar {
  car: Car;
  driver: AiDriver;
}

type CarFactory = (position: THREE.Vector3, yaw: number, paint: string) => Car;

const _spot = new THREE.Vector3();
const _n = new THREE.Vector3();

export class Traffic {
  private readonly active: AiCar[] = [];
  private timer = TRAFFIC.firstSpawnDelay;

  constructor(
    private readonly field: TerrainField,
    private readonly obstacles: Obstacles,
    private readonly terrain: Terrain,
    private readonly createCar: CarFactory,
  ) {}

  get cars(): readonly AiCar[] {
    return this.active;
  }

  /** Removes a car right away (e.g. its physics blew up). */
  remove(car: Car): void {
    const i = this.active.findIndex((a) => a.car === car);
    if (i < 0) return;
    car.dispose();
    this.active.splice(i, 1);
  }

  update(dt: number, player: THREE.Vector3, view: Visibility): void {
    const T = TRAFFIC;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const { car } = this.active[i];
      const pos = car.position;
      // A car whose physics blew up (non-finite position) goes immediately, before any
      // terrain lookup, which can't handle such positions.
      const distance = player.distanceTo(pos);
      const blewUp = !Number.isFinite(distance);
      if (blewUp) console.warn('AI car physics blew up; removing it', { position: { ...pos } });
      const underground = !blewUp && pos.y < this.field.height(pos.x, pos.z) - T.underground;
      const far = distance > (car.engineAlive ? T.despawnDistance : T.wreckDespawnDistance);
      if (blewUp || underground || (far && !view.canSee(pos, T.carViewRadius))) {
        car.dispose();
        this.active.splice(i, 1);
      }
    }

    this.timer -= dt;
    if (this.timer > 0 || this.active.length >= T.maxCars) return;
    const spot = this.findHiddenSpot(player, view);
    if (!spot) {
      this.timer = T.retryDelay;
      return;
    }
    this.spawn(spot);
    this.timer = T.spawnGapMin + Math.random() * (T.spawnGapMax - T.spawnGapMin);
  }

  private findHiddenSpot(player: THREE.Vector3, view: Visibility): THREE.Vector3 | null {
    const T = TRAFFIC;
    for (let i = 0; i < T.spotAttempts; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = T.spawnDistanceMin + Math.random() * (T.spawnDistanceMax - T.spawnDistanceMin);
      const x = player.x + Math.sin(angle) * dist;
      const z = player.z + Math.cos(angle) * dist;
      _spot.set(x, this.field.height(x, z) + 1, z);
      if (!this.terrain.isLoadedAt(x, z)) continue;
      if (view.canSee(_spot, T.carViewRadius)) continue;
      if (this.field.normal(x, z, _n).y < T.minGroundUp) continue;
      if (this.obstacles.blocking(x, z, T.treeClearance)) continue;
      if (player.distanceTo(_spot) < T.carSpacing) continue;
      if (this.active.some((a) => a.car.position.distanceTo(_spot) < T.carSpacing)) continue;
      return _spot.clone();
    }
    return null;
  }

  /** Places a car already rolling downhill at its cruise speed, as if mid-run. */
  private spawn(at: THREE.Vector3): void {
    const T = TRAFFIC;
    const yaw = (Math.random() - 0.5) * 0.4;
    const cruise = T.cruiseMin + Math.random() * (T.cruiseMax - T.cruiseMin);
    const paint = T.paints[Math.floor(Math.random() * T.paints.length)];
    const car = this.createCar(at, yaw, paint);
    const speed = cruise * 0.8;
    car.body.setLinvel({ x: -Math.sin(yaw) * speed, y: 0, z: -Math.cos(yaw) * speed }, true);
    this.active.push({ car, driver: new AiDriver(this.obstacles, cruise) });
  }
}
