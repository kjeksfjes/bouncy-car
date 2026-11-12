import * as THREE from 'three';
import type { PointerOrbit } from './pointerOrbit';

/**
 * Feel values for photo mode. Feel-tuned by hand: change freely.
 */
const PHOTO = {
  /** Orbit: radians per pixel dragged. */
  dragTurn: 0.005,
  /** Orbit on the arrow keys (rad/s). */
  turnSpeed: 1.2,
  /** Orbit elevation limits (rad): from looking up from below to straight down. */
  pitchMin: -1.4,
  pitchMax: 1.5,
  /**
   * Pan, scaled by the camera's distance from the car (at least `panNear` m), so it reaches further
   * the further out the camera is: metres per pixel dragged, and per second on Shift+arrow keys,
   * per metre of that distance.
   */
  panPerPixel: 0.0012,
  panPerSecond: 0.8,
  panNear: 4,
  /** Moving forward/back: metres per scroll unit (a wheel notch is ≈100). */
  movePerScroll: 0.02,
  /** Lens zoom: how fast the field of view changes per Shift scroll unit. */
  zoomPerScroll: 0.0015,
  /** Field-of-view limits (degrees, vertical). */
  fovMin: 8,
  fovMax: 100,
};

const _offset = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _forward = new THREE.Vector3();

/**
 * Photo mode's free camera, used while paused: it takes over from wherever the camera is and
 * orbits a pivot (drag, or the arrow keys), pans it (Shift+drag, or Shift+arrow keys), moves
 * forward and back along the view (scroll), and zooms the lens (Shift+scroll). The field of view is put back on leaving.
 */
export class PhotoCamera {
  /** The point the camera orbits and looks at. */
  private readonly pivot = new THREE.Vector3();
  private yaw = 0;
  private pitch = 0;
  private distance = 1;
  private fov = 60;
  /** The field of view before photo mode, put back on leaving. */
  private normalFov = 60;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly pointer: PointerOrbit,
  ) {}

  /** Takes over from the camera where it is, orbiting `pivot` (what it was looking at). */
  begin(pivot: THREE.Vector3): void {
    this.pivot.copy(pivot);
    _offset.subVectors(this.camera.position, pivot);
    this.distance = Math.max(0.5, _offset.length());
    this.yaw = Math.atan2(_offset.x, _offset.z);
    this.pitch = THREE.MathUtils.clamp(Math.asin(_offset.y / this.distance), PHOTO.pitchMin, PHOTO.pitchMax);
    this.normalFov = this.fov = this.camera.fov;
  }

  /** Puts the field of view back. */
  end(): void {
    this.camera.fov = this.normalFov;
    this.camera.updateProjectionMatrix();
  }

  /**
   * @param dt real time (s)
   * @param turn left/right from the keys (−1..1, left is +1, like a drag to the left)
   * @param tilt up/down from the keys (−1..1, up is +1: the camera rises over the pivot)
   * @param shift Shift held: the keys pan instead of orbiting
   * @param subject what's being photographed (the car): panning speeds up with distance from it
   */
  update(dt: number, turn: number, tilt: number, shift: boolean, subject: THREE.Vector3): void {
    const P = PHOTO;
    const input = this.pointer.take(dt);
    const orbitKeys = shift ? 0 : P.turnSpeed * dt;

    this.yaw += -input.dx * P.dragTurn + turn * orbitKeys;
    this.pitch = THREE.MathUtils.clamp(this.pitch + input.dy * P.dragTurn + tilt * orbitKeys, P.pitchMin, P.pitchMax);

    // The camera's own axes, for panning and moving.
    this.place();
    _right.setFromMatrixColumn(this.camera.matrixWorld, 0);
    _up.setFromMatrixColumn(this.camera.matrixWorld, 1);
    this.camera.getWorldDirection(_forward);

    // Pan: a drag moves the scene along with the mouse; Shift+arrow keys slide the camera.
    const reach = Math.max(P.panNear, this.camera.position.distanceTo(subject));
    const pan = reach * P.panPerPixel;
    const panKeys = shift ? reach * P.panPerSecond * dt : 0;
    this.pivot.addScaledVector(_right, -input.panX * pan - turn * panKeys).addScaledVector(_up, input.panY * pan + tilt * panKeys);

    // Forward and back: the camera and its pivot travel together along the view.
    this.pivot.addScaledVector(_forward, -input.scroll * P.movePerScroll);

    // Lens zoom: Shift+scroll up narrows the view.
    this.fov = THREE.MathUtils.clamp(this.fov * Math.exp(input.shiftScroll * P.zoomPerScroll), P.fovMin, P.fovMax);

    this.place();
  }

  private place(): void {
    _offset.set(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    this.camera.position.copy(this.pivot).addScaledVector(_offset, this.distance);
    this.camera.lookAt(this.pivot);
    if (this.camera.fov !== this.fov) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }
}
