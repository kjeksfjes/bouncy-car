import * as THREE from 'three';

/**
 * How far the haze drains colour as it lifts it (0..1, Stage.setWarmth sets it): none in the snow,
 * where lifting toward the pale haze is all it takes, `DESATURATE` in the grassland.
 */
export const fogFade = { value: 0 };
/** Direction toward the sun (world space) and its colour, for the haze's glow on the sun's side. */
export const fogSun = { dir: { value: new THREE.Vector3(0, 1, 0) }, color: { value: new THREE.Color(1, 1, 1) } };
/**
 * The sky's colours (top, below the horizon, and its curve; kept in step with the sky by Stage):
 * the fog's last stretch blends into the sky's own colour in each direction, so far hills melt into
 * the sky behind them, a little above or below the horizon line, instead of standing out as a
 * band of plain horizon colour.
 */
/**
 * How thick the haze is (Stage sets it, thicker as it snows): the distance it builds over (m, see
 * HAZE.scale) and how far toward full it gets (see HAZE.reach).
 */
export const fogThick = { scale: { value: 0 }, reach: { value: 0 } };
export const fogSky = { top: { value: new THREE.Color(1, 1, 1) }, below: { value: new THREE.Color(1, 1, 1) }, curve: { value: 1 } };

/**
 * Aerial perspective: distance lifts colours toward the pale haze gently, clear near the camera and
 * still showing the land's colours far off, then the last stretch blends fully into the sky to hide
 * the streamed terrain's edge. Feel values (after playtests: a haze that builds early, or hangs
 * thicker over valleys, made nearby ground look foggy and distant hills flat silhouettes).
 */
const HAZE = {
  /**
   * The haze builds with distance past the fog's near end (Stage) as reach × (1 − e^−(d/scale)^power):
   * slow near the car, then levelling off, in metres (not a share of the fog range), so it reads the
   * same however far the view reaches. About 0.1 at 100 m, 0.27 at 200 m, 0.5 at 400 m, 0.68 at 800 m.
   */
  scale: 300,
  power: 1.3,
  /** How hazy the far distance gets before the edge zone: short of full, so distant hills keep their colours. */
  reach: 0.7,
  /** Share of the fog range (from the far end) where it blends fully into the haze, hiding the streamed terrain's edge. */
  edge: 0.2,
  /** How much of the colour's saturation the haze drains at full strength, × fogFade. */
  desaturate: 0.35,
};

/**
 * The haze's glow toward the sun: sun colour × amount × (cos of the angle to the sun)^power. The
 * sky adds the same glow (Stage), so terrain melting into the sky meets it without an edge.
 */
export const SUN_GLOW = { amount: 0.28, power: 7 };

/**
 * Installs the haze into every shader that uses three's fog chunks (built-in materials and our own
 * shader materials alike), sharing the `fogFade` and `fogSun` uniforms. Call once, before anything
 * is rendered (Stage does, first thing in its constructor).
 *
 * This patches three.js internals; keep these in mind:
 * - It rewrites `THREE.ShaderChunk.fog_pars_vertex`, `fog_vertex`, `fog_pars_fragment` and
 *   `fog_fragment` by string replacement, written against three r187. If an upgrade changes the
 *   replaced lines, it throws at startup (by design: no silent fallback to the plain fog). Re-read
 *   the four chunks in node_modules/three/src/renderers/shaders/ShaderChunk/ and adapt.
 * - The haze uses the view-space position (`mvPosition`, which three's fog_vertex already relies
 *   on) and three's `viewMatrix` in the fragment shader, for distance and sun direction.
 * - The uniforms reach materials through a global `THREE.Material.prototype.onBeforeCompile`. A
 *   material that sets its own `onBeforeCompile` replaces it, and then its shader never gets them:
 *   such a material must call this one first (FarTerrain's does).
 * - Only linear `THREE.Fog` is supported: its near and far set where the haze starts and where
 *   everything is haze. `FogExp2` would leave fogNear/fogFar undeclared and fail to compile.
 */
