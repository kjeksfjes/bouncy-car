import * as THREE from 'three';
import type { CarPiece } from './carModel';

/** Paint wear feel values (part of the car's damage config). */
export interface WearTuning {
  /** Chips laid round a hit, per m/s of Δv over toughness (1 = as chipped as it gets), and their reach (× dentRadius). */
  chipPerDv: number;
  chipReach: number;
  /** Scratches from the body dragging along something: per metre slid, and their reach (m, round each contact). */
  scratchPerMetre: number;
  scratchReach: number;
  /** Slower than this (m/s) a contact doesn't scratch. */
  scratchFrom: number;
  /** Scratches close round a hit, per m/s of Δv over toughness, and their reach (m). */
  scratchPerDv: number;
  scratchHitReach: number;
  /**
   * Chips and scratches from a hit on soft ground, as a share of the same hit on something hard
   * (rock, stony ground, a tree, a boulder, a car). Grass also stands for dirt.
   */
  softHitChips: { snow: number; grass: number };
  softHitScratches: { snow: number; grass: number };
}

/**
 * How the wear looks, in the paint's shader. Patterns are laid out in metres on the panel's rest
 * shape, so they stay put as the panel crumples. Feel values.
 */
const LOOK = {
  /**
   * Chips: each cell of a grid (cells per metre) may hold one chip, at a random spot, the more
   * often the more worn the paint (`…Density` × wear^`…Power`, so big chips come later than
   * specks). Sizes are random, mostly small (radius `chipMin`..`chipMax` of a cell, cubed toward
   * the small end), growing by up to `chipGrow` with wear. Specks only go down to the primer; a
   * big chip shows bare metal inside a primer border `chipRing` (of a cell) wide.
   */
  flakeScale: 9,
  flakeDensity: 0.75,
  flakePower: 1.6,
  speckScale: 30,
  speckDensity: 0.9,
  speckPower: 0.8,
  chipMin: 0.06,
  chipMax: 0.34,
  chipGrow: 0.6,
  chipRing: 0.1,
  /** Chip edges fray by this share of their radius (noise at 2.7 per cell). */
  chipFray: 0.3,
  /**
   * Gouges: where the paint is scratched (fully by `gougeFrom` of scratch wear), chips are drawn
   * out `gougeStretch` times along the scratches, their tails tapering by up to `gougeTaper`.
   */
  gougeFrom: 0.3,
  gougeStretch: 4,
  gougeTaper: 0.6,
  /**
   * Creases: a face turned from its rest direction by more than acos(1 − creaseFrom) (≈16°) starts
   * chipping, up to `creaseWear` by acos(1 − creaseTo) (≈46°): folds crack the paint even where nothing touched it.
   */
  creaseFrom: 0.04,
  creaseTo: 0.3,
  /** How chipped a crease gets at most on its own (a hit there adds to it). */
  creaseWear: 0.55,
  /** Scratch lines: noise stretched along the slide (features per metre across the lines and along them). */
  scratchAcross: 60,
  scratchAlong: 3,
  /** Half width of a line (in that noise) at full scratching; the deepest middle shows bare metal. */
  scratchWidth: 0.07,
  /**
   * Of those lines, only stretches show as scratches: where slower noise (× `segmentAcross` and
   * `segmentAlong` of the line noise's scale) passes `segmentFrom`, lowered by `segmentSpread` × wear.
   */
  segmentAcross: 0.12,
  segmentAlong: 0.6,
  segmentFrom: 0.55,
  segmentSpread: 0.45,
  /** How much a scratched coat lightens toward white, and how rough it turns. */
  scratchLighten: 0.5,
  scratchRoughness: 0.8,
};

const PRIMER = new THREE.Color('#8e8b85');
const METAL = new THREE.Color('#878c91');

/**
 * Gives a body piece's geometry the wear attributes the paint shader reads: its rest shape (for
 * creases and to pin the patterns), wear (chips, scratches; 0..1 each) and the scratches'
 * direction (geometry-local, unnormalised, sign-free). `rest` is shared, not copied: keep it unchanged.
 */
