import * as THREE from 'three';
import type { PointerOrbit } from './pointerOrbit';

/**
 * Feel values for photo mode. Feel-tuned by hand: change freely.
 */
const PHOTO = {
  /**
   * Orbiting (drag): radians per pixel dragged. (A right-drag looks round by what's under the
   * mouse instead: see PhotoCamera.update.)
   */
  orbitTurn: 0.0035,
  /** Looking round on the arrow keys (rad/s). */
  turnSpeed: 1.2,
  /** How far the view tilts up and down (rad): just short of straight up and down. */
  pitchMax: 1.5,
  /**
   * Pan on Shift+arrow keys, scaled by the camera's distance from the car (at least `panNear` m),
   * so it reaches further the further out the camera is: metres per second per metre of that
   * distance. (A Shift+drag pans by what it grabbed instead: see PhotoCamera.update.)
   */
  panPerSecond: 0.8,
  panNear: 4,
  /**
   * A drag pans as if what it grabbed were between these depths (m): one this close to the lens
   * still pans, and one far off (distant terrain, the sky) doesn't fling the camera hundreds of
   * metres per drag. At `grabFarthest` and the normal 60° view, a drag across a 1000 px high canvas
   * pans ≈35 m.
   */
  grabNearest: 0.05,
  grabFarthest: 30,
  /**
   * How long the camera takes to settle after the mouse, keys or wheel move it (s): it covers
   * about two thirds of each move in this time and eases out the rest. 0 follows instantly.
   */
  ease: 0.09,
  /**
   * Scrolling moves towards (or away from) the point under the mouse, by a share of the way there
   * per scroll unit (a wheel notch is ≈100, which goes ≈14 % of the way). The distance it takes a
   * share of is held between `dollyNearest` and `dollyFarthest` (m), so it still moves right up
   * close, and a point far off (distant terrain, the sky) doesn't fling it: at most ≈8 m a notch.
   */
  dollyPerScroll: 0.0015,
  dollyNearest: 0.5,
  dollyFarthest: 60,
  /** How close the last point scrolled at must still lie to the mouse to be kept (−1..1 screen units: ≈5 px). */
  dollyStillUnder: 0.01,
  /** Lens zoom: how fast the field of view changes per Shift scroll unit. */
  zoomPerScroll: 0.0015,
  /** Field-of-view limits (degrees, vertical). */
  fovMin: 8,
  fovMax: 100,
};

const UP = new THREE.Vector3(0, 1, 0);
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _hit = new THREE.Vector3();
const _ray = new THREE.Raycaster();

/** A camera move still to be made: what update eases through. */
interface Move {
  /** Looking round (rad). */
  yaw: number;
  pitch: number;
  /** Orbiting round `orbitAt` (rad; see PhotoCamera.orbit). */
  across: number;
  over: number;
  /** Panning along the camera's right and up (m), and moving towards `dollyAt` (m). */
  right: number;
  up: number;
  forward: number;
  /** Zoom: the log of the factor the field of view changes by. */
  zoom: number;
}

const still = (): Move => ({ yaw: 0, pitch: 0, across: 0, over: 0, right: 0, up: 0, forward: 0, zoom: 0 });

/**
 * Photo mode's free camera, used while paused: it takes over from wherever the camera is, orbits
 * the point under the mouse (drag), looks round from where it stands (right-drag or Option+drag,
 * or the arrow keys), pans (Shift+drag, keeping the grabbed point under the mouse, or Shift+arrow
 * keys), moves towards and away from the point under the mouse (scroll), and zooms the lens (Shift+scroll). The
 * scene moves with the mouse, as if dragged. Every move eases in over a moment (PHOTO.ease)
 * rather than jumping with each mouse event. The field of view is put back on leaving.
 */
export class PhotoCamera {
  /** Which way the camera looks: turned about the vertical, then tilted (rad; no roll). */
  private yaw = 0;
  private pitch = 0;
  private fov = 60;
  /** The field of view before photo mode, put back on leaving. */
  private normalFov = 60;
  /** How far in front of the lens the current pan grabbed (m), and the canvas's height (px). */
  private grabDepth = 1;
  private grabHeight = 1;
  /** The point the current drag orbits. */
  private readonly orbitAt = new THREE.Vector3();
  /**
   * The point the scroll moves towards, and which way it lay when last scrolled. It's kept while
   * it's still under the mouse (moving straight at it leaves it there), so a steady scroll looks
   * for it only once.
   */
  private readonly dollyAt = new THREE.Vector3(Infinity, Infinity, Infinity);
  private readonly dollyDir = new THREE.Vector3();
  /** Moves made with the mouse and keys that the camera hasn't caught up with yet. */
  private pending = still();
  private readonly step = still();

