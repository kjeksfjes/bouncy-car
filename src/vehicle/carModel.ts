import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bendEnds, buildPanels, endShift, sample, sideHalfWidth, type Bumper, type CarBlueprint, type Panels } from './blueprint';
import type { CarConfig } from './carConfig';
import type { LightFixtureDef, LightKind } from './lights';
import { engineParts } from './engine';
import { addWearAttributes, paintWithWear } from './paintWear';
import { addSnowAttributes, withSnow } from './snowCover';
import { Linkage, underbodyParts } from './underbody';
import { softDotTexture } from '../render/smoke';

/**
 * The glow round a lit lamp (there's no bloom to give one): light falling on the body round the
 * lens, a soft patch lying flat on it in the lens's plane, `size` times the lens, added onto what's
 * there at `opacity`. Drawn just in front of the body (so its facets don't cut it). The brake
 * lights glow while braking; the headlights, on all the time (as running lights), softly and warm.
 * Feel values.
 */
const BRAKE_GLOW = { colour: '#ff1a0a', size: { x: 1.4, y: 2.4 }, opacity: 0.6 };
const HEAD_GLOW = { colour: '#ffe2a8', size: 3.2, opacity: 0.45 };

/**
 * A round headlamp seen through its glass, drawn once and shared: a dark rim, the reflector
 * brightening toward the middle, the glass's faint rings and flutes, and the bulb's bright spot.
 */
let headlampLook: THREE.Texture | null = null;
function headlampTexture(): THREE.Texture {
  if (headlampLook) return headlampLook;
  const n = 128;
  const c = n / 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = n;
  const g = canvas.getContext('2d')!;
  const reflector = g.createRadialGradient(c, c, 0, c, c, c);
  reflector.addColorStop(0, '#fffaf0');
  reflector.addColorStop(0.5, '#eee7d6');
  reflector.addColorStop(0.86, '#b9b1a0');
  reflector.addColorStop(0.94, '#77716a');
  reflector.addColorStop(1, '#4a4743');
  g.fillStyle = reflector;
  g.fillRect(0, 0, n, n);
  g.save();
  g.beginPath();
  g.arc(c, c, c * 0.88, 0, Math.PI * 2);
  g.clip();
  g.strokeStyle = 'rgb(90 80 60 / 0.3)';
  g.lineWidth = 1.5;
  for (const r of [0.22, 0.4, 0.58, 0.74]) {
    g.beginPath();
    g.arc(c, c, c * r, 0, Math.PI * 2);
    g.stroke();
  }
  g.strokeStyle = 'rgb(90 80 60 / 0.14)';
  for (let x = 6; x < n; x += 9) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, n);
    g.stroke();
  }
  g.restore();
  const bulb = g.createRadialGradient(c, c, 0, c, c, c * 0.2);
  bulb.addColorStop(0, 'rgb(255 255 255 / 1)');
  bulb.addColorStop(1, 'rgb(255 255 255 / 0)');
  g.fillStyle = bulb;
  g.fillRect(0, 0, n, n);
  headlampLook = new THREE.CanvasTexture(canvas);
  headlampLook.colorSpace = THREE.SRGBColorSpace;
  return headlampLook;
}

/** A dentable mesh on the car. Detachable pieces can be knocked off. */
export interface CarPiece {
  name: string;
  mesh: THREE.Mesh;
  /** Rest-state vertex positions (piece-local), as built. */
  original: Float32Array;
  /** Car-local position of the piece's origin as built (its mesh moves off the car once it breaks loose). */
  origin: THREE.Vector3;
  /** Doesn't crumple: the crush moves it as a whole, by the displacement at its origin (the engine). */
  rigid: boolean;
  /** Rest shape after crumple-zone crush (see Crush); dents are capped against it. */
  base: Float32Array;
  /** Car-local bounds at build time, for hit proximity. */
  bounds: THREE.Box3;
  detachable: boolean;
  /** Debris mass (kg) once it's knocked off without a hinge. */
  mass: number;
  /** Another piece this one is mounted on (mirrors on doors); it only takes hits while that one is closed. */
  rides?: string;
  /** closed = on the car and dentable; hinged = hanging on its hinge; gone = torn off. */
  state: 'closed' | 'hinged' | 'gone';
  hp: number;
  /** Where a detachable panel hangs once it breaks loose. */
  hinge?: HingeSpec;
  /** Set for glass panes, which crack and shatter instead of denting. */
  glass?: GlassPane;
}

export interface GlassPane {
  /** Planar UV projection of the pane (geometry-local), for placing the crack pattern. */
  u: THREE.Vector3;
  v: THREE.Vector3;
  min: THREE.Vector2;
  size: THREE.Vector2;
  /** The cracked material, once cracked. */
  cracked: THREE.Material | null;
  /** A pane that rides on another piece (door glass on its door) and shatters when that tears off. */
  follows?: string;
}

/** Tint of intact glass; cracked panes reuse it under the crack pattern. */
export const GLASS_TINT = '#1e2a33';
/** Per surface; solidified panes have two surfaces, so they look about twice as dark. */
export const GLASS_OPACITY = 0.45;

/** A revolute hinge in car-local space. Angles are relative to the closed position. */
export interface HingeSpec {
  anchor: THREE.Vector3;
  axis: THREE.Vector3;
  min: number;
  max: number;
  /** Panel mass (kg) once it hangs as its own body. */
  mass: number;
  /** Hinge friction (motor damping factor). */
  damping: number;
  /** Bumpers: the hinge flips to the far end when the anchor end is the one that's hit. */
  mirrorable?: boolean;
}

export interface WheelVisual {
  /** Positioned at the wheel centre; yaws for steering. */
  pivot: THREE.Group;
  /** Child of pivot; rolls about X. */
  spin: THREE.Group;
  /** Chrome cover on the outer face (child of spin); pops off on hard knocks. */
  hubcap: THREE.Mesh;
}

