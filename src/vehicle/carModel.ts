import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildPanels, sample, type CarBlueprint, type PanelMaterial, type Panels } from './blueprint';
import type { CarConfig } from './carConfig';
import type { LightFixtureDef, LightKind } from './lights';

/** A dentable mesh on the car. Detachable pieces can be knocked off. */
export interface CarPiece {
  name: string;
  mesh: THREE.Mesh;
  /** Rest-state vertex positions (piece-local), as built. */
  original: Float32Array;
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
}

interface CarMaterials {
  paint: THREE.Material;
  glass: THREE.Material;
  chrome: THREE.Material;
  steel: THREE.Material;
  dark: THREE.Material;
  tire: THREE.Material;
  headlight: THREE.Material;
  taillight: THREE.Material;
  marker: THREE.Material;
  /** Smashed lenses: a bare reflector bowl for headlights, unlit coloured plastic for the rest. */
  brokenHead: THREE.Material;
  brokenTail: THREE.Material;
  brokenMarker: THREE.Material;
  engine: THREE.Material;
  upholstery: THREE.Material;
}

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
const TRIM = new Set(['grille', 'grille-frame', 'mirror-left', 'mirror-right', 'exhaust-tip-left', 'exhaust-tip-right']);
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
    m = {
      paint: std(paint, { roughness: 0.4, metalness: 0.25 }),
      glass: std(GLASS_TINT, { roughness: 0.05, metalness: 0.5, transparent: true, opacity: GLASS_OPACITY }),
      chrome: std('#d9dde2', { roughness: 0.2, metalness: 0.9 }),
      steel: std('#4b5056', { roughness: 0.5, metalness: 0.6 }),
      dark: std('#1c1d20', { roughness: 0.7 }),
      tire: std('#1a1a1c', { roughness: 0.9 }),
      headlight: std('#fff6d8', { emissive: '#fff1c4', emissiveIntensity: 0.6 }),
      taillight: std('#a3121b', { emissive: '#7a0a10', emissiveIntensity: 0.5 }),
      marker: std('#e08a1e', { emissive: '#7a4208', emissiveIntensity: 0.4 }),
      brokenHead: std('#c3c9cf', { roughness: 0.35, metalness: 0.8 }),
      brokenTail: std('#5a1418', { roughness: 0.6 }),
      brokenMarker: std('#7a4a14', { roughness: 0.6 }),
      engine: std('#c0502d', { roughness: 0.5, metalness: 0.3 }),
      upholstery: std('#5a2e24', { roughness: 0.75 }),
    };
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
  const doorX = sample(bp.halfWidth, doorZ);
  const doorH = (sample(bp.rocker, doorZ) + sample(bp.deck, doorZ)) / 2;
  const ajar = 0.05;
  const door = { axis: Y, mass: 35, damping: 4 };
  const lid = { axis: X, damping: 3 };
  const bumper = { axis: Z, min: ajar, max: 1.4, mass: 15, damping: 1, mirrorable: true };
  return {
    'door-right': { ...door, anchor: v(doorX, doorH, doorZ), min: ajar, max: 1.2 },
    'door-left': { ...door, anchor: v(-doorX, doorH, doorZ), min: -1.2, max: -ajar },
    hood: { ...lid, anchor: v(0, sample(bp.deck, bp.hood[1]), bp.hood[1]), min: ajar, max: 1.25, mass: 25 },
    trunk: { ...lid, anchor: v(0, sample(bp.deck, bp.trunk[0]), bp.trunk[0]), min: -1.25, max: -ajar, mass: 20 },
    'bumper-front': { ...bumper, anchor: v(0.95, 0.5, bp.front - 0.06) },
    'bumper-rear': { ...bumper, anchor: v(0.95, 0.56, bp.rear + 0.06) },
  };
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
    pieces.push({
      name,
      mesh,
      original: Float32Array.from(geometry.getAttribute('position').array),
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
      geos.push(g);
      // Lamp recesses are thin-walled but look like the rest of the dark inner panels.
      materials.push(m === 'recess' ? mat.dark : mat[m satisfies Exclude<PanelMaterial, 'recess'>]);
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

  // Chrome bumpers, subdivided along their length so they can bend.
  add('bumper-front', box(2.0, 0.12, 0.13, 10), mat.chrome, at(0, 0.5, bp.front - 0.06));
  add('bumper-rear', box(1.98, 0.12, 0.13, 10), mat.chrome, at(0, 0.56, bp.rear + 0.06));

  // Grille with a chrome surround, covering the grille opening (its frame overlaps the edge).
  // Subdivided across so a crumpled nose bends it along with it.
  const grille = bp.openings.grille;
  add('grille-frame', box(grille.width + 0.1, grille.height + 0.1, 0.03, 8), mat.chrome, at(0, grille.h, bp.front - 0.005));
  add('grille', box(grille.width + 0.04, grille.height + 0.04, 0.03, 8), mat.dark, at(0, grille.h, bp.front - 0.02));

  // Lights are rigid fixtures (see CarLights), posed relative to their mount point. Head- and
  // taillights cover real openings in the end panels (see the blueprint's openings); side markers
  // get a dark socket patch just proud of the body surface instead.
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
      socket = new THREE.Mesh(socketGeometry, mat.dark);
      socket.position.copy(mount).addScaledVector(normal, 0.003);
      root.add(socket);
    }
    // The lens is the last part (the ring, if any, comes first).
    lights.push({ name, kind, group, lens: meshes[meshes.length - 1], socket, normal });
  };
  const disc = (r: number, depth: number) => new THREE.CylinderGeometry(r, r, depth, 10).rotateX(Math.PI / 2);
  const back = new THREE.Vector3(0, 0, 1);
  const forward = new THREE.Vector3(0, 0, -1);
  // Chrome ring wider than the opening so it covers the rim; lens just inside the opening.
  const head = bp.openings.head;
  for (const side of [-1, 1]) {
    for (const hx of head.x) {
      const x = side * hx;
      fixture(`headlight-${x}`, 'head', at(x, head.h, bp.front), forward, [
        [disc(head.radius * 1.3, 0.04), mat.chrome, new THREE.Vector3(0, 0, -0.01)],
        [disc(head.radius * 0.98, 0.05), mat.headlight, new THREE.Vector3(0, 0, -0.02)],
      ]);
    }
  }
  // The 70s full-width taillight strip, in two halves so each side can go on its own.
  const tail = bp.openings.tail;
  for (const side of [-1, 1]) {
    fixture(`taillight-${side}`, 'tail', at(side * tail.x, tail.h, bp.rear), back, [
      [box(tail.width + 0.02, tail.height + 0.01, 0.03, 3), mat.taillight, new THREE.Vector3(0, 0, 0.01)],
    ]);
  }
  for (const side of [-1, 1]) {
    const out = new THREE.Vector3(side, 0, 0);
    const zf = bp.front + 0.25;
    const zr = bp.rear - 0.25;
    fixture(`marker-front-${side}`, 'marker', at(side * sample(bp.halfWidth, zf), 0.72, zf), out, [
      [box(0.02, 0.05, 0.14), mat.marker, new THREE.Vector3(side * 0.01, 0, 0)],
    ], box(0.01, 0.045, 0.13));
    fixture(`marker-rear-${side}`, 'tail', at(side * sample(bp.halfWidth, zr), 0.74, zr), out, [
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
  cabin.push(
    [put(new THREE.BoxGeometry(1.24, 0.14, 0.45), 0, 0.47, 0.95), mat.upholstery],
    [put(new THREE.BoxGeometry(1.24, 0.5, 0.12), 0, 0.78, 1.22, 0.35), mat.upholstery],
    [put(new THREE.BoxGeometry(1.5, 0.16, 0.3), 0, 0.92, -0.62), mat.dark],
    [put(new THREE.TorusGeometry(0.17, 0.022, 6, 14), -0.42, 0.88, -0.38, -0.45), mat.dark],
    [put(new THREE.CylinderGeometry(0.025, 0.025, 0.35, 6), -0.42, 0.9, -0.52, Math.PI / 2 - 0.45), mat.dark],
  );
  assemble('interior', cabin);

  // Engine bay: V8 block with valve covers and air cleaner, radiator, battery.
  assemble('engine', [
    [put(new THREE.BoxGeometry(0.55, 0.38, 0.8), 0, 0.62, -1.45), mat.engine],
    [put(new THREE.BoxGeometry(0.16, 0.08, 0.7), -0.26, 0.86, -1.45, 0, 0.5), mat.chrome],
    [put(new THREE.BoxGeometry(0.16, 0.08, 0.7), 0.26, 0.86, -1.45, 0, -0.5), mat.chrome],
    [put(new THREE.CylinderGeometry(0.2, 0.2, 0.06, 12), 0, 0.88, -1.45), mat.chrome],
    // Exhaust manifolds along the block's sides; the exhaust pipes start at their rear ends.
    [put(new THREE.BoxGeometry(0.06, 0.07, 0.5), -0.31, 0.55, -1.5), mat.steel],
    [put(new THREE.BoxGeometry(0.06, 0.07, 0.5), 0.31, 0.55, -1.5), mat.steel],
    [put(new THREE.BoxGeometry(1.1, 0.4, 0.08, 8), 0, 0.66, -2.18), mat.dark],
    [put(new THREE.BoxGeometry(0.24, 0.2, 0.18), 0.55, 0.62, -2.0), mat.dark],
    [put(new THREE.BoxGeometry(0.04, 0.03, 0.04), 0.6, 0.735, -2.04), mat.taillight],
  ]);

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
  };
}
