import { createNoise2D } from 'simplex-noise';
import * as THREE from 'three';
import type { TerrainField } from '../world/terrainField';
import type { PointerOrbit } from './pointerOrbit';
import { SightLiftFilter, sightLift } from './sightLine';

/**
 * Feel values for the helicopter shot. Distance, elevation and orbit speed each drift
 * slowly and independently (low-frequency noise), so the shot keeps changing.
 */
const HELI = {
  /**
   * Distance from the car (m): close passes to wide shots. The drift is skewed by
   * `distanceSkew` so it mostly stays near, and only now and then pulls far out. Kept well
   * inside the fog (ends 250 m from the camera), or the car fades.
   */
  distanceMin: 18,
  distanceMax: 120,
  distanceSkew: 2.2,
  /** Elevation above the car (rad): low dramatic angles to steep looks down. */
  elevationMin: 0.05,
  elevationMax: 0.6,
  /** Orbit speed wanders between ±this (rad/s), so it also changes direction. */
  orbitSpeed: 0.3,
  /** How fast distance, elevation and orbit drift (noise frequency, 1/s). */
  drift: 0.045,
  /** How quickly the helicopter catches up with the car and its framing (1/s): lazy and floaty. */
  follow: 1.6,
  /** How quickly the lens re-aims at the car (1/s). */
  aim: 3.5,
  /** Seconds of the car's velocity to fly ahead to, so the car drives into frame. */
  lead: 0.7,
  /** Telephoto field of view (degrees) at the reference distance; farther shots zoom in a bit. */
  fov: 30,
  fovDistance: 32,
  /** Minimum height above the snow (m): low enough for shots skimming the snow. */
  clearance: 1.2,
  /** Beyond this distance from the car the shot cuts to a fresh position (m); above distanceMax. */
  cutDistance: 160,
  /** Hover wobble amplitude (m) and speed. */
  wobble: 0.5,
  wobbleSpeed: 0.35,
};

/** Mouse steering of the helicopter. */
const MANUAL = {
  /** Rotation per pixel of drag (rad): around the car, and up/down in elevation. */
  dragYaw: 0.006,
  dragPitch: 0.004,
  /**
   * Elevation limits with the mouse's tilt added (rad): from well below the car (looking up at
   * it; near the ground the snow is the real limit) to short of overhead, where aiming flips.
   */
  elevationMin: -1.2,
  elevationMax: 1.2,
  /** Zoom change per wheel delta unit (exponential). */
  wheelZoom: 0.0012,
  zoomMin: 0.3,
  zoomMax: 8,
  /**
   * Hard cap on distance (m): the fog ends 250 m from the camera, and the car is already half
   * fogged at this distance. Zooming out further widens the lens instead, up to `wideFov` (degrees).
   */
  maxDistance: 160,
  wideFov: 75,
  /** After the last input, automatic drift stays paused for `hold` s, then eases back in over `fadeIn` s. */
  hold: 4,
  fadeIn: 3,
  /** Snappier following while being steered, so the drag feels direct but still smooth. */
  follow: 6,
};

/**
 * Line of sight: the helicopter climbs when terrain would hide the car. Acts as a soft
 * floor under the drag height too: dragging down stops where the view would be blocked.
 */
const SIGHT = {
  /** Height above the car's origin that must stay visible (m): about the roofline. */
  aimHeight: 1.0,
  /** Clearance kept between the sight line and the snow (m). */
  margin: 1.5,
  /** Sample spacing (m); with maxSamples it covers the full 160 m at ≈4 m spacing. */
  step: 3,
  maxSamples: 40,
  /** Ground under the car itself (m) doesn't count. */
  skipNear: 3,
  /** Climb and sink rates (1/s): slower than the orbit cam, it's a lazy helicopter. */
  rise: 4,
  fall: 0.8,
  max: 60,
};

const _aim = new THREE.Vector3();
const _lead = new THREE.Vector3();
const _offset = new THREE.Vector3();

/**
 * TV-style helicopter camera: hovers off to the side, drifts in distance, elevation and angle,
 * lags and wobbles. Drag to swing it around and up/down, scroll to zoom; the automatic drift
 * pauses while you steer and then takes over from your framing. It's placed by angle, elevation
 * and distance around a lagging anchor on the car, each eased on its own, so swinging round
 * follows the orbit instead of cutting through it.
 */
