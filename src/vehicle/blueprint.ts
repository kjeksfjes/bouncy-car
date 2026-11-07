import * as THREE from 'three';
import { solidify } from './solidify';

/** Piecewise-linear profile: [z, value] pairs sorted by z (front = −Z). */
export type Curve = readonly (readonly [number, number])[];

/**
 * A car body described like an orthographic drawing: profile curves along
 * the car's length, plus the cut lines that split it into parts. Heights are
 * metres above the drawing's ground line; `groundY` maps them to car-local Y.
 */
export interface CarBlueprint {
  groundY: number;
  /** Nose and tail Z. */
  front: number;
  rear: number;
  /** Nominal spacing between loft stations (m). */
  station: number;
  /** Plan-view half width of the body. */
  halfWidth: Curve;
  /** Upper edge of the lower body: hood, beltline, trunk. */
  deck: Curve;
  /** Lower edge of the body outside the wheel arches. */
  rocker: Curve;
  /** Extra height at the centre line of hood, trunk and roof. */
  crown: number;
  /** Half width of the floor, i.e. where the inner wheel-well walls stand. */
  wellHalf: number;
  /** Wheel arches: centre Z, centre height and radius. */
  arches: readonly { z: number; h: number; radius: number }[];
  /** Cut lines (Z ranges) of detachable panels. */
  hood: readonly [number, number];
  trunk: readonly [number, number];
  door: readonly [number, number];
  greenhouse: {
    /** Roof height; its first and last Z are where the greenhouse meets the deck. */
    roof: Curve;
    sillHalf: number;
    roofHalf: number;
    windshieldTo: number;
    rearGlassFrom: number;
    doorGlass: readonly [number, number];
    quarterGlass: readonly [number, number];
  };
  mirror: { z: number; size: readonly [number, number, number] };
  /**
   * Openings cut into the nose and tail panels, covered by their fixture until it breaks out.
   * Lamp openings (mirrored to both sides) get a dark recess behind them; the grille opening
   * looks straight into the engine bay at the radiator.
   */
  openings: {
    /** Round headlight holes: x of each per side, centre height, radius. */
    head: { x: readonly number[]; h: number; radius: number };
    /** One rectangular taillight hole per side: centre x and height, size. */
    tail: { x: number; h: number; width: number; height: number };
    /** The grille opening, centred: height and size. */
    grille: { h: number; width: number; height: number };
    /** Depth of the recess behind each lamp opening (m). */
    depth: number;
  };
  hoodBulge: { from: number; to: number; halfWidth: number; height: number };
  /** Twin exhaust under the floor, mirrored to both sides. Heights as for the body. */
  exhaust: {
    /** Pipe centre line on the right side, [x, height, z], from the manifold to the tip. */
    route: readonly (readonly [number, number, number])[];
    pipeRadius: number;
    /** One muffler per pipe: Z range, centre x and height, and its oval cross-section. */
    muffler: { z: readonly [number, number]; x: number; h: number; width: number; height: number };
    /** Chrome tip slid over the pipe's end: radius at the mouth, length. */
    tip: { radius: number; length: number };
  };
}

export function sample(curve: Curve, z: number): number {
  if (z <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [z1, v1] = curve[i];
    if (z <= z1) {
      const [z0, v0] = curve[i - 1];
      return v0 + ((v1 - v0) * (z - z0)) / (z1 - z0);
    }
  }
  return curve[curve.length - 1][1];
}

/** `recess` is drawn like `dark` but thin-walled: lamp recesses sit right behind the panel edges. */
export type PanelMaterial = 'paint' | 'dark' | 'glass' | 'recess';
/** Body triangles (flat position arrays, car-local) grouped by part, then material. */
export type Panels = Map<string, Map<PanelMaterial, number[]>>;

/** Wall thickness per surface type (m): sheet metal reads as a visible edge, glass is thin. */
const THICKNESS: Record<PanelMaterial, number> = { paint: 0.03, dark: 0.03, glass: 0.01, recess: 0.005 };
/** Firewall and rear bulkhead are scaled down by this much to sit inside the skin. */
const INNER_WALL_SCALE = 0.93;

