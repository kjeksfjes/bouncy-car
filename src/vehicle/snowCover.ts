import * as THREE from 'three';
import { SUN_DIR } from '../render/stage';
import type { CarPiece } from './carModel';
import { NOISE_GLSL } from './shaderNoise';

/**
 * Snow building up on a car's paint (0..1 per vertex: 1 is a full crust), and going again. Feel
 * values, per second unless said otherwise.
 *
 * Built up by its tyres throwing snow, per particle of spray (`spray*`, all four tyres' together
 * unless said):
 * - the lower body all round: `sprayLow`, the lower the more (none higher than `lowTop` m above
 *   the tyres' contacts), less on faces turned down (× `underside`);
 * - round each tyre: `sprayTyre` per particle of that tyre's, within `tyreReach` m (falling off),
 *   more on faces turned toward it: wheel arches, sills, the bumper behind;
 * - the cloud it drives in: `sprayCloud`, all over (where snow reaches, see EXPOSED);
 * - its wake: `sprayWake` per m/s of speed (up to `wakeSpeed`), onto faces turned back;
 * - ploughing through its own spray: `plough` per m/s, onto faces turned the way it goes, the
 *   lower the more (up to `lowTop` m);
 * - a hit into snow: `hit` per m/s of severity, round the hit (`hitReach` m), onto faces turned
 *   toward it.
 * It builds up ever more slowly toward a `ceiling`: `top` on the upper body, rising to `low` on
 * the lower (see `lowTop`), so it settles in between a dusting and a crust; only a hit packs more.
 * Lost by melting (`melt` × how warm the air is: none in the snow, a little through the thaw,
 * all of it in the grassland; see Biome.warmth) and the wind blowing it off faces turned up and
 * forward (`wind` per m/s over `windFrom`). Applied every `every` s.
 */
export const SNOW_COVER = {
  sprayLow: 0.0005,
  lowTop: 0.9,
  underside: 0.3,
  sprayTyre: 0.0002,
  tyreReach: 2,
  sprayCloud: 0.00008,
  sprayWake: 0.000012,
  wakeSpeed: 20,
  plough: 0.0012,
  hit: 0.05,
  hitReach: 1.5,
  ceiling: { top: 0.4, low: 0.7 },
  melt: 1 / 300,
  wind: 0.0012,
  windFrom: 14,
  every: 0.1,
};

/**
 * How snow looks on the paint (the shader). Patterns in metres on the panel's rest shape, so they
 * stay put as it crumples. It lies in patches where the patch noise (three octaves, at
 * `patchScale`, × 3.2 and × 9.6 per metre) is lowest, more spreading them until they join; `edge`
 * softens a patch's rim. A little is a dusting: fine specks of powder (`speckScale` per metre),
 * filling in to a solid crust between `solidFrom` and `solidTo` of a full one. A crust is lumpy: its
 * surface is bumped by noise (`lumpScale` and `grainScale` per metre, the grain `grainShare` of
 * it), `bump` strong, more where it's thick, and its colour varies by ±`tone`. Matte
 * (`roughness`). Now and then a facet catches the sun: cells of `glitterScale` per metre, each a
 * tiny mirror turned off the surface by up to `glitterTilt`, flashing `glitter` bright at
 * `glitterSharp` (higher: briefer).
 */
const LOOK = {
  color: new THREE.Color('#f2f6fb'),
  patchScale: 4.5,
  edge: 0.25,
  speckScale: 110,
  solidFrom: 0.25,
  solidTo: 0.75,
  lumpScale: 9,
  grainScale: 38,
  grainShare: 0.35,
  bump: 0.55,
  tone: 0.07,
  roughness: 0.92,
  glitterScale: 70,
  glitterTilt: 0.35,
  glitter: 1.2,
  glitterSharp: 400,
};

/**
 * Gives a piece's geometry the attributes the snow shader reads: its snow (none yet) and, unless
 * the paint wear has given it one, its rest shape (`rest`, shared: keep it unchanged), which pins
 * the snow's patterns.
 */
