import * as THREE from 'three';

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
  hoodBulge: { from: number; to: number; halfWidth: number; height: number };
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

export type PanelMaterial = 'paint' | 'dark' | 'glass';
/** Body triangles (flat position arrays, car-local) grouped by part, then material. */
export type Panels = Map<string, Map<PanelMaterial, number[]>>;

/** Gap between greenhouse and deck surfaces (m); see `upper` in buildPanels. */
const GREENHOUSE_LIFT = 0.012;

const within = (z: number, range: readonly [number, number]) => z >= range[0] && z <= range[1];
const sideName = (side: number) => (side > 0 ? 'right' : 'left');

const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c = new THREE.Vector3();

/**
 * Lofts the body from the blueprint: a lower body (floor, wheel wells,
 * sides, deck) and a greenhouse (glass, pillars, roof), sampled at stations
 * along Z. Every quad is assigned to a part by where it sits, so panels split
 * exactly along the blueprint's cut lines.
 */
export function buildPanels(bp: CarBlueprint): Panels {
  const panels: Panels = new Map();
  const target = (part: string, mat: PanelMaterial) => {
    let mats = panels.get(part);
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
    target(part, mat).push(a.x, a.y, a.z, p.x, p.y, p.z, q.x, q.y, q.z);
  };
  const quad = (part: string, mat: PanelMaterial, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, ref: THREE.Vector3) => {
    tri(part, mat, a, b, c, ref);
    tri(part, mat, a, c, d, ref);
  };
  const addBox = (part: string, mat: PanelMaterial, size: readonly [number, number, number], center: THREE.Vector3) => {
    const geo = new THREE.BoxGeometry(...size).toNonIndexed();
    geo.translate(center.x, center.y, center.z);
    target(part, mat).push(...geo.getAttribute('position').array);
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
  const lower = (z: number): [number, number][] => {
    const hw = sample(bp.halfWidth, z);
    const deck = sample(bp.deck, z);
    const rocker = sample(bp.rocker, z);
    const bottom = Math.max(rocker, archHeight(z));
    return [
      [0, rocker], // 0 floor centre
      [bp.wellHalf, rocker], // 1 floor edge
      [bp.wellHalf, bottom], // 2 top of inner wheel-well wall
      [hw * 0.96, bottom], // 3 outer lower lip
      [hw, bottom + (deck - bottom) * 0.3], // 4 lower side
      [hw, deck - 0.1], // 5 shoulder crease
      [hw * 0.97, deck - 0.02], // 6 rounded top edge
      [hw * 0.92, deck], // 7 deck edge
      [0, deck + bp.crown], // 8 deck centre
    ];
  };
  const lowerPart = (zm: number, seg: number, side: number): [string, PanelMaterial] => {
    if (seg <= 2) return ['shell', 'dark']; // floor and wheel wells
    if (seg <= 5) return within(zm, bp.door) ? [`door-${sideName(side)}`, 'paint'] : ['shell', 'paint'];
    if (seg === 7 && within(zm, bp.hood)) return ['hood', 'paint'];
    if (seg === 7 && within(zm, bp.trunk)) return ['trunk', 'paint'];
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
        const [part, mat] = lowerPart(zm, j, side);
        quad(
          part, mat,
          v(side * s0[j][0], s0[j][1], z0), v(side * s1[j][0], s1[j][1], z1),
          v(side * s1[j + 1][0], s1[j + 1][1], z1), v(side * s0[j + 1][0], s0[j + 1][1], z0),
          ref,
        );
      }
    }
  }

  // Nose and tail caps: fan over the full cross-section.
  for (const [z, inward] of [[bp.front, 1], [bp.rear, -1]] as const) {
    const s = lower(z);
    const ring = [...s.map(([x, h]) => v(x, h, z)), ...s.slice(1, -1).reverse().map(([x, h]) => v(-x, h, z))];
    const mid = (sample(bp.rocker, z) + sample(bp.deck, z)) / 2;
    const center = v(0, mid, z);
    const ref = v(0, mid, z + inward * 0.2);
    for (let k = 0; k < ring.length; k++) tri('shell', 'paint', center, ring[k], ring[(k + 1) % ring.length], ref);
  }

  // Greenhouse cross-section (right half): sill → window top → roof edge → roof centre.
  // It sits a hair above the deck so the two never share a plane (which flickers).
  // The inward lean (tumblehome) scales with the greenhouse's height, so where the roof
  // slopes down to the deck the panels stay planar instead of twisting (which flat
  // shading shows as saw teeth).
  const maxRise = Math.max(...gh.roof.map(([z, h]) => h - sample(bp.deck, z)));
  const upper = (z: number): [number, number][] => {
    const deck = sample(bp.deck, z) + GREENHOUSE_LIFT;
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
      if (within(zm, gh.doorGlass)) return [`door-${sideName(side)}`, 'glass'];
      if (within(zm, gh.quarterGlass)) return ['glass', 'glass'];
      return ['roof', 'paint'];
    }
    if (seg === 1) return ['roof', 'paint'];
    if (seg === 2) return ['roof', 'paint'];
    return zone === 'roof' ? ['roof', 'paint'] : ['glass', 'glass'];
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

  // Body-coloured mirrors ride on the doors; the power bulge rides on the hood.
  const [mw, mh, ml] = bp.mirror.size;
  for (const side of [1, -1]) {
    const deck = sample(bp.deck, bp.mirror.z);
    addBox(`door-${sideName(side)}`, 'paint', bp.mirror.size, v(side * (gh.sillHalf + mw / 2 + 0.02), deck + mh / 2 + 0.06, bp.mirror.z));
    addBox(`door-${sideName(side)}`, 'paint', [mw + 0.04, 0.03, ml * 0.5], v(side * (gh.sillHalf + 0.03), deck + 0.04, bp.mirror.z));
  }
  // The bulge is tilted to follow the hood's slope so it sits flush along its length.
  const b = bp.hoodBulge;
  const bz = (b.from + b.to) / 2;
  const pitch = Math.atan2(sample(bp.deck, b.to) - sample(bp.deck, b.from), b.to - b.from);
  const bulge = new THREE.BoxGeometry(b.halfWidth * 2, b.height, b.to - b.from).rotateX(-pitch).toNonIndexed();
  bulge.translate(0, sample(bp.deck, bz) + bp.crown + gy + b.height / 2 - 0.015, bz);
  target('hood', 'paint').push(...bulge.getAttribute('position').array);
  bulge.dispose();

  return panels;
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
