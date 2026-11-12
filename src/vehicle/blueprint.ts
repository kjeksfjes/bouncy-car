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
  /** Plan-view half width of the body (at its widest, the hips). */
  halfWidth: Curve;
  /**
   * Cross-section of the lower body's side, from the lower lip up to the deck edge, as
   * [height, width] pairs: height as a fraction from the rocker (0) to the deck (1), width as a
   * fraction of `halfWidth`. Over a wheel arch the side starts at the arch instead (see sideSection).
   */
  side: Curve;
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
   * Openings cut into the nose and tail panels, each with a dark recess behind it: the front
   * surround (holding the headlights and grille), the taillights and the license plates.
   */
  openings: {
    /** Headlights inside the surround: x of each per side, centre height, lens radius. */
    head: { x: readonly number[]; h: number; radius: number };
    /** The recessed surround across the nose, centred: height, size, corner radius. */
    surround: { h: number; width: number; height: number; radius: number };
    /** One rounded-rectangle taillight hole per side: centre x and height, size, corner radius. */
    tail: { x: number; h: number; width: number; height: number; radius: number };
    /** License plate recesses below the bumpers, centred: height and size. */
    plates: { front: { h: number; width: number; height: number }; rear: { h: number; width: number; height: number } };
    /** The hole in the surround's back wall into the engine bay, behind the grille: height and size. */
    grille: { h: number; width: number; height: number };
    /** Depth of the recess behind each lamp opening (m). */
    depth: number;
  };
  hoodBulge: { from: number; to: number; halfWidth: number; height: number };
  /** Shapes of the nose (a forward-leaning shark nose, a V in plan) and the tail (see EndShape). */
  nose: EndShape;
  tail: EndShape;
  /** Chrome bumpers at each end (see Bumper). */
  bumpers: { front: Bumper; rear: Bumper };
  /** Fuel filler cap, centred on the tail panel: height and radius. */
  fillerCap: { h: number; radius: number };
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

/**
 * Points near one end of the car are moved in toward the middle by `profile` (along the centre
 * line, by height: [height, metres]) plus `vee` growing linearly to `cornerX` across the width
 * (a V in plan), fading out over `blend` metres from the end.
 */
export interface EndShape {
  profile: Curve;
  vee: number;
  cornerX: number;
  blend: number;
}

/**
 * A bumper: a chrome section swept along a path in plan, straight across the end of the car,
 * round a 90° arc at each corner and back along the sides (before the end shapes bend it).
 */