const within = (z: number, range: readonly [number, number]) => z >= range[0] && z <= range[1];
const sideName = (side: number) => (side > 0 ? 'right' : 'left');

const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c = new THREE.Vector3();

/**
 * Lofts the body from the blueprint: a lower body (floor, wheel wells,
 * sides, deck), bulkheads around an open cabin, and a greenhouse (glass,
 * pillars, roof), sampled at stations along Z. Every quad is assigned to a
 * part by where it sits, so panels split exactly along the blueprint's cut
 * lines. Finally every surface is solidified to a real wall thickness.
 */
export function buildPanels(bp: CarBlueprint): Panels {
  const loft: Panels = new Map();
  const panels: Panels = new Map();
  const target = (into: Panels, part: string, mat: PanelMaterial) => {
    let mats = into.get(part);
    if (!mats) into.set(part, (mats = new Map()));
    if (!mats) panels.set(part, (mats = new Map()));
    let arr = mats.get(mat);
    if (!arr) mats.set(mat, (arr = []));
    return arr;
  };
  // Emits a triangle wound so its normal points away from `ref` (a point inside the body).
  const tri = (part: string, mat: PanelMaterial, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, ref: THREE.Vector3) => {
    _n.crossVectors(_ab.subVectors(b, a), _ac.subVectors(c, a));
    if (_n.lengthSq() < 1e-10) return;
    _c.copy(a).add(b).add(c).divideScalar(3).sub(ref);
    const [p, q] = _n.dot(_c) >= 0 ? [b, c] : [c, b];
    target(loft, part, mat).push(a.x, a.y, a.z, p.x, p.y, p.z, q.x, q.y, q.z);
  };
  const quad = (part: string, mat: PanelMaterial, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, ref: THREE.Vector3) => {
    tri(part, mat, a, b, c, ref);
    tri(part, mat, a, c, d, ref);
  };
  // Closed boxes are already solid, so they skip the loft and go straight to the output.
  const addBox = (part: string, mat: PanelMaterial, geo: THREE.BufferGeometry, center: THREE.Vector3) => {
    const flat = geo.toNonIndexed();
    flat.translate(center.x, center.y, center.z);
    target(panels, part, mat).push(...flat.getAttribute('position').array);
    flat.dispose();
    geo.dispose();
  };

  const gy = bp.groundY;
  const gh = bp.greenhouse;
  const ghFrom = gh.roof[0][0];
  const ghTo = gh.roof[gh.roof.length - 1][0];
  const v = (x: number, h: number, z: number) => new THREE.Vector3(x, h + gy, z);

  // Stations: every cut line exactly, plus a regular grid in between.
  const marks = [
    bp.front, bp.rear, ...bp.hood, ...bp.trunk, ...bp.door, ghFrom, ghTo, gh.windshieldTo, gh.rearGlassFrom,
    ...gh.doorGlass, ...gh.quarterGlass, ...bp.arches.flatMap((a) => [a.z - a.radius, a.z, a.z + a.radius]),
  ];
  const stations = [...marks];
  for (let z = bp.front; z < bp.rear; z += bp.station) {
    if (marks.every((m) => Math.abs(m - z) > bp.station * 0.3)) stations.push(z);
  }
  stations.sort((a, b) => a - b);

  const archHeight = (z: number) => {
    let h = -Infinity;
    for (const a of bp.arches) {
      const dz = z - a.z;
      if (Math.abs(dz) < a.radius) h = Math.max(h, a.h + Math.sqrt(a.radius * a.radius - dz * dz));
    }
    return h;
  };

  // Lower body cross-section (right half, x ≥ 0), from floor centre round to deck centre.
  // The floor and the deck between the sills are split into several strips: crumple zones
  // push the middle in further than the sides, and one wide strip would shear into slivers.
  const DECK_STRIPS = 4;
  const lower = (z: number): [number, number][] => {
    const hw = sample(bp.halfWidth, z);
    const deck = sample(bp.deck, z);
    const rocker = sample(bp.rocker, z);
    const bottom = Math.max(rocker, archHeight(z));
    const sill = deck + bp.crown * (1 - gh.sillHalf / (hw * 0.92));
    const centre = deck + bp.crown;
    const inner: [number, number][] = [];
    for (let k = 1; k < DECK_STRIPS; k++) {
      const f = k / DECK_STRIPS;
      inner.push([gh.sillHalf * (1 - f), sill + (centre - sill) * f]);
    }
    return [
      [0, rocker], // 0 floor centre
      [bp.wellHalf / 2, rocker], // 1 floor middle
      [bp.wellHalf, rocker], // 2 floor edge
      [bp.wellHalf, bottom], // 3 top of inner wheel-well wall
      [hw * 0.96, bottom], // 4 outer lower lip
      [hw, bottom + (deck - bottom) * 0.3], // 5 lower side
      [hw, deck - 0.1], // 6 shoulder crease
      [hw * 0.97, deck - 0.02], // 7 rounded top edge
      [hw * 0.92, deck], // 8 deck edge
      [gh.sillHalf, sill], // 9 window sill line
      ...inner, // 10.. deck between the sills
      [0, centre], // deck centre
    ];
  };
  /** Part and material for lower-body segment `seg` (between points seg and seg + 1), or null where the cabin is open. */
  const lowerPart = (zm: number, seg: number, side: number): [string, PanelMaterial] | null => {
    if (seg <= 3) return ['shell', 'dark']; // floor and wheel wells
    if (seg <= 6) return within(zm, bp.door) ? [`door-${sideName(side)}`, 'paint'] : ['shell', 'paint'];
    if (seg >= 8 && within(zm, bp.hood)) return ['hood', 'paint'];
    if (seg >= 8 && within(zm, bp.trunk)) return ['trunk', 'paint'];
    // Between the sills the cabin opens up into the greenhouse; only a beltline ledge remains.
    if (seg >= 9 && zm > ghFrom && zm < ghTo) return null;
    return ['shell', 'paint'];
  };

  for (let i = 0; i < stations.length - 1; i++) {
    const z0 = stations[i];
    const z1 = stations[i + 1];
    const zm = (z0 + z1) / 2;
    const s0 = lower(z0);
    const s1 = lower(z1);
    // Reference point inside the body, pulled toward the middle along Z so faces that
    // point mostly forward/backward (nose, tail drop) still orient unambiguously.
    const refZ = THREE.MathUtils.clamp(zm, bp.front + 0.8, bp.rear - 0.8);
    const ref = v(0, (sample(bp.rocker, zm) + sample(bp.deck, zm)) / 2, refZ);
    for (let j = 0; j < s0.length - 1; j++) {
      for (const side of [1, -1]) {
        const slot = lowerPart(zm, j, side);
        if (!slot) continue;
        quad(
          slot[0], slot[1],
          v(side * s0[j][0], s0[j][1], z0), v(side * s1[j][0], s1[j][1], z1),
          v(side * s1[j + 1][0], s1[j + 1][1], z1), v(side * s0[j + 1][0], s0[j + 1][1], z0),
          ref,
        );
      }
    }
  }

  // Nose and tail caps (paint), firewall and rear-seat bulkhead (dark), closing the engine
  // bay, cabin and trunk off from each other. The caps have the light openings cut out.
  const walls = [
    { z: bp.front, inward: 1, mat: 'paint' },
    { z: bp.rear, inward: -1, mat: 'paint' },
    { z: ghFrom, inward: 1, mat: 'dark' },
    { z: ghTo, inward: -1, mat: 'dark' },
  ] as const;
  for (const { z, inward, mat } of walls) {
    const s = lower(z);
    const mid = (sample(bp.rocker, z) + sample(bp.deck, z)) / 2;
    // Interior walls shrink toward their centre so their edges stay inside the skin
    // (an edge lying in the outer surface flickers against the paint).
    const k = mat === 'dark' ? INNER_WALL_SCALE : 1;
    const at = (x: number, h: number) => v(x * k, mid + (h - mid) * k, z);
    const ring = [...s.map(([x, h]) => at(x, h)), ...s.slice(1, -1).reverse().map(([x, h]) => at(-x, h))];
    const center = v(0, mid, z);
    const ref = v(0, mid, z + inward * 0.2);
    if (mat === 'paint') {
      capWithOpenings(ring, panelOpenings(bp, z === bp.front ? 'front' : 'rear'), z, inward, bp.openings.depth, ref, tri);
      continue;
    }
    for (let k = 0; k < ring.length; k++) tri('shell', mat, center, ring[k], ring[(k + 1) % ring.length], ref);
  }

  // Greenhouse cross-section (right half): sill → window top → roof edge → roof centre.
  // The inward lean (tumblehome) scales with the greenhouse's height, so where the roof
  // slopes down to the deck the panels stay planar instead of twisting (which flat
  // shading shows as saw teeth).
  const maxRise = Math.max(...gh.roof.map(([z, h]) => h - sample(bp.deck, z)));
  const upper = (z: number): [number, number][] => {
    const deck = sample(bp.deck, z);
    const roof = Math.max(deck, sample(gh.roof, z));
    const roofHalf = gh.sillHalf + (gh.roofHalf - gh.sillHalf) * ((roof - deck) / maxRise);
    const t = 0.85;
    return [
      [gh.sillHalf, deck],
      [gh.sillHalf + (roofHalf - gh.sillHalf) * t, deck + (roof - deck) * t],
      [roofHalf, roof],
      [roofHalf * 0.8, roof + bp.crown * 0.6],
      [0, roof + bp.crown],
    ];
  };
  const upperPart = (zm: number, seg: number, side: number): [string, PanelMaterial] => {
    const zone = zm < gh.windshieldTo ? 'windshield' : zm > gh.rearGlassFrom ? 'rear' : 'roof';
    if (seg === 0) {
      if (within(zm, gh.doorGlass)) return [`door-glass-${sideName(side)}`, 'glass'];
      if (within(zm, gh.quarterGlass)) return [`quarter-glass-${sideName(side)}`, 'glass'];
      return ['roof', 'paint'];
    }
    if (seg === 1) return ['roof', 'paint'];
    if (seg === 2) return ['roof', 'paint'];
    if (zone === 'windshield') return ['windshield', 'glass'];
    return zone === 'rear' ? ['rear-glass', 'glass'] : ['roof', 'paint'];
  };

  const ghStations = stations.filter((z) => z >= ghFrom && z <= ghTo);
  for (let i = 0; i < ghStations.length - 1; i++) {
    const z0 = ghStations[i];
    const z1 = ghStations[i + 1];
    const zm = (z0 + z1) / 2;
    const s0 = upper(z0);
    const s1 = upper(z1);
    // Below the deck and at the cabin's middle: the sloped windshield and rear glass face
    // mostly forward/backward, so a reference at the face's own Z would be ambiguous.
    const ref = v(0, sample(bp.deck, zm) - 0.3, (ghFrom + ghTo) / 2);
    for (let j = 0; j < s0.length - 1; j++) {
      for (const side of [1, -1]) {
        const [part, mat] = upperPart(zm, j, side);
        quad(
          part, mat,
          v(side * s0[j][0], s0[j][1], z0), v(side * s1[j][0], s1[j][1], z1),
          v(side * s1[j + 1][0], s1[j + 1][1], z1), v(side * s0[j + 1][0], s0[j + 1][1], z0),
          ref,
        );
      }
    }
  }

  for (const [part, byMaterial] of loft) {
    for (const [mat, triangles] of byMaterial) target(panels, part, mat).push(...solidify(triangles, THICKNESS[mat]));
  }

  // Body-coloured mirrors are their own parts (they ride on the doors and can be knocked off);
  // the power bulge rides on the hood.
  const [mw, mh, ml] = bp.mirror.size;
  for (const side of [1, -1]) {
    const deck = sample(bp.deck, bp.mirror.z);
    const mirror = `mirror-${sideName(side)}`;
    addBox(mirror, 'paint', new THREE.BoxGeometry(...bp.mirror.size), v(side * (gh.sillHalf + mw / 2 + 0.02), deck + mh / 2 + 0.06, bp.mirror.z));
    addBox(mirror, 'paint', new THREE.BoxGeometry(mw + 0.04, 0.03, ml * 0.5), v(side * (gh.sillHalf + 0.03), deck + 0.04, bp.mirror.z));
  }
  // The bulge is tilted to follow the hood's slope so it sits flush along its length.
  const b = bp.hoodBulge;
  const bz = (b.from + b.to) / 2;
  const pitch = Math.atan2(sample(bp.deck, b.to) - sample(bp.deck, b.from), b.to - b.from);
  addBox(
    'hood', 'paint',
    // Subdivided so a crumple-zone notch can bend it instead of shearing it.
    new THREE.BoxGeometry(b.halfWidth * 2, b.height, b.to - b.from, 6, 1, 8).rotateX(-pitch),
    v(0, sample(bp.deck, bz) + bp.crown + b.height / 2 - 0.015, bz),
  );

  return panels;
}