export interface CarModel {
  root: THREE.Group;
  pieces: CarPiece[];
  wheels: WheelVisual[];
  lights: LightFixtureDef[];
  /** Lens material once a light is smashed, per kind. */
  smashedLens: Record<LightKind, THREE.Material>;
  /** The taillight lenses' own lamp, this car's alone, lit while it brakes (see Car.syncVisual). */
  brakeLight: THREE.MeshStandardMaterial;
  /** The headlight lenses' own lamp, this car's alone, lit while its headlights are on. */
  headLight: THREE.MeshStandardMaterial;
  /**
   * A glow round each lamp, with its lens and the lens's lit material (it glows only while the lens
   * has that: not once smashed); the brake lights' only while braking, the headlights' while on.
   */
  lampGlows: { glow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>; lens: THREE.Mesh; lamp: THREE.Material; brake: boolean }[];
  /** Axle, driveshaft and A-arms that follow the wheels (see Linkage). */
  linkage: Linkage;
}

interface CarMaterials {
  paint: THREE.Material;
  /** The inside of painted panels in the engine bay and trunk: the paint in shade (see LINING). */
  lining: THREE.Material;
  /** The inside of painted panels round the cabin: dark trim. */
  trim: THREE.Material;
  /** Painted sheet metal in the engine bay (aprons, strut towers, radiator support): the lining's shade, evenly. */
  bay: THREE.Material;
  glass: THREE.Material;
  chrome: THREE.Material;
  steel: THREE.Material;
  dark: THREE.Material;
  /** Inside the lamp openings (recess walls, side marker sockets, headlight buckets): dark, but snow doesn't settle down there. */
  recess: THREE.Material;
  tire: THREE.Material;
  headlight: THREE.Material;
  taillight: THREE.Material;
  marker: THREE.Material;
  /** Smashed lenses: a bare reflector bowl for headlights, unlit coloured plastic for the rest. */
  brokenHead: THREE.Material;
  brokenTail: THREE.Material;
  brokenMarker: THREE.Material;
  /** Engine: cast-iron block and oil pan, painted valve covers, bare aluminium (intake, air cleaner, alternator), heat-bleached headers, the coolant tank's plastic. */
  engineBlock: THREE.Material;
  valveCover: THREE.Material;
  aluminium: THREE.Material;
  header: THREE.Material;
  coolantTank: THREE.Material;
  radiator: THREE.Material;
  upholstery: THREE.Material;
  plate: THREE.Material;
  /** Unpainted cast and galvanised metal: gearbox, differential, fuel tank. */
  alloy: THREE.Material;
}

/** Pieces the crush moves as a whole instead of crumpling: an engine block doesn't fold. */
const RIGID = new Set(['engine']);

/** Glass panes (from the blueprint's part names). */
const GLASS = /glass|windshield/;

/**
 * Projects a pane onto its own plane and stores the result as UVs, so a crack
 * texture can be centred on a hit point. The basis comes from the pane's
 * average facing (inner faces are flipped to agree with the outer ones).
 */
