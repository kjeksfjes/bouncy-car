import { createNoise2D } from 'simplex-noise';
import * as THREE from 'three';
import type { TerrainField } from '../world/terrainField';
import type { PointerOrbit } from './pointerOrbit';
import { SightLiftFilter, sightLift } from './sightLine';

/** Screen shake: trauma (0..1) decays over time; shake strength is trauma². */
const SHAKE = {
  decay: 1.4,
  /** Max positional jitter (m) and roll (rad) at full trauma. */
  offset: 0.35,
  roll: 0.07,
  frequency: 22,
};
/** Landing dip: a damped spring pulling the camera back to rest. */
const KICK = { stiffness: 90, damping: 14 };
/** Line of sight: the camera rises when a crest or bump would hide the car. */
const SIGHT = {
  /** Height above the car's origin the camera must see (m): about the roofline. */
  aimHeight: 1.0,
  /** Clearance kept between the sight line and the snow (m). */
  margin: 0.4,
  step: 1,
  maxSamples: 16,
  /** Ground under the car itself (m, about half its length) doesn't count. */
  skipNear: 2.5,
  /** Rise and sink rates (1/s) and the most it ever rises (m). */
  rise: 10,
  fall: 1.5,
  max: 8,
};
/** The chase camera's lag: how quickly its position and aim catch up (1/s), and its floor above the snow (m). */
const CHASE = { follow: 8, aim: 14, clearance: 1.2 };
/** The resting chase framing behind the car; it pulls back and up a little with speed. */
const FRAME = {
  distance: 7.5,
  distancePerSpeed: 0.06,
  height: 2.6,
  heightPerSpeed: 0.02,
  /** The point orbited (and looked at) sits this high above the car's origin (m). */
  pivotHeight: 0.9,
  /** At rest behind the car, it looks this far ahead of the car (m). */
  lookAhead: 2,
};
/** Orbiting with the mouse. */
const ORBIT = {
  /** Rotation per pixel of drag (rad). */
  dragYaw: 0.006,
  dragPitch: 0.005,
  /**
   * Elevation limits (rad): from almost straight below the car to almost straight down on it.
   * Near the ground the snow is the real limit (see update).
   */
  pitchMin: -1.4,
  pitchMax: 1.4,
  /** How quickly the angles and zoom follow the mouse (1/s): smooth, but direct. */
  smoothing: 12,
  /** Zoom per wheel delta unit (exponential), and its limits (× the resting distance). */
  wheelZoom: 0.0012,
  zoomMin: 0.45,
  zoomMax: 3.5,
  /** After `hold` s without input, a moving car pulls the view back behind it at `recenter` (1/s), at normal speed only (not in slow motion). */
  hold: 3,
  recenter: 1.2,
  /** Below this speed (m/s) it never recentres, so a parked or wrecked car can be looked over. */
  recenterSpeed: 2,
  /** How quickly the orbit's centre follows the car's height (1/s). */
  follow: 10,
  /** Yaw or tilt (rad) away from behind the car over which the chase view hands over to the orbit. */
  blend: 0.3,
  /** Lowest the camera goes above the snow (m). */
  clearance: 0.3,
};

const _fwd = new THREE.Vector3();
const _velDir = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _orbit = new THREE.Vector3();

/**
 * Third-person camera: the classic chase camera trailing the car, which can be orbited. Drag to
 * swing around the car (from down at the snow to almost overhead), scroll to zoom. The orbit is
 * placed by angles and distance around the car, so it follows the circle instead of cutting
 * across it, and it takes over from the chase view as you drag away from behind. The view holds
 * where it's left; while the car is moving (and the game isn't paused) it eases back behind it
 * after a few seconds, which hands back to the chase view.
 */