type Tri = (part: string, mat: PanelMaterial, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, ref: THREE.Vector3) => void;

/** Segments of a round lamp opening; matches the fixtures' 10-sided cylinders. */
const ROUND_SEGMENTS = 10;
/** Recess walls sit this far (m) inside the opening, so they don't share a plane with the panel's rim. */
const RECESS_INSET = 0.003;
/**
 * The recess starts this far (m) behind the panel's outer surface: solidify closes its open
 * front edge with a dark ring as wide as its wall thickness, which would z-fight with the paint
 * if it lay in the panel's plane. Behind it, the ring is hidden inside the panel's thickness.
 * Its walls are thin (`recess` thickness) and grow outward, so an opening near the panel's
 * edge doesn't poke out through the corner.
 */
const RECESS_START = 0.006;

interface Opening {
  /** (x, y) outline in car-local coordinates. */
  outline: THREE.Vector2[];
  /** Lamp openings get a dark recess; the grille opens into the engine bay. */
  recess: boolean;
}

const rect = (cx: number, cy: number, width: number, height: number) => [
  new THREE.Vector2(cx - width / 2, cy - height / 2),
  new THREE.Vector2(cx + width / 2, cy - height / 2),
  new THREE.Vector2(cx + width / 2, cy + height / 2),
  new THREE.Vector2(cx - width / 2, cy + height / 2),
];