function planarProjection(geometry: THREE.BufferGeometry): GlassPane {
  const pos = geometry.getAttribute('position');
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  const sum = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1).sub(a);
    c.fromBufferAttribute(pos, i + 2).sub(a);
    n.crossVectors(b, c);
    sum.addScaledVector(n, sum.dot(n) < 0 ? -1 : 1);
  }
  const normal = sum.normalize();
  const u = new THREE.Vector3().crossVectors(normal, Math.abs(normal.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
  const v = new THREE.Vector3().crossVectors(normal, u);
  const uv = new Float32Array(pos.count * 2);
  const min = new THREE.Vector2(Infinity, Infinity);
  const max = new THREE.Vector2(-Infinity, -Infinity);
  for (let i = 0; i < pos.count; i++) {
    a.fromBufferAttribute(pos, i);
    uv[i * 2] = a.dot(u);
    uv[i * 2 + 1] = a.dot(v);
    min.min(new THREE.Vector2(uv[i * 2], uv[i * 2 + 1]));
    max.max(new THREE.Vector2(uv[i * 2], uv[i * 2 + 1]));
  }
  const size = max.clone().sub(min);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (uv[i * 2] - min.x) / size.x;
    uv[i * 2 + 1] = (uv[i * 2 + 1] - min.y) / size.y;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return { u, v, min, size, cracked: null };
}

/** Body parts that can be knocked off. Everything else stays on and only dents. */
/** Small trim that gets knocked clean off: fewer hit points, light debris. */
const TRIM = new Set([
  'grille', 'plate-front', 'mirror-left', 'mirror-right', 'exhaust-tip-left', 'exhaust-tip-right', 'plate-rear', 'filler-cap',
]);
const DETACHABLE = new Set(['hood', 'trunk', 'door-left', 'door-right', 'bumper-front', 'bumper-rear', ...TRIM]);
const PANEL_MASS = 20;
const TRIM_MASS = 3;

// The lofted, solidified body is identical for every car of a blueprint, so it's built once.
// Each car still gets its own geometry buffers (copied from these arrays) to dent.
const panelCache = new WeakMap<CarBlueprint, Panels>();
function panelsFor(bp: CarBlueprint): Panels {
  let panels = panelCache.get(bp);
  if (!panels) panelCache.set(bp, (panels = buildPanels(bp)));
  return panels;
}

/**
 * The painted inside of the engine bay and trunk, shaded as the pit it is (nothing here darkens a
 * cavity on its own): the paint × `shade` (linear) at the deck, down to × `shade` × `floorShade`
 * at the rocker, and matte. The bay's own sheet metal (see engineParts) is evenly `bayShade` of
 * the paint. Feel values.
 */
const LINING = { shade: 0.3, floorShade: 0.35, bayShade: 0.24, roughness: 0.7 };

/**
 * Vertex colours for a part's surfaces, white except the lining: darker the lower it sits between
 * rocker and deck (shading the lining material, see LINING; other materials ignore them).
 */
function liningShade(bp: CarBlueprint, positions: number[], lining: boolean): THREE.Float32BufferAttribute {
  const colors = new Float32Array(positions.length).fill(1);
  if (lining) {
    for (let i = 0; i < positions.length; i += 3) {
      const z = positions[i + 2];
      const rocker = sample(bp.rocker, z);
      const h = (positions[i + 1] - bp.groundY - rocker) / (sample(bp.deck, z) - rocker);
      const k = LINING.shade * THREE.MathUtils.lerp(LINING.floorShade, 1, THREE.MathUtils.smoothstep(h, 0, 1));
      colors[i] = colors[i + 1] = colors[i + 2] = k;
    }
  }
  return new THREE.Float32BufferAttribute(colors, 3);
}

// Materials are shared between every car built from the same config and paint (and their
// debris), so they are never disposed with an individual car.
const materialCache = new WeakMap<CarConfig, Map<string, CarMaterials>>();

function materialsFor(cfg: CarConfig, paint: string): CarMaterials {
  let byPaint = materialCache.get(cfg);
  if (!byPaint) materialCache.set(cfg, (byPaint = new Map()));
  let m = byPaint.get(paint);
  if (!m) {
    const std = (color: string, extra: THREE.MeshStandardMaterialParameters = {}) =>
      new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.55, metalness: 0.1, ...extra });
    // Panels are solid (see solidify), so ordinary front-face rendering is enough.
    const paintLook = { roughness: 0.4, metalness: 0.25 };
    const paintMaterial = std(paint, paintLook);
    // Chips and scratches (see paintWear).
    paintWithWear(paintMaterial);
    m = {
      paint: paintMaterial,
      lining: std(paint, { roughness: LINING.roughness, metalness: 0.1, vertexColors: true }),
      trim: std('#2a2b2f', { roughness: 0.75 }),
      bay: std(paint, { color: new THREE.Color(paint).multiplyScalar(LINING.bayShade), roughness: LINING.roughness, metalness: 0.1 }),
      glass: std(GLASS_TINT, { roughness: 0.05, metalness: 0.5, transparent: true, opacity: GLASS_OPACITY }),
      chrome: std('#d9dde2', { roughness: 0.2, metalness: 0.9 }),
      steel: std('#4b5056', { roughness: 0.5, metalness: 0.6 }),
      dark: std('#1c1d20', { roughness: 0.7 }),
      recess: std('#1c1d20', { roughness: 0.7 }),
      tire: std('#1a1a1c', { roughness: 0.9 }),
      headlight: std('#ffffff', { map: headlampTexture(), emissive: '#ffe9bd', emissiveMap: headlampTexture(), emissiveIntensity: 0.7, roughness: 0.25 }),
      taillight: std('#a3121b', { emissive: '#7a0a10', emissiveIntensity: 0.5 }),
      marker: std('#e08a1e', { emissive: '#7a4208', emissiveIntensity: 0.4 }),
      brokenHead: std('#c3c9cf', { roughness: 0.35, metalness: 0.8 }),
      brokenTail: std('#5a1418', { roughness: 0.6 }),
      brokenMarker: std('#7a4a14', { roughness: 0.6 }),
      engineBlock: std('#2c2d31', { roughness: 0.65, metalness: 0.35 }),
      valveCover: std('#df6328', { roughness: 0.45, metalness: 0.15 }),
      aluminium: std('#b7bdc4', { roughness: 0.45, metalness: 0.5 }),
      header: std('#d6d0c6', { roughness: 0.55, metalness: 0.3 }),
      coolantTank: std('#d9cfb5', { roughness: 0.7 }),
      radiator: std('#5c5f63', { roughness: 0.6, metalness: 0.4 }),
      upholstery: std('#5a2e24', { roughness: 0.75 }),
      plate: std('#e6e1cc', { roughness: 0.6 }),
      alloy: std('#8b8e91', { roughness: 0.45, metalness: 0.5 }),
    };
    // Snow settles on the outside's other surfaces too (the paint has it built in).
    for (const outside of [m.glass, m.chrome, m.trim, m.dark, m.plate, m.steel]) withSnow(outside as THREE.MeshStandardMaterial);
    byPaint.set(paint, m);
  }
  return m;
}

/**
 * Hinges along the blueprint's cut lines: doors at their front edge (swing out),
 * hood at the windshield and trunk at the rear glass (open upward), bumpers at
 * one end (dangle). Masses and friction are feel values.
 *
 * A hanging panel doesn't collide with its own car, so its closed-side limit stops
 * a little short of fully shut (`ajar`); otherwise airflow or gravity pressing it
 * against the limit pushes it slightly into the body.
 */
function hingesFor(cfg: CarConfig): Record<string, HingeSpec> {
  const bp = cfg.blueprint;
  const v = (x: number, h: number, z: number) => new THREE.Vector3(x, h + bp.groundY, z);
  const X = new THREE.Vector3(1, 0, 0);
  const Y = new THREE.Vector3(0, 1, 0);
  const Z = new THREE.Vector3(0, 0, 1);
  const doorZ = bp.door[0];
  const doorH = (sample(bp.rocker, doorZ) + sample(bp.deck, doorZ)) / 2;
  const doorX = sideHalfWidth(bp, doorZ, doorH);
  const ajar = 0.05;
  const door = { axis: Y, mass: 35, damping: 4 };
  const lid = { axis: X, damping: 3 };
  const bumper = { axis: Z, min: ajar, max: 1.4, mass: 15, damping: 1, mirrorable: true };
  // A bumper hangs from its corner, near where the straight part turns into the wrap.
  const bumperAnchor = (spec: Bumper, z: number) => v(0.95, spec.h, z + endShift(bp, 0.95, spec.h, z));
  return {
    'door-right': { ...door, anchor: v(doorX, doorH, doorZ), min: ajar, max: 1.2 },
    'door-left': { ...door, anchor: v(-doorX, doorH, doorZ), min: -1.2, max: -ajar },
    hood: { ...lid, anchor: v(0, sample(bp.deck, bp.hood[1]), bp.hood[1]), min: ajar, max: 1.25, mass: 25 },
    trunk: { ...lid, anchor: v(0, sample(bp.deck, bp.trunk[0]), bp.trunk[0]), min: -1.25, max: -ajar, mass: 20 },
    'bumper-front': { ...bumper, anchor: bumperAnchor(bp.bumpers.front, bp.front - bp.bumpers.front.gap) },
    'bumper-rear': { ...bumper, anchor: bumperAnchor(bp.bumpers.rear, bp.rear + bp.bumpers.rear.gap) },
  };
}

