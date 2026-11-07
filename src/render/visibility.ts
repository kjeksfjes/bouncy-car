import * as THREE from 'three';

const _frustum = new THREE.Frustum();
const _viewProj = new THREE.Matrix4();
const _sphere = new THREE.Sphere();

/** Per-frame snapshot of what the camera can see, for spawn/despawn decisions. */
export class Visibility {
  private readonly cameraPos = new THREE.Vector3();
  private viewDistance = 0;

  /** Call once per frame after the camera has moved. */
  update(camera: THREE.Camera, viewDistance: number): void {
    camera.updateMatrixWorld();
    _viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_viewProj);
    this.cameraPos.setFromMatrixPosition(camera.matrixWorld);
    this.viewDistance = viewDistance;
  }

  /** True if a sphere at `point` could appear on screen (inside the view and nearer than the fog end). */
  canSee(point: THREE.Vector3, radius: number): boolean {
    return (
      this.cameraPos.distanceTo(point) - radius < this.viewDistance &&
      _frustum.intersectsSphere(_sphere.set(point, radius))
    );
  }
}
