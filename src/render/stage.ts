import * as THREE from 'three';

const PALETTE = {
  skyTop: '#4a7fc1',
  horizon: '#d6e2ee',
  belowHorizon: '#c4d2e0',
  sun: '#fff0d9',
};

/** Direction *towards* the sun: right-front, fairly low for long shadows. */
export const SUN_DIR = new THREE.Vector3(0.6, 0.55, -0.45).normalize();

const SHADOW_EXTENT = 45;

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
      sunDir: { value: SUN_DIR },
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
      uniform vec3 sunDir;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = mix(horizon, top, pow(max(d.y, 0.0), 0.6));
        col = mix(col, below, smoothstep(0.0, -0.2, d.y));
        float s = max(dot(d, sunDir), 0.0);
        col += sunColor * (pow(s, 900.0) * 3.0 + pow(s, 10.0) * 0.18);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), material);
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  return mesh;
}

/** Renderer, scene, camera and lighting. */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** Fog end: nothing further from the camera than this is visible. */
  readonly viewDistance = 250;
  private readonly sun: THREE.DirectionalLight;
  private readonly sky: THREE.Mesh;

  constructor(container: HTMLElement) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1500);

    // Fog far must stay inside the streamed terrain radius (see LOAD_RADIUS).
    this.scene.fog = new THREE.Fog(PALETTE.horizon, 60, this.viewDistance);
    this.sky = makeSky(900);
    this.scene.add(this.sky);

    // Image-based ambient light from the same sky gradient: cool fill in the shadows.
    const envScene = new THREE.Scene();
    envScene.add(makeSky(50));
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(envScene, 0.04).texture;
    this.scene.environmentIntensity = 0.75;
    pmrem.dispose();

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

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  /** Keeps the shadow frustum and sky centred on the action. */
  follow(target: THREE.Vector3): void {
    this.sun.position.copy(target).addScaledVector(SUN_DIR, 150);
    this.sun.target.position.copy(target);
    this.sky.position.copy(this.camera.position);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}