export function addWearAttributes(geometry: THREE.BufferGeometry, rest: Float32Array): void {
  const n = rest.length / 3;
  geometry.setAttribute('aRest', new THREE.BufferAttribute(rest, 3));
  geometry.setAttribute('aWear', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  geometry.setAttribute('aScrape', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
}

const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

/**
 * Wears the paint of every closed piece near `point` (car-local), falling off smoothly over
 * `radius`: `chip` and `scratch` are added (each capped at 1); scratches run along `dir`
 * (car-local, unit). Pieces are unrotated children of the car root, like for applyDent.
 */
export function wearPaint(
  pieces: CarPiece[],
  point: THREE.Vector3,
  radius: number,
  chip: number,
  scratch: number,
  dir?: THREE.Vector3,
): void {
  for (const piece of pieces) {
    if (piece.glass || piece.rides || piece.state !== 'closed' || piece.bounds.distanceToPoint(point) > radius) continue;
    const geometry = piece.mesh.geometry;
    const wear = geometry.getAttribute('aWear') as THREE.BufferAttribute | undefined;
    if (!wear) continue;
    const scrape = geometry.getAttribute('aScrape') as THREE.BufferAttribute;
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    const offset = piece.mesh.position;
    let changed = false;
    for (let i = 0; i < pos.count; i++) {
      const d = _v.fromBufferAttribute(pos, i).add(offset).distanceTo(point);
      if (d >= radius) continue;
      const f = (1 - d / radius) ** 2;
      wear.setXY(i, Math.min(1, wear.getX(i) + chip * f), Math.min(1, wear.getY(i) + scratch * f));
      if (dir && scratch > 0) {
        // Lines have no sign: add the direction the way that agrees with what's there.
        _s.fromBufferAttribute(scrape, i);
        _s.addScaledVector(dir, (_s.dot(dir) < 0 ? -1 : 1) * scratch * f);
        scrape.setXYZ(i, _s.x, _s.y, _s.z);
      }
      changed = true;
    }
    if (changed) {
      wear.needsUpdate = true;
      scrape.needsUpdate = true;
    }
  }
}

/**
 * Makes a paint material draw wear: chips (a primer ring round bare metal) where the attributes
 * say or where a face has creased away from its rest direction, and fine scratch lines along the
 * scrape direction. Geometry without the attributes reads them as zero and shows clean paint.
 * Chains to the global onBeforeCompile (the fog haze's uniforms, see fogFade).
 */
export function paintWithWear(material: THREE.MeshStandardMaterial): void {
  const L = LOOK;
  const f = (x: number) => x.toFixed(4);
  material.customProgramCacheKey = () => 'paint-wear';
  material.onBeforeCompile = (shader, renderer) => {
    THREE.Material.prototype.onBeforeCompile.call(material, shader, renderer);
    shader.uniforms.wearPrimer = { value: PRIMER };
    shader.uniforms.wearMetal = { value: METAL };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec3 aRest;
attribute vec2 aWear;
attribute vec3 aScrape;
varying vec3 vWearRest;
varying vec3 vWearNow;
varying vec2 vWear;
varying vec3 vWearScrape;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vWearRest = aRest;
vWearNow = transformed;
vWear = aWear;
vWearScrape = aScrape;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 wearPrimer;
uniform vec3 wearMetal;
varying vec3 vWearRest;
varying vec3 vWearNow;
varying vec2 vWear;
varying vec3 vWearScrape;
#define CHIP_MIN ${f(L.chipMin)}
#define CHIP_MAX ${f(L.chipMax)}
${WEAR_GLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
// Paint wear: 0..1 shares of this fragment that show primer, bare metal and scratched coat.
float wearPrimerAmt = 0.0;
float wearMetalAmt = 0.0;
float wearScratchAmt = 0.0;
{
  vec3 restFace = cross( dFdx( vWearRest ), dFdy( vWearRest ) );
  vec3 nowFace = cross( dFdx( vWearNow ), dFdy( vWearNow ) );
  // How far this face has turned from its rest direction (1 - cos of the angle; 0 = not at all), for creases.
  float turned = length( restFace ) > 1e-12 && length( nowFace ) > 1e-12 ? 1.0 - abs( dot( normalize( restFace ), normalize( nowFace ) ) ) : 0.0;
  float chips = clamp( vWear.x + ${f(L.creaseWear)} * smoothstep( ${f(L.creaseFrom)}, ${f(L.creaseTo)}, turned ), 0.0, 1.0 );
  if ( chips > 0.001 ) {
    float grow = 1.0 + ${f(L.chipGrow)} * chips;
    // Where the paint was scratched, chips are gouges: drawn out along the scratches (the grid
    // squashed along them, so its round chips come out long) with a tapering tail.
    float scraped = length( vWearScrape ) > 1e-5 ? smoothstep( 0.0, ${f(L.gougeFrom)}, vWear.y ) : 0.0;
    vec3 along = scraped > 0.0 ? normalize( vWearScrape ) : vec3( 0.0 );
    float squash = 1.0 / ( 1.0 + ( ${f(L.gougeStretch)} - 1.0 ) * scraped ) - 1.0;
    vec3 gougeAt = vWearRest + along * dot( vWearRest, along ) * squash;
    float taper = ${f(L.gougeTaper)} * scraped;
    vec3 flakeAt = gougeAt * ${f(L.flakeScale)};
    vec3 speckAt = gougeAt * ${f(L.speckScale)} + 5.3;
    vec2 flake = wearChipField( flakeAt, ${f(L.flakeDensity)} * pow( chips, ${f(L.flakePower)} ), grow, ${f(L.chipRing)}, along, taper );
    vec2 speck = wearChipField( speckAt, ${f(L.speckDensity)} * pow( chips, ${f(L.speckPower)} ), grow, 1.0, along, taper );
    flake *= 1.0 + ${f(L.chipFray)} * wearNoise( flakeAt * 2.7 );
    speck.x *= 1.0 + ${f(L.chipFray)} * wearNoise( speckAt * 2.7 );
    float inPrimer = min( flake.x, speck.x );
    float aa = fwidth( inPrimer ) + 1e-4;
    float aaMetal = fwidth( flake.y ) + 1e-4;
    wearMetalAmt = 1.0 - smoothstep( 1.0 - aaMetal, 1.0 + aaMetal, flake.y );
    wearPrimerAmt = max( 0.0, 1.0 - smoothstep( 1.0 - aa, 1.0 + aa, inPrimer ) - wearMetalAmt );
  }
  float scratch = vWear.y;
  float dirLength = length( vWearScrape );
  if ( scratch > 0.001 && dirLength > 1e-5 && length( restFace ) > 1e-12 ) {
    vec3 faceN = normalize( restFace );
    vec3 along = vWearScrape / dirLength;
    along = normalize( along - faceN * dot( along, faceN ) + 1e-6 );
    vec3 across = cross( faceN, along );
    vec3 q = vec3( dot( vWearRest, across ) * ${f(L.scratchAcross)}, dot( vWearRest, along ) * ${f(L.scratchAlong)}, dot( vWearRest, faceN ) * 4.0 );
    float line = abs( wearNoise( q ) );
    // Only stretches of the lines show, as separate scratches: more of them the more it's scratched.
    float from = ${f(L.segmentFrom)} - ${f(L.segmentSpread)} * scratch;
    float segment = smoothstep( from, from + 0.1, wearNoise( vec3( q.x * ${f(L.segmentAcross)}, q.y * ${f(L.segmentAlong)}, q.z ) + 23.0 ) );
    float width = ${f(L.scratchWidth)} * ( 0.5 + 0.5 * scratch );
    // Lines finer than a pixel blur into a faint scuff instead of shimmering.
    float pixel = fwidth( q.x );
    float sharp = clamp( 1.5 - pixel, 0.0, 1.0 );
    float aa = fwidth( line ) + 1e-4;
    float lines = ( 1.0 - smoothstep( width - aa, width + aa, line ) ) * segment;
    wearScratchAmt = mix( width * 3.0 * segment, lines, sharp );
    wearMetalAmt = max( wearMetalAmt, ( 1.0 - smoothstep( width * 0.35 - aa, width * 0.35 + aa, line ) ) * segment * smoothstep( 0.6, 1.0, scratch ) * sharp );
  }
  wearScratchAmt = clamp( wearScratchAmt - wearMetalAmt - wearPrimerAmt, 0.0, 1.0 );
  diffuseColor.rgb = mix( diffuseColor.rgb, mix( diffuseColor.rgb, vec3( 1.0 ), ${f(L.scratchLighten)} ), wearScratchAmt );
  diffuseColor.rgb = mix( diffuseColor.rgb, wearPrimer, wearPrimerAmt );
  diffuseColor.rgb = mix( diffuseColor.rgb, wearMetal, wearMetalAmt );
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = mix( roughnessFactor, ${f(L.scratchRoughness)}, wearScratchAmt + wearPrimerAmt );
roughnessFactor = mix( roughnessFactor, 0.5, wearMetalAmt );`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
metalnessFactor = mix( metalnessFactor, 0.0, wearPrimerAmt );
metalnessFactor = mix( metalnessFactor, 0.5, wearMetalAmt );`,
      );
  };
}

/**
 * The wear shader's helpers: a hash, the chip field, and 3D simplex noise (≈ −1..1) from Ashima
 * Arts / Stefan Gustavson's webgl-noise (MIT licence, https://github.com/ashima/webgl-noise),
 * renamed to keep clear of other shader code.
 */
const WEAR_GLSL = /* glsl */ `
// Hash (Dave Hoskins, "Hash without Sine", MIT licence, https://www.shadertoy.com/view/4djSRW).
float wearHash( vec3 p ) {
  p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
  p += dot( p, p.yxz + 33.33 );
  return fract( ( p.x + p.y ) * p.z );
}
// The nearest chips round p (in cells): x = distance over radius (< 1 inside a chip), y = the same for
// its bare-metal middle (radius less ring). Each chip's tail reaches further along 'along', by
// up to 1 / (1 - taper) of its radius. A chip sits 0.15..0.85 into its cell and reaches at most
// 0.45 of a cell (0.65 frayed), so only the eight cells on p's side can touch it.
vec2 wearChipField( vec3 p, float density, float grow, float ring, vec3 along, float taper ) {
  vec3 cell = floor( p );
  vec3 f = p - cell;
  vec3 side = step( 0.5, f ) * 2.0 - 1.0;
  vec2 k = vec2( 9.0 );
  for ( int i = 0; i < 8; i++ ) {
    vec3 o = vec3( mod( float( i ), 2.0 ), mod( floor( float( i ) / 2.0 ), 2.0 ), floor( float( i ) / 4.0 ) ) * side;
    vec3 c = cell + o;
    if ( wearHash( c ) > density ) continue;
    float size = wearHash( c + 19.19 );
    float tail = taper * ( 0.4 + 0.6 * wearHash( c + 29.3 ) );
    float radius = min( ( CHIP_MIN + ( CHIP_MAX - CHIP_MIN ) * size * size * size ) * grow, 0.45 * ( 1.0 - tail ) );
    vec3 centre = o + 0.15 + 0.7 * vec3( wearHash( c + 3.1 ), wearHash( c + 7.7 ), wearHash( c + 11.3 ) );
    vec3 v = f - centre;
    v -= along * max( dot( v, along ), 0.0 ) * tail;
    float d = length( v );
    k.x = min( k.x, d / radius );
    if ( radius > ring ) k.y = min( k.y, d / ( radius - ring ) );
  }
  return k;
}
vec3 wearMod289( vec3 x ) { return x - floor( x * ( 1.0 / 289.0 ) ) * 289.0; }
vec4 wearMod289( vec4 x ) { return x - floor( x * ( 1.0 / 289.0 ) ) * 289.0; }
vec4 wearPermute( vec4 x ) { return wearMod289( ( ( x * 34.0 ) + 1.0 ) * x ); }
vec4 wearInvSqrt( vec4 r ) { return 1.79284291400159 - 0.85373472095314 * r; }
float wearNoise( vec3 v ) {
  const vec2 C = vec2( 1.0 / 6.0, 1.0 / 3.0 );
  const vec4 D = vec4( 0.0, 0.5, 1.0, 2.0 );
  vec3 i = floor( v + dot( v, C.yyy ) );
  vec3 x0 = v - i + dot( i, C.xxx );
  vec3 g = step( x0.yzx, x0.xyz );
  vec3 l = 1.0 - g;
  vec3 i1 = min( g.xyz, l.zxy );
  vec3 i2 = max( g.xyz, l.zxy );
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = wearMod289( i );
  vec4 p = wearPermute( wearPermute( wearPermute( i.z + vec4( 0.0, i1.z, i2.z, 1.0 ) ) + i.y + vec4( 0.0, i1.y, i2.y, 1.0 ) ) + i.x + vec4( 0.0, i1.x, i2.x, 1.0 ) );
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor( p * ns.z * ns.z );
  vec4 x_ = floor( j * ns.z );
  vec4 y_ = floor( j - 7.0 * x_ );
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs( x ) - abs( y );
  vec4 b0 = vec4( x.xy, y.xy );
  vec4 b1 = vec4( x.zw, y.zw );
  vec4 s0 = floor( b0 ) * 2.0 + 1.0;
  vec4 s1 = floor( b1 ) * 2.0 + 1.0;
  vec4 sh = -step( h, vec4( 0.0 ) );
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3( a0.xy, h.x );
  vec3 p1 = vec3( a0.zw, h.y );
  vec3 p2 = vec3( a1.xy, h.z );
  vec3 p3 = vec3( a1.zw, h.w );
  vec4 norm = wearInvSqrt( vec4( dot( p0, p0 ), dot( p1, p1 ), dot( p2, p2 ), dot( p3, p3 ) ) );
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max( 0.6 - vec4( dot( x0, x0 ), dot( x1, x1 ), dot( x2, x2 ), dot( x3, x3 ) ), 0.0 );
  m = m * m;
  return 42.0 * dot( m * m, vec4( dot( p0, x0 ), dot( p1, x1 ), dot( p2, x2 ), dot( p3, x3 ) ) );
}
`;
