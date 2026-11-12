import * as THREE from 'three';
import { fogFade, fogSky, fogSun, installFogFade, SUN_GLOW } from './fogFade';
import { createSunFlare } from './sunFlare';

const PALETTE = {
  skyTop: '#4a7fc1',
  horizon: '#d6e2ee',
  belowHorizon: '#c4d2e0',
  sun: '#fff0d9',
};

/**
 * The summer end of the atmosphere (Stage.setWarmth): a deeper blue that comes in lower (a
 * steeper gradient `curve`), above a light blue haze that gives distant hills a bluish aerial
 * perspective. Keep the horizon pale and bluish:
 * most of a normal view is horizon colour, and the fog takes it too, so a cream horizon turns the
 * scene sepia and a neutral one reads as overcast.
 */
const WARM = {
  skyTop: '#3f80d0',
  horizon: '#d2e2ee',
  belowHorizon: '#c6d6df',
  curve: 0.4,
};
/** The sky gradient's curve in the snow: how quickly it turns from horizon to top colour (lower = sooner). */
const COOL_CURVE = 0.6;
/** The haze starts this far from the camera (m), so the car and the ground around it stay clear (see fogFade's HAZE). */
const HAZE_NEAR = 30;
/** The ambient light (baked from the sky) is re-baked when the warmth has moved this much. */
const REBAKE_STEP = 0.1;

/** Colour of sunlight (the sun light, its disc in the sky, glints and flares). */
export const SUN_COLOR = new THREE.Color(PALETTE.sun);

/** Device pixels per CSS pixel the renderer draws at (capped for fill rate). */
export const pixelRatio = () => Math.min(window.devicePixelRatio, 2);

/** Direction *towards* the sun: right-front, fairly low for long shadows. */
export const SUN_DIR = new THREE.Vector3(0.6, 0.55, -0.45).normalize();

/**
 * The sun's colour encoded for output (sRGB). The haze's sun glow is added after the colour-space
 * conversion, both in the fog (three applies fog in output space) and in the sky, so they match.
 */
const SUN_GLOW_COLOR = (() => {
  const c = { r: 0, g: 0, b: 0 };
  SUN_COLOR.getRGB(c, THREE.SRGBColorSpace);
  return new THREE.Color().setRGB(c.r, c.g, c.b, THREE.LinearSRGBColorSpace);
})();

const SHADOW_EXTENT = 45;
const _warm = new THREE.Color();
/** The lens flare's anchor sits this far from the camera toward the sun: inside the sky dome and the far plane. */
const FLARE_DISTANCE = 800;

function makeSky(radius: number): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    // Untonemapped so the horizon matches the fog colour exactly (fog is applied post-tonemap).
    toneMapped: false,
    uniforms: {
      top: { value: new THREE.Color(PALETTE.skyTop) },
      horizon: { value: new THREE.Color(PALETTE.horizon) },
      below: { value: new THREE.Color(PALETTE.belowHorizon) },
      sunColor: { value: new THREE.Color(PALETTE.sun) },
      glowColor: { value: SUN_GLOW_COLOR },
      sunDir: { value: SUN_DIR },
      curve: { value: COOL_CURVE },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 top;
      uniform vec3 horizon;
      uniform vec3 below;
      uniform vec3 sunColor;
      uniform vec3 glowColor;
      uniform vec3 sunDir;
      uniform float curve;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        // A curve under 1 rises steeply right above the horizon, which reads as a hard line;
        // the smoothstep eases it out of the horizon colour over the first ≈3.5°.
        float h = max(d.y, 0.0);
        vec3 col = mix(horizon, top, pow(h, curve) * smoothstep(0.0, 0.06, h));
        col = mix(col, below, smoothstep(0.0, -0.2, d.y));
        float s = max(dot(d, sunDir), 0.0);
        col += sunColor * pow(s, 900.0) * 3.0;
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
        // The glow around the sun, in output space like the haze's (see SUN_GLOW_COLOR).
        gl_FragColor.rgb += glowColor * pow(s, ${SUN_GLOW.power.toFixed(1)}) * ${SUN_GLOW.amount.toFixed(3)};
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), material);
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  return mesh;
}

const _forward = new THREE.Vector3();

/** Whether `object` and everything it hangs from are shown. */
function shown(object: THREE.Object3D): boolean {
  for (let o: THREE.Object3D | null = object; o; o = o.parent) if (!o.visible) return false;
  return true;
}

