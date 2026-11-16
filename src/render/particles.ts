import * as THREE from 'three';
import { GRAVITY } from '../constants';
import type { TerrainField } from '../world/terrainField';
import { softDotTexture } from './smoke';

export interface ParticleOptions {
  capacity: number;
  blending: THREE.Blending;
  /** Fraction of world gravity the particles feel. */
  gravity: number;
  /** Air drag (1/s): high for powder snow, low for sparks. */
  drag: number;
}

export interface Emission {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** World-space size at birth and growth per second. */
  size: number;
  grow: number;
  life: number;
  color: THREE.Color;
  alpha: number;
}

const VERTEX = /* glsl */ `
  attribute float size;
  attribute float alpha;
  attribute vec3 tint;
  uniform float halfHeight;
  varying float vAlpha;
  varying vec3 vTint;
  #include <fog_pars_vertex>
  void main() {
    vAlpha = alpha;
    vTint = tint;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    // World-space size → pixels for this perspective camera.
    gl_PointSize = size * projectionMatrix[1][1] * halfHeight / -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;

const FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  varying float vAlpha;
  varying vec3 vTint;
  #include <fog_pars_fragment>
  void main() {
    float a = texture2D(map, gl_PointCoord).a * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vTint, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

/**
 * Cheap world-space point particles (one draw call): CPU-simulated with
 * gravity and drag, settling on the analytic terrain, fading out over life.
 */
export class Particles {
  private count = 0;
  private readonly position: Float32Array;
  private readonly velocity: Float32Array;
  private readonly size: Float32Array;
  private readonly grow: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly alpha: Float32Array;
  private readonly baseAlpha: Float32Array;
  private readonly tint: Float32Array;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;

  constructor(
    scene: THREE.Scene,
    private readonly field: TerrainField,
    private readonly opts: ParticleOptions,
  ) {
    const n = opts.capacity;
    this.position = new Float32Array(n * 3);
    this.velocity = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.grow = new Float32Array(n);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.baseAlpha = new Float32Array(n);
    this.tint = new Float32Array(n * 3);
    const dynamic = (array: Float32Array, size: number) =>
      new THREE.BufferAttribute(array, size).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', dynamic(this.position, 3));
    this.geometry.setAttribute('size', dynamic(this.size, 1));
    this.geometry.setAttribute('alpha', dynamic(this.alpha, 1));
    this.geometry.setAttribute('tint', dynamic(this.tint, 3));
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { map: { value: null }, halfHeight: { value: 400 } },
      ]),
      fog: true,
      transparent: true,
      depthWrite: false,
      blending: opts.blending,
    });
    this.material.uniforms.map.value = softDotTexture();
    const points = new THREE.Points(this.geometry, this.material);
    points.frustumCulled = false;
    scene.add(points);
  }

  emit(e: Emission): void {
    // When full, overwrite a random live particle rather than dropping the new one.
    const i = this.count < this.opts.capacity ? this.count++ : Math.floor(Math.random() * this.opts.capacity);
    e.position.toArray(this.position, i * 3);
    e.velocity.toArray(this.velocity, i * 3);
    e.color.toArray(this.tint, i * 3);
    this.size[i] = e.size;
    this.grow[i] = e.grow;
    this.age[i] = 0;
    this.life[i] = e.life;
    this.baseAlpha[i] = e.alpha;
  }

  /**
   * @param halfHeight half the drawing-buffer height in pixels (for point sizing)
   * @param clear how clear of solid things a particle at (x, y, z), `radius` m round, is: 0 (into
   *   one) .. 1 (clear); it shows that much. A flat sprite cutting through a solid shows a hard edge.
   */
  update(dt: number, halfHeight: number, clear?: (x: number, y: number, z: number, radius: number) => number): void {
    this.material.uniforms.halfHeight.value = halfHeight;
    const g = GRAVITY * this.opts.gravity * dt;
    const keep = Math.max(0, 1 - this.opts.drag * dt);
    let i = 0;
    while (i < this.count) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.moveLast(i);
        continue;
      }
      const o = i * 3;
      this.velocity[o + 1] -= g;
      for (let k = 0; k < 3; k++) {
        this.velocity[o + k] *= keep;
        this.position[o + k] += this.velocity[o + k] * dt;
      }
      // Settle on the snow instead of falling through it.
      const ground = this.field.height(this.position[o], this.position[o + 2]) + 0.05;
      if (this.position[o + 1] < ground) {
        this.position[o + 1] = ground;
        this.velocity[o] *= 0.3;
        this.velocity[o + 1] = 0;
        this.velocity[o + 2] *= 0.3;
      }
      this.size[i] += this.grow[i] * dt;
      const t = this.age[i] / this.life[i];
      this.alpha[i] = this.baseAlpha[i] * (1 - t) * Math.min(1, t * 10 + 0.3);
      if (clear) this.alpha[i] *= clear(this.position[o], this.position[o + 1], this.position[o + 2], this.size[i] / 2);
      i++;
    }
    this.geometry.setDrawRange(0, this.count);
    for (const name of ['position', 'size', 'alpha', 'tint']) this.geometry.getAttribute(name).needsUpdate = true;
  }

  /** Removes particle i by moving the last live particle into its slot. */
  private moveLast(i: number): void {
    const last = --this.count;
    if (i === last) return;
    for (let k = 0; k < 3; k++) {
      this.position[i * 3 + k] = this.position[last * 3 + k];
      this.velocity[i * 3 + k] = this.velocity[last * 3 + k];
      this.tint[i * 3 + k] = this.tint[last * 3 + k];
    }
    this.size[i] = this.size[last];
    this.grow[i] = this.grow[last];
    this.age[i] = this.age[last];
    this.life[i] = this.life[last];
    this.alpha[i] = this.alpha[last];
    this.baseAlpha[i] = this.baseAlpha[last];
  }
}