export function addSnowAttributes(geometry: THREE.BufferGeometry, rest: Float32Array): void {
  geometry.setAttribute('aSnow', new THREE.BufferAttribute(new Float32Array(geometry.getAttribute('position').count), 1));
  if (!geometry.hasAttribute('aRest')) geometry.setAttribute('aRest', new THREE.BufferAttribute(rest, 3));
}

/**
 * Makes a material other than the paint (which has it built in, see paintWithWear) draw the snow
 * lying on it. Geometry without the attributes reads them as zero and shows none.
 */
export function withSnow(material: THREE.MeshStandardMaterial): void {
  material.customProgramCacheKey = () => 'snow';
  material.onBeforeCompile = (shader, renderer) => {
    THREE.Material.prototype.onBeforeCompile.call(material, shader, renderer);
    shader.uniforms.snowColor = { value: LOOK.color };
    shader.uniforms.snowSun = { value: SUN_DIR };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec3 aRest;\nvarying vec3 vWearRest;\n${SNOW_VERTEX_DECL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvWearRest = aRest;\n${SNOW_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWearRest;\n${NOISE_GLSL}\n${SNOW_FRAGMENT_DECL}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${SNOW_COLOR}`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${SNOW_METAL}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${SNOW_NORMAL}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${SNOW_GLITTER}`);
  };
}

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** One car's snow: what's waiting to be laid on or taken off at the next step (see SNOW_COVER.every). */
interface CarState {
  wait: number;
  /** Spray from each tyre since the last step: where (car-local) and how much. */
  spray: { at: THREE.Vector3; amount: number }[];
  /** Seconds since its tyres last threw snow. */
  sinceSpray: number;
}

/**
 * Snow on the cars (see SNOW_COVER): gathers what each car throws and meets, and lays it on or takes
 * it off its paint pieces' vertices every SNOW_COVER.every s.
 */
export class SnowCover {
  private readonly states = new WeakMap<object, CarState>();

  private state(car: object): CarState {
    let s = this.states.get(car);
    if (!s) this.states.set(car, (s = { wait: 0, spray: [], sinceSpray: Infinity }));
    return s;
  }

  /** A tyre at `contact` (world) threw `particles` of snow spray, the car's root being `root`. */
  spray(car: object, root: THREE.Object3D, contact: THREE.Vector3, particles: number): void {
    const s = this.state(car);
    s.sinceSpray = 0;
    const at = root.worldToLocal(contact.clone());
    const near = s.spray.find((e) => e.at.distanceToSquared(at) < 0.25);
    if (near) near.amount += particles;
    else s.spray.push({ at, amount: particles });
  }

  /** A hit into snow at `at` (world), `severity` m/s over the car's toughness: packs snow round it. */
  hit(pieces: CarPiece[], root: THREE.Object3D, at: THREE.Vector3, severity: number): void {
    const C = SNOW_COVER;
    const local = root.worldToLocal(at.clone());
    lay(pieces, (p, n) => {
      const d = p.distanceTo(local);
      if (d >= C.hitReach) return 0;
      return C.hit * severity * (1 - d / C.hitReach) ** 2 * THREE.MathUtils.smoothstep(n.dot(_d.subVectors(local, p).normalize()), -0.2, 0.5);
    });
  }

  /**
   * Builds up and takes off the car's snow (see SNOW_COVER). `onSnow` is how much of the ground
   * under it is snow (0..1), `warmth` how warm the air is there (0 in the snow .. 1 in the
   * grassland, see Biome.warmth).
   */
  update(dt: number, car: object, pieces: CarPiece[], root: THREE.Object3D, velocity: THREE.Vector3, onSnow: number, warmth: number): void {
    const C = SNOW_COVER;
    const s = this.state(car);
    s.sinceSpray += dt;
    if ((s.wait += dt) < C.every) return;
    const step = s.wait;
    s.wait = 0;
    // The car's way, up and speed in its own frame.
    _q.copy(root.quaternion).invert();
    const way = velocity.clone().applyQuaternion(_q);
    const speed = way.length();
    if (speed > 1e-3) way.divideScalar(speed);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(_q);
    const spray = s.spray;
    s.spray = [];
    const groundY = spray.length > 0 ? Math.min(...spray.map((e) => e.at.y)) : -Infinity;
    const sprayed = spray.reduce((sum, e) => sum + e.amount, 0);
    const low = C.sprayLow * sprayed;
    const cloud = C.sprayCloud * sprayed;
    const wake = C.sprayWake * sprayed * Math.min(speed, C.wakeSpeed);
    const plough = onSnow > 0.5 && s.sinceSpray < 0.5 ? C.plough * speed * step * onSnow : 0;
    const melt = C.melt * warmth * step;
    const wind = C.wind * Math.max(0, speed - C.windFrom) * step;
    each(pieces, (snow, i, p, n, open) => {
      let add = 0;
      const upward = n.dot(up);
      if (sprayed > 0) {
        for (const e of spray) {
          const d = p.distanceTo(e.at);
          if (d >= C.tyreReach) continue;
          const facing = n.dot(_d.subVectors(e.at, p).normalize());
          add += C.sprayTyre * e.amount * (1 - d / C.tyreReach) * (0.3 + 0.7 * Math.max(0, facing));
        }
        const lowness = 1 - (p.y - groundY) / C.lowTop;
        const ceiling = C.ceiling.top + (C.ceiling.low - C.ceiling.top) * THREE.MathUtils.clamp(lowness, 0, 1);
        if (lowness > 0) add += low * Math.min(1, lowness) * (n.y < -0.5 ? C.underside : 1);
        add += cloud;
        add += wake * Math.max(0, -n.dot(way));
        if (plough > 0 && lowness > 0) add += plough * Math.max(0, n.dot(way)) * Math.min(1, lowness);
        add *= Math.max(0, 1 - snow.getX(i) / ceiling);
      }
      add *= open;
      let off = melt;
      if (wind > 0) off += wind * Math.max(0, upward, n.dot(way));
      snow.setX(i, THREE.MathUtils.clamp(snow.getX(i) + add - off, 0, 1));
    });
    creep(pieces);
  }
}

/**
 * Which faces snow reaches: the sides and ends, not the top or the underside. Panels are solid, so
 * each has an inner skin facing the cabin, boot or bay, which no snow reaches. A face counts as
 * outside by how its rest normal points against the way out from the car's middle (its long axis
 * at mid height, stretched by `along` toward the ends): none from `inside` (the cosine), fully
 * from `outside`. None reaches faces turned up (from `top[0]` of the normal's upward share, none
 * from `top[1]`: roof, hood, boot lid, the sloping screens), nor those turned down
 * (`down[0]`..`down[1]`) within `under` (min..max) m of the body's bottom: the underbody and the
 * sills' undersides, not the wheel arches.
 */
const EXPOSED = { inside: -0.35, outside: 0.05, along: 0.4, top: [0.45, 0.65], down: [0.5, 0.7], under: [0.15, 0.3] } as const;

/** Per car (by its pieces): the height of its middle and of its body's bottom (car-local, m). */
const middles = new WeakMap<CarPiece[], { middle: number; bottom: number }>();
/** Per geometry: how much each vertex is outside (0..1, see EXPOSED). */
const exposure = new WeakMap<THREE.BufferGeometry, Float32Array>();

function middleOf(pieces: CarPiece[]): { middle: number; bottom: number } {
  let m = middles.get(pieces);
  if (!m) {
    const box = new THREE.Box3();
    for (const piece of pieces) if (!piece.rides) box.union(piece.bounds);
    m = { middle: (box.min.y + box.max.y) / 2, bottom: box.min.y };
    middles.set(pieces, m);
  }
  return m;
}

function exposureOf(piece: CarPiece, { middle, bottom }: { middle: number; bottom: number }): Float32Array {
  const geometry = piece.mesh.geometry;
  let out = exposure.get(geometry);
  if (out) return out;
  const E = EXPOSED;
  const rest = geometry.getAttribute('aRest') as THREE.BufferAttribute;
  const normals = geometry.getAttribute('normal') as THREE.BufferAttribute;
  const offset = piece.origin;
  out = new Float32Array(rest.count);
  for (let i = 0; i < rest.count; i++) {
    _p.fromBufferAttribute(rest, i).add(offset);
    _d.set(_p.x, _p.y - middle, _p.z * E.along);
    _n.fromBufferAttribute(normals, i);
    const away = _d.lengthSq() < 1e-6 ? 1 : _n.dot(_d.normalize());
    const up = 1 - THREE.MathUtils.smoothstep(_n.y, E.top[0], E.top[1]);
    const under = THREE.MathUtils.smoothstep(-_n.y, E.down[0], E.down[1]) * (1 - THREE.MathUtils.smoothstep(_p.y - bottom, E.under[0], E.under[1]));
    out[i] = THREE.MathUtils.smoothstep(away, E.inside, E.outside) * up * (1 - under);
  }
  exposure.set(geometry, out);
  return out;
}

/**
 * Snow creeping over an edge onto the top: a top face (see EXPOSED.top) within `reach` m of
 * faces snow reaches (rest shapes, car-local; across pieces too, e.g. from the rear panel onto
 * the boot lid) carries their snow, `share` of it, falling off as (1 − distance / reach)^`power`,
 * from its `sources` strongest neighbours. It follows theirs, so it melts away with it.
 */
const CREEP = { reach: 0.25, share: 0.9, power: 1.5, sources: 4 };

/** A top-face vertex carrying the snow of the vertices near it (see CREEP). */
interface Creep {
  target: THREE.BufferAttribute;
  i: number;
  from: THREE.BufferAttribute[];
  j: number[];
  w: number[];
}

/** Per car (by its pieces): its top-face vertices by an edge, and where their snow comes from. */
const creeps = new WeakMap<CarPiece[], Creep[]>();

function creepOf(pieces: CarPiece[]): Creep[] {
  let out = creeps.get(pieces);
  if (out) return out;
  const C = CREEP;
  const E = EXPOSED;
  const m = middleOf(pieces);
  type Spot = { snow: THREE.BufferAttribute; i: number; p: THREE.Vector3 };
  const cell = (p: THREE.Vector3) => `${Math.floor(p.x / C.reach)},${Math.floor(p.y / C.reach)},${Math.floor(p.z / C.reach)}`;
  const grid = new Map<string, Spot[]>();
  const tops: Spot[] = [];
  for (const piece of pieces) {
    if (piece.rides) continue;
    const geometry = piece.mesh.geometry;
    const snow = geometry.getAttribute('aSnow') as THREE.BufferAttribute | undefined;
    if (!snow) continue;
    const open = exposureOf(piece, m);
    const rest = geometry.getAttribute('aRest') as THREE.BufferAttribute;
    const normals = geometry.getAttribute('normal') as THREE.BufferAttribute;
    for (let i = 0; i < rest.count; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(rest, i).add(piece.origin);
      if (open[i] > 0.5) {
        const key = cell(p);
        const list = grid.get(key);
        if (list) list.push({ snow, i, p });
        else grid.set(key, [{ snow, i, p }]);
        continue;
      }
      // A top face on the outside (not an inner skin).
      _n.fromBufferAttribute(normals, i);
      _d.set(p.x, p.y - m.middle, p.z * E.along);
      if (_n.y > E.top[0] && _d.lengthSq() > 1e-6 && _n.dot(_d.normalize()) >= E.outside) tops.push({ snow, i, p });
    }
  }
  out = [];
  for (const t of tops) {
    const near: { s: Spot; w: number }[] = [];
    const cx = Math.floor(t.p.x / C.reach);
    const cy = Math.floor(t.p.y / C.reach);
    const cz = Math.floor(t.p.z / C.reach);
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        for (let z = cz - 1; z <= cz + 1; z++) {
          for (const s of grid.get(`${x},${y},${z}`) ?? []) {
            const d = s.p.distanceTo(t.p);
            if (d < C.reach) near.push({ s, w: C.share * (1 - d / C.reach) ** C.power });
          }
        }
      }
    }
    if (near.length === 0) continue;
    near.sort((a, b) => b.w - a.w);
    const best = near.slice(0, C.sources);
    out.push({ target: t.snow, i: t.i, from: best.map((b) => b.s.snow), j: best.map((b) => b.s.i), w: best.map((b) => b.w) });
  }
  creeps.set(pieces, out);
  return out;
}

