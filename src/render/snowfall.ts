import * as THREE from 'three';
import { SUN_DIR } from './stage';

/**
 * Falling snow, all on the GPU: each flake's place is worked out in the vertex shader from time, in
 * a box that travels with the camera and wraps round (a flake falling out of the bottom comes back
 * in at the top), so snow is everywhere and costs no CPU per flake. Two layers of the same flakes:
 * near ones, distinct and big enough to see as flakes, and a far layer, many and small, that fills
 * the air between (sparse flakes over a dense fill, as Langer et al. 2004 render snow).
 *
 * What keeps it from looking like the usual game snow: every flake falls at its own pace (natural
 * aggregates fall at ≈0.4–1.2 m/s, Locatelli & Hobbs 1974) and sways on its own rhythm, all
 * carried by one wind, and heavy snow is big clumps falling nearly straight, light snow small
 * crystals that flutter (see FLAKES); each is stretched along how it moves past the camera, so driving into it
 * draws streaks (the longer, the fainter, by the root of the stretch); flakes are soft, a little see-through, bluish-white,
 * brighter looking toward the sun (snowflakes scatter light forward), drawn over the scene rather
 * than added to it (added light vanishes against white snow); and they fade out near the camera,
 * at the box's edges (no popping) and into the fog.
 */
const LAYERS = [
  // box: the volume round the camera (m); count of flakes in it; size across (m, min..max; drawn
  // bigger than real flakes, a few mm to 2 cm, so they read from the chase camera); how opaque.
  { box: new THREE.Vector3(36, 22, 36), count: 30000, size: [0.03, 0.06], alpha: 0.9 },
  { box: new THREE.Vector3(130, 50, 130), count: 40000, size: [0.08, 0.14], alpha: 0.5 },
] as const;

/**
 * Feel values. The flakes change with how hard it snows: in `light` snow small single crystals
 * that fall slowly and flutter, in `heavy` snow big clumps (many crystals stuck together, heavier
 * for their size) that fall faster and nearly straight. For each: their size (× LAYERS' sizes),
 * fall (min..max, m/s), a slow sway round a circle up to `sway` m wide (at `swayRate`, min..max
 * rad/s), a quick flutter up to `flutter` m (at `flutterRate`) and a flicker as they tumble and
 * catch the light (`flicker`: how much they dim at most). A flake shows its motion over `shutter`
 * s (a camera's exposure): the faster it passes, the longer its streak. Nearer the camera than
 * `near` (min..max, m) it fades out (no flake fills the screen); it fades in over the outer
 * `edge` of its box.
 */
const FLAKES = {
  light: { size: 0.8, fall: [0.35, 0.8] as const, sway: 0.45, flutter: 0.1, flicker: 0.5 },
  heavy: { size: 2.2, fall: [2.4, 3.6] as const, sway: 0.06, flutter: 0.015, flicker: 0.1 },
  swayRate: [0.6, 1.4] as const,
  flutterRate: [3, 6] as const,
  shutter: 1 / 45,
  near: [0.35, 1.2] as const,
  edge: 0.2,
  /** Colours: in shade, and lit with the sun behind them (glowing). */
  shade: new THREE.Color('#c9d4e2'),
  lit: new THREE.Color('#ffffff'),
};

