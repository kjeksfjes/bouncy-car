import * as THREE from 'three';

/**
 * How far the fog fades instead of whitening (0..1, Stage.setWarmth sets it). At 0 the fog is
 * three.js's own: everything blends toward the fog colour with distance. At 1 distance mostly
 * drains the colour (desaturates) and only lifts it a little toward the haze, an aerial
 * perspective; the last stretch still blends fully into the fog colour, hiding the edge of the
 * streamed terrain against the sky.
 */
export const fogFade = { value: 0 };

/** How much of a faded colour's saturation is gone at the fog's far end, and how far it lifts toward the haze. */
const DESATURATE = 0.8;
const LIFT = 0.3;
/** Share of the fog range (from the far end) where it blends fully into the fog colour. */
const EDGE = 0.25;

/**
 * Installs the fading fog into every shader that uses three's fog chunks (built-in materials and
 * our own shader materials alike), sharing the one `fogFade` uniform. Call once, before anything
 * is rendered (Stage does, first thing in its constructor).
 *
 * This patches three.js internals; keep these in mind:
 * - It rewrites `THREE.ShaderChunk.fog_pars_fragment` and `fog_fragment` by string replacement,
 *   written against three r187. If an upgrade changes the replaced lines, it throws at startup
 *   (by design: no silent fallback to the plain fog). Re-read the two chunks in
 *   node_modules/three/src/renderers/shaders/ShaderChunk/ and adapt the replacements.
 * - The uniform reaches materials through a global `THREE.Material.prototype.onBeforeCompile`.
 *   A material that sets its own `onBeforeCompile` replaces it, and then its shader declares
 *   `fogFade` but never gets it (it reads as 0: plain fog). Such a material must add
 *   `shader.uniforms.fogFade = fogFade` itself. Nothing in the game sets one today.
 * - Only linear `THREE.Fog` is covered in practice; `FogExp2` shares the chunk and works too, but
 *   isn't used or tested.
 */
export function installFogFade(): void {
  THREE.ShaderChunk.fog_pars_fragment = THREE.ShaderChunk.fog_pars_fragment.replace(
    'uniform vec3 fogColor;',
    'uniform vec3 fogColor;\n\tuniform float fogFade;',
  );
  THREE.ShaderChunk.fog_fragment = THREE.ShaderChunk.fog_fragment.replace(
    'gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );',
    /* glsl */ `vec3 fogBase = gl_FragColor.rgb;
	float fogLuma = dot( fogBase, vec3( 0.299, 0.587, 0.114 ) );
	vec3 fogFaded = mix( fogBase, vec3( fogLuma ), fogFactor * ${DESATURATE.toFixed(3)} );
	fogFaded = mix( fogFaded, fogColor, fogFactor * ${LIFT.toFixed(3)} );
	fogFaded = mix( fogFaded, fogColor, smoothstep( ${(1 - EDGE).toFixed(3)}, 1.0, fogFactor ) );
	gl_FragColor.rgb = mix( mix( fogBase, fogColor, fogFactor ), fogFaded, fogFade );`,
  );
  if (!THREE.ShaderChunk.fog_fragment.includes('fogFade')) throw new Error('Fog fade: three.js fog chunk changed, patch did not apply');
  // Every material compiled from here on gets the shared uniform (their fog chunks now read it).
  THREE.Material.prototype.onBeforeCompile = (shader) => {
    shader.uniforms.fogFade = fogFade;
  };
}