export class HeliCamera {
  /** The anchor: the car plus a lead along its velocity, trailing behind. */
  private readonly anchor = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  // Where the framing is heading (target) and where it is (eased), around the anchor.
  private angleTarget = Math.PI * 0.35;
  private angle = this.angleTarget;
  private distance = 30;
  private elevation = 0.3;
  private time = 0;
  /** Drift clock: paused while the user steers, so the framing doesn't shift under them. */
  private driftTime = 0;
  /** Offset into the drift noise; jumps on every cut so each shot is framed differently. */
  private shot = Math.random() * 1000;
  private initialized = false;
  private readonly noise = createNoise2D();
  /** How much the automatic drift ran when the game was paused; while paused it can only drop. */
  private frozenAuto = 1;
  // Lasting manual offsets: zoom and tilt.
  private zoom = 1;
  private tilt = 0;
  private readonly lift = new SightLiftFilter(SIGHT.rise, SIGHT.fall, SIGHT.max);

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly field: TerrainField,
    private readonly pointer: PointerOrbit,
  ) {}

  /** Starts the shot fresh at the default zoom and tilt (next update cuts straight to position). */
  reset(): void {
    this.initialized = false;
    this.zoom = 1;
    this.tilt = 0;
    this.lift.reset();
  }

  /**
   * @param dt real time (s)
   * @param frozen the game is paused: the automatic drift stops and doesn't come back (the shot
   *   holds where the user leaves it), but the mouse still swings, tilts and zooms.
   * @param timeScale slow motion: catching up with the car and re-aiming run on game time;
   *   the framing, the mouse and the hover wobble stay on real time.
   */
  update(dt: number, target: THREE.Object3D, velocity: THREE.Vector3, frozen = false, timeScale = 1): void {
    /** Game time this frame. */
    const gt = dt * timeScale;
    const H = HELI;
    const M = MANUAL;
    // The hover wobble's clock; it holds still while paused too.
    if (!frozen) this.time += dt;

    // Manual steering: drag swings around and tilts up/down, scroll zooms. Offsets persist.
    const input = this.pointer.take(dt);
    this.angleTarget -= input.dx * M.dragYaw;
    this.tilt += input.dy * M.dragPitch;
    this.zoom = THREE.MathUtils.clamp(this.zoom * Math.exp(input.scroll * M.wheelZoom), M.zoomMin, M.zoomMax);
    // 0 while steering (and `hold` s after), easing back to 1: how much the auto drift runs.
    let auto = THREE.MathUtils.smoothstep(input.idle, M.hold, M.hold + M.fadeIn);
    if (frozen) auto = this.frozenAuto = Math.min(this.frozenAuto, auto);
    else this.frozenAuto = auto;
    const driftRate = frozen ? 0 : auto;

    this.driftTime += dt * driftRate;
    const drift = (seed: number) => 0.5 + 0.5 * this.noise((this.driftTime + this.shot) * H.drift, seed); // 0..1
    this.angleTarget += (drift(30) * 2 - 1) * H.orbitSpeed * dt * driftRate;

    // The framing the helicopter is heading for. The tilt is clamped with the drift, so the
    // elevation stays short of overhead whatever the drift does.
    const base = THREE.MathUtils.lerp(H.distanceMin, H.distanceMax, drift(10) ** H.distanceSkew);
    const distance = Math.min(M.maxDistance, base * this.zoom);
    /** How far past the distance cap the zoom asks to pull out (1 = not past it). */
    const beyond = (base * this.zoom) / distance;
    const driftElevation = THREE.MathUtils.lerp(H.elevationMin, H.elevationMax, drift(20));
    this.tilt = THREE.MathUtils.clamp(this.tilt, M.elevationMin - driftElevation, M.elevationMax - driftElevation);
    const elevation = driftElevation + this.tilt;

    // The lead fades out while steering, so a manual orbit circles the car itself (around a point
    // ahead of a fast car, swinging round to the front would pass close by it).
    _lead.copy(velocity).setY(0).multiplyScalar(H.lead * auto).add(target.position);
    const cutDistance = Math.max(H.cutDistance, M.maxDistance + 40);
    if (!this.initialized || this.anchor.distanceTo(target.position) > cutDistance) {
      // Cut: a new side of the car and a new framing.
      if (this.initialized) {
        this.angleTarget += Math.PI * (0.5 + Math.random() * 0.5);
        this.shot = Math.random() * 1000;
      }
      this.angle = this.angleTarget;
      this.distance = distance;
      this.elevation = elevation;
      this.anchor.copy(_lead);
      this.look.copy(target.position);
      this.initialized = true;
    }
    const rate = THREE.MathUtils.lerp(M.follow, H.follow, auto);
    const follow = 1 - Math.exp(-rate * dt);
    this.anchor.lerp(_lead, 1 - Math.exp(-rate * gt));
    this.angle += (this.angleTarget - this.angle) * follow;
    this.distance += (distance - this.distance) * follow;
    this.elevation += (elevation - this.elevation) * follow;

    _offset.set(Math.sin(this.angle) * Math.cos(this.elevation), Math.sin(this.elevation), Math.cos(this.angle) * Math.cos(this.elevation));
    const pos = _offset.multiplyScalar(this.distance).add(this.anchor);
    const ground = this.field.height(pos.x, pos.z) + H.clearance;
    if (pos.y < ground) {
      pos.y = ground;
      // Don't let the tilt wind up below the snow, so tilting back up answers at once.
      const actual = Math.asin(THREE.MathUtils.clamp((pos.y - this.anchor.y) / this.distance, -1, 1));
      this.tilt = Math.max(this.tilt, actual - driftElevation);
      this.elevation = Math.max(this.elevation, actual);
    }
    _aim.copy(target.position);
    _aim.y += SIGHT.aimHeight;
    const lift = this.lift.update(sightLift(this.field, pos, _aim, SIGHT), gt);
    this.look.lerp(target.position, 1 - Math.exp(-H.aim * gt));

    const n = (seed: number) => this.noise(this.time * H.wobbleSpeed, seed) * H.wobble;
    this.camera.position.set(pos.x + n(1), pos.y + lift + n(2), pos.z + n(3));
    this.camera.lookAt(this.look);
    // Zoom partly compensates for distance: the car stays readable, but you still feel it. Past
    // the distance cap, zooming out widens the lens instead.
    const tele = THREE.MathUtils.clamp(H.fov * Math.sqrt(H.fovDistance / Math.max(1, pos.distanceTo(target.position))), 18, 45);
    const fov = Math.min(M.wideFov, tele * beyond);
    this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-4 * dt));
    this.camera.updateProjectionMatrix();
  }
}
