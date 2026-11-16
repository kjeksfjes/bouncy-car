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
/**
 * The ground as the ambient light sees it below the horizon (see bakeEnvironment): the light it
 * bounces up onto whatever faces down, the undersides of cars and crowns. In the snow (warmth 0) to
 * grass (1). Estimated as albedo / π × the light falling on the ground (the sun's 2.6 at ≈33° up,
 * plus roughly the sky's 0.75): snow (albedo ≈0.8) bounces about as much as the pale haze, grass
 * (≈0.2, greenish) far less.
 */
const GROUND_BOUNCE = { snow: '#c2c5ca', grass: '#596d4a' };
/**
 * Overcast, as when it snows (Stage.setOvercast): a flat grey-white sky, brightest overhead, that
 * the snowy ground's light bounces back into; the sun hidden, through thinning cloud first a pale
 * disc (`hazyDisc`) in a soft halo, its sharp disc, glow and flare coming back only as the cloud
 * clears; its light down to `sunLight` of its strength (no sharp shadows), more of the light from
 * the sky all round (the ambient × `ambient`); shadows softer (`shadowRadius`); the haze closing in
 * to `fogFar` of the view.
 */
const OVERCAST = {
  skyTop: '#c9d1da',
  horizon: '#dbe1e7',
  belowHorizon: '#cfd5dc',
  curve: 1.4,
  hazyDisc: 0.45,
  sunLight: 0.3,
  ambient: 1.6,
  shadowRadius: 8,
  fogFar: 0.55,
};
/** The renderer's exposure, looking anywhere but into the sun. */
const EXPOSURE = 1.05;
/**
 * Looking into the sun: the land and the car darken toward a silhouette against the bright sky,
 * as a camera exposing for the sky shows them (the sky isn't tone mapped, so it stays as it is).
 * The exposure drops by up to `depth`: fully with the sun within `inner` rad of the view's centre,
 * not at all past `outer` rad. It darkens over `darken` s and recovers over `recover` s (the time
 * to go two thirds of the way). Only while the terrain leaves the sun showing: checked along the
 * sun's direction from the camera out to `reach` m, `firstStep` m first, each step `stepGrowth`
 * times the last. Trees and the car itself don't count: around them the sky still glares.
 */
