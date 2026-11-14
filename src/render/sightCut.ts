import * as THREE from 'three';
import { replaceOnce } from './shaderPatch';
import { pixelRatio } from './stage';

/**
 * How a tree that hides the car thins out. Feel values: change freely.
 * - `thin`: the share of its leaves' pixels dropped once it's fully thinned.
 * - `wood`: the same for its trunk, roots and limbs: less, so the tree's frame still shows where
 *   it stands and what the car can hit.
 * - `block`: the pattern's dots are this many CSS px square, in an ordered 4×4 grid (Bayer), so
 *   the thinned leaves read as a deliberate screen rather than grain.
 */
const THIN = { thin: 0.75, wood: 0.45, block: 2 };

/**
 * When a tree thins: the camera's sight lines to `points` on the car's body (car-local m: its
 * corners, sides, middle and roof; front is −z, the ground ≈ −0.75) are checked against the
 * trees every frame, and once trees block at least `hiddenShare` of them, every tree on those lines
 * thins out over `fadeIn` s, and fills in again over `fadeOut` s when it no longer hides the car.
 * A tree hiding only a corner, a side or a strip of the car is left alone: enough of it still shows.
 * At most `max` trees are thinned at once.
 */
const OPEN = {
  points: [
    [0, 0.1, 0],
    [-0.85, -0.05, -2.1],
    [0.85, -0.05, -2.1],
    [-0.85, -0.05, 2.1],
    [0.85, -0.05, 2.1],
    [-0.9, 0, 0],
    [0.9, 0, 0],
    [0, 0.6, -0.2],
    [0, 0.6, 0.8],
  ].map(([x, y, z]) => new THREE.Vector3(x, y, z)),
  hiddenShare: 0.6,
  fadeIn: 0.2,
  fadeOut: 0.5,
  max: 8,
};

/**
 * The thinned trees: each one's root (world m, its instance's origin) and how far it's thinned
 * (0..1), unused slots at 0. SightCut sets them every frame; every material given the cut (see
 * cutSightLine) reads them.
 */
export const sightCut = { trees: { value: Array.from({ length: OPEN.max }, () => new THREE.Vector4()) } };

/** What can hide the car: the trees' meshes, added and removed as their chunks come and go. */
export const sightBlockers = new Set<THREE.Object3D>();

const _point = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _matrix = new THREE.Matrix4();

/** Thins the trees that hide most of the car (see OPEN). */
export class SightCut {
  private readonly ray = new THREE.Raycaster();
  private readonly hits: THREE.Intersection[] = [];
  private readonly blockers: THREE.Object3D[] = [];
  /** The trees hiding the car this frame, by root. */
  private readonly blocking: THREE.Vector3[] = [];
  /** The trees thinned or thinning, by root. */
  private readonly thinned: { root: THREE.Vector3; fade: number }[] = [];

  /**
   * @param dt real time (s)
   * @param car the car's visual root
   * @param enabled false fills every tree in again (photo mode: the shot shows the trees whole)
   */
  update(dt: number, camera: THREE.Camera, car: THREE.Object3D, enabled: boolean): void {
    const O = OPEN;
    this.blocking.length = 0;
    if (enabled) this.findBlocking(camera.position, car);
    const same = (a: THREE.Vector3, b: THREE.Vector3) => a.distanceToSquared(b) < 1e-4;
    for (const root of this.blocking) {
      if (this.thinned.length < O.max && !this.thinned.some((t) => same(t.root, root))) this.thinned.push({ root, fade: 0 });
    }
    for (let i = this.thinned.length - 1; i >= 0; i--) {
      const t = this.thinned[i];
      const hides = this.blocking.some((root) => same(t.root, root));
      t.fade = hides ? Math.min(1, t.fade + dt / O.fadeIn) : Math.max(0, t.fade - dt / O.fadeOut);
      if (t.fade === 0 && !hides) this.thinned.splice(i, 1);
    }
    sightCut.trees.value.forEach((slot, i) => {
      const t = this.thinned[i];
      if (t) slot.set(t.root.x, t.root.y, t.root.z, t.fade);
      else slot.w = 0;
    });
  }