const VERTEX = /* glsl */ `
  attribute vec4 seed;
  attribute vec4 traits;
  uniform float time;
  uniform vec3 box;
  uniform vec3 eye;
  uniform vec3 wind;
  uniform vec3 blown;
  uniform vec3 eyeVelocity;
  uniform float heavy;
  uniform vec4 fall;
  uniform vec2 fallen;
  uniform vec2 sizes;
  uniform vec2 sizeScale;
  uniform vec2 sway;
  uniform vec2 flutter;
  uniform vec2 flicker;
  uniform vec2 swayRate;
  uniform vec2 flutterRate;
  uniform float shutter;
  uniform vec2 near;
  uniform float edge;
  uniform float amount;
  varying vec2 vUv;
  varying float vAlpha;
  varying float vToSun;
  #include <fog_pars_vertex>
  // A sway round a circle: its offset (amplitude a, angular rate w, phase f) and its velocity.
  vec3 circle( float a, float w, float f ) { return a * vec3( cos( time * w + f ), 0.0, sin( time * w * 0.8 + f ) ); }
  vec3 circleVelocity( float a, float w, float f ) { return a * w * vec3( -sin( time * w + f ), 0.0, 0.8 * cos( time * w * 0.8 + f ) ); }
  void main() {
    // Only the share of flakes the snowfall's strength calls for.
    if ( seed.w > amount ) { gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 ); return; }
    // Its fall: the light and heavy speeds for its trait, weighed by how far each has carried it
    // (summed up as the snow changed: see Snowfall.update), so a change in the snow never jolts it.
    float lightSpeed = mix( fall.x, fall.y, traits.x );
    float heavySpeed = mix( fall.z, fall.w, traits.x );
    float speed = mix( lightSpeed, heavySpeed, heavy );
    float phase = traits.w * 6.2832;
    float swayW = mix( swayRate.x, swayRate.y, traits.z );
    float flutterW = mix( flutterRate.x, flutterRate.y, fract( traits.z * 7.31 ) );
    float swayA = mix( sway.x, sway.y, heavy ) * ( 0.4 + 0.6 * traits.y );
    float flutterA = mix( flutter.x, flutter.y, heavy ) * ( 0.5 + 0.5 * fract( traits.y * 5.17 ) );
    vec3 drift = circle( swayA, swayW, phase ) + circle( flutterA, flutterW, phase * 2.3 );
    vec3 p = seed.xyz * box + blown + vec3( 0.0, -( lightSpeed * fallen.x + heavySpeed * fallen.y ), 0.0 ) + drift;
    // Into the box round the eye, wrapping round.
    vec3 rel = mod( p - eye + 0.5 * box, box ) - 0.5 * box;
    vec3 world = eye + rel;
    // How it moves past the camera: its fall, sway and the wind, less the camera's own motion.
    vec3 v = wind + circleVelocity( swayA, swayW, phase ) + circleVelocity( flutterA, flutterW, phase * 2.3 ) + vec3( 0.0, -speed, 0.0 ) - eyeVelocity;
    vec3 toEye = normalize( cameraPosition - world );
    vec3 across = v - dot( v, toEye ) * toEye;
    float streak = length( across ) * shutter;
    vec3 axis = streak > 1e-4 ? across / length( across ) : normalize( cross( toEye, vec3( 1.0, 0.0, 0.0 ) ) );
    vec3 side = normalize( cross( axis, toEye ) );
    float size = mix( sizes.x, sizes.y, traits.y ) * mix( sizeScale.x, sizeScale.y, heavy );
    float len = size + streak;
    vec3 corner = world + side * position.x * size * 0.5 + axis * position.y * len * 0.5;
    vUv = position.xy;
    // Fainter the longer the streak (the same flake spread thinner, though a streak still reads, as
    // in a photo: by the root of the stretch), near the camera and at the box's edge.
    float dist = length( rel );
    vec3 inside = abs( rel ) / ( 0.5 * box );
    float rim = max( inside.x, max( inside.y, inside.z ) );
    vAlpha = sqrt( size / len ) * smoothstep( near.x, near.y, dist ) * ( 1.0 - smoothstep( 1.0 - edge, 1.0, rim ) );
    // Tumbling, it catches the light and loses it.
    vAlpha *= 1.0 - mix( flicker.x, flicker.y, heavy ) * ( 0.5 + 0.5 * sin( time * flutterW * 1.7 + phase * 3.1 ) );
    vToSun = dot( -toEye, normalize( vec3( ${SUN_DIR.x.toFixed(4)}, ${SUN_DIR.y.toFixed(4)}, ${SUN_DIR.z.toFixed(4)} ) ) );
    vec4 mvPosition = viewMatrix * vec4( corner, 1.0 );
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 shade;
  uniform vec3 lit;
  uniform float alpha;
  varying vec2 vUv;
  varying float vAlpha;
  varying float vToSun;
  #include <fog_pars_fragment>
  void main() {
    // A soft round flake (an ellipse along a streak).
    float d = length( vUv );
    float a = ( 1.0 - smoothstep( 0.35, 1.0, d ) ) * vAlpha * alpha;
    if ( a < 0.004 ) discard;
    // Looking toward the sun, flakes glow.
    float glow = smoothstep( 0.2, 0.95, vToSun );
    gl_FragColor = vec4( mix( shade, lit, 0.35 + 0.65 * glow ), a );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

/** Falling snow round the camera (see LAYERS, FLAKES), its strength set each frame. */
export class Snowfall {
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly lastEye = new THREE.Vector3(NaN, 0, 0);
  private readonly eyeVelocity = new THREE.Vector3();
  private time = 0;
  /** How far the wind has carried the snow (m), and the time spent falling light and heavy (s): summed, so changes never jolt it. */
  private readonly blown = new THREE.Vector3();
  private readonly fallen = new THREE.Vector2();

  constructor(scene: THREE.Scene) {
    const F = FLAKES;
    for (const layer of LAYERS) {
      const geometry = new THREE.InstancedBufferGeometry();
      // A quad, −1..1 (x across the flake, y along its motion).
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
      geometry.setIndex([0, 1, 2, 0, 2, 3]);
      const seed = new Float32Array(layer.count * 4);
      const traits = new Float32Array(layer.count * 4);
      for (let i = 0; i < layer.count * 4; i++) {
        seed[i] = Math.random();
        traits[i] = Math.random();
      }
      geometry.setAttribute('seed', new THREE.InstancedBufferAttribute(seed, 4));
      geometry.setAttribute('traits', new THREE.InstancedBufferAttribute(traits, 4));
      geometry.instanceCount = layer.count;
      const material = new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        uniforms: THREE.UniformsUtils.merge([
          THREE.UniformsLib.fog,
          {
            time: { value: 0 },
            box: { value: layer.box.clone() },
            eye: { value: new THREE.Vector3() },
            wind: { value: new THREE.Vector3() },
            eyeVelocity: { value: new THREE.Vector3() },
            blown: { value: new THREE.Vector3() },
            heavy: { value: 0 },
            fall: { value: new THREE.Vector4(F.light.fall[0], F.light.fall[1], F.heavy.fall[0], F.heavy.fall[1]) },
            fallen: { value: new THREE.Vector2() },
            sizes: { value: new THREE.Vector2(...layer.size) },
            sizeScale: { value: new THREE.Vector2(F.light.size, F.heavy.size) },
            sway: { value: new THREE.Vector2(F.light.sway, F.heavy.sway) },
            flutter: { value: new THREE.Vector2(F.light.flutter, F.heavy.flutter) },
            flicker: { value: new THREE.Vector2(F.light.flicker, F.heavy.flicker) },
            swayRate: { value: new THREE.Vector2(...F.swayRate) },
            flutterRate: { value: new THREE.Vector2(...F.flutterRate) },
            shutter: { value: F.shutter },
            near: { value: new THREE.Vector2(...F.near) },
            edge: { value: F.edge },
            amount: { value: 0 },
            shade: { value: F.shade },
            lit: { value: F.lit },
            alpha: { value: layer.alpha },
          },
        ]),
        fog: true,
        transparent: true,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      // After the rest of the transparent things (it's in front of most of them).
      mesh.renderOrder = 10;
      scene.add(mesh);
      this.materials.push(material);
    }
  }

  /**
   * @param dt game time (s): snow hangs still when paused and falls slowly in slow motion
   * @param eye the camera's position
   * @param amount how hard it snows, 0 (not at all) .. 1 (every flake, big and heavy: see FLAKES)
   * @param wind the wind (m/s)
   */
  update(dt: number, eye: THREE.Vector3, amount: number, wind: THREE.Vector3): void {
    this.time += dt;
    this.blown.addScaledVector(wind, dt);
    this.fallen.x += (1 - amount) * dt;
    this.fallen.y += amount * dt;
    if (dt > 0 && Number.isFinite(this.lastEye.x)) {
      // The camera's velocity, smoothed (its shake shouldn't streak the snow).
      const v = eye.clone().sub(this.lastEye).divideScalar(dt);
      this.eyeVelocity.lerp(v.length() > 80 ? this.eyeVelocity : v, 1 - Math.exp(-8 * dt));
    }
    this.lastEye.copy(eye);
    for (const m of this.materials) {
      const u = m.uniforms;
      u.time.value = this.time;
      u.eye.value.copy(eye);
      u.wind.value.copy(wind);
      u.blown.value.copy(this.blown);
      u.fallen.value.copy(this.fallen);
      u.heavy.value = amount;
      u.eyeVelocity.value.copy(this.eyeVelocity);
      u.amount.value = amount;
    }
    for (const m of this.materials) m.visible = amount > 0.001;
  }
}