const GLARE = { depth: 0.45, inner: 0.17, outer: 0.8, darken: 0.25, recover: 0.6, reach: 2000, firstStep: 2, stepGrowth: 1.15 };
/** The sky gradient's curve in the snow: how quickly it turns from horizon to top colour (lower = sooner). */
const COOL_CURVE = 0.6;
/** The haze starts this far from the camera (m), so the car and the ground around it stay clear (see fogFade's HAZE). */
const HAZE_NEAR = 30;
/** Fog pushed out beyond anything the camera reaches (m): no haze at all (see setHaze). */
const CLEAR_AIR = 1e6;
/** The ambient light (baked from the sky) is re-baked when the warmth or overcast has moved this much. */
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
/** The sun light's strength, the ambient light's (baked from the sky), and the shadows' blur, in clear weather. */
const SUN_LIGHT = 2.6;
const AMBIENT = 0.75;
const SHADOW_RADIUS = 2;
const _warm = new THREE.Color();
const _view = new THREE.Vector3();
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
      glowColor: { value: SUN_GLOW_COLOR.clone() },
      sunDir: { value: SUN_DIR },
      curve: { value: COOL_CURVE },
      overcast: { value: 0 },
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
      uniform float overcast;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        // A curve under 1 rises steeply right above the horizon, which reads as a hard line;
        // the smoothstep eases it out of the horizon colour over the first ≈3.5°.
        float h = max(d.y, 0.0);
        vec3 col = mix(horizon, top, pow(h, curve) * smoothstep(0.0, 0.06, h));
        col = mix(col, below, smoothstep(0.0, -0.2, d.y));
        float s = max(dot(d, sunDir), 0.0);
        // The sun's disc; through thin cloud a pale, soft-edged disc in a halo instead; behind thick cloud nothing.
        float clear = 1.0 - overcast;
        float hazy = overcast * clear * 4.0;
        col += sunColor * pow(s, 900.0) * 3.0 * clear * clear * clear;
        col += sunColor * (smoothstep(0.99955, 0.9999, s) * ${OVERCAST.hazyDisc.toFixed(3)} + pow(s, 60.0) * 0.12) * hazy;
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
  private readonly flare: THREE.Object3D & { setStrength(k: number): void };
  /** The sky the ambient light is baked from, and the warmth it was last baked at. */
  private readonly envSky: THREE.Mesh;
  private bakedWarmth = 0;
  private bakedOvercast = 0;
  /** How overcast it is (0 clear .. 1 thick cloud: see setOvercast). */
  private overcast = 0;
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
    renderer.toneMappingExposure = EXPOSURE;
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

    // Image-based ambient light from the same sky gradient: cool fill in the shadows, and the
    // ground's bounce from below.
    this.envSky = makeSky(50);
    (this.envSky.material as THREE.ShaderMaterial).uniforms.below.value.set(GROUND_BOUNCE.snow);
    this.bakeEnvironment();
    this.scene.environmentIntensity = AMBIENT;

    const sun = new THREE.DirectionalLight(PALETTE.sun, SUN_LIGHT);
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
    sun.shadow.radius = SHADOW_RADIUS;
    this.scene.add(sun, sun.target);
    this.sun = sun;
    this.flare = createSunFlare(pixelRatio(), SUN_COLOR);
    this.setStrengths();
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
      const k = this.overcast;
      u.top.value.set(PALETTE.skyTop).lerp(_warm.set(WARM.skyTop), t).lerp(_warm.set(OVERCAST.skyTop), k);
      u.horizon.value.set(PALETTE.horizon).lerp(_warm.set(WARM.horizon), t).lerp(_warm.set(OVERCAST.horizon), k);
      u.below.value.set(PALETTE.belowHorizon).lerp(_warm.set(WARM.belowHorizon), t).lerp(_warm.set(OVERCAST.belowHorizon), k);
      u.curve.value = THREE.MathUtils.lerp(THREE.MathUtils.lerp(COOL_CURVE, WARM.curve, t), OVERCAST.curve, k);
      u.overcast.value = k;
    }
    // The ambient light sees the ground below the horizon, not the haze.
    (this.envSky.material as THREE.ShaderMaterial).uniforms.below.value.set(GROUND_BOUNCE.snow).lerp(_warm.set(GROUND_BOUNCE.grass), t);
    const fog = this.scene.fog as THREE.Fog;
    const sky = (this.sky.material as THREE.ShaderMaterial).uniforms;
    fog.color.copy(sky.horizon.value);
    // In output colour space, as three hands the fog its own colour (the haze mixes after it).
    sky.top.value.getRGB(fogSky.top.value, THREE.SRGBColorSpace);
    sky.below.value.getRGB(fogSky.below.value, THREE.SRGBColorSpace);
    fogSky.curve.value = sky.curve.value;
    fogFade.value = t;
    const k = this.overcast;
    const settled = (now: number, baked: number) => Math.abs(now - baked) < REBAKE_STEP && (now === baked || (now !== 0 && now !== 1));
    if (!settled(t, this.bakedWarmth) || !settled(k, this.bakedOvercast)) {
      this.bakedWarmth = t;
      this.bakedOvercast = k;
      this.bakeEnvironment();
    }
  }

  /**
   * How overcast it is, 0 (clear) .. 1 (thick cloud, as when it snows hard): see OVERCAST. Takes
   * effect in the sky's colours at the next setWarmth.
   */
  setOvercast(overcast: number): void {
    this.overcast = THREE.MathUtils.clamp(overcast, 0, 1);
    this.setStrengths();
  }

  /** The sun's light, glow, flare and shadows, and the haze, for how overcast it is. */
  private setStrengths(): void {
    const O = OVERCAST;
    const k = this.overcast;
    const clear = 1 - k;
    this.sun.intensity = SUN_LIGHT * THREE.MathUtils.lerp(1, O.sunLight, k);
    this.sun.shadow.radius = THREE.MathUtils.lerp(SHADOW_RADIUS, O.shadowRadius, k);
    this.scene.environmentIntensity = AMBIENT * THREE.MathUtils.lerp(1, O.ambient, k);
    this.flare.setStrength(clear * clear * clear);
    // The glow round the sun, in the sky and in the haze.
    (this.sky.material as THREE.ShaderMaterial).uniforms.glowColor.value.copy(SUN_GLOW_COLOR).multiplyScalar(clear * clear);
    fogSun.color.value.copy(SUN_GLOW_COLOR).multiplyScalar(clear * clear);
    const fog = this.scene.fog as THREE.Fog;
    if (fog.near !== CLEAR_AIR) fog.far = this.viewDistance * THREE.MathUtils.lerp(1, O.fogFar, k);
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
   * The first visible surface under `ndc` (−1..1 screen coordinates), or null where there is only
   * sky: written into `out`. One raycast through the whole scene: fine for a click, too slow for
   * every frame.
   */
  surfaceAt(ndc: THREE.Vector2, out: THREE.Vector3): THREE.Vector3 | null {
    this.raycaster.setFromCamera(ndc, this.camera);
    this.raycaster.far = this.camera.far;
    for (const hit of this.raycaster.intersectObject(this.scene, true)) {
      const o = hit.object;
      if (o === this.sky || !(o as THREE.Mesh).isMesh || !shown(o)) continue;
      return out.copy(hit.point);
    }
    return null;
  }

  /** Keeps the shadow frustum, the sky and the sun's flare centred on the action. Call after the camera moves. */
  /** Dev map view: off clears the haze, so the ground shows its own colours however high the camera is. */
  setHaze(on: boolean): void {
    const fog = this.scene.fog as THREE.Fog;
    fog.near = on ? HAZE_NEAR : CLEAR_AIR;
    fog.far = on ? this.viewDistance : CLEAR_AIR + 1;
    if (on) this.setStrengths();
  }

  follow(target: THREE.Vector3): void {
    this.sun.position.copy(target).addScaledVector(SUN_DIR, 150);
    this.sun.target.position.copy(target);
    this.sky.position.copy(this.camera.position);
    this.flare.position.copy(this.camera.position).addScaledVector(SUN_DIR, FLARE_DISTANCE);
  }

  /**
   * Darkens the exposure while the camera looks into the sun (see GLARE). Call after the camera moves.
   * @param dt real time (s)
   * @param groundAt the terrain's height at (x, z), which can hide the sun
   */
  expose(dt: number, groundAt: (x: number, z: number) => number): void {
    const G = GLARE;
    this.camera.getWorldDirection(_view);
    const toward = THREE.MathUtils.smoothstep(_view.dot(SUN_DIR), Math.cos(G.outer), Math.cos(G.inner));
    const into = toward > 0 && this.sunAbove(groundAt) ? toward : 0;
    // Behind cloud there's no sun to glare.
    const goal = EXPOSURE * (1 - G.depth * into * (1 - this.overcast));
    const now = this.renderer.toneMappingExposure;
    this.renderer.toneMappingExposure = goal + (now - goal) * Math.exp(-dt / (goal < now ? G.darken : G.recover));
  }

  /** Whether the sun stands above the terrain as seen from the camera (see GLARE). */
  private sunAbove(groundAt: (x: number, z: number) => number): boolean {
    const G = GLARE;
    const eye = this.camera.position;
    for (let d = G.firstStep; d <= G.reach; d *= G.stepGrowth) {
      if (groundAt(eye.x + SUN_DIR.x * d, eye.z + SUN_DIR.z * d) > eye.y + SUN_DIR.y * d) return false;
    }
    return true;
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