  /**
   * Fills `blocking` with the roots of the trees on the sight lines from `eye` to the car's points,
   * if they hide enough of them (see OPEN).
   */
  private findBlocking(eye: THREE.Vector3, car: THREE.Object3D): void {
    const points = OPEN.points;
    this.blockers.length = 0;
    for (const b of sightBlockers) this.blockers.push(b);
    let hidden = 0;
    for (const local of points) {
      car.localToWorld(_point.copy(local));
      const distance = _dir.subVectors(_point, eye).length();
      this.ray.set(eye, _dir.divideScalar(distance));
      this.ray.far = distance;
      this.hits.length = 0;
      this.ray.intersectObjects(this.blockers, false, this.hits);
      if (this.hits.length > 0) hidden++;
      for (const hit of this.hits) {
        // An instanced tree's root is its instance's origin; an oak's own foot (a plain mesh) stands
        // where its crown's instance does, so the two thin together.
        const root = new THREE.Vector3();
        if (hit.object instanceof THREE.InstancedMesh && hit.instanceId !== undefined) {
          hit.object.getMatrixAt(hit.instanceId, _matrix);
          root.setFromMatrixPosition(_matrix).applyMatrix4(hit.object.matrixWorld);
        } else {
          root.setFromMatrixPosition(hit.object.matrixWorld);
        }
        if (!this.blocking.some((b) => b.distanceToSquared(root) < 1e-4)) this.blocking.push(root);
      }
    }
    if (hidden / points.length < OPEN.hiddenShare) this.blocking.length = 0;
  }
}

/** The 4×4 ordered dither (Bayer), as thresholds 0..15. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/**
 * Gives `material` the see-through cut: a tree SightCut thins (see sightCut.trees) drops pixels in
 * a coarse ordered pattern (whole pixels dropped, not blended, so no transparency sorting), as far
 * as it's thinned: its leaves (the faces whose `crown` attribute is 1, see the tree builders in
 * props.ts) by THIN.thin, the wood by THIN.wood. Shadows are drawn with three's own
 * depth material, so a thinned crown still casts its full shadow.
 *
 * Sets the material's `onBeforeCompile`, so it first calls the shared one on the prototype (the
 * haze's uniforms, see installFogFade).
 */
export function cutSightLine(material: THREE.Material): void {
  const f = (n: number) => n.toFixed(3);
  const n = OPEN.max;
  // In device pixels, as gl_FragCoord counts.
  const block = Math.max(1, Math.round(THIN.block * pixelRatio()));
  material.onBeforeCompile = (shader, renderer) => {
    THREE.Material.prototype.onBeforeCompile.call(material, shader, renderer);
    shader.uniforms.sightTrees = sightCut.trees;
    shader.vertexShader = replaceOnce(
      replaceOnce(
        shader.vertexShader,
        'void main() {',
        `attribute float crown;\nuniform vec4 sightTrees[${n}];\nvarying float vSightThin;\nvoid main() {`,
        'Sight cut',
      ),
      '#include <project_vertex>',
      /* glsl */ `#include <project_vertex>
	vSightThin = 0.0;
#ifdef USE_INSTANCING
	vec3 sightRoot = (modelMatrix * instanceMatrix[3]).xyz;
#else
	vec3 sightRoot = modelMatrix[3].xyz;
#endif
	for (int i = 0; i < ${n}; i++) {
		if (sightTrees[i].w > 0.0 && distance(sightRoot, sightTrees[i].xyz) < 0.01) {
			vSightThin = sightTrees[i].w * mix(${f(THIN.wood)}, ${f(THIN.thin)}, crown);
		}
	}`,
      'Sight cut',
    );
    shader.fragmentShader = replaceOnce(
      shader.fragmentShader,
      'void main() {',
      /* glsl */ `varying float vSightThin;
const float SIGHT_BAYER[16] = float[16](${BAYER.map((v) => f(v)).join(', ')});
void main() {
	if (vSightThin > 0.0) {
		ivec2 sightCell = ivec2(gl_FragCoord.xy / ${f(block)}) & 3;
		float sightThreshold = (SIGHT_BAYER[sightCell.x + sightCell.y * 4] + 0.5) / 16.0;
		if (vSightThin > sightThreshold) discard;
	}`,
      'Sight cut',
    );
  };
}