/** Renderer, scene, camera and lighting. */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** Fog end: nothing further from the camera than this is visible (the far view reaches past it: see FarTerrain). */
  readonly viewDistance = 1000;
  private readonly sun: THREE.DirectionalLight;
  private readonly sky: THREE.Mesh;
  private readonly flare: THREE.Object3D;
  /** The sky the ambient light is baked from, and the warmth it was last baked at. */
  private readonly envSky: THREE.Mesh;
  private bakedWarmth = 0;
  /** Bound only while compiling shaders for render targets (see compileForTargets). */
  private readonly compileTarget = new THREE.WebGLRenderTarget(1, 1);
  private readonly raycaster = new THREE.Raycaster();

  constructor(container: HTMLElement) {
    installFogFade();
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(pixelRatio());
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1500);

    // Fog far must stay inside the far view's reach (see FarTerrain).
    this.scene.fog = new THREE.Fog(PALETTE.horizon, HAZE_NEAR, this.viewDistance);
    fogSun.dir.value.copy(SUN_DIR);
    fogSun.color.value.copy(SUN_GLOW_COLOR);
    _warm.set(PALETTE.skyTop).getRGB(fogSky.top.value, THREE.SRGBColorSpace);
    _warm.set(PALETTE.belowHorizon).getRGB(fogSky.below.value, THREE.SRGBColorSpace);
    fogSky.curve.value = COOL_CURVE;
    this.sky = makeSky(900);
    this.scene.add(this.sky);

    // Image-based ambient light from the same sky gradient: cool fill in the shadows.
    this.envSky = makeSky(50);
    this.bakeEnvironment();
    this.scene.environmentIntensity = 0.75;

    const sun = new THREE.DirectionalLight(PALETTE.sun, 2.6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const cam = sun.shadow.camera;
    cam.left = -SHADOW_EXTENT;
    cam.right = SHADOW_EXTENT;
    cam.top = SHADOW_EXTENT;
    cam.bottom = -SHADOW_EXTENT;
    cam.near = 1;
    cam.far = 300;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    sun.shadow.radius = 2;
    this.scene.add(sun, sun.target);
    this.sun = sun;
    this.flare = createSunFlare(pixelRatio(), SUN_COLOR);
    this.scene.add(this.flare);

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  /**
   * Shifts the sky, horizon and fog from wintry (0) toward summer (1), keeping the fog matched to
   * the horizon; in summer the haze also drains distant colours a little (see fogFade).
   * Re-bakes the ambient light now and then (it costs a few ms).
   */
  setWarmth(warmth: number): void {
    const t = THREE.MathUtils.clamp(warmth, 0, 1);
    for (const sky of [this.sky, this.envSky]) {
      const u = (sky.material as THREE.ShaderMaterial).uniforms;
      u.top.value.set(PALETTE.skyTop).lerp(_warm.set(WARM.skyTop), t);
      u.horizon.value.set(PALETTE.horizon).lerp(_warm.set(WARM.horizon), t);
      u.below.value.set(PALETTE.belowHorizon).lerp(_warm.set(WARM.belowHorizon), t);
      u.curve.value = THREE.MathUtils.lerp(COOL_CURVE, WARM.curve, t);
    }
    const fog = this.scene.fog as THREE.Fog;
    const sky = (this.sky.material as THREE.ShaderMaterial).uniforms;
    fog.color.copy(sky.horizon.value);
    // In output colour space, as three hands the fog its own colour (the haze mixes after it).
    sky.top.value.getRGB(fogSky.top.value, THREE.SRGBColorSpace);
    sky.below.value.getRGB(fogSky.below.value, THREE.SRGBColorSpace);
    fogSky.curve.value = sky.curve.value;
    fogFade.value = t;
    if (Math.abs(t - this.bakedWarmth) >= REBAKE_STEP || (t !== this.bakedWarmth && (t === 0 || t === 1))) {
      this.bakedWarmth = t;
      this.bakeEnvironment();
    }
  }

  private bakeEnvironment(): void {
    const envScene = new THREE.Scene();
    envScene.add(this.envSky);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const old = this.scene.environment;
    this.scene.environment = pmrem.fromScene(envScene, 0.04).texture;
    old?.dispose();
    pmrem.dispose();
  }

  /**
   * How far in front of the camera (along its view, m) the first visible surface under `ndc`
   * (−1..1 screen coordinates) lies, or null where there is only sky. One raycast through the
   * whole scene: fine for a click, too slow for every frame.
   */
  depthAt(ndc: THREE.Vector2): number | null {
    this.raycaster.setFromCamera(ndc, this.camera);
    this.raycaster.far = this.camera.far;
    this.camera.getWorldDirection(_forward);
    for (const hit of this.raycaster.intersectObject(this.scene, true)) {
      const o = hit.object;
      if (o === this.sky || !(o as THREE.Mesh).isMesh || !shown(o)) continue;
      return hit.point.sub(this.camera.position).dot(_forward);
    }
    return null;
  }

  /** Keeps the shadow frustum, the sky and the sun's flare centred on the action. Call after the camera moves. */
  follow(target: THREE.Vector3): void {
    this.sun.position.copy(target).addScaledVector(SUN_DIR, 150);
    this.sun.target.position.copy(target);
    this.sky.position.copy(this.camera.position);
    this.flare.position.copy(this.camera.position).addScaledVector(SUN_DIR, FLARE_DISTANCE);
  }

  render(): void {
    const programs = this.programCount();
    this.renderer.render(this.scene, this.camera);
    // Something new on screen just compiled its shaders; compile its render-target versions now
    // too (see compileForTargets), in this already slow frame, rather than in a crash later.
    if (this.programCount() > programs) this.compileForTargets();
  }

  private programCount(): number {
    return this.renderer.info.programs?.length ?? 0;
  }

  /**
   * Compiles the shaders of everything in the scene for drawing into a render target, as the
   * glass's transmission pass does (it draws the scene behind see-through glass, in linear colour),
   * so the first shattered window near something new doesn't stall compiling them.
   */
  private compileForTargets(): void {
    this.renderer.setRenderTarget(this.compileTarget);
    this.renderer.compile(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
  }

  /**
   * Compiles the shaders of everything in the scene (on screen or not), plus `extra` objects that
   * only show up later (put in the scene just for this), for the screen and for render targets,
   * so they don't compile mid-game in a visible hitch.
   */
  warmUp(extra: THREE.Object3D[]): void {
    const group = new THREE.Group();
    group.add(...extra);
    this.scene.add(group);
    this.renderer.compile(this.scene, this.camera);
    this.compileForTargets();
    this.scene.remove(group);
  }
}