export function installFogFade(): void {
  const H = HAZE;
  fogThick.scale.value = H.scale;
  fogThick.reach.value = H.reach;
  const replace = (chunk: keyof typeof THREE.ShaderChunk, from: string, to: string) => {
    const before = THREE.ShaderChunk[chunk];
    if (!before.includes(from)) throw new Error(`Fog haze: three.js ${chunk} changed, patch did not apply`);
    (THREE.ShaderChunk as Record<string, string>)[chunk] = before.replace(from, to);
  };
  replace('fog_pars_vertex', 'varying float vFogDepth;', 'varying float vFogDepth;\n\tvarying vec3 vFogPosition;');
  replace('fog_vertex', 'vFogDepth = - mvPosition.z;', 'vFogDepth = - mvPosition.z;\n\tvFogPosition = mvPosition.xyz;');
  replace(
    'fog_pars_fragment',
    'uniform vec3 fogColor;',
    'uniform vec3 fogColor;\n\tuniform float fogScale;\n\tuniform float fogReach;\n\tuniform float fogFade;\n\tuniform vec3 fogSunDir;\n\tuniform vec3 fogSunColor;\n\tuniform vec3 fogSkyTop;\n\tuniform vec3 fogSkyBelow;\n\tuniform float fogSkyCurve;\n\tvarying vec3 vFogPosition;',
  );
  replace(
    'fog_fragment',
    'float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );',
    /* glsl */ `float fogDistance = length( vFogPosition );
		float fogEdgeStart = fogFar * ${(1 - H.edge).toFixed(3)};
		float fogBuilt = max( fogDistance - fogNear, 0.0 ) / fogScale;
		float fogFactor = fogReach * ( 1.0 - exp( - pow( fogBuilt, ${H.power.toFixed(2)} ) ) );
		float fogEdge = smoothstep( fogEdgeStart, fogFar, fogDistance );
		fogFactor = max( fogFactor, fogEdge );`,
  );
  replace(
    'fog_fragment',
    'gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );',
    /* glsl */ `vec3 fogWorldDir = normalize( vFogPosition * mat3( viewMatrix ) );
	float fogSun = max( dot( fogWorldDir, fogSunDir ), 0.0 );
	// Toward the fog's end, the sky's own colour in this direction (as Stage's sky shader mixes it).
	float fogUp = max( fogWorldDir.y, 0.0 );
	vec3 fogSkyColor = mix( fogColor, fogSkyTop, pow( fogUp, fogSkyCurve ) * smoothstep( 0.0, 0.06, fogUp ) );
	fogSkyColor = mix( fogSkyColor, fogSkyBelow, smoothstep( 0.0, -0.2, fogWorldDir.y ) );
	vec3 fogHaze = mix( fogColor, fogSkyColor, fogEdge ) + fogSunColor * pow( fogSun, ${SUN_GLOW.power.toFixed(1)} ) * ${SUN_GLOW.amount.toFixed(3)};
	float fogLuma = dot( gl_FragColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
	vec3 fogDrained = mix( gl_FragColor.rgb, vec3( fogLuma ), fogFactor * fogFade * ${H.desaturate.toFixed(3)} );
	gl_FragColor.rgb = mix( fogDrained, fogHaze, fogFactor );`,
  );
  // Every material compiled from here on gets the shared uniforms (their fog chunks now read them).
  THREE.Material.prototype.onBeforeCompile = (shader) => {
    shader.uniforms.fogFade = fogFade;
    shader.uniforms.fogScale = fogThick.scale;
    shader.uniforms.fogReach = fogThick.reach;
    shader.uniforms.fogSunDir = fogSun.dir;
    shader.uniforms.fogSunColor = fogSun.color;
    shader.uniforms.fogSkyTop = fogSky.top;
    shader.uniforms.fogSkyBelow = fogSky.below;
    shader.uniforms.fogSkyCurve = fogSky.curve;
  };
}