/** Lays the snow creeping over the car's edges onto its top (see CREEP). */
function creep(pieces: CarPiece[]): void {
  for (const c of creepOf(pieces)) {
    let v = 0;
    for (let k = 0; k < c.from.length; k++) v = Math.max(v, c.from[k].getX(c.j[k]) * c.w[k]);
    c.target.setX(c.i, v);
    c.target.needsUpdate = true;
  }
}

/**
 * Calls `visit` for every vertex of the car's closed pieces with the snow attribute (all but the
 * wheels) that snow reaches (see EXPOSED), with its current position and rest normal (car-local),
 * how much snow reaches it (0..1), and its index. Marks the attributes changed.
 */
function each(pieces: CarPiece[], visit: (snow: THREE.BufferAttribute, i: number, p: THREE.Vector3, n: THREE.Vector3, open: number) => void): void {
  const middle = middleOf(pieces);
  for (const piece of pieces) {
    if (piece.rides || piece.state !== 'closed') continue;
    const geometry = piece.mesh.geometry;
    const snow = geometry.getAttribute('aSnow') as THREE.BufferAttribute | undefined;
    if (!snow) continue;
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    // Rest normals: the mesh's normals aren't recomputed as it deforms.
    const normals = geometry.getAttribute('normal') as THREE.BufferAttribute;
    const open = exposureOf(piece, middle);
    const offset = piece.mesh.position;
    for (let i = 0; i < pos.count; i++) {
      if (open[i] <= 0) continue;
      visit(snow, i, _p.fromBufferAttribute(pos, i).add(offset), _n.fromBufferAttribute(normals, i), open[i]);
    }
    snow.needsUpdate = true;
  }
}

