import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildPanels, sample, type CarBlueprint, type PanelMaterial, type Panels } from './blueprint';
import type { CarConfig } from './carConfig';

/** A dentable mesh on the car. Detachable pieces can be knocked off. */
export interface CarPiece {
  name: string;
  mesh: THREE.Mesh;
  /** Rest-state vertex positions, used to cap how far a dent can push. */
  original: Float32Array;
  /** Car-local bounds at build time, for hit proximity. */
  bounds: THREE.Box3;
  detachable: boolean;
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
}

export interface CarModel {
  root: THREE.Group;
  pieces: CarPiece[];
  wheels: WheelVisual[];
}

interface CarMaterials {
  paint: THREE.Material;
  glass: THREE.Material;
  chrome: THREE.Material;
  dark: THREE.Material;
  tire: THREE.Material;
  headlight: THREE.Material;
  taillight: THREE.Material;
  marker: THREE.Material;
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
const DETACHABLE = new Set(['hood', 'trunk', 'door-left', 'door-right', 'bumper-front', 'bumper-rear']);

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
      dark: std('#1c1d20', { roughness: 0.7 }),
      tire: std('#1a1a1c', { roughness: 0.9 }),
      headlight: std('#fff6d8', { emissive: '#fff1c4', emissiveIntensity: 0.6 }),
      taillight: std('#a3121b', { emissive: '#7a0a10', emissiveIntensity: 0.5 }),
      marker: std('#e08a1e', { emissive: '#7a4208', emissiveIntensity: 0.4 }),
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
      bounds: geometry.boundingBox!.clone().translate(mesh.position),
      detachable: DETACHABLE.has(name),
      state: 'closed',
      hp: glass ? cfg.damage.glassHp : cfg.damage.partHp,
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
      materials.push(mat[m satisfies PanelMaterial]);
    }
    const merged = mergeGeometries(geos, true);
    if (!merged) throw new Error(`Body part "${part}" failed to merge`);
    add(part, merged, materials);
  }

  // Door windows ride on their doors: they swing and fly off with them.
  for (const side of ['left', 'right']) {
    const door = pieces.find((p) => p.name === `door-${side}`)!;
    const pane = pieces.find((p) => p.name === `door-glass-${side}`)!;
    door.mesh.attach(pane.mesh);
    pane.glass!.follows = door.name;
  }

  const box = (w: number, h: number, d: number, segX = 1) => new THREE.BoxGeometry(w, h, d, segX, 1, 1);
  const at = (x: number, h: number, z: number) => new THREE.Vector3(x, h + gy, z);

  // Chrome bumpers, subdivided along their length so they can bend.
  add('bumper-front', box(2.0, 0.12, 0.13, 10), mat.chrome, at(0, 0.5, bp.front - 0.06));
  add('bumper-rear', box(1.98, 0.12, 0.13, 10), mat.chrome, at(0, 0.56, bp.rear + 0.06));

  // Grille with a chrome surround, quad headlights in chrome rings.
  add('grille-frame', box(0.92, 0.26, 0.03), mat.chrome, at(0, 0.69, bp.front - 0.005));
  add('grille', box(0.86, 0.2, 0.03), mat.dark, at(0, 0.69, bp.front - 0.02));
  for (const x of [-0.77, -0.56, 0.56, 0.77]) {
    add(`headlight-ring-${x}`, new THREE.CylinderGeometry(0.085, 0.085, 0.04, 10).rotateX(Math.PI / 2), mat.chrome, at(x, 0.7, bp.front - 0.01));
    add(`headlight-${x}`, new THREE.CylinderGeometry(0.065, 0.065, 0.05, 10).rotateX(Math.PI / 2), mat.headlight, at(x, 0.7, bp.front - 0.02));
  }

  // Full-width 70s taillight strip and side marker lights.
  add('taillights', box(1.55, 0.1, 0.03, 6), mat.taillight, at(0, 0.7, bp.rear + 0.01));
  for (const side of [-1, 1]) {
    const zf = bp.front + 0.25;
    const zr = bp.rear - 0.25;
    add(`marker-front-${side}`, box(0.02, 0.05, 0.14), mat.marker, at(side * (sample(bp.halfWidth, zf) + 0.01), 0.72, zf));
    add(`marker-rear-${side}`, box(0.02, 0.05, 0.14), mat.taillight, at(side * (sample(bp.halfWidth, zr) + 0.01), 0.74, zr));
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
    [put(new THREE.BoxGeometry(1.1, 0.4, 0.08), 0, 0.66, -2.18), mat.dark],
    [put(new THREE.BoxGeometry(0.24, 0.2, 0.18), 0.55, 0.62, -2.0), mat.dark],
    [put(new THREE.BoxGeometry(0.04, 0.03, 0.04), 0.6, 0.735, -2.04), mat.taillight],
  ]);

  // Spare wheel lying in the trunk.
  assemble('spare', [
    [put(new THREE.CylinderGeometry(0.32, 0.32, 0.2, 14), 0.35, 0.5, 2.0), mat.tire],
    [put(new THREE.CylinderGeometry(0.19, 0.19, 0.21, 10), 0.35, 0.5, 2.0), mat.chrome],
  ]);

  // Wheels: tyre, chrome rim and five lug nuts on the outer face.
  const W = cfg.wheels;
  const wheels: WheelVisual[] = [];
  for (const z of [W.frontZ, W.rearZ]) {
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * W.halfTrack, W.mountY - cfg.suspension.restLength, z);
      const spin = new THREE.Group();
      // Per-wheel geometry: a lost wheel takes (and later disposes) its own buffers.
      const tire = new THREE.Mesh(new THREE.CylinderGeometry(W.radius, W.radius, W.width, 16).rotateZ(Math.PI / 2), mat.tire);
      const rim = new THREE.Mesh(
        new THREE.CylinderGeometry(W.radius * 0.6, W.radius * 0.6, W.width + 0.02, 10).rotateZ(Math.PI / 2),
        mat.chrome,
      );
      spin.add(tire, rim);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const lug = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.035, 0.035), mat.dark);
        lug.position.set(side * (W.width / 2 + 0.02), Math.cos(a) * W.radius * 0.28, Math.sin(a) * W.radius * 0.28);
        spin.add(lug);
      }
      spin.traverse((o) => (o.castShadow = true));
      pivot.add(spin);
      root.add(pivot);
      wheels.push({ pivot, spin });
    }
  }

  return { root, pieces, wheels };
}