export interface Bumper {
  /** Centre height, and how far beyond the end of the body its centre line sits. */
  h: number;
  gap: number;
  /** Section size: height, and depth (front to back). */
  height: number;
  depth: number;
  /** Half length of the straight part, radius of the corner arcs, length of the returns along the sides. */
  halfStraight: number;
  wrapRadius: number;
  wrapReturn: number;
  /** Vertical guards on the face, mirrored to both sides: x, bottom and top heights. */
  guards: { x: number; bottom: number; top: number };
  /** Where the lower edge rises over the license plate: half width and rise. */
  notch?: { halfWidth: number; rise: number };
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

/** Top of the wheel arches at `z` (−Infinity away from them). */
function archHeight(bp: CarBlueprint, z: number): number {
  let h = -Infinity;
  for (const a of bp.arches) {
    const dz = z - a.z;
    if (Math.abs(dz) < a.radius) h = Math.max(h, a.h + Math.sqrt(a.radius * a.radius - dz * dz));
  }
  return h;
}

/**
 * The lower body's side at `z` (right half), from the lower lip to the deck edge, as [x, height]
 * (heights above the drawing's ground line). Over an arch the profile's heights are squeezed into
 * the span between arch and deck while each point keeps its width, so the strips along the car
 * stay planar (flat shading shows twisted ones as saw teeth) and the arch lip stays tucked in.
 */
export function sideSection(bp: CarBlueprint, z: number): [number, number][] {
  const hw = sample(bp.halfWidth, z);
  const deck = sample(bp.deck, z);
  const rocker = sample(bp.rocker, z);
  const bottom = Math.max(rocker, archHeight(bp, z));
  const from = (bottom - rocker) / (deck - rocker);
  return bp.side.map(([f, w]) => [hw * w, rocker + (deck - rocker) * (from + (1 - from) * f)]);
}

/**
 * How far (m, along Z) the end shapes move a rest point: toward +Z at the nose, −Z at the tail.
 * A pure function of position, so everything built at an end (panels, recesses, grille, bumpers,
 * lights) moves together. Heights above the drawing's ground line.
 */
export function endShift(bp: CarBlueprint, x: number, h: number, z: number): number {
  const at = (shape: EndShape, fromEnd: number) => {
    const t = Math.max(0, fromEnd / shape.blend);
    if (t >= 1) return 0;
    // (1 − t)²: steepest at the end, where its slope (2 / blend × shift) must stay well under 1
    // or the panels fold through each other.
    return (sample(shape.profile, h) + shape.vee * Math.min(1, Math.abs(x) / shape.cornerX)) * (1 - t) ** 2;
  };
  return at(bp.nose, z - bp.front) - at(bp.tail, bp.rear - z);
}

/**
 * Half width of the body's side at `z` and height `h` (above the drawing's ground line). Over an
 * arch the side's profile is squeezed in above it, as sideSection builds it (below the arch's top
 * it's the lip's width).
 */
export function sideHalfWidth(bp: CarBlueprint, z: number, h: number): number {
  const rocker = sample(bp.rocker, z);
  const deck = sample(bp.deck, z);
  const from = (Math.max(rocker, archHeight(bp, z)) - rocker) / (deck - rocker);
  const f = (h - rocker) / (deck - rocker);
  return sample(bp.halfWidth, z) * sample(bp.side, Math.max(0, (f - from) / (1 - from)));
}

/** `recess` is drawn like `dark` but thin-walled: lamp recesses sit right behind the panel edges. */
/**
 * The inside of painted panels (never worn, see paintWear): `lining` in the engine bay and trunk,
 * painted like the outside but in their shade; `trim` round the cabin (doors, roof, the shell
 * between firewall and bulkhead), where real cars cover the metal.
 */
export type PanelMaterial = 'paint' | 'lining' | 'trim' | 'dark' | 'glass' | 'recess';
/** Body triangles (flat position arrays, car-local) grouped by part, then material. */
export type Panels = Map<string, Map<PanelMaterial, number[]>>;

/** Wall thickness per surface type (m): sheet metal reads as a visible edge, glass is thin. */
const THICKNESS: Record<PanelMaterial, number> = { paint: 0.03, lining: 0.03, trim: 0.03, dark: 0.03, glass: 0.01, recess: 0.005 };
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
    const out = target(loft, part, mat);
    for (const v of [a, p, q]) out.push(v.x, v.y, v.z + endShift(bp, v.x, v.y - gy, v.z));
  };
  const quad = (part: string, mat: PanelMaterial, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, ref: THREE.Vector3) => {
    tri(part, mat, a, b, c, ref);
    tri(part, mat, a, c, d, ref);
  };
  // Closed boxes are already solid, so they skip the loft and go straight to the output.
  const addBox = (part: string, mat: PanelMaterial, geo: THREE.BufferGeometry, center: THREE.Vector3) => {
    const flat = geo.toNonIndexed();
    flat.translate(center.x, center.y, center.z);
    bendEnds(bp, flat);
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

  // Lower body cross-section (right half, x ≥ 0), from floor centre round to deck centre.
  // The floor and the deck between the sills are split into several strips: crumple zones
  // push the middle in further than the sides, and one wide strip would shear into slivers.
  const DECK_STRIPS = 4;
  // Point indices: the side runs from the lower lip (LIP) to the deck edge (DECK_EDGE).
  const LIP = 4;
  const DECK_EDGE = LIP + bp.side.length - 1;
  const lower = (z: number): [number, number][] => {
    const deck = sample(bp.deck, z);
    const rocker = sample(bp.rocker, z);
    const side = sideSection(bp, z);
    const [edgeX] = side[side.length - 1];
    const sill = deck + bp.crown * (1 - gh.sillHalf / edgeX);
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
      [bp.wellHalf, side[0][1]], // 3 top of inner wheel-well wall
      ...side, // LIP .. DECK_EDGE: lower lip, side, shoulder, deck edge
      [gh.sillHalf, sill], // window sill line
      ...inner, // deck between the sills
      [0, centre], // deck centre
    ];
  };
  /** Part and material for lower-body segment `seg` (between points seg and seg + 1), or null where the cabin is open. */
  const lowerPart = (zm: number, seg: number, side: number): [string, PanelMaterial] | null => {
    if (seg < LIP) return ['shell', 'dark']; // floor, wheel wells and the ledge under the lip
    // The door is the side up to the shoulder; the rounded top edge above it stays on the body.
    if (seg < DECK_EDGE - 1) return within(zm, bp.door) ? [`door-${sideName(side)}`, 'paint'] : ['shell', 'paint'];
    if (seg >= DECK_EDGE && within(zm, bp.hood)) return ['hood', 'paint'];
    if (seg >= DECK_EDGE && within(zm, bp.trunk)) return ['trunk', 'paint'];
    // Between the sills the cabin opens up into the greenhouse; only a beltline ledge remains.
    if (seg > DECK_EDGE && zm > ghFrom && zm < ghTo) return null;
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
    // The floor and wheel wells face outward, toward the road and the wheels: down and out, seen from
    // a point well above the body. From mid-height instead, a housing's top (at the arch's height:
    // above mid-height over the wheel, below it toward the arch's ends) flipped facing along its
    // length, and the walls solidify grew on either side of the flip didn't meet: cracks.
    const wellRef = v(0, sample(bp.deck, zm) + 1, refZ);
    for (let j = 0; j < s0.length - 1; j++) {
      for (const side of [1, -1]) {
        const slot = lowerPart(zm, j, side);
        if (!slot) continue;
        quad(
          slot[0], slot[1],
          v(side * s0[j][0], s0[j][1], z0), v(side * s1[j][0], s1[j][1], z1),
          v(side * s1[j + 1][0], s1[j + 1][1], z1), v(side * s0[j + 1][0], s0[j + 1][1], z0),
          j < LIP ? wellRef : ref,
        );
      }
    }
  }

  // Nose and tail caps (paint), firewall and rear-seat bulkhead (painted lining toward the engine
  // bay and trunk, trim toward the cabin), closing them off from each other. The caps have the
  // light openings cut out.
  const walls = [
    { z: bp.front, inward: 1, mat: 'paint' },
    { z: bp.rear, inward: -1, mat: 'paint' },
    { z: ghFrom, inward: 1, mat: 'lining' },
    { z: ghTo, inward: -1, mat: 'lining' },
  ] as const;
  for (const { z, inward, mat } of walls) {
    const s = lower(z);
    const mid = (sample(bp.rocker, z) + sample(bp.deck, z)) / 2;
    // Interior walls shrink toward their centre so their edges stay inside the skin
    // (an edge lying in the outer surface flickers against the paint).
    const k = mat === 'lining' ? INNER_WALL_SCALE : 1;
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
    for (const [mat, triangles] of byMaterial) {
      const { outer, inner } = solidify(triangles, THICKNESS[mat]);
      target(panels, part, mat).push(...outer);
      // A bulkhead's lining faces the bay or trunk; its other side faces the cabin.
      if (mat !== 'paint') {
        target(panels, part, mat === 'lining' ? 'trim' : mat).push(...inner);
        continue;
      }
      // The inside of a painted panel: trim where it faces the cabin, painted lining elsewhere.
      const cabinPart = part === 'roof' || part.startsWith('door-');
      for (let t = 0; t < inner.length; t += 9) {
        const zm = (inner[t + 2] + inner[t + 5] + inner[t + 8]) / 3;
        const inCabin = cabinPart || (part === 'shell' && zm > ghFrom && zm < ghTo);
        target(panels, part, inCabin ? 'trim' : 'lining').push(...inner.slice(t, t + 9));
      }
    }
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

/** Applies the end shapes (see endShift) to a car-local geometry, in place. */
export function bendEnds(bp: CarBlueprint, geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = geometry.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    pos.setZ(i, pos.getZ(i) + endShift(bp, pos.getX(i), pos.getY(i) - bp.groundY, pos.getZ(i)));
  }
  pos.needsUpdate = true;
  return geometry;
}