/** Adds `amount(p, n)` of snow (capped at 1) to every vertex of the car's paint (see each). */
function lay(pieces: CarPiece[], amount: (p: THREE.Vector3, n: THREE.Vector3) => number): void {
  each(pieces, (snow, i, p, n, open) => {
    const a = amount(p, n) * open;
    if (a > 0) snow.setX(i, Math.min(1, snow.getX(i) + a));
  });
}

const f = (x: number) => x.toFixed(4);
const L = LOOK;

/** Shader additions (see paintWithWear, withSnow): declarations for the vertex shader, and what its main passes on. */
export const SNOW_VERTEX_DECL = /* glsl */ `
attribute float aSnow;
varying float vSnow;`;
export const SNOW_VERTEX = /* glsl */ `
vSnow = aSnow;`;

/** Fragment declarations; needs the shared noise (NOISE_GLSL) before it. */
export const SNOW_FRAGMENT_DECL = /* glsl */ `
uniform vec3 snowColor;
uniform vec3 snowSun;
uniform mat3 normalMatrix;
varying float vSnow;
// How much of this spot snow covers (0..1), for 'amount' of it there.
float snowCoverAt( vec3 p, float amount ) {
  if ( amount < 0.003 ) return 0.0;
  vec3 q = p * ${f(L.patchScale)};
  float patchy = 0.5 + 0.5 * ( 0.55 * wearNoise( q ) + 0.3 * wearNoise( q * 3.2 + 7.0 ) + 0.15 * wearNoise( q * 9.6 + 13.0 ) );
  float cover = smoothstep( patchy - ${f(L.edge)} * 0.5, patchy + ${f(L.edge)} * 0.5, amount * 1.4 );
  // Thin snow is specks of powder; they fill in as it thickens.
  float solid = smoothstep( ${f(L.solidFrom)}, ${f(L.solidTo)}, amount );
  vec3 sp = p * ${f(L.speckScale)};
  float speck = smoothstep( 0.55 - 0.5 * solid, 0.75 - 0.5 * solid, 0.5 + 0.5 * wearNoise( sp + 37.0 ) );
  // Specks smaller than a pixel would shimmer: from afar, their average share instead.
  speck = mix( speck, 0.3 + 0.6 * solid, smoothstep( 0.4, 1.0, length( fwidth( sp ) ) ) );
  return cover * mix( speck, 1.0, solid );
}
// The crust's height at p (≈ −1..1): lumps with grain on them.
float snowHeight( vec3 p ) {
  return ( 1.0 - ${f(L.grainShare)} ) * wearNoise( p * ${f(L.lumpScale)} + 3.0 ) + ${f(L.grainShare)} * wearNoise( p * ${f(L.grainScale)} + 21.0 );
}`;