/** Openings in an end panel. */
function panelOpenings(bp: CarBlueprint, end: 'front' | 'rear'): Opening[] {
  const L = bp.openings;
  const openings: Opening[] = [];
  if (end === 'front') {
    const g = L.grille;
    openings.push({ outline: rect(0, g.h + bp.groundY, g.width, g.height), recess: false });
    for (const side of [-1, 1]) {
      for (const x of L.head.x) {
        const cx = side * x;
        const cy = L.head.h + bp.groundY;
        const ring: THREE.Vector2[] = [];
        for (let i = 0; i < ROUND_SEGMENTS; i++) {
          const a = (i / ROUND_SEGMENTS) * Math.PI * 2;
          ring.push(new THREE.Vector2(cx + Math.cos(a) * L.head.radius, cy + Math.sin(a) * L.head.radius));
        }
        openings.push({ outline: ring, recess: true });
      }
    }
  } else {
    const { x, h, width, height } = L.tail;
    for (const side of [-1, 1]) openings.push({ outline: rect(side * x, h + bp.groundY, width, height), recess: true });
  }
  return openings;
}

/**
 * An end panel (nose or tail cap) as a polygon with openings, plus a dark recess behind each
 * lamp opening: walls facing the opening's axis and a back face toward the hole.
 */