/**
 * The bumper's section as (out, up) pairs, as fractions of its depth and height: a flat top and
 * bottom, a vertical face, and chamfers between them. A flat chrome face just mirrors one patch
 * of sky and reads as pale plastic; the chamfers catch light and shadow.
 */
const BUMPER_SECTION: readonly (readonly [number, number])[] = [
  [-0.5, 0.5], [0.2, 0.5], [0.5, 0.25], [0.5, -0.25], [0.2, -0.5], [-0.5, -0.5],
];

/**
 * A bumper (see Bumper) in car-local space, before the end shapes: its section swept along the
 * path in plan, subdivided so it bends with dents and crush, with the guards merged in.
 */
function bumperGeometry(bp: CarBlueprint, end: 'front' | 'rear'): THREE.BufferGeometry {
  const spec = bp.bumpers[end];
  const { halfStraight: S, wrapRadius: R, wrapReturn: B } = spec;
  // Path points in plan as (x, d, normal x, normal d): d runs back toward the car, the normal
  // points away from it. Right half: straight, corner arc, return; mirrored for the left.
  const half: [number, number, number, number][] = [];
  for (let i = 0; i <= 8; i++) half.push([(S * i) / 8, 0, 0, -1]);
  for (let i = 1; i <= 4; i++) {
    const a = (i / 4) * (Math.PI / 2);
    half.push([S + R * Math.sin(a), R - R * Math.cos(a), Math.sin(a), -Math.cos(a)]);
  }
  for (let i = 1; i <= 2; i++) half.push([S + R, R + (B * i) / 2, 1, 0]);
  const path = [...half.slice(1).reverse().map(([x, d, nx, nd]) => [-x, d, -nx, nd]), ...half];

  const zc = end === 'front' ? bp.front - spec.gap : bp.rear + spec.gap;
  const back = end === 'front' ? 1 : -1;
  const y0 = spec.h + bp.groundY;
  /** Rises the lower half of the section over the plate (none at the top edge). */
  const lift = (x: number, up: number) => {
    const n = spec.notch;
    if (!n) return 0;
    const k = 1 - THREE.MathUtils.smoothstep(Math.abs(x), n.halfWidth, n.halfWidth + 0.04);
    return n.rise * k * (0.5 - up);
  };
  const rings = path.map(([x, d, nx, nd]) =>
    BUMPER_SECTION.map(([out, up]) => {
      const u = out * spec.depth;
      const px = x + nx * u;
      return new THREE.Vector3(px, y0 + up * spec.height + lift(px, up), zc + back * (d + nd * u));
    }),
  );
  const centres = rings.map((ring) => ring.reduce((c, p) => c.add(p), new THREE.Vector3()).divideScalar(ring.length));

  const positions: number[] = [];
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  // Winds each triangle so it faces away from `ref` (a point inside the bumper).
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, ref: THREE.Vector3) => {
    const n = ab.subVectors(b, a).cross(ac.subVectors(c, a));
    const flip = n.dot(ac.copy(a).add(b).add(c).divideScalar(3).sub(ref)) < 0;
    for (const p of flip ? [a, c, b] : [a, b, c]) positions.push(p.x, p.y, p.z);
  };
  const m = BUMPER_SECTION.length;
  for (let i = 0; i < rings.length - 1; i++) {
    const ref = centres[i].clone().add(centres[i + 1]).multiplyScalar(0.5);
    for (let j = 0; j < m; j++) {
      const k = (j + 1) % m;
      tri(rings[i][j], rings[i + 1][j], rings[i + 1][k], ref);
      tri(rings[i][j], rings[i + 1][k], rings[i][k], ref);
    }
  }
  // End caps (the section is convex, so a fan), facing away from the neighbouring ring.
  for (const [i, next] of [[0, 1], [rings.length - 1, rings.length - 2]]) {
    for (let j = 1; j < m - 1; j++) tri(rings[i][0], rings[i][j], rings[i][j + 1], centres[next]);
  }
  const sweep = new THREE.BufferGeometry();
  sweep.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

  // Guards: 6-sided (faceted) posts standing proud of the face.
  const g = spec.guards;
  const parts = [sweep];
  for (const side of [-1, 1]) {
    const post = new THREE.CylinderGeometry(0.025, 0.025, g.top - g.bottom, 6, 3)
      .scale(1, 1, 1.2)
      .translate(side * g.x, (g.top + g.bottom) / 2 + bp.groundY, zc - back * (spec.depth / 2 + 0.01))
      .toNonIndexed();
    post.deleteAttribute('normal');
    post.deleteAttribute('uv');
    parts.push(post);
  }
  const merged = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  if (!merged) throw new Error(`Bumper "${end}" failed to merge`);
  return merged;
}

/**
 * A 5-spoke chrome hubcap: rolled outer lip, twisted spokes dished toward a raised centre cap,
 * open between the spokes so the steel wheel and lug nuts show through. Built around +Y, then
 * turned so its face points out along the axle (+X on the right, −X on the left). The spokes
 * sit between the lug nuts (which are at 0°, 72°, … around the axle).
 */