/** After the colour (in roughnessmap_fragment): how much snow covers here, its colour and matte finish. */
export const SNOW_COLOR = /* glsl */ `
float snowCover = snowCoverAt( vWearRest, vSnow );
float snowThick = 0.0;
if ( snowCover > 0.0 ) {
  snowThick = smoothstep( 0.0, 0.6, vSnow ) * snowCover;
  float tone = 1.0 + ${f(L.tone)} * ( 0.6 * wearNoise( vWearRest * ${f(L.grainScale)} + 5.0 ) + 0.4 * wearNoise( vWearRest * ${f(L.lumpScale)} + 9.0 ) );
  diffuseColor.rgb = mix( diffuseColor.rgb, snowColor * tone, snowCover );
  // On glass, the snow is opaque.
  diffuseColor.a = mix( diffuseColor.a, 1.0, snowCover );
  roughnessFactor = mix( roughnessFactor, ${f(L.roughness)}, snowCover );
}`;

/** After metalnessmap_fragment: snow isn't metal. */
export const SNOW_METAL = /* glsl */ `
metalnessFactor = mix( metalnessFactor, 0.0, snowCover );`;

/** After normal_fragment_maps: the crust's lumps, bumped from its height's slope across the panel. */
export const SNOW_NORMAL = /* glsl */ `
if ( snowCover > 0.0 ) {
  const float e = 0.004;
  float h0 = snowHeight( vWearRest );
  vec3 slope = vec3( snowHeight( vWearRest + vec3( e, 0.0, 0.0 ) ), snowHeight( vWearRest + vec3( 0.0, e, 0.0 ) ), snowHeight( vWearRest + vec3( 0.0, 0.0, e ) ) ) - h0;
  // Into view space, and only its part along the surface tilts the normal.
  vec3 g = normalMatrix * ( slope / e ) * 0.01;
  g -= dot( g, normal ) * normal;
  normal = normalize( normal - ${f(L.bump)} * ( 0.4 + 0.6 * snowThick ) * g );
}`;

/** After emissivemap_fragment: now and then a facet of the crust mirrors the sun. */
export const SNOW_GLITTER = /* glsl */ `
if ( snowThick > 0.05 ) {
  vec3 cell = floor( vWearRest * ${f(L.glitterScale)} );
  vec3 tilt = vec3( wearHash( cell ), wearHash( cell + 17.0 ), wearHash( cell + 31.0 ) ) * 2.0 - 1.0;
  vec3 facet = normalize( normal + ${f(L.glitterTilt)} * normalMatrix * tilt );
  vec3 sunView = normalize( ( viewMatrix * vec4( snowSun, 0.0 ) ).xyz );
  float lined = max( dot( reflect( -normalize( vViewPosition ), facet ), sunView ), 0.0 );
  totalEmissiveRadiance += snowColor * ${f(L.glitter)} * pow( lined, ${f(L.glitterSharp)} ) * snowThick;
}`;

/** The look's colour, for the shader's uniform. */
export const SNOW_LOOK_COLOR = LOOK.color;
