import * as THREE from 'three';
import { createNoise3D } from 'simplex-noise';
import { mulberry32 } from '../world/noise';
import type { CarPiece } from './carModel';

/** Paint wear feel values (part of the car's damage config). */
export interface WearTuning {
  /** Chips laid round a hit, per m/s of Δv over toughness (1 = as chipped as it gets), and their reach (× dentRadius). */
  chipPerDv: number;
  chipReach: number;
  /** Share of those chips a glancing hit lays (a head-on hit lays them all). */
  glancingChips: number;
  /** Big flakes laid round a head-on hit, per m/s of Δv over toughness (fewer the more glancing), and their reach (× dentRadius). */
  flakePerDv: number;
  flakeReach: number;
  /**
   * Scratches from the body dragging along something, per metre slid, wherever the body rests
   * against it: every panel within `scratchDepth` (m) of the part that sticks out furthest toward
   * it, up to `scratchReach` (m) round the contacts (a box's corners when it lies flat).
   */
  scratchPerMetre: number;
  scratchReach: number;
  scratchDepth: number;
  /** Slower than this (m/s) a contact doesn't scratch. */
  scratchFrom: number;
  /** Sliding scratches on bark and on another car, as a share of those on rock (rock faces, stony ground, boulders). */
  slideScratches: { tree: number; metal: number };
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
  chipScale: 9,
  chipDensity: 0.75,
  chipPower: 2.2,
  speckScale: 30,
  /** Specks only where the wear is heavy: low power scatters them over the whole hit like stars. */
  speckDensity: 0.7,
  speckPower: 2.2,
  chipMin: 0.06,
  chipMax: 0.45,
  chipGrow: 1.2,
  chipRing: 0.1,
  /** Chip edges fray by this share of their radius (noise at 2.7 per cell). */
  chipFray: 0.3,
  /**
   * Flakes, from head-on hits and folds: the same on a coarser grid, sized `flakeMin`..`flakeMax`
   * of a cell (evenly, not mostly small), with a thin primer border and ragged edges: the grid is
   * warped by `flakeWarp` of a cell (noise at 0.8 per cell) and the edges fray (two octaves, at
   * 1.6 and 5 per cell). Flaking also scatters `flakeSpecks` of chips round itself.
   */
  flakeScale: 1.6,
  flakeDensity: 0.9,
  flakePower: 0.7,
  flakeMin: 0.25,
  flakeMax: 0.42,
  flakeWarp: 0.3,
  flakeRing: 0.04,
  flakeFray: 0.35,
  flakeSpecks: 0.5,
  /** Heavy chipping turns to flaking: flakes added from `chipFlakeFrom` of chip wear, `chipFlake` at full. */
  chipFlakeFrom: 0.55,
  chipFlake: 0.7,
  /**
   * Patches: light wear shows only in patches, heavy wear everywhere, so worn spots fray out
   * unevenly from the hit. Slow noise (features per metre, plus a finer octave) gives each spot a
   * hold of 0..`patchHold`; wear shows from there, fully `patchEdge` above it.
   */
  patchScale: 2.2,
  patchDetail: 6,
  patchHold: 0.7,
  patchEdge: 0.25,
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
  creaseFrom: 0.015,
  creaseTo: 0.3,
  /** How chipped, and how flaked, a crease gets at most on its own (a hit there adds to it). */
  creaseWear: 0.9,
  creaseFlake: 0.5,
  /**
   * Streaks: straight lines along the slide. Tubes run along it, one per cell of a grid across it
   * (`cells` per metre), at a random spot in the cell, `radiusMin`..`radiusMax` of a cell thick;
   * a panel cuts them into parallel streaks. A tube is there when its hash is under `density` ×
   * how far the wear is from `from` to `full`, and it shows in stretches (noise along it, `breaks`
   * per metre), more of it the more worn (`gapFrom` at the start to `gapTo` at full wear).
   * Fine lines scratch the clear coat; gouges go through to primer, the deepest to bare metal.
   * Gouge edges are ragged: their thickness wavers by `ragged` (share) along them, `raggedScale` per metre.
   */
  fine: { cells: 120, radiusMin: 0.1, radiusMax: 0.35, density: 0.9, from: 0, full: 0.6, breaks: 3, gapFrom: 0.5, gapTo: -0.3 },
  gouge: { cells: 40, radiusMin: 0.06, radiusMax: 0.2, density: 1, from: 0.15, full: 0.7, breaks: 1, gapFrom: 0.6, gapTo: 0 },
  ragged: 0.45,
  raggedScale: 30,
  /** A gouge's middle shows bare metal: none of them below `gougeMetalFrom` of scratch wear, half of them at full. */
  gougeMetalFrom: 0.5,
  gougeMetal: 0.5,
  /**
   * The slide's direction is snapped to steps of this (radians, 5°), blending the four nearest,
   * so each set of lines stays dead straight: a direction that drifts across the panel bends them.
   */
  directionStep: Math.PI / 36,
  /** How far a fine line lightens toward pale grey, and how rough it is. */
  lineLighten: 0.45,
  lineRoughness: 0.85,
  /** Rock dust ground into the scratches (at full dust). */
  dustInLines: 0.6,
};

