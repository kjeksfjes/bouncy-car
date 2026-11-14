import * as THREE from 'three';
import type { PointerOrbit } from './pointerOrbit';

/**
 * Dev map view: the camera `height` m (min..max) straight above the car, looking down, with downhill
 * (−z) up the screen; at the lowest the car fills the screen. Scroll zooms in and out round the
 * cursor (by `wheelZoom` per wheel unit, exponential), easing in like photo mode's moves: about two
 * thirds of the way in `ease` s; any drag pans at once. The lens is `fov` degrees and reaches `far`
 * m, past the far view's edge from the top height.
 */
const MAP = { height: 450, min: 5, max: 1100, wheelZoom: 0.0015, ease: 0.09, fov: 60, far: 4000 };

/** Looking straight down, with −z up the screen. */
const DOWN = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

export class MapCamera {
  private height = MAP.height;
  /** Panned this far from the car (m, world x and z). */
  private readonly offset = new THREE.Vector2();
  /** Where the zoom is easing to: the height, and the pan that keeps the zoomed-at point in place. */
  private toHeight = MAP.height;
  private readonly toOffset = new THREE.Vector2();
  /** The lens the other cameras had, given back on leaving. */
  private fov = 60;
  private far = 1500;
  /** Where the view is centred (on the ground under the camera, roughly): the car plus the pan. */
  readonly centre = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly pointer: PointerOrbit,
  ) {}

  begin(): void {
    this.fov = this.camera.fov;
    this.far = this.camera.far;
    this.camera.fov = MAP.fov;
    this.camera.far = MAP.far;
    this.camera.updateProjectionMatrix();
    this.offset.set(0, 0);
    this.toOffset.set(0, 0);
    this.toHeight = this.height;
    this.pointer.take(0);
  }

  end(): void {
    this.camera.fov = this.fov;
    this.camera.far = this.far;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number, car: THREE.Vector3): void {
    const input = this.pointer.take(dt);
    const tan = Math.tan(THREE.MathUtils.degToRad(MAP.fov / 2));
    // Zooming keeps the ground under the cursor where it is. It lies ndc × height × tan from the
    // middle (taking the ground as level with the car), so the pan to ease to is where that point
    // is now, less its place at the new height. Height and pan ease alike, so it stays put all the way.
    if (input.scrollAt) {
      this.toHeight = THREE.MathUtils.clamp(this.toHeight * Math.exp(input.scroll * MAP.wheelZoom), MAP.min, MAP.max);
      const kx = input.scrollAt.x * tan * this.camera.aspect;
      const kz = -input.scrollAt.y * tan;
      this.toOffset.set(this.offset.x + kx * (this.height - this.toHeight), this.offset.y + kz * (this.height - this.toHeight));
    }
    const share = 1 - Math.exp(-dt / MAP.ease);
    this.height += (this.toHeight - this.height) * share;
    this.offset.lerp(this.toOffset, share);
    // A drag moves the ground with the cursor at once (metres per pixel on the ground below).
    const perPixel = (2 * this.height * tan) / this.pointer.height;
    const dx = (input.dx + input.panX + input.lookX) * perPixel;
    const dy = (input.dy + input.panY + input.lookY) * perPixel;
    this.offset.x -= dx;
    this.offset.y -= dy;
    this.toOffset.x -= dx;
    this.toOffset.y -= dy;
    this.centre.set(car.x + this.offset.x, car.y, car.z + this.offset.y);
    this.camera.position.set(this.centre.x, car.y + this.height, this.centre.z);
    this.camera.quaternion.copy(DOWN);
  }
}
