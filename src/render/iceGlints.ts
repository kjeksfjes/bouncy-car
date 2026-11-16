import * as THREE from 'three';
import { GRAVITY } from '../constants';
import { SUN_COLOR, SUN_DIR } from './stage';

/**
 * Ice crystals in thrown-up snow: tiny flat plates, each a mirror. One shows only when it tilts so
 * that it throws the sun into the eye, a brief flash as it tumbles, and is invisible between
 * (they're what makes snow glitter). Drawn bigger than real crystals (a few mm) so a flash reads
 * from the chase camera: `size` (min..max, m) across. They hang in the air with the powder
 * (`gravity` of world gravity, `drag` 1/s), tumbling at `spin` (min..max, rad/s), for `life`
 * (min..max) s, the last `fade` of it fading. A flash is `sharp` narrow (the power on how well the
 * mirror lines up with the sun: higher is briefer and rarer), at its strongest (`peak` opaque)
 * from `full` of a perfect line-up. On a screen a flash can't outshine white snow, so it shows as a spot painted
 * over it, not light added: white for some crystals, and for `fire` of them a colour, as ice splits
 * the sun like a prism: a rainbow hue (`hues`, min..max on the colour wheel, red 0 to blue ≈0.65;
 * never the purples and pinks past it, which no prism makes), `saturation` strong. A crystal
 * nearer the camera than `near` (min..max, m) fades out, so none shows its shape up close.
 */
const ICE = {
  capacity: 3000,
  size: [0.04, 0.07] as const,
  gravity: 0.015,
  drag: 1.4,
  spin: [4, 12] as const,
  life: [2.2, 4.4] as const,
  fade: 0.3,
  sharp: 30,
  full: 0.5,
  fire: 0.4,
  hues: [0, 0.62] as const,
  saturation: 0.3,
  near: [2.5, 6] as const,
  peak: 0.7,
};

const VERTEX = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorld;
  varying vec3 vColor;
  void main() {
    vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * vec3(0.0, 1.0, 0.0));
    vColor = instanceColor;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 sunDir;
  uniform float sharp;
  uniform float full;
  varying vec3 vNormal;
  varying vec3 vWorld;
  varying vec3 vColor;
  uniform vec2 near;
  uniform float peak;
  void main() {
    vec3 toEye = normalize(cameraPosition - vWorld);
    // Either face mirrors.
    vec3 n = faceforward(vNormal, -toEye, vNormal);
    float lined = max(dot(reflect(-toEye, n), sunDir), 0.0);
    // The instance colour is the flash's colour times its fade.
    float strength = max(vColor.r, max(vColor.g, vColor.b));
    float flash = peak * min(1.0, pow(lined, sharp) / full) * strength * smoothstep(near.x, near.y, distance(cameraPosition, vWorld));
    if (flash < 0.01) discard;
    gl_FragColor = vec4(vColor / strength, flash);
    #include <colorspace_fragment>
  }
`;

interface Crystal {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  rotation: THREE.Quaternion;
  axis: THREE.Vector3;
  spin: number;
  size: number;
  age: number;
  life: number;
  /** The colour it flashes. */
  color: THREE.Color;
}

const between = (range: readonly [number, number]) => range[0] + Math.random() * (range[1] - range[0]);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

/** Glittering ice crystals in the snow cars throw up (see ICE). One instanced draw call. */
export class IceGlints {
  private readonly mesh: THREE.InstancedMesh;
  private readonly crystals: Crystal[] = [];

  constructor(scene: THREE.Scene) {
    // A hexagonal plate, 1 m across, lying flat (its faces ±y).
    const plate = new THREE.CircleGeometry(0.5, 6).rotateX(-Math.PI / 2);
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        sunDir: { value: SUN_DIR },
        sharp: { value: ICE.sharp },
        full: { value: ICE.full },
        near: { value: new THREE.Vector2(...ICE.near) },
        peak: { value: ICE.peak },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.mesh = new THREE.InstancedMesh(plate, material, ICE.capacity);
    this.mesh.setColorAt(0, _c.setRGB(1, 1, 1)); // allocates instanceColor: the flash's colour times its fade
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  /** `count` crystals from `at`, flying with `velocity` give or take a little. */
  emit(at: THREE.Vector3, velocity: THREE.Vector3, count: number): void {
    for (let i = 0; i < count; i++) {
      if (this.crystals.length >= ICE.capacity) this.crystals.shift();
      this.crystals.push({
        position: at.clone(),
        velocity: velocity.clone().add(_s.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(1.5)),
        rotation: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3)),
        axis: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
        spin: between(ICE.spin),
        size: between(ICE.size),
        age: 0,
        life: between(ICE.life),
        color: Math.random() < ICE.fire ? new THREE.Color().setHSL(between(ICE.hues), ICE.saturation, 0.6) : SUN_COLOR.clone(),
      });
    }
  }

  update(dt: number): void {
    const g = GRAVITY * ICE.gravity * dt;
    const keep = Math.exp(-ICE.drag * dt);
    let n = 0;
    for (const c of this.crystals) {
      c.age += dt;
      if (c.age >= c.life) continue;
      c.velocity.multiplyScalar(keep);
      c.velocity.y -= g;
      c.position.addScaledVector(c.velocity, dt);
      c.rotation.multiply(_q.setFromAxisAngle(c.axis, c.spin * dt));
      this.mesh.setMatrixAt(n, _m.compose(c.position, c.rotation, _s.setScalar(c.size)));
      const fade = Math.min(1, (c.life - c.age) / (c.life * ICE.fade));
      this.mesh.setColorAt(n, _c.copy(c.color).multiplyScalar(fade));
      this.crystals[n++] = c;
    }
    this.crystals.length = n;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }
}
