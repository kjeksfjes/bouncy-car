import * as THREE from 'three';
import { GRAVITY } from '../constants';
import type { TerrainField } from '../world/terrainField';

/** Feel values for the sparks. */
const SPARK = {
  /**
   * Air drag (1/s, min..max): most sparks fly on, drawn out into streaks; `flecks` of them are the
   * tiniest, which the air brakes hard (`fleckDrag`), so they slow to short dashes and glowing dots.
   */
  drag: [0.4, 0.8] as const,
  flecks: 0.35,
  fleckDrag: [4, 9] as const,
  /** A streak is the path of the last `streak` seconds, at most `maxLength` m long. */
  streak: 0.04,
  maxLength: 0.8,
  /** Streak half-width (m), and at least this many pixels so far sparks don't vanish. */
  width: 0.012,
  minPixels: 0.8,
  /** On hitting the ground: speed kept up (bounce) and along it, and life lost (s). */
  bounce: 0.3,
  skid: 0.85,
  bounceCost: 0.05,
  /**
   * The glow round each spark (there's no bloom to give one): the same streak drawn again
   * `width` m to each side (at least `minPixels` px), soft to its edges, added onto what's behind at
   * `strength` of the spark's colour.
   */
  glow: { width: 0.04, minPixels: 3, strength: 0.35 },
};

/**
 * Colours as a spark cools over its life: white-hot, yellow, orange, dull red. Over 1 so the
 * tone mapping keeps the hot end near white.
 */
const HEAT = [
  new THREE.Color(3, 2.6, 1.6),
  new THREE.Color(2.4, 1.4, 0.35),
  new THREE.Color(1.6, 0.55, 0.08),
  new THREE.Color(0.7, 0.12, 0.02),
];

export interface SparkEmission {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  life: number;
}