type Tri = (part: string, mat: PanelMaterial, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, ref: THREE.Vector3) => void;

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
  /** A hole in the recess's back wall (x, y; the surround's opens into the engine bay). */
  hole?: THREE.Vector2[];
}

const rect = (cx: number, cy: number, width: number, height: number) => [
  new THREE.Vector2(cx - width / 2, cy - height / 2),
  new THREE.Vector2(cx + width / 2, cy - height / 2),
  new THREE.Vector2(cx + width / 2, cy + height / 2),
  new THREE.Vector2(cx - width / 2, cy + height / 2),
];

/** A rounded rectangle, counter-clockwise, with `segments` edges per corner. */
const roundedRect = (cx: number, cy: number, width: number, height: number, radius: number, segments = 3) => {
  const points: THREE.Vector2[] = [];
  const corners = [
    [width / 2 - radius, -height / 2 + radius, -Math.PI / 2],
    [width / 2 - radius, height / 2 - radius, 0],
    [-width / 2 + radius, height / 2 - radius, Math.PI / 2],
    [-width / 2 + radius, -height / 2 + radius, Math.PI],
  ];
  for (const [x, y, from] of corners) {
    for (let i = 0; i <= segments; i++) {
      const a = from + (i / segments) * (Math.PI / 2);
      points.push(new THREE.Vector2(cx + x + Math.cos(a) * radius, cy + y + Math.sin(a) * radius));
    }
  }
  return points;
};