function capWithOpenings(
  ring: THREE.Vector3[],
  openings: Opening[],
  z: number,
  inward: number,
  depth: number,
  ref: THREE.Vector3,
  tri: Tri,
): void {
  // The cross-section repeats points where a segment has no length (no arch at the tips).
  const contour: THREE.Vector2[] = [];
  for (const p of ring) {
    const q = new THREE.Vector2(p.x, p.y);
    if (!contour.length || contour[contour.length - 1].distanceTo(q) > 1e-6) contour.push(q);
  }
  if (contour[0].distanceTo(contour[contour.length - 1]) <= 1e-6) contour.pop();
  const outlines = openings.map((o) => o.outline);
  for (const outline of outlines) {
    for (const p of outline) {
      if (!insidePolygon(p, contour)) {
        throw new Error(`Panel opening at (${p.x.toFixed(3)}, ${p.y.toFixed(3)}) sticks out of the end panel at z=${z}`);
      }
    }
  }
  const points = [...contour, ...outlines.flat()].map((p) => new THREE.Vector3(p.x, p.y, z));
  for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, outlines)) {
    tri('shell', 'paint', points[a], points[b], points[c], ref);
  }

  for (const { outline: opening, recess } of openings) {
    if (!recess) continue;
    const centre = opening.reduce((sum, p) => sum.add(p), new THREE.Vector2()).divideScalar(opening.length);
    // Inset toward the centre, then a front ring (at the panel) and a back ring (at depth).
    const rim = opening.map((p) => p.clone().sub(centre).setLength(p.distanceTo(centre) - RECESS_INSET).add(centre));
    const front = rim.map((p) => new THREE.Vector3(p.x, p.y, z + inward * RECESS_START));
    const back = rim.map((p) => new THREE.Vector3(p.x, p.y, z + inward * depth));
    const axis = new THREE.Vector3(centre.x, centre.y, z + (inward * depth) / 2);
    for (let i = 0; i < rim.length; i++) {
      const j = (i + 1) % rim.length;
      // A reference outside the wall makes its face point at the axis (seen from the hole).
      const mid = front[i].clone().add(front[j]).multiplyScalar(0.5);
      const out = new THREE.Vector3(mid.x - centre.x, mid.y - centre.y, 0).setLength(0.2).add(mid).setZ(axis.z);
      tri('shell', 'recess', front[i], front[j], back[j], out);
      tri('shell', 'recess', front[i], back[j], back[i], out);
    }
    const backCentre = new THREE.Vector3(centre.x, centre.y, z + inward * depth);
    const behind = backCentre.clone().setZ(backCentre.z + inward * 0.2);
    for (let i = 0; i < rim.length; i++) tri('shell', 'recess', backCentre, back[i], back[(i + 1) % rim.length], behind);
  }
}