const VERTEX = /* glsl */ `
  attribute vec2 corner;
  attribute vec3 head;
  attribute vec3 tail;
  attribute vec3 tint;
  attribute float alpha;
  uniform float halfHeight;
  uniform float width;
  uniform float minPixels;
  varying vec3 vTint;
  varying float vAlpha;
  varying float vSide;
  // Along the quad (0 at the tail end, 1 at the head end), and the share of it each rounded end takes.
  varying float vAlong;
  varying float vEnd;
  #include <fog_pars_vertex>
  void main() {
    vec4 h = modelViewMatrix * vec4( head, 1.0 );
    vec4 t = modelViewMatrix * vec4( tail, 1.0 );
    vec4 mvPosition = mix( t, h, corner.x );
    // Across the streak as seen on screen; a streak pointing at the camera is a dot.
    vec2 dir = h.xy / max( -h.z, 0.01 ) - t.xy / max( -t.z, 0.01 );
    float len = length( dir );
    dir = len > 1e-5 ? dir / len : vec2( 1.0, 0.0 );
    vec2 across = vec2( -dir.y, dir.x );
    float pixel = max( -mvPosition.z, 0.01 ) / ( projectionMatrix[1][1] * halfHeight );
    float w = max( width, minPixels * pixel );
    // Room past each end for a rounded cap (see capsule), so short streaks still read as sparks.
    mvPosition.xy += across * w * corner.y + dir * w * ( corner.x * 2.0 - 1.0 );
    vTint = tint;
    // Thinner than the minimum: fade instead of growing.
    vAlpha = alpha * min( 1.0, 0.4 + width / w );
    vSide = corner.y;
    vAlong = corner.x;
    // As drawn: across the view, not toward it (a streak pointing at the camera is short on screen).
    vEnd = w / ( distance( h.xy, t.xy ) + 2.0 * w );
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;

/**
 * How far a point of the quad lies from the streak's middle line, squared, in half-widths: across
 * it, and past either end, so the ends are round (a capsule). 1 at the edge.
 */
const CAPSULE = /* glsl */ `
  float capsule() {
    float past = max( 0.0, 1.0 - vAlong / vEnd ) + max( 0.0, 1.0 - ( 1.0 - vAlong ) / vEnd );
    return past * past + vSide * vSide;
  }`;

const FRAGMENT = /* glsl */ `
  varying vec3 vTint;
  varying float vAlpha;
  varying float vSide;
  varying float vAlong;
  varying float vEnd;
  #include <fog_pars_fragment>
  ${CAPSULE}
  void main() {
    float a = vAlpha * max( 0.0, 1.0 - capsule() );
    if ( a < 0.01 ) discard;
    gl_FragColor = vec4( vTint, a );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

/**
 * The glow: the streak's colour, warmer (a white-hot glow added onto snow would only whiten it),
 * falling off softly from its middle line out to the edge of a wider capsule, added onto what's behind.
 */
const GLOW_FRAGMENT = /* glsl */ `
  uniform float strength;
  varying vec3 vTint;
  varying float vAlpha;
  varying float vSide;
  varying float vAlong;
  varying float vEnd;
  #include <fog_pars_fragment>
  ${CAPSULE}
  void main() {
    float d = capsule();
    float a = vAlpha * strength * exp( -4.0 * d ) * max( 0.0, 1.0 - d );
    if ( a < 0.004 ) discard;
    gl_FragColor = vec4( vTint * vec3( 1.0, 0.65, 0.3 ), a );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

/**
 * Sparks: hot flecks of metal drawn as streaks along their flight, cooling from white-hot to dull
 * red, falling under gravity and bouncing off the terrain. CPU-simulated, one instanced draw call.
 */
export class Sparks {
  private count = 0;
  private readonly position: Float32Array;
  private readonly velocity: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly drag: Float32Array;
  private readonly head: Float32Array;
  private readonly tail: Float32Array;
  private readonly tint: Float32Array;
  private readonly alpha: Float32Array;
  private readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly glowMaterial: THREE.ShaderMaterial;
  private readonly attributes: THREE.InstancedBufferAttribute[];

  constructor(
    scene: THREE.Scene,
    private readonly field: TerrainField,
    private readonly capacity: number,
  ) {
    const n = capacity;
    this.position = new Float32Array(n * 3);
    this.velocity = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.head = new Float32Array(n * 3);
    this.tail = new Float32Array(n * 3);
    this.tint = new Float32Array(n * 3);
    this.alpha = new Float32Array(n);
    // A quad from the tail (x = 0) to the head (x = 1), across from y = −1 to 1.
    this.geometry.setAttribute('corner', new THREE.Float32BufferAttribute([0, -1, 1, -1, 1, 1, 0, 1], 2));
    // Three.js wants a position attribute to draw; the shader places the quad from head and tail.
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const instanced = (array: Float32Array, size: number) =>
      new THREE.InstancedBufferAttribute(array, size).setUsage(THREE.DynamicDrawUsage);
    this.attributes = [instanced(this.head, 3), instanced(this.tail, 3), instanced(this.tint, 3), instanced(this.alpha, 1)];
    ['head', 'tail', 'tint', 'alpha'].forEach((name, i) => this.geometry.setAttribute(name, this.attributes[i]));
    this.geometry.instanceCount = 0;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { halfHeight: { value: 400 }, width: { value: SPARK.width }, minPixels: { value: SPARK.minPixels } },
      ]),
      fog: true,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.frustumCulled = false;
    scene.add(mesh);
    // The glow: the same streaks again, wider and soft, in one more draw.
    const G = SPARK.glow;
    this.glowMaterial = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: GLOW_FRAGMENT,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { halfHeight: { value: 400 }, width: { value: G.width }, minPixels: { value: G.minPixels }, strength: { value: G.strength } },
      ]),
      fog: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const glow = new THREE.Mesh(this.geometry, this.glowMaterial);
    glow.frustumCulled = false;
    scene.add(glow);
  }

  emit(e: SparkEmission): void {
    // When full, overwrite a random live spark rather than dropping the new one.
    const i = this.count < this.capacity ? this.count++ : Math.floor(Math.random() * this.capacity);
    e.position.toArray(this.position, i * 3);
    e.velocity.toArray(this.velocity, i * 3);
    this.age[i] = 0;
    this.life[i] = e.life;
    const [lo, hi] = Math.random() < SPARK.flecks ? SPARK.fleckDrag : SPARK.drag;
    this.drag[i] = lo + (hi - lo) * Math.random();
  }

  /** @param halfHeight half the drawing-buffer height in pixels (for the minimum width) */
  update(dt: number, halfHeight: number): void {
    const S = SPARK;
    this.material.uniforms.halfHeight.value = halfHeight;
    this.glowMaterial.uniforms.halfHeight.value = halfHeight;
    const g = GRAVITY * dt;
    let i = 0;
    while (i < this.count) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.moveLast(i);
        continue;
      }
      const o = i * 3;
      const p = this.position;
      const v = this.velocity;
      v[o + 1] -= g;
      const keep = Math.max(0, 1 - this.drag[i] * dt);
      for (let k = 0; k < 3; k++) {
        v[o + k] *= keep;
        p[o + k] += v[o + k] * dt;
      }
      const ground = this.field.quickHeight(p[o], p[o + 2]) + 0.02;
      if (p[o + 1] < ground) {
        p[o + 1] = ground;
        v[o] *= S.skid;
        v[o + 1] = Math.abs(v[o + 1]) * S.bounce;
        v[o + 2] *= S.skid;
        this.age[i] += S.bounceCost;
      }
      // The streak trails back along the velocity.
      const speed = Math.hypot(v[o], v[o + 1], v[o + 2]);
      const back = speed > 0 ? Math.min(S.streak, S.maxLength / speed) : 0;
      for (let k = 0; k < 3; k++) {
        this.head[o + k] = p[o + k];
        this.tail[o + k] = p[o + k] - v[o + k] * back;
      }
      const t = this.age[i] / this.life[i];
      heatColour(t).toArray(this.tint, o);
      this.alpha[i] = Math.min(1, (1 - t) * 3);
      i++;
    }
    this.geometry.instanceCount = this.count;
    for (const attribute of this.attributes) attribute.needsUpdate = true;
  }

  /** Removes spark i by moving the last live one into its slot. */
  private moveLast(i: number): void {
    const last = --this.count;
    if (i === last) return;
    for (let k = 0; k < 3; k++) {
      this.position[i * 3 + k] = this.position[last * 3 + k];
      this.velocity[i * 3 + k] = this.velocity[last * 3 + k];
    }
    this.age[i] = this.age[last];
    this.life[i] = this.life[last];
    this.drag[i] = this.drag[last];
  }
}

const _heat = new THREE.Color();

/** The spark's colour at `t` (0..1) of its life: quickly off white-hot, slowly through orange to red. */
function heatColour(t: number): THREE.Color {
  const x = Math.sqrt(t) * (HEAT.length - 1);
  const k = Math.min(HEAT.length - 2, Math.floor(x));
  return _heat.copy(HEAT[k]).lerp(HEAT[k + 1], x - k);
}