/** Openings in an end panel. */
function panelOpenings(bp: CarBlueprint, end: 'front' | 'rear'): Opening[] {
  const L = bp.openings;
  const gy = bp.groundY;
  const plate = L.plates[end];
  const openings: Opening[] = [{ outline: rect(0, plate.h + gy, plate.width, plate.height) }];
  if (end === 'front') {
    const { h, width, height, radius } = L.surround;
    const g = L.grille;
    openings.push({ outline: roundedRect(0, h + gy, width, height, radius), hole: rect(0, g.h + gy, g.width, g.height) });
  } else {
    const { x, h, width, height, radius } = L.tail;
    for (const side of [-1, 1]) openings.push({ outline: roundedRect(side * x, h + gy, width, height, radius) });
  }
  return openings;
}

/**
 * Longest edge (m) along an end panel's openings and their recesses (END_PANEL_EDGE), and inside
 * the panel and the recess back walls (END_PANEL_INNER). The crumple zones bend the body only at
 * its vertices: a longer edge stays a straight bar across a crushed nose, and triangulating a
 * panel that's a thin frame round wide openings joins points far across it. Under the crush
 * columns' spacing (≈0.22 m). The panel's outer edge keeps the body skin's own points (every
 * 0.2–0.3 m), so the seam with the skin stays closed.
 */
const END_PANEL_EDGE = 0.1;
const END_PANEL_INNER = 0.15;

/**
 * Triangulates a polygon with holes into triangles no wider than `max` inside, so it bends with a
 * crush (see END_PANEL_INNER). Returns the points (the rings' own, then added ones) and the
 * triangles as index triples. Steps:
 * 1. Triangulate the rings without the points lying in a row between their neighbours: on its own,
 *    three's triangulator lays zero-area triangles along such rows and fans long slivers off them.
 * 2. Put those points back, each splitting the ring edge it lies on (one triangle uses it).
 * 3. Delaunay flips: an inside edge whose two opposite corners see it at over 180° together is
 *    swapped for the other diagonal of their (convex) quad. This turns slivers into fat triangles.
 * 4. Split every inside edge longer than `max` at its middle, in both triangles, longest first,
 *    flipping again after each pass, until none is left. An edge whose middle would land within
 *    OUTLINE_GAP of a ring is left: it runs along a sliver of panel too thin to bend anyway.
 * Ring edges are never split or flipped, so the panel keeps its outline's points exactly.
 */