/** Even-odd point-in-polygon test. */
function insidePolygon(p: THREE.Vector2, polygon: readonly THREE.Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export interface HullBox {
  center: THREE.Vector3;
  half: THREE.Vector3;
}

/** Collision boxes derived from the blueprint: the lower body and the cabin. */
export function hullBoxes(bp: CarBlueprint): { lower: HullBox; cabin: HullBox } {
  const zs: number[] = [];
  for (let z = bp.front; z <= bp.rear; z += 0.05) zs.push(z);
  const maxHalf = Math.max(...zs.map((z) => sample(bp.halfWidth, z)));
  const minRocker = Math.min(...zs.map((z) => sample(bp.rocker, z)));
  const maxDeck = Math.max(...zs.map((z) => sample(bp.deck, z)));
  const gh = bp.greenhouse;
  const maxRoof = Math.max(...gh.roof.map(([, h]) => h));
  // Cabin box spans the tall middle of the greenhouse; the sloped glass ends are left out.
  const cabinFrom = gh.windshieldTo - 0.15;
  const cabinTo = gh.rearGlassFrom + 0.1;
  const cabinBase = sample(bp.deck, (cabinFrom + cabinTo) / 2);
  // Bumpers overhang the body by ~0.1 m at each end.
  const overhang = 0.1;
  return {
    lower: {
      center: new THREE.Vector3(0, (minRocker + maxDeck) / 2 + bp.groundY, (bp.front + bp.rear) / 2),
      half: new THREE.Vector3(maxHalf, (maxDeck - minRocker) / 2, (bp.rear - bp.front) / 2 + overhang),
    },
    cabin: {
      center: new THREE.Vector3(0, (cabinBase + maxRoof) / 2 + bp.groundY, (cabinFrom + cabinTo) / 2),
      half: new THREE.Vector3((gh.sillHalf + gh.roofHalf) / 2, (maxRoof - cabinBase) / 2, (cabinTo - cabinFrom) / 2),
    },
  };
}