const PRIMER = new THREE.Color('#8e8b85');
const METAL = new THREE.Color('#878c91');
const LINE = new THREE.Color('#e8e6e0');
const DUST = new THREE.Color('#8f8577');

/**
 * Gives a body piece's geometry the wear attributes the paint shader reads: its rest shape (for
 * creases and to pin the patterns), wear (chips, scratches, flakes, rock dust; 0..1 each) and the scratches'
 * direction (geometry-local, unnormalised, sign-free). `rest` is shared, not copied: keep it unchanged.
 */
export function addWearAttributes(geometry: THREE.BufferGeometry, rest: Float32Array): void {
  const n = rest.length / 3;
  geometry.setAttribute('aRest', new THREE.BufferAttribute(rest, 3));
  geometry.setAttribute('aWear', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
  geometry.setAttribute('aScrape', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
}

const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _n = new THREE.Vector3();

/**
 * Only faces turned toward what touched them wear: none at `FACING_FROM` (cos of the angle between
 * the face's rest normal and the contact's), fully from `FACING_TO`. A floor hit doesn't reach up
 * the sides, nor any hit through to the panel's underside. Feel values.
 */
const FACING_FROM = 0.2;
const FACING_TO = 0.6;

/** How sharply wear falls off from a hit: (1 − d / radius)^WEAR_FALLOFF. Higher keeps it at the point of impact. */
const WEAR_FALLOFF = 3;

/**
 * Wears the paint of every closed piece near `point` (car-local), on faces turned toward `normal`
 * (car-local, unit, out of the car: see FACING_FROM), falling off smoothly over `radius`:
 * `chip`, `scratch`, `flake` and `dust` (rock dust ground in with the scratches) are added
 * (each capped at 1); scratches run along `dir` (car-local, unit). Pieces are unrotated children of the car root, like for applyDent.
 */
export function wearPaint(
  pieces: CarPiece[],
  point: THREE.Vector3,
  normal: THREE.Vector3,
  radius: number,
  chip: number,
  scratch: number,
  flake: number,
  dir?: THREE.Vector3,
  dust = 0,
): void {
  for (const piece of pieces) {
    if (piece.glass || piece.rides || piece.state !== 'closed' || piece.bounds.distanceToPoint(point) > radius) continue;
    const geometry = piece.mesh.geometry;
    const wear = geometry.getAttribute('aWear') as THREE.BufferAttribute | undefined;
    if (!wear) continue;
    const scrape = geometry.getAttribute('aScrape') as THREE.BufferAttribute;
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    // Rest normals: the mesh's normals are never recomputed as it deforms (flat shading doesn't need them).
    const normals = geometry.getAttribute('normal') as THREE.BufferAttribute;
    const offset = piece.mesh.position;
    let changed = false;
    for (let i = 0; i < pos.count; i++) {
      const d = _v.fromBufferAttribute(pos, i).add(offset).distanceTo(point);
      if (d >= radius) continue;
      const facing = THREE.MathUtils.smoothstep(_n.fromBufferAttribute(normals, i).dot(normal), FACING_FROM, FACING_TO);
      if (facing <= 0) continue;
      const f = (1 - d / radius) ** WEAR_FALLOFF * facing;
      wear.setXYZW(
        i,
        Math.min(1, wear.getX(i) + chip * f),
        Math.min(1, wear.getY(i) + scratch * f),
        Math.min(1, wear.getZ(i) + flake * f),
        Math.min(1, wear.getW(i) + dust * f),
      );
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

const _u = new THREE.Vector3();
const _w = new THREE.Vector3();
const _centre = new THREE.Vector3();

/**
 * How the edge of a grind frays (feel values). What counts as touching reaches `depth` × 1 ± `ragged`
 * in, varying over the panel (noise, `raggedScale` per metre), so the edge wanders instead of
 * following a straight line across a flat panel. A vertex that only just touches wears no further
 * than √(how much it touches), so the edge stays thin however long it grinds. The touching area
 * fades out over the last `fadeFrom`..1 of `reach` past the contacts.
 */
const GRIND_EDGE = { ragged: 0.7, raggedScale: 2.5, fadeFrom: 0.3 };

/** Per geometry: the edge noise (−1..1) at each vertex's rest position. */
const edgeNoise = new WeakMap<THREE.BufferGeometry, Float32Array>();
const noise3 = createNoise3D(mulberry32(5023));

function edgeNoiseOf(geometry: THREE.BufferGeometry): Float32Array {
  let out = edgeNoise.get(geometry);
  if (out) return out;
  const rest = (geometry.getAttribute('aRest') as THREE.BufferAttribute).array;
  const s = GRIND_EDGE.raggedScale;
  out = new Float32Array(rest.length / 3);
  for (let i = 0, k = 0; i < out.length; i++, k += 3) out[i] = noise3(rest[k] * s, rest[k + 1] * s, rest[k + 2] * s);
  edgeNoise.set(geometry, out);
  return out;
}

/**
 * Scratches the paint wherever the body rests against what it slides on: of the faces turned
 * toward it (see FACING_FROM) within `reach` (m, across the contact plane) of the `contacts`'
 * spread, those within about `depth` (m, see GRIND_EDGE) of the furthest-out one along `normal`,
 * the most at that one. Adds `scratch` and `dust` (capped at 1, and lower toward the edge);
 * scratches run along `dir`. All car-local; `normal` and `dir` unit, `normal` out of the car.
 * Pieces are unrotated children of the car root.
 */
export function grindPaint(
  pieces: CarPiece[],
  contacts: readonly THREE.Vector3[],
  count: number,
  normal: THREE.Vector3,
  reach: number,
  depth: number,
  scratch: number,
  dir: THREE.Vector3,
  dust: number,
): void {
  const E = GRIND_EDGE;
  // The contacts' spread across the contact plane, and a ball round it to skip pieces by.
  _u.set(Math.abs(normal.x) < 0.9 ? 1 : 0, Math.abs(normal.x) < 0.9 ? 0 : 1, 0);
  _u.addScaledVector(normal, -_u.dot(normal)).normalize();
  _w.crossVectors(normal, _u);
  let u0 = Infinity;
  let u1 = -Infinity;
  let w0 = Infinity;
  let w1 = -Infinity;
  _centre.set(0, 0, 0);
  for (let c = 0; c < count; c++) {
    const u = contacts[c].dot(_u);
    const w = contacts[c].dot(_w);
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    w0 = Math.min(w0, w);
    w1 = Math.max(w1, w);
    _centre.add(contacts[c]);
  }
  _centre.divideScalar(count);
  const deepest = depth * (1 + E.ragged);
  const ball = Math.hypot(u1 - u0, w1 - w0) / 2 + reach + deepest;
  const ux = _u.x, uy = _u.y, uz = _u.z;
  const wx = _w.x, wy = _w.y, wz = _w.z;
  const nx = normal.x, ny = normal.y, nz = normal.z;

  // The vertices near that spread facing the surface: how far out toward it each is, how far in
  // still touches there, and how squarely it faces the surface (less toward the spread's edge).
  let found = 0;
  let furthest = -Infinity;
  for (let p = 0; p < pieces.length; p++) {
    const piece = pieces[p];
    if (piece.glass || piece.rides || piece.state !== 'closed' || piece.bounds.distanceToPoint(_centre) > ball) continue;
    const geometry = piece.mesh.geometry;
    if (!geometry.getAttribute('aWear')) continue;
    const pos = (geometry.getAttribute('position') as THREE.BufferAttribute).array;
    const normals = (geometry.getAttribute('normal') as THREE.BufferAttribute).array;
    let ragged: Float32Array | undefined;
    const { x: ox, y: oy, z: oz } = piece.mesh.position;
    for (let i = 0, k = 0; k < pos.length; i++, k += 3) {
      const facing = normals[k] * nx + normals[k + 1] * ny + normals[k + 2] * nz;
      if (facing <= FACING_FROM) continue;
      const x = pos[k] + ox;
      const y = pos[k + 1] + oy;
      const z = pos[k + 2] + oz;
      const u = x * ux + y * uy + z * uz;
      const du = Math.max(u0 - u, u - u1, 0);
      if (du > reach) continue;
      const w = x * wx + y * wy + z * wz;
      const dw = Math.max(w0 - w, w - w1, 0);
      if (dw > reach) continue;
      const outside = Math.hypot(du, dw) / reach;
      if (outside >= 1) continue;
      const out = x * nx + y * ny + z * nz;
      if (out < furthest - deepest) continue;
      furthest = Math.max(furthest, out);
      ragged ??= edgeNoiseOf(geometry);
      if (found === _found.piece.length) growFound();
      _found.piece[found] = p;
      _found.vertex[found] = i;
      _found.out[found] = out;
      _found.depth[found] = depth * (1 + E.ragged * ragged[i]);
      _found.facing[found] = THREE.MathUtils.smoothstep(facing, FACING_FROM, FACING_TO) * (1 - THREE.MathUtils.smoothstep(outside, E.fadeFrom, 1));
      found++;
    }
  }

  let last: CarPiece | undefined;
  let wear!: THREE.BufferAttribute;
  let scrape!: THREE.BufferAttribute;
  for (let c = 0; c < found; c++) {
    const f = (1 - (furthest - _found.out[c]) / _found.depth[c]) * _found.facing[c];
    if (f <= 0) continue;
    const piece = pieces[_found.piece[c]];
    if (piece !== last) {
      last = piece;
      wear = piece.mesh.geometry.getAttribute('aWear') as THREE.BufferAttribute;
      scrape = piece.mesh.geometry.getAttribute('aScrape') as THREE.BufferAttribute;
      wear.needsUpdate = true;
      scrape.needsUpdate = true;
    }
    const i = _found.vertex[c];
    const most = Math.sqrt(f);
    const was = wear.getY(i);
    wear.setY(i, Math.max(was, Math.min(was + scratch * f, most)));
    wear.setW(i, Math.max(wear.getW(i), Math.min(wear.getW(i) + dust * f, most)));
    _s.fromBufferAttribute(scrape, i);
    _s.addScaledVector(dir, (_s.dot(dir) < 0 ? -1 : 1) * scratch * f);
    scrape.setXYZ(i, _s.x, _s.y, _s.z);
  }
}

/** grindPaint's candidate vertices, kept between calls (grown as needed). */
const _found = { piece: new Int32Array(4096), vertex: new Int32Array(4096), out: new Float32Array(4096), depth: new Float32Array(4096), facing: new Float32Array(4096) };
function growFound(): void {
  const n = _found.piece.length * 2;
  const grow = <T extends Int32Array | Float32Array>(a: T, make: (n: number) => T): T => {
    const b = make(n);
    b.set(a);
    return b;
  };
  _found.piece = grow(_found.piece, (k) => new Int32Array(k));
  _found.vertex = grow(_found.vertex, (k) => new Int32Array(k));
  _found.out = grow(_found.out, (k) => new Float32Array(k));
  _found.depth = grow(_found.depth, (k) => new Float32Array(k));
  _found.facing = grow(_found.facing, (k) => new Float32Array(k));
}

/**
 * Makes a paint material draw wear: chips (a primer ring round bare metal) where the attributes
 * say or where a face has creased away from its rest direction, and grinding along the scrape
 * direction: straight lines and gouges, dusted with rock. Geometry without the attributes reads them as zero and shows clean paint.
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
    shader.uniforms.wearLine = { value: LINE };
    shader.uniforms.wearDust = { value: DUST };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec3 aRest;
attribute vec4 aWear;
attribute vec3 aScrape;
varying vec3 vWearRest;
varying vec3 vWearNow;
varying vec4 vWear;
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
uniform vec3 wearLine;
uniform vec3 wearDust;
varying vec3 vWearRest;
varying vec3 vWearNow;
varying vec4 vWear;
varying vec3 vWearScrape;
${WEAR_GLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
// Paint wear: 0..1 shares of this fragment that show primer, bare metal and scratch lines.
float wearPrimerAmt = 0.0;
float wearMetalAmt = 0.0;
float wearLineAmt = 0.0;
{
  vec3 restFace = cross( dFdx( vWearRest ), dFdy( vWearRest ) );
  vec3 nowFace = cross( dFdx( vWearNow ), dFdy( vWearNow ) );
  // How far this face has turned from its rest direction (1 - cos of the angle; 0 = not at all), for creases.
  float turned = length( restFace ) > 1e-12 && length( nowFace ) > 1e-12 ? 1.0 - abs( dot( normalize( restFace ), normalize( nowFace ) ) ) : 0.0;
  float crease = smoothstep( ${f(L.creaseFrom)}, ${f(L.creaseTo)}, turned );
  float flakes = vWear.z + ${f(L.creaseFlake)} * crease + ${f(L.chipFlake)} * smoothstep( ${f(L.chipFlakeFrom)}, 1.0, vWear.x );
  float chips = vWear.x + ${f(L.creaseWear)} * crease + ${f(L.flakeSpecks)} * vWear.z;
  if ( chips > 0.001 || flakes > 0.001 ) {
    // Light wear only in patches: it frays out unevenly from where it's heavy.
    float hold = ${f(L.patchHold)} * clamp( 0.5 + 0.5 * ( 0.7 * wearNoise( vWearRest * ${f(L.patchScale)} ) + 0.3 * wearNoise( vWearRest * ${f(L.patchDetail)} + 41.0 ) ), 0.0, 1.0 );
    chips = min( chips, 1.0 );
    flakes = min( flakes, 1.0 );
    chips *= smoothstep( hold, hold + ${f(L.patchEdge)}, chips );
    flakes *= smoothstep( hold, hold + ${f(L.patchEdge)}, flakes );
    float grow = 1.0 + ${f(L.chipGrow)} * chips;
    // Where the paint was scratched, chips are gouges: drawn out along the scratches (the grid
    // squashed along them, so its round chips come out long) with a tapering tail.
    float scraped = length( vWearScrape ) > 1e-5 ? smoothstep( 0.0, ${f(L.gougeFrom)}, vWear.y ) : 0.0;
    vec3 along = scraped > 0.0 ? normalize( vWearScrape ) : vec3( 0.0 );
    float squash = 1.0 / ( 1.0 + ( ${f(L.gougeStretch)} - 1.0 ) * scraped ) - 1.0;
    vec3 gougeAt = vWearRest + along * dot( vWearRest, along ) * squash;
    float taper = ${f(L.gougeTaper)} * scraped;
    vec3 chipAt = gougeAt * ${f(L.chipScale)};
    vec3 speckAt = gougeAt * ${f(L.speckScale)} + 5.3;
    vec3 chipSize = vec3( ${f(L.chipMin)}, ${f(L.chipMax)}, 3.0 );
    vec2 chip = wearChipField( chipAt, ${f(L.chipDensity)} * pow( chips, ${f(L.chipPower)} ), chipSize, grow, ${f(L.chipRing)}, along, taper );
    vec2 speck = wearChipField( speckAt, ${f(L.speckDensity)} * pow( chips, ${f(L.speckPower)} ), chipSize, grow, 1.0, along, taper );
    chip *= 1.0 + ${f(L.chipFray)} * wearNoise( chipAt * 2.7 );
    speck.x *= 1.0 + ${f(L.chipFray)} * wearNoise( speckAt * 2.7 );
    vec2 flake = vec2( 9.0 );
    if ( flakes > 0.001 ) {
      vec3 flakeAt = gougeAt * ${f(L.flakeScale)} + 9.7;
      vec3 w = flakeAt * 0.8;
      flakeAt += ${f(L.flakeWarp)} * vec3( wearNoise( w ), wearNoise( w + 31.0 ), wearNoise( w + 57.0 ) );
      flake = wearChipField( flakeAt, ${f(L.flakeDensity)} * pow( flakes, ${f(L.flakePower)} ), vec3( ${f(L.flakeMin)}, ${f(L.flakeMax)}, 1.0 ), 1.0, ${f(L.flakeRing)}, along, taper * 0.5 );
      flake *= 1.0 + ${f(L.flakeFray)} * ( 0.65 * wearNoise( flakeAt * 1.6 ) + 0.35 * wearNoise( flakeAt * 5.0 + 17.0 ) );
    }
    float inPrimer = min( min( chip.x, speck.x ), flake.x );
    float inMetal = min( chip.y, flake.y );
    float aa = fwidth( inPrimer ) + 1e-4;
    float aaMetal = fwidth( inMetal ) + 1e-4;
    wearMetalAmt = 1.0 - smoothstep( 1.0 - aaMetal, 1.0 + aaMetal, inMetal );
    wearPrimerAmt = max( 0.0, 1.0 - smoothstep( 1.0 - aa, 1.0 + aa, inPrimer ) - wearMetalAmt );
  }
  // Grinding: fine lines through the clear coat and gouges to primer and metal,
  // straight along the slide. Its direction is snapped to steps (the four nearest blended, each
  // as a share of the lines) so every set of lines stays straight.
  float scratch = vWear.y;
  float dirLength = length( vWearScrape );
  if ( scratch > 0.001 && dirLength > 1e-5 ) {
    vec3 along = vWearScrape / dirLength;
    along *= along.z < 0.0 ? -1.0 : 1.0;
    vec2 turn = vec2( atan( along.x, along.z ), asin( clamp( along.y, -1.0, 1.0 ) ) ) / ${f(L.directionStep)};
    vec2 base = floor( turn );
    vec2 t = turn - base;
    float fineAmt = smoothstep( ${f(L.fine.from)}, ${f(L.fine.full)}, scratch );
    float gougeAmt = smoothstep( ${f(L.gouge.from)}, ${f(L.gouge.full)}, scratch );
    float fineGap = mix( ${f(L.fine.gapFrom)}, ${f(L.fine.gapTo)}, fineAmt );
    float gougeGap = mix( ${f(L.gouge.gapFrom)}, ${f(L.gouge.gapTo)}, gougeAmt );
    float metalShare = ${f(L.gougeMetal)} * smoothstep( ${f(L.gougeMetalFrom)}, 1.0, scratch );
    float gouge = 0.0;
    float gougeMetal = 0.0;
    for ( int i = 0; i < 4; i++ ) {
      vec2 o = vec2( mod( float( i ), 2.0 ), floor( float( i ) / 2.0 ) );
      vec2 share = mix( 1.0 - t, t, o );
      float w = share.x * share.y;
      if ( w < 0.02 ) continue;
      vec2 q = ( base + o ) * ${f(L.directionStep)};
      vec3 dir = vec3( cos( q.y ) * sin( q.x ), sin( q.y ), cos( q.y ) * cos( q.x ) );
      float seed = dot( base + o, vec2( 3.1, 7.3 ) );
      vec3 fine = wearStreaks( vWearRest, dir, ${f(L.fine.cells)}, vec2( ${f(L.fine.radiusMin)}, ${f(L.fine.radiusMax)} ), ${f(L.fine.density)} * fineAmt * w, ${f(L.fine.breaks)}, fineGap, seed, vec2( 0.0 ) );
      vec3 g = wearStreaks( vWearRest, dir, ${f(L.gouge.cells)}, vec2( ${f(L.gouge.radiusMin)}, ${f(L.gouge.radiusMax)} ), ${f(L.gouge.density)} * gougeAmt * w, ${f(L.gouge.breaks)}, gougeGap, seed + 50.0, vec2( ${f(L.ragged)}, ${f(L.raggedScale)} ) );
      wearLineAmt = max( wearLineAmt, fine.x );
      gouge = max( gouge, g.x );
      gougeMetal = max( gougeMetal, g.x * step( g.y, metalShare ) * smoothstep( 0.35, 0.55, g.z ) );
    }
    wearMetalAmt = max( wearMetalAmt, gougeMetal );
    wearPrimerAmt = max( wearPrimerAmt, gouge - wearMetalAmt );
  }
  float dust = vWear.w;
  vec3 line = mix( mix( diffuseColor.rgb, wearLine, ${f(L.lineLighten)} ), wearDust, ${f(L.dustInLines)} * dust );
  wearLineAmt = clamp( wearLineAmt - wearMetalAmt - wearPrimerAmt, 0.0, 1.0 );
  diffuseColor.rgb = mix( diffuseColor.rgb, line, wearLineAmt );
  diffuseColor.rgb = mix( diffuseColor.rgb, wearPrimer, wearPrimerAmt );
  diffuseColor.rgb = mix( diffuseColor.rgb, mix( wearMetal, wearDust, 0.3 * dust ), wearMetalAmt );
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = mix( roughnessFactor, ${f(L.lineRoughness)}, wearLineAmt + wearPrimerAmt );
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
 * The wear shader's helpers: a hash, the chip field, the streaks, and 3D simplex noise (≈ −1..1) from Ashima
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
// its bare-metal middle (radius less ring). Radii run size.x..size.y of a cell, the random pick
// raised to size.z (higher: mostly small). Each chip's tail reaches further along 'along', by
// up to 1 / (1 - taper) of its radius. A chip sits 0.15..0.85 into its cell and reaches at most
// 0.45 of a cell (0.65 frayed by up to 0.35), so only the eight cells on p's side can touch it.
vec2 wearChipField( vec3 p, float density, vec3 size, float grow, float ring, vec3 along, float taper ) {
  vec3 cell = floor( p );
  vec3 f = p - cell;
  vec3 side = step( 0.5, f ) * 2.0 - 1.0;
  vec2 k = vec2( 9.0 );
  for ( int i = 0; i < 8; i++ ) {
    vec3 o = vec3( mod( float( i ), 2.0 ), mod( floor( float( i ) / 2.0 ), 2.0 ), floor( float( i ) / 4.0 ) ) * side;
    vec3 c = cell + o;
    if ( wearHash( c ) > density ) continue;
    float pick = pow( wearHash( c + 19.19 ), size.z );
    float tail = taper * ( 0.4 + 0.6 * wearHash( c + 29.3 ) );
    float radius = min( ( size.x + ( size.y - size.x ) * pick ) * grow, 0.45 * ( 1.0 - tail ) );
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
// Straight streaks along 'dir' (unit): tubes laid along it, one per cell of a grid on the plane
// square to it ('cells' per metre), each at a random spot in its cell, radii.x..radii.y of a cell
// thick, there if its hash is under 'density', and in stretches where noise along it ('breaks'
// per metre) passes 'gap', tapering to each stretch's ends, their thickness wavering by ragged.x
// (share) along them, ragged.y per metre. A panel cuts them into parallel
// streaks. x = coverage (antialiased; the average once a cell is under a pixel), y = the streak's
// own random 0..1, z = 1 at its middle, 0 at its edge.
vec3 wearStreaks( vec3 rest, vec3 dir, float cells, vec2 radii, float density, float breaks, float gap, float seed, vec2 ragged ) {
  vec3 ref = abs( dir.y ) < 0.7 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
  vec3 e1 = normalize( ref - dir * dot( dir, ref ) );
  vec3 e2 = cross( dir, e1 );
  vec2 p = vec2( dot( rest, e1 ), dot( rest, e2 ) ) * cells;
  float px = max( length( fwidth( p ) ), 1e-4 );
  vec2 cell = floor( p );
  vec3 key = vec3( cell, seed );
  float radius = mix( radii.x, radii.y, wearHash( key + 3.7 ) );
  vec2 centre = 0.5 + ( 0.5 - radius ) * ( 2.0 * vec2( wearHash( key + 5.1 ), wearHash( key + 8.9 ) ) - 1.0 );
  float stretch = smoothstep( gap, gap + 0.3, wearNoise( vec3( cell * 0.71, dot( rest, dir ) * breaks + seed ) ) );
  float r = radius * stretch * ( 1.0 + ragged.x * wearNoise( vec3( cell * 1.37, dot( rest, dir ) * ragged.y + seed ) ) );
  float d = length( p - cell - centre );
  float there = step( wearHash( key ), density );
  float cover = there * ( 1.0 - smoothstep( r - px, r + px, d ) );
  // The share of a panel the tubes cover on average (half of each tube showing).
  float mean = 0.5 * density * 3.1416 * 0.5 * ( radii.x * radii.x + radii.y * radii.y );
  float blur = smoothstep( 0.4, 1.2, px );
  return vec3( mix( cover, mean, blur ), wearHash( key + 13.1 ), r > 0.0 ? clamp( 1.0 - d / r, 0.0, 1.0 ) : 0.0 );
}
`;