function hubcapGeometry(radius: number, side: number): THREE.BufferGeometry {
  const r = radius;
  const parts: THREE.BufferGeometry[] = [];
  // Rolled lip: (radius, height) profile swept around the axle.
  const lip = [[1, 0], [1.03, 0.04], [0.98, 0.08], [0.84, 0.085], [0.8, 0.05]].map(([u, h]) => new THREE.Vector2(u * r, h * r));
  parts.push(new THREE.LatheGeometry(lip, 15));
  // Spokes: tapered slats, widening toward the lip, twisted about their length and dished.
  const slat = new THREE.Shape([
    new THREE.Vector2(0.2 * r, -0.07 * r),
    new THREE.Vector2(0.85 * r, -0.15 * r),
    new THREE.Vector2(0.85 * r, 0.15 * r),
    new THREE.Vector2(0.2 * r, 0.07 * r),
  ]);
  // Lug nuts sit at 0°, 72°, …; the frame turns differently per side, so the offset differs.
  const offset = side > 0 ? 0 : Math.PI / 5;
  for (let i = 0; i < 5; i++) {
    parts.push(
      new THREE.ExtrudeGeometry(slat, { depth: 0.06 * r, bevelEnabled: false })
        .rotateX(Math.PI / 2) // shape's width onto Z, thickness along −Y
        .rotateX(0.35) // twist: facets catch the light
        .rotateZ(-0.14) // dish: the hub end stands proud of the lip
        .translate(0, 0.14 * r, 0)
        .rotateY(offset + (i * 2 * Math.PI) / 5),
    );
  }
  // Raised centre cap.
  parts.push(new THREE.CylinderGeometry(0.2 * r, 0.24 * r, 0.1 * r, 10).translate(0, 0.17 * r, 0));
  const merged = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)).map((g) => {
    g.deleteAttribute('uv');
    return g;
  }));
  parts.forEach((g) => g.dispose());
  if (!merged) throw new Error('Hubcap failed to merge');
  return merged.rotateZ(side > 0 ? -Math.PI / 2 : Math.PI / 2);
}

/** Pieces inside the car, by name, that snow never reaches (see snowCover): the cabin, the engine bay's engine and the spare in the boot. */
const SNOW_INSIDE = /^(interior|engine|spare)/;