  /**
   * @param surfaceAt the first surface under a screen point, or null for open sky (see Stage.surfaceAt)
   */
  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly pointer: PointerOrbit,
    private readonly surfaceAt: (ndc: THREE.Vector2, out: THREE.Vector3) => THREE.Vector3 | null,
  ) {}

  /** Takes over from the camera where it stands, looking where it looks. */
  begin(): void {
    this.camera.getWorldDirection(_forward);
    this.yaw = Math.atan2(-_forward.x, -_forward.z);
    this.pitch = THREE.MathUtils.clamp(Math.asin(_forward.y), -PHOTO.pitchMax, PHOTO.pitchMax);
    this.normalFov = this.fov = this.camera.fov;
    this.grabHeight = this.pointer.height;
    this.pending = still();
    this.dollyAt.set(Infinity, Infinity, Infinity);
  }

  /** Puts the field of view back. */
  end(): void {
    this.camera.fov = this.normalFov;
    this.camera.updateProjectionMatrix();
  }

  /**
   * @param dt real time (s)
   * @param turn left/right from the keys (−1..1, left is +1: looks left)
   * @param tilt up/down from the keys (−1..1, up is +1: looks up)
   * @param shift Shift held: the keys pan instead of looking round
   * @param subject what's being photographed (the car): key panning speeds up with distance from
   *   it, and a grab of open sky takes its distance
   */
  update(dt: number, turn: number, tilt: number, shift: boolean, subject: THREE.Vector3): void {
    const P = PHOTO;
    const cam = this.camera;
    const input = this.pointer.take(dt);
    // New grabs, of the scene as it stood when the mouse went down: how deep a pan grabbed, and the
    // point an orbit turns round (open sky: as far off as the car, along the mouse's ray).
    if (input.grab || input.dragGrab) cam.getWorldDirection(_forward);
    const subjectDistance = cam.position.distanceTo(subject);
    if (input.grab) {
      const hit = this.surfaceAt(input.grab.ndc, _hit);
      const depth = hit ? hit.sub(cam.position).dot(_forward) : subjectDistance;
      this.grabDepth = THREE.MathUtils.clamp(depth, P.grabNearest, P.grabFarthest);
      this.grabHeight = input.grab.height;
    }
    if (input.dragGrab) {
      if (!this.surfaceAt(input.dragGrab.ndc, this.orbitAt)) {
        _ray.setFromCamera(input.dragGrab.ndc, cam);
        _ray.ray.at(subjectDistance, this.orbitAt);
      }
    }

    // Look round: a right-drag turns the view by the angle a pixel covers, so the scene stays under the
    // mouse (slower the more it's zoomed in); the keys look the way they point.
    const m = this.pending;
    const lookTurn = THREE.MathUtils.degToRad(this.fov) / this.pointer.height;
    const keyTurn = shift ? 0 : P.turnSpeed * dt;
    m.yaw += input.lookX * lookTurn + turn * keyTurn;
    m.pitch += input.lookY * lookTurn + tilt * keyTurn;

    // Orbit: the camera swings round the grabbed point as one piece (it stays where it is on
    // screen), the scene turning with the mouse.
    m.across -= input.dx * P.orbitTurn;
    m.over -= input.dy * P.orbitTurn;

    // Pan: a drag keeps what it grabbed under the mouse (it moves one pixel's width at that depth
    // per pixel); Shift+arrow keys slide the camera.
    const pan = (this.grabDepth * 2 * Math.tan(THREE.MathUtils.degToRad(this.fov) / 2)) / this.grabHeight;
    const panKeys = shift ? Math.max(P.panNear, subjectDistance) * P.panPerSecond * dt : 0;
    m.right -= input.panX * pan + turn * panKeys;
    m.up += input.panY * pan + tilt * panKeys;

    // Towards or away from the point under the mouse, taking a share of the way there that's left
    // once what's pending is made; and the lens zoom (Shift+scroll up narrows the view).
    if (input.scrollAt) {
      _hit.copy(this.dollyAt).project(cam);
      const under = _hit.z < 1 && Math.hypot(_hit.x - input.scrollAt.x, _hit.y - input.scrollAt.y) < P.dollyStillUnder;
      if (!under) {
        if (!this.surfaceAt(input.scrollAt, this.dollyAt)) {
          _ray.setFromCamera(input.scrollAt, cam);
          _ray.ray.at(subjectDistance, this.dollyAt);
        }
      }
      _offset.subVectors(this.dollyAt, cam.position);
      const way = THREE.MathUtils.clamp(_offset.length() - m.forward, P.dollyNearest, P.dollyFarthest);
      m.forward += way * (1 - Math.exp(input.scroll * P.dollyPerScroll));
      this.dollyDir.copy(_offset).normalize();
    }
    m.zoom += input.shiftScroll * P.zoomPerScroll;

    // Make this frame's share of what's pending.
    const share = P.ease > 0 ? 1 - Math.exp(-dt / P.ease) : 1;
    const d = this.step;
    for (const key of Object.keys(m) as (keyof Move)[]) {
      d[key] = m[key] * share;
      m[key] -= d[key];
    }
    this.yaw += d.yaw;
    this.pitch = THREE.MathUtils.clamp(this.pitch + d.pitch, -P.pitchMax, P.pitchMax);
    if (d.across !== 0 || d.over !== 0) this.orbit(d.across, d.over);
    this.place();
    _right.setFromMatrixColumn(cam.matrixWorld, 0);
    _up.setFromMatrixColumn(cam.matrixWorld, 1);
    cam.position.addScaledVector(_right, d.right).addScaledVector(_up, d.up).addScaledVector(this.dollyDir, d.forward);
    this.fov = THREE.MathUtils.clamp(this.fov * Math.exp(d.zoom), P.fovMin, P.fovMax);
    this.place();
  }

  /**
   * Swings the camera round `orbitAt` as one piece: `across` (rad) about the vertical, `over` (rad)
   * about its own right-hand axis (positive tilts it up), held to the tilt limits.
   */
  private orbit(across: number, over: number): void {
    const P = PHOTO;
    const cam = this.camera;
    const tilt = THREE.MathUtils.clamp(this.pitch + over, -P.pitchMax, P.pitchMax) - this.pitch;
    _offset.subVectors(cam.position, this.orbitAt);
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    _offset.applyAxisAngle(_right, tilt).applyAxisAngle(UP, across);
    cam.position.addVectors(this.orbitAt, _offset);
    this.pitch += tilt;
    this.yaw += across;
  }

  private place(): void {
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    if (this.camera.fov !== this.fov) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }
}