export class OrbitCamera {
  private readonly dir = new THREE.Vector3(0, 0, -1);
  /** The chase camera's own (lagging) position and aim. */
  private readonly chasePos = new THREE.Vector3();
  private readonly chaseLook = new THREE.Vector3();
  /** The orbit's centre: on the car, its height smoothed. */
  private readonly pivot = new THREE.Vector3();
  private initialized = false;
  // Orbit offsets from the resting framing (yaw, elevation) and zoom: where the mouse is
  // taking them, and where they are now.
  private yawTarget = 0;
  private pitchTarget = 0;
  private zoomTarget = 1;
  private yaw = 0;
  private pitch = 0;
  private zoom = 1;
  /** Speed (m/s) the framing was last set for; kept while paused. */
  private speed = 0;
  private trauma = 0;
  private time = 0;
  private kickY = 0;
  private kickVel = 0;
  private readonly noise = createNoise2D();
  private readonly lift = new SightLiftFilter(SIGHT.rise, SIGHT.fall, SIGHT.max);

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly field: TerrainField,
    private readonly pointer: PointerOrbit,
  ) {}

  /** Starts fresh behind the car at the default zoom (next update snaps instead of swooping in). */
  reset(): void {
    this.initialized = false;
    this.yawTarget = this.pitchTarget = this.yaw = this.pitch = 0;
    this.zoomTarget = this.zoom = 1;
    this.trauma = 0;
    this.kickY = 0;
    this.kickVel = 0;
    this.lift.reset();
  }

  /** Adds screen shake (0..1); repeated hits stack up to the cap. */
  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Dips the camera down (m/s of downward kick), e.g. on landing. */
  kick(amount: number): void {
    this.kickVel -= amount;
  }

  /**
   * @param dt real time (s)
   * @param frozen the game is paused: the car stands still (its velocity is stale), so the
   *   framing holds and the view never recentres, but the mouse still orbits and zooms.
   * @param timeScale slow motion: following the car, shake and the landing dip run on game
   *   time (so they slow down with it); the mouse stays on real time, and the view never
   *   recentres (slow motion is for looking around a moment from any angle).
   */
  update(dt: number, target: THREE.Object3D, velocity: THREE.Vector3, frozen = false, timeScale = 1): void {
    const O = ORBIT;
    /** Game time this frame. */
    const gt = dt * timeScale;
    this.time += gt;
    _fwd.set(0, 0, -1).applyQuaternion(target.quaternion).setY(0);
    _velDir.copy(velocity).setY(0);
    if (!frozen) this.speed = _velDir.length();
    const speed = this.speed;

    // The resting direction: the direction of travel when moving forward (nicer through slides
    // and jumps), otherwise the car's nose. Keeps the last heading if the car points straight
    // up or down. The orbit is relative to it, so the view turns with the car.
    if (!frozen && _fwd.lengthSq() > 0.01) {
      _fwd.normalize();
      _desired.copy(_fwd);
      if (speed > 4 && _velDir.dot(_fwd) > 0) _desired.lerp(_velDir.normalize(), 0.6).normalize();
      if (!this.initialized) this.dir.copy(_desired);
      this.dir.lerp(_desired, 1 - Math.exp(-3 * gt)).normalize();
    }

    // The resting framing, as a distance and elevation around the pivot.
    const back = FRAME.distance + speed * FRAME.distancePerSpeed;
    const up = FRAME.height + speed * FRAME.heightPerSpeed - FRAME.pivotHeight;
    const restPitch = Math.atan2(up, back);
    const restRadius = Math.hypot(back, up);

    // Mouse: drag swings the targets around (drag down = camera up), scroll zooms.
    const input = this.pointer.take(dt);
    this.yawTarget -= input.dx * O.dragYaw;
    this.pitchTarget = THREE.MathUtils.clamp(this.pitchTarget + input.dy * O.dragPitch, O.pitchMin - restPitch, O.pitchMax - restPitch);
    this.zoomTarget = THREE.MathUtils.clamp(this.zoomTarget * Math.exp(input.scroll * O.wheelZoom), O.zoomMin, O.zoomMax);
    if (!frozen && timeScale === 1 && input.idle > O.hold && speed > O.recenterSpeed) {
      // Back behind the car the short way round (wrapping both angles by the same turns, so the
      // smoothing doesn't spin); the zoom stays as it was left.
      const wrapped = Math.atan2(Math.sin(this.yawTarget), Math.cos(this.yawTarget));
      this.yaw += wrapped - this.yawTarget;
      this.yawTarget = wrapped;
      const k = Math.exp(-O.recenter * dt);
      this.yawTarget *= k;
      this.pitchTarget *= k;
    }
    const s = 1 - Math.exp(-O.smoothing * dt);
    this.yaw += (this.yawTarget - this.yaw) * s;
    this.pitch += (this.pitchTarget - this.pitch) * s;
    this.zoom += (this.zoomTarget - this.zoom) * s;

    // The chase camera, as it always was: it trails behind and above the car, its position and
    // aim each lagging at their own rate, so the car moves in the frame as it turns and speeds
    // up. Zooming scales its framing.
    _desired.copy(target.position).addScaledVector(this.dir, -back * this.zoom);
    _desired.y += (FRAME.height + speed * FRAME.heightPerSpeed) * this.zoom;
    _look.copy(target.position).addScaledVector(this.dir, FRAME.lookAhead);
    _look.y += FRAME.pivotHeight;
    if (!this.initialized) {
      this.chasePos.copy(_desired);
      this.chaseLook.copy(_look);
    }
    this.chasePos.lerp(_desired, 1 - Math.exp(-CHASE.follow * gt));
    this.chaseLook.lerp(_look, 1 - Math.exp(-CHASE.aim * gt));
    const chaseGround = this.field.height(this.chasePos.x, this.chasePos.z) + CHASE.clearance;
    if (this.chasePos.y < chaseGround) this.chasePos.y = chaseGround;

    // The free orbit: a sphere around the car itself. Its height is smoothed, so bumps and
    // landings don't jerk the view, with the car's vertical speed fed forward so it doesn't lag
    // above the car on a steady descent.
    _aim.copy(target.position);
    _aim.y += FRAME.pivotHeight;
    if (!this.initialized) this.pivot.copy(_aim);
    if (!frozen) this.pivot.y += velocity.y * gt;
    this.pivot.y += (_aim.y - this.pivot.y) * (1 - Math.exp(-O.follow * gt));
    this.pivot.x = _aim.x;
    this.pivot.z = _aim.z;
    const elevation = restPitch + this.pitch;
    const radius = restRadius * this.zoom;
    // Behind the car is −dir; the yaw turns that about the vertical.
    const place = (e: number) => {
      _orbit.copy(this.dir).negate().applyAxisAngle(THREE.Object3D.DEFAULT_UP, this.yaw).multiplyScalar(Math.cos(e) * radius);
      _orbit.y = Math.sin(e) * radius;
      return _orbit.add(this.pivot);
    };
    place(elevation);
    const ground = this.field.height(_orbit.x, _orbit.z) + O.clearance;
    if (_orbit.y < ground) {
      // The snow is in the way: climb the orbit until clear, keeping the distance (just lifting
      // the camera would pull it in close, even into a car standing on the snow). The drag can't
      // wind up below the snow either, so dragging back up answers at once.
      const clear = Math.asin(THREE.MathUtils.clamp((ground - this.pivot.y) / radius, -1, 1));
      place(clear);
      const below = this.field.height(_orbit.x, _orbit.z) + O.clearance;
      if (_orbit.y < below) _orbit.y = below;
      // Only up to the resting elevation: above it this would count as dragged away from behind
      // and pull an untouched view off the chase camera (the orbit is placed clear regardless).
      const floor = Math.min(0, clear - restPitch);
      this.pitchTarget = Math.max(this.pitchTarget, floor);
      this.pitch = Math.max(this.pitch, floor);
    }
    this.initialized = true;

    // Untouched (or eased back behind the car) it's the chase camera; dragged away from behind
    // it hands over to the orbit, fully by `blend` rad of yaw or tilt.
    const free = THREE.MathUtils.smoothstep(Math.max(Math.abs(this.yaw), Math.abs(this.pitch)), 0, O.blend);
    _desired.lerpVectors(this.chasePos, _orbit, free);
    _look.lerpVectors(this.chaseLook, this.pivot, free);

    _aim.copy(target.position);
    _aim.y += SIGHT.aimHeight;
    const lift = this.lift.update(sightLift(this.field, _desired, _aim, SIGHT), gt);

    this.kickVel += (-this.kickY * KICK.stiffness - this.kickVel * KICK.damping) * gt;
    this.kickY += this.kickVel * gt;

    const shake = this.trauma * this.trauma;
    this.trauma = Math.max(0, this.trauma - SHAKE.decay * gt);
    const n = (seed: number) => this.noise(this.time * SHAKE.frequency, seed);
    this.camera.position.copy(_desired);
    this.camera.position.y += this.kickY + lift;
    this.camera.position.x += n(1) * shake * SHAKE.offset;
    this.camera.position.y += n(2) * shake * SHAKE.offset;
    this.camera.position.z += n(3) * shake * SHAKE.offset;
    this.camera.lookAt(_look);
    this.camera.rotateZ(n(4) * shake * SHAKE.roll);
    // Wider view at speed sells the velocity.
    const fov = 60 + Math.min(speed, 55) * 0.32;
    this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-2 * gt));
    this.camera.updateProjectionMatrix();
  }
}