function triangulateFine(contour: THREE.Vector2[], holes: THREE.Vector2[][], max: number): { points: THREE.Vector2[]; tris: number[][] } {
  const OUTLINE_GAP = 0.002;
  const cross = (a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2) => (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
  const key = (a: number, b: number) => (a < b ? a * 1_000_000 + b : b * 1_000_000 + a);
  const rings = [contour, ...holes];

  // 1. Corners only: a point in a row with its neighbours and between them is left out for now
  // (a point where the ring doubles back on itself stays).
  const between = (a: THREE.Vector2, p: THREE.Vector2, b: THREE.Vector2) =>
    Math.abs(cross(a, p, b)) <= 1e-9 && p.clone().sub(a).dot(b.clone().sub(p)) > 0;
  const simple = rings.map((ring) => ring.filter((p, i) => !between(ring[(i - 1 + ring.length) % ring.length], p, ring[(i + 1) % ring.length])));
  // triangulateShape reorders the rings in place: list the points after it.
  const tris = THREE.ShapeUtils.triangulateShape(simple[0], simple.slice(1)).map((t) => [...t]);
  const points = simple.flat();
  const indexOf = new Map(points.map((p, i) => [p, i]));
  const edgeIn = (t: number[], e: number) => t.findIndex((v, i) => key(v, t[(i + 1) % 3]) === e);
  /** Splits edge e (index pair) at point m in triangle t: (p, q, r) → (p, m, r) and (m, q, r). */
  const splitIn = (t: number, e: number, m: number): number => {
    const tri = tris[t];
    const k = edgeIn(tri, e);
    const [p, q, r] = [tri[k], tri[(k + 1) % 3], tri[(k + 2) % 3]];
    tris[t] = [p, m, r];
    return tris.push([m, q, r]) - 1;
  };

  // 2. The left-out points back, walking each ring from a corner.
  const outline = new Set<number>();
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    const kept = new Set(simple[r]);
    const start = ring.findIndex((p) => kept.has(p));
    let prev = indexOf.get(ring[start])!;
    for (let s = 1; s <= ring.length; s++) {
      const p = ring[(start + s) % ring.length];
      if (kept.has(p)) {
        outline.add(key(prev, indexOf.get(p)!));
        prev = indexOf.get(p)!;
        continue;
      }
      let n = s;
      while (!kept.has(ring[(start + n) % ring.length])) n++;
      const e = key(prev, indexOf.get(ring[(start + n) % ring.length])!);
      const t = tris.findIndex((tri) => edgeIn(tri, e) >= 0);
      if (t < 0) throw new Error('End panel: a ring edge is missing from its triangulation');
      const m = points.push(p) - 1;
      indexOf.set(p, m);
      splitIn(t, e, m);
      outline.add(key(prev, m));
      prev = m;
    }
  }

  const owners = () => {
    const map = new Map<number, number[]>();
    tris.forEach((t, i) => {
      for (let k = 0; k < 3; k++) {
        const e = key(t[k], t[(k + 1) % 3]);
        const list = map.get(e);
        if (list) list.push(i);
        else map.set(e, [i]);
      }
    });
    return map;
  };
  const angle = (o: number, p: number, q: number) => {
    const u = points[p].clone().sub(points[o]);
    const w = points[q].clone().sub(points[o]);
    return Math.acos(THREE.MathUtils.clamp(u.dot(w) / (u.length() * w.length()), -1, 1));
  };
  // 3. Flips, until a round makes none.
  const flip = () => {
    for (let round = 0; ; round++) {
      if (round > 200) throw new Error('End panel: edge flips did not settle');
      let flips = 0;
      const done = new Set<number>();
      for (const [e, users] of owners()) {
        if (users.length !== 2 || outline.has(e) || users.some((t) => done.has(t))) continue;
        const a = Math.floor(e / 1_000_000);
        const b = e % 1_000_000;
        const [t1, t2] = users;
        const c = tris[t1].find((v) => v !== a && v !== b)!;
        const d = tris[t2].find((v) => v !== a && v !== b)!;
        if (angle(c, a, b) + angle(d, a, b) <= Math.PI + 1e-9) continue;
        // Only a convex quad: a and b on either side of c–d.
        if (Math.sign(cross(points[c], points[d], points[a])) === Math.sign(cross(points[c], points[d], points[b]))) continue;
        tris[t1] = [c, d, a];
        tris[t2] = [d, c, b];
        done.add(t1).add(t2);
        flips++;
      }
      if (flips === 0) return;
    }
  };
  flip();

  // 4. Split long inside edges.
  const segments = rings.flatMap((ring) => ring.map((p, i) => new THREE.Line3(new THREE.Vector3(p.x, p.y), new THREE.Vector3(ring[(i + 1) % ring.length].x, ring[(i + 1) % ring.length].y))));
  const _m = new THREE.Vector3();
  const _c = new THREE.Vector3();
  const nearOutline = (m: THREE.Vector2) => segments.some((s) => s.closestPointToPoint(_m.set(m.x, m.y, 0), true, _c).distanceTo(_m) < OUTLINE_GAP);
  for (let pass = 0; ; pass++) {
    // A panel needs under 10 passes; more means the splitting doesn't converge.
    if (pass > 40) throw new Error(`End panel refinement didn't converge (${tris.length} triangles)`);
    const users = owners();
    const long: { e: number; length: number }[] = [];
    for (const e of users.keys()) {
      if (outline.has(e)) continue;
      const length = points[Math.floor(e / 1_000_000)].distanceTo(points[e % 1_000_000]);
      if (length > max) long.push({ e, length });
    }
    long.sort((a, b) => b.length - a.length);
    const touched = new Set<number>();
    let splits = 0;
    for (const { e } of long) {
      const ts = users.get(e)!;
      if (ts.some((t) => touched.has(t))) continue;
      const mid = points[Math.floor(e / 1_000_000)].clone().lerp(points[e % 1_000_000], 0.5);
      if (nearOutline(mid)) continue;
      const m = points.push(mid) - 1;
      for (const t of ts) touched.add(t).add(splitIn(t, e, m));
      splits++;
    }
    if (splits === 0) break;
    flip();
  }
  // Zero-area triangles (where a ring doubles back on itself) draw nothing.
  return { points, tris: tris.filter(([a, b, c]) => Math.abs(cross(points[a], points[b], points[c])) > 1e-12) };
}