/** Builds the car from its blueprint: lofted body parts plus lights, grille, bumpers and wheels. */
export function buildCarModel(cfg: CarConfig, paint: string): CarModel {
  const mat = materialsFor(cfg, paint);
  const bp = cfg.blueprint;
  const gy = bp.groundY;
  const root = new THREE.Group();
  const pieces: CarPiece[] = [];
  const hinges = hingesFor(cfg);

  /** Adds a piece. Geometry is recentred on its bounds so the mesh position is the part's centre. */
  const add = (
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material | THREE.Material[],
    at?: THREE.Vector3,
  ) => {
    geometry.computeBoundingBox();
    const center = at ?? geometry.boundingBox!.getCenter(new THREE.Vector3());
    if (!at) geometry.translate(-center.x, -center.y, -center.z);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(center);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    const glass = GLASS.test(name) ? planarProjection(geometry) : undefined;
    const original = Float32Array.from(geometry.getAttribute('position').array);
    if (Array.isArray(material) ? material.includes(mat.paint) : material === mat.paint) addWearAttributes(geometry, original);
    if (!SNOW_INSIDE.test(name)) addSnowAttributes(geometry, original);
    pieces.push({
      name,
      mesh,
      original,
      origin: mesh.position.clone(),
      rigid: RIGID.has(name),
      base: Float32Array.from(geometry.getAttribute('position').array),
      bounds: geometry.boundingBox!.clone().translate(mesh.position),
      detachable: DETACHABLE.has(name),
      state: 'closed',
      hp: glass ? cfg.damage.glassHp : TRIM.has(name) ? cfg.damage.trimHp : cfg.damage.partHp,
      mass: TRIM.has(name) ? TRIM_MASS : PANEL_MASS,
      hinge: hinges[name],
      glass,
    });
  };

  // Lofted body parts, one mesh per part with a material group per surface type.
  for (const [part, byMaterial] of panelsFor(bp)) {
    const geos: THREE.BufferGeometry[] = [];
    const materials: THREE.Material[] = [];
    for (const [m, positions] of byMaterial) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      g.setAttribute('color', liningShade(bp, positions, m === 'lining'));
      geos.push(g);
      materials.push(mat[m]);
    }
    const merged = mergeGeometries(geos, true);
    if (!merged) throw new Error(`Body part "${part}" failed to merge`);
    add(part, merged, materials);
  }

  // Door windows and mirrors ride on their doors: they swing and fly off with them.
  for (const side of ['left', 'right']) {
    const door = pieces.find((p) => p.name === `door-${side}`)!;
    const pane = pieces.find((p) => p.name === `door-glass-${side}`)!;
    door.mesh.attach(pane.mesh);
    pane.glass!.follows = door.name;
    const mirror = pieces.find((p) => p.name === `mirror-${side}`)!;
    door.mesh.attach(mirror.mesh);
    mirror.rides = door.name;
  }

  const box = (w: number, h: number, d: number, segX = 1) => new THREE.BoxGeometry(w, h, d, segX, 1, 1);
  const at = (x: number, h: number, z: number) => new THREE.Vector3(x, h + gy, z);
  /** A point at an end of the car: `at`, moved by the end shapes like the panels around it. */
  const onEnd = (x: number, h: number, z: number) => at(x, h, z + endShift(bp, x, h, z));

  // Chrome bumpers, wrapping round the corners. A bumper is rigid: it follows the end shape at
  // its own centre height (the V in plan), not the lean of the panel behind it, or its face and
  // guards would kink back with the receding valance.
  for (const end of ['front', 'rear'] as const) {
    const geometry = bumperGeometry(bp, end);
    const pos = geometry.getAttribute('position');
    const h = bp.bumpers[end].h;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, pos.getZ(i) + endShift(bp, pos.getX(i), h, pos.getZ(i)));
    add(`bumper-${end}`, geometry, mat.chrome);
  }

  // Lights are rigid fixtures (see CarLights), posed relative to their mount point. Headlights sit
  // in the nose's recessed surround and taillights in their own openings (see the blueprint's
  // openings); side markers get a dark socket patch just proud of the body surface instead.
  const lights: LightFixtureDef[] = [];
  const fixture = (
    name: string,
    kind: LightKind,
    mount: THREE.Vector3,
    normal: THREE.Vector3,
    parts: [THREE.BufferGeometry, THREE.Material, THREE.Vector3][],
    socketGeometry?: THREE.BufferGeometry,
  ) => {
    const group = new THREE.Group();
    group.position.copy(mount);
    const meshes = parts.map(([geometry, material, offset]) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(offset);
      mesh.castShadow = true;
      group.add(mesh);
      return mesh;
    });
    root.add(group);
    let socket: THREE.Mesh | undefined;
    if (socketGeometry) {
      socket = new THREE.Mesh(socketGeometry, mat.recess);
      socket.position.copy(mount).addScaledVector(normal, 0.003);
      root.add(socket);
    }
    // The lens is the last part (the ring, if any, comes first).
    lights.push({ name, kind, group, lens: meshes[meshes.length - 1], socket, normal });
  };
  /**
   * Tilt (about X) of the end panel at `z` (front or rear) at (x, h): the slope the end shape
   * gives it. rotateX(tilt) lines a part's local Y axis up with the panel.
   */
  const endTilt = (z: number, x: number, h: number) =>
    Math.atan((endShift(bp, x, h + 0.01, z) - endShift(bp, x, h - 0.01, z)) / 0.02);
  /** The rear-facing direction tilted by `tilt` about X (what +Z becomes under rotateX(tilt)). */
  const facingAt = (tilt: number) => new THREE.Vector3(0, -Math.sin(tilt), Math.cos(tilt));
  /** One half (`up` = 1 upper, −1 lower) of a w × h rounded rectangle, cut across its middle with a `seam` gap. */
  const lensHalf = (w: number, h: number, r: number, seam: number, up: number) => {
    const shape = new THREE.Shape();
    const y = (v: number) => up * v;
    shape.moveTo(-w / 2, y(seam / 2));
    shape.lineTo(w / 2, y(seam / 2));
    shape.lineTo(w / 2, y(h / 2 - r));
    shape.absarc(w / 2 - r, y(h / 2 - r), r, 0, up * Math.PI / 2, up < 0);
    shape.lineTo(-w / 2 + r, y(h / 2));
    shape.absarc(-w / 2 + r, y(h / 2 - r), r, up * Math.PI / 2, up * Math.PI, up < 0);
    shape.lineTo(-w / 2, y(seam / 2));
    return shape;
  };
  const extrude = (shape: THREE.Shape, depth: number) =>
    new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 3 });
  const disc = (r: number, depth: number) => new THREE.CylinderGeometry(r, r, depth, 10).rotateX(Math.PI / 2);
  const forward = new THREE.Vector3(0, 0, -1);
  const lampGlows: CarModel['lampGlows'] = [];
  const glowMaterial = (look: { colour: string; opacity: number }) =>
    new THREE.MeshBasicMaterial({
      map: softDotTexture(),
      color: look.colour,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: look.opacity,
      depthWrite: false,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
  /**
   * Adds a glow (`geometry`, built round the mount in car-local orientation) for the fixture just
   * made. On the body at the lamp's mount rather than in the lamp, so the lamp's size (its hit box,
   * see CarLights) stays its own; and light, not a thing, so the photo camera's point picking looks past it.
   */
  const addGlow = (geometry: THREE.PlaneGeometry, material: THREE.MeshBasicMaterial, brake: boolean) => {
    const { group, lens } = lights[lights.length - 1];
    const glow = new THREE.Mesh(geometry, material);
    glow.visible = false;
    glow.raycast = () => {};
    glow.position.copy(group.position);
    root.add(glow);
    lampGlows.push({ glow, lens, lamp: lens.material as THREE.Material, brake });
  };
  // On the flat surround, behind the lens and ring (so they cover its middle): nothing to win against.
  // This car's own, so its headlights switch on and off by themselves (see Car.syncVisual).
  const headLight = (mat.headlight as THREE.MeshStandardMaterial).clone();
  const headGlow = glowMaterial(HEAD_GLOW);
  headGlow.polygonOffset = false;
  // Headlights at the surround's face: a dark bucket reaching back to the recess's back wall (so
  // they don't float in the cavity), a chrome ring and the lens. The ring is a torus with a
  // 4-sided (diamond) tube, faceted so it catches light: a flat chrome face reads as pale plastic.
  const head = bp.openings.head;
  for (const side of [-1, 1]) {
    for (const hx of head.x) {
      const x = side * hx;
      const r = head.radius;
      fixture(`headlight-${x}`, 'head', onEnd(x, head.h, bp.front), forward, [
        [new THREE.CylinderGeometry(r * 1.05, r * 1.05, 0.045, 10).rotateX(Math.PI / 2), mat.recess, new THREE.Vector3(0, 0, 0.035)],
        [new THREE.TorusGeometry(r * 1.08, 0.009, 4, 10), mat.chrome, new THREE.Vector3(0, 0, -0.004)],
        [disc(r * 0.98, 0.03), headLight, new THREE.Vector3(0, 0, 0.01)],
      ]);
      // Facing forward (−Z), just in front of the surround's face, behind the lens's.
      addGlow(new THREE.PlaneGeometry(r * HEAD_GLOW.size, r * HEAD_GLOW.size).rotateY(Math.PI).translate(0, 0, -0.002), headGlow, false);
    }
  }
  // Taillights: a red lens in two sections (upper and lower, with a seam where the dark recess
  // shows through), one per side in its own rounded opening. The lens is a little smaller than
  // the opening, so the recess also shows as a thin outline around it. Tilted back with the
  // leaning tail panel (built facing +Z, then tilted).
  const tail = bp.openings.tail;
  const origin = new THREE.Vector3();
  const brakeLight = (mat.taillight as THREE.MeshStandardMaterial).clone();
  const brakeGlow = glowMaterial(BRAKE_GLOW);
  const SEAM = 0.006;
  for (const side of [-1, 1]) {
    const tilt = endTilt(bp.rear, side * tail.x, tail.h);
    const w = tail.width - 0.008;
    const h = tail.height - 0.008;
    const r = tail.radius - 0.004;
    // Nearly flush: 8 mm proud of the panel, the rest down in the recess.
    const halves = [1, -1].map((up) => extrude(lensHalf(w, h, r, SEAM, up), 0.03).translate(0, 0, -0.022));
    const lens = mergeGeometries(halves);
    halves.forEach((g) => g.dispose());
    if (!lens) throw new Error('Taillight lens failed to merge');
    const facing = facingAt(tilt);
    fixture(`taillight-${side}`, 'tail', onEnd(side * tail.x, tail.h, bp.rear), facing, [
      [lens.rotateX(tilt), brakeLight, origin],
    ]);
    // Built facing +Z like the lens, at the panel's face (the lens stands 8 mm proud of it), then tilted.
    addGlow(new THREE.PlaneGeometry(tail.width * BRAKE_GLOW.size.x, tail.height * BRAKE_GLOW.size.y).translate(0, 0, 0.002).rotateX(tilt), brakeGlow, true);
  }
  for (const side of [-1, 1]) {
    const out = new THREE.Vector3(side, 0, 0);
    const zf = bp.front + 0.25;
    const zr = bp.rear - 0.25;
    fixture(`marker-front-${side}`, 'marker', onEnd(side * sideHalfWidth(bp, zf, 0.72), 0.72, zf), out, [
      [box(0.02, 0.05, 0.14), mat.marker, new THREE.Vector3(side * 0.01, 0, 0)],
    ], box(0.01, 0.045, 0.13));
    fixture(`marker-rear-${side}`, 'tail', onEnd(side * sideHalfWidth(bp, zr, 0.74), 0.74, zr), out, [
      [box(0.02, 0.05, 0.14), mat.taillight, new THREE.Vector3(side * 0.01, 0, 0)],
    ], box(0.01, 0.045, 0.13));
  }

  /** Merges positioned primitives into one dentable piece with a material group each. */
  const assemble = (name: string, parts: [THREE.BufferGeometry, THREE.Material][]) => {
    const merged = mergeGeometries(parts.map(([g]) => g), true);
    if (!merged) throw new Error(`Piece "${name}" failed to merge`);
    parts.forEach(([g]) => g.dispose());
    add(name, merged, parts.map(([, m]) => m));
  };
  // The grille: horizontal bars over a dark backing, down in the surround's recess, covering the
  // hole into the engine bay. Subdivided across so it bends with the V nose and a crumpled one.
  const grille = bp.openings.grille;
  const barLength = grille.width + 0.02;
  const grilleParts: [THREE.BufferGeometry, THREE.Material][] = [
    [box(grille.width + 0.04, grille.height + 0.03, 0.015, 8).translate(0, grille.h + gy, bp.front + 0.035), mat.dark],
  ];
  for (let i = 0; i < 5; i++) {
    const h = grille.h + (i - 2) * (grille.height / 5);
    // Diamond-section bars (4-sided cylinders along X), like the headlight rings.
    grilleParts.push([new THREE.CylinderGeometry(0.008, 0.008, barLength, 4, 8).rotateZ(Math.PI / 2).translate(0, h + gy, bp.front + 0.02), mat.steel]);
  }
  grilleParts.forEach(([g]) => bendEnds(bp, g));
  assemble('grille', grilleParts);

  // License plates in their recesses below the bumpers, and the fuel filler cap between the
  // taillights; all small trim that can be knocked off.
  for (const end of ['front', 'rear'] as const) {
    const plate = bp.openings.plates[end];
    const z = end === 'front' ? bp.front : bp.rear;
    const tilt = endTilt(z, 0, plate.h);
    const facing = facingAt(tilt).multiplyScalar(end === 'front' ? -1 : 1);
    const centre = onEnd(0, plate.h, z).addScaledVector(facing, -0.02);
    // The plate face fills its recess, leaving a 2.5 cm margin around it; a dark frame behind it.
    const [faceW, faceH] = [plate.width - 0.05, plate.height - 0.025];
    assemble(`plate-${end}`, [
      [new THREE.BoxGeometry(faceW + 0.02, faceH + 0.015, 0.006).rotateX(tilt).translate(centre.x, centre.y, centre.z), mat.dark],
      [new THREE.BoxGeometry(faceW, faceH, 0.008).rotateX(tilt).translate(centre.x, centre.y, centre.z), mat.plate],
    ]);
  }
  // Half sunk into the panel: between the openings the tail panel is a few large flat
  // triangles, which can sit a centimetre off the end shape's curve.
  const cap = bp.fillerCap;
  const capTilt = endTilt(bp.rear, 0, cap.h);
  const capAt = onEnd(0, cap.h, bp.rear);
  const capTop = capAt.clone().addScaledVector(facingAt(capTilt), 0.012);
  assemble('filler-cap', [
    [new THREE.CylinderGeometry(cap.radius, cap.radius, 0.02, 10).rotateX(Math.PI / 2 + capTilt).translate(capAt.x, capAt.y, capAt.z), mat.chrome],
    [new THREE.CylinderGeometry(cap.radius * 0.6, cap.radius * 0.6, 0.01, 10).rotateX(Math.PI / 2 + capTilt).translate(capTop.x, capTop.y, capTop.z), mat.chrome],
  ]);

  /** Primitive placed at (x, height above ground, z), optionally tilted about X then Z. */
  const put = (geo: THREE.BufferGeometry, x: number, h: number, z: number, tiltX = 0, tiltZ = 0) =>
    geo.rotateX(tiltX).rotateZ(tiltZ).translate(x, h + gy, z);

  // Cabin: bucket seats, rear bench, dashboard and a left-hand-drive steering wheel.
  const cabin: [THREE.BufferGeometry, THREE.Material][] = [];
  for (const x of [-0.42, 0.42]) {
    cabin.push(
      [put(new THREE.BoxGeometry(0.5, 0.14, 0.5), x, 0.47, 0.05), mat.upholstery],
      [put(new THREE.BoxGeometry(0.5, 0.6, 0.12), x, 0.82, 0.33, 0.2), mat.upholstery],
      [put(new THREE.BoxGeometry(0.3, 0.16, 0.1), x, 1.2, 0.42, 0.2), mat.upholstery],
    );
  }
  // The rear bench fits between the rear wheel wells, clear of their walls (0.03 thick, see the
  // blueprint's THICKNESS) by 1 cm: ends in a wall's plane flicker against it.
  const bench = 2 * (bp.wellHalf - 0.04);
  cabin.push(
    [put(new THREE.BoxGeometry(bench, 0.14, 0.45), 0, 0.47, 0.95), mat.upholstery],
    [put(new THREE.BoxGeometry(bench, 0.5, 0.12), 0, 0.78, 1.22, 0.35), mat.upholstery],
    // The dash's front face sits inside the firewall's wall (bay face at z −0.77), not in its face.
    [put(new THREE.BoxGeometry(1.5, 0.16, 0.285), 0, 0.92, -0.6125), mat.dark],
    [put(new THREE.TorusGeometry(0.17, 0.022, 6, 14), -0.42, 0.88, -0.38, -0.45), mat.dark],
    [put(new THREE.CylinderGeometry(0.025, 0.025, 0.35, 6), -0.42, 0.9, -0.52, Math.PI / 2 - 0.45), mat.dark],
  );
  assemble('interior', cabin);

  // Engine bay: a V8 and what's in front of it, after the user's reference (09.11.2026). See engineParts.
  const bay = engineParts(cfg, mat);
  assemble('engine', bay.engine);
  assemble('engine-front', bay.front);

  // Underbody (frame, floor ribs, drivetrain, fuel tank) and the suspension parts that follow
  // the wheels, from the underside drawing.
  assemble('underbody', underbodyParts(cfg, mat));
  const linkage = new Linkage(cfg, mat, root);

  // Spare wheel lying in the trunk.
  assemble('spare', [
    [put(new THREE.CylinderGeometry(0.32, 0.32, 0.2, 14), 0.35, 0.5, 2.0), mat.tire],
    [put(new THREE.CylinderGeometry(0.19, 0.19, 0.21, 10), 0.35, 0.5, 2.0), mat.chrome],
  ]);

  // Twin exhaust (see the blueprint): a pipe with its muffler per side, and a chrome tip that
  // can be knocked off, baring the pipe's dark open end. The pipe is subdivided along its
  // length so it dents and crushes with the floor.
  const ex = bp.exhaust;
  const Y = new THREE.Vector3(0, 1, 0);
  for (const side of [-1, 1]) {
    const name = side > 0 ? 'right' : 'left';
    const route = ex.route.map(([x, h, z]) => at(side * x, h, z));
    const curve = new THREE.CatmullRomCurve3(route, false, 'centripetal');
    const end = route[route.length - 1];
    const dir = end.clone().sub(route[route.length - 2]).normalize();
    const facing = new THREE.Quaternion().setFromUnitVectors(Y, dir);
    const m = ex.muffler;
    assemble(`exhaust-${name}`, [
      [new THREE.TubeGeometry(curve, Math.ceil(curve.getLength() / 0.08), ex.pipeRadius, 6), mat.steel],
      [put(new THREE.CylinderGeometry(0.5, 0.5, m.z[1] - m.z[0], 12, 4).scale(m.width, 1, m.height), side * m.x, m.h, (m.z[0] + m.z[1]) / 2, Math.PI / 2), mat.steel],
      [new THREE.CylinderGeometry(ex.pipeRadius * 0.9, ex.pipeRadius * 0.9, 0.004, 6).applyQuaternion(facing).translate(end.x, end.y, end.z).translate(-dir.x * 0.005, -dir.y * 0.005, -dir.z * 0.005), mat.dark],
    ]);
    // The tip flares toward its mouth; a dark disc just proud of the mouth reads as the opening.
    const tipCentre = end.clone().addScaledVector(dir, ex.tip.length / 2 - 0.04);
    const mouth = end.clone().addScaledVector(dir, ex.tip.length - 0.04 + 0.002);
    assemble(`exhaust-tip-${name}`, [
      [new THREE.CylinderGeometry(ex.tip.radius, ex.tip.radius * 0.85, ex.tip.length, 10).applyQuaternion(facing).translate(tipCentre.x, tipCentre.y, tipCentre.z), mat.chrome],
      [new THREE.CylinderGeometry(ex.tip.radius * 0.8, ex.tip.radius * 0.8, 0.004, 10).applyQuaternion(facing).translate(mouth.x, mouth.y, mouth.z), mat.dark],
    ]);
  }

  // Wheels: tyre, steel wheel with five lug nuts, and a chrome hubcap covering them.
  const W = cfg.wheels;
  const wheels: WheelVisual[] = [];
  for (const z of [W.frontZ, W.rearZ]) {
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * W.halfTrack, W.mountY - cfg.suspension.restLength, z);
      const spin = new THREE.Group();
      // Per-wheel geometry: a lost wheel takes (and later disposes) its own buffers.
      const tire = new THREE.Mesh(new THREE.CylinderGeometry(W.radius, W.radius, W.width, 16).rotateZ(Math.PI / 2), mat.tire);
      const steel = new THREE.Mesh(
        new THREE.CylinderGeometry(W.radius * 0.6, W.radius * 0.6, W.width + 0.01, 10).rotateZ(Math.PI / 2),
        mat.steel,
      );
      spin.add(tire, steel);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const lug = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.035, 0.035), mat.dark);
        lug.position.set(side * (W.width / 2 + 0.012), Math.cos(a) * W.radius * 0.28, Math.sin(a) * W.radius * 0.28);
        spin.add(lug);
      }
      // Its own geometry centred on the mesh, so it flies off spinning about its middle.
      const hubcap = new THREE.Mesh(hubcapGeometry(W.radius * 0.62, side), mat.chrome);
      // Its base sits against the tyre face; the spokes and cap stand out from there.
      hubcap.position.x = side * (W.width / 2 + 0.002);
      spin.add(hubcap);
      spin.traverse((o) => (o.castShadow = true));
      pivot.add(spin);
      root.add(pivot);
      wheels.push({ pivot, spin, hubcap });
    }
  }

  return {
    root,
    pieces,
    wheels,
    lights,
    smashedLens: { head: mat.brokenHead, tail: mat.brokenTail, marker: mat.brokenMarker },
    brakeLight,
    headLight,
    lampGlows,
    linkage,
  };
}
