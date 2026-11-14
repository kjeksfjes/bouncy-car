import * as THREE from 'three';
import { replaceOnce } from './shaderPatch';

/**
 * The see-through cut's shape. Feel values: change freely.
 * - `radius`: the cone from the camera to the car is this wide at the car (m), narrowing to the
 *   camera, so on screen it covers the middle of the car and nothing else. The outer `edge` share
 *   of it dissolves out gradually rather than ending in a hard rim.
 * - `shortOf`: the cone ends this far short of the car's centre (m), fading out over `endFade` m,
 *   so what stands right beside the car (and the ground it's on) stays whole.
 */
const CUT = {
  radius: 1.6,
  edge: 0.5,
  shortOf: 1.5,
  endFade: 2,
};

/**
 * When the cut opens: the camera's sight lines to `points` on the car's body (car-local m: its
 * corners, sides, middle and roof; front is −z, the ground ≈ −0.75) are checked against the
 * trees every frame, and the cut fades in once at least `hiddenShare` of them are blocked, over
 * `fadeIn` s, and out again over `fadeOut` s. A tree hiding only a corner, a side or a strip of
 * the car leaves it alone: enough of it still shows.
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
  fadeIn: 0.15,
  fadeOut: 0.4,
};

/**
 * Where the car is, and how far the cut is open (0..1). SightCut sets both every frame; every
 * material given the cut (see cutSightLine) reads them.
 */
export const sightCut = { target: { value: new THREE.Vector3() }, on: { value: 0 } };

/** What can hide the car: the trees' meshes, added and removed as their chunks come and go. */
export const sightBlockers = new Set<THREE.Object3D>();

const _point = new THREE.Vector3();
const _dir = new THREE.Vector3();

/** Opens the cut while trees hide most of the car (see OPEN), and keeps it aimed at the car. */
export class SightCut {
  private readonly ray = new THREE.Raycaster();
  private readonly hits: THREE.Intersection[] = [];
  private readonly blockers: THREE.Object3D[] = [];

  /**
   * @param dt real time (s)
   * @param car the car's visual root
   * @param enabled false keeps the cut shut (photo mode: the shot shows the trees whole)
   */
  update(dt: number, camera: THREE.Camera, car: THREE.Object3D, enabled: boolean): void {
    const O = OPEN;
    sightCut.target.value.copy(car.position);
    const open = enabled && this.hiddenShare(camera.position, car) >= O.hiddenShare;
    const on = sightCut.on;
    on.value = open ? Math.min(1, on.value + dt / O.fadeIn) : Math.max(0, on.value - dt / O.fadeOut);
  }

  /** The share of the car's sight points that trees hide from `eye`. */
  private hiddenShare(eye: THREE.Vector3, car: THREE.Object3D): number {
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
    }
    return hidden / points.length;
  }
}

/**
 * Gives `material` the see-through cut: whatever it draws between the camera and the car, in a
 * cone round the line of sight (see CUT), dissolves in a fine dither (whole pixels dropped, not
 * blended, so no transparency sorting) as far as the cut is open. Shadows are drawn with three's
 * own depth material, so the cut parts still cast theirs.
 *
 * Sets the material's `onBeforeCompile`, so it first calls the shared one on the prototype (the
 * haze's uniforms, see installFogFade).
 */
export function cutSightLine(material: THREE.Material): void {
  const C = CUT;
  const f = (n: number) => n.toFixed(3);
  material.onBeforeCompile = (shader, renderer) => {
    THREE.Material.prototype.onBeforeCompile.call(material, shader, renderer);
    shader.uniforms.sightTarget = sightCut.target;
    shader.uniforms.sightOn = sightCut.on;
    shader.vertexShader = replaceOnce(
      replaceOnce(shader.vertexShader, 'void main() {', 'varying vec3 vSightWorld;\nvoid main() {', 'Sight cut'),
      '#include <project_vertex>',
      [
        '#include <project_vertex>',
        '#ifdef USE_INSTANCING',
        '\tvSightWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;',
        '#else',
        '\tvSightWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        '#endif',
      ].join('\n'),
      'Sight cut',
    );
    shader.fragmentShader = replaceOnce(
      shader.fragmentShader,
      'void main() {',
      /* glsl */ `varying vec3 vSightWorld;
uniform vec3 sightTarget;
uniform float sightOn;
void main() {
	if (sightOn > 0.0) {
		vec3 sightAxis = sightTarget - cameraPosition;
		float sightLength = max(length(sightAxis), 1e-3);
		vec3 sightDir = sightAxis / sightLength;
		vec3 sightFrom = vSightWorld - cameraPosition;
		float sightAlong = dot(sightFrom, sightDir);
		// How far off the line of sight, as a share of the cone's radius at that depth.
		float sightAway = length(sightFrom - sightDir * sightAlong) * sightLength / (${f(C.radius)} * max(sightAlong, 1e-3));
		float sightEnd = sightLength - ${f(C.shortOf)};
		float sightIn = sightOn
			* (1.0 - smoothstep(${f(1 - C.edge)}, 1.0, sightAway))
			* (1.0 - smoothstep(sightEnd - ${f(C.endFade)}, sightEnd, sightAlong))
			* step(0.0, sightAlong);
		// Interleaved gradient noise: an even, fine dither over the screen.
		float sightDither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
		if (sightIn > sightDither) discard;
	}`,
      'Sight cut',
    );
  };
}