/**
 * The closed polygon with extra points along any edge longer than `max`, so none is. A point
 * repeated where the outline closes (or anywhere in a row) is dropped.
 */
function densify(polygon: readonly THREE.Vector2[], max: number): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const length = a.distanceTo(b);
    if (length < 1e-6) continue;
    const steps = Math.ceil(length / max);
    for (let k = 0; k < steps; k++) out.push(a.clone().lerp(b, k / steps));
  }
  return out;
}

/**
 * An end panel (nose or tail cap) as a polygon with openings, plus a dark recess behind each
 * opening: walls facing the opening's axis and a back wall (with its hole, if any) facing out.
 * Openings are densified and the insides split fine (END_PANEL_EDGE), so they bend with a crush.
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
  const outline0 = openings.map((o) => o.outline);
  for (const outline of outline0) {
    for (const p of outline) {
      if (!insidePolygon(p, contour)) {
        throw new Error(`Panel opening at (${p.x.toFixed(3)}, ${p.y.toFixed(3)}) sticks out of the end panel at z=${z}`);
      }
    }
  }
  const outlines = outline0.map((o) => densify(o, END_PANEL_EDGE));
  const panel = triangulateFine(contour, outlines, END_PANEL_INNER);
  const points = panel.points.map((p) => new THREE.Vector3(p.x, p.y, z));
  for (const [a, b, c] of panel.tris) tri('shell', 'paint', points[a], points[b], points[c], ref);

  for (const [n, { outline: sparse, hole: sparseHole }] of openings.entries()) {
    // The centre from the outline as drawn: the added points would pull it toward long edges.
    const centre = sparse.reduce((sum, p) => sum.add(p), new THREE.Vector2()).divideScalar(sparse.length);
    const opening = outlines[n];
    const hole = sparseHole && densify(sparseHole, END_PANEL_EDGE);
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
    const behind = new THREE.Vector3(centre.x, centre.y, z + inward * (depth + 0.2));
    const wall = triangulateFine(rim, hole ? [hole] : [], END_PANEL_INNER);
    const backPoints = wall.points.map((p) => new THREE.Vector3(p.x, p.y, z + inward * depth));
    for (const [a, b, c] of wall.tris) tri('shell', 'recess', backPoints[a], backPoints[b], backPoints[c], behind);
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
