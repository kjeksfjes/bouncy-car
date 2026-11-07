import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildPanels, sample, type PanelMaterial } from './blueprint';
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
  attached: boolean;
  hp: number;
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
}

/** Body parts that can be knocked off. Everything else stays on and only dents. */
const DETACHABLE = new Set(['hood', 'trunk', 'door-left', 'door-right', 'bumper-front', 'bumper-rear']);

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
    // Body panels are double-sided so a missing door or hood never reveals see-through holes.
    // Shadows come from back faces only; double-sided casting causes acne on the panels.
    const twoSided = { side: THREE.DoubleSide, shadowSide: THREE.BackSide } as const;
    m = {
      paint: std(paint, { roughness: 0.4, metalness: 0.25, ...twoSided }),
      glass: std('#1e2a33', { roughness: 0.08, metalness: 0.4, ...twoSided }),
      chrome: std('#d9dde2', { roughness: 0.2, metalness: 0.9 }),
      dark: std('#1c1d20', { roughness: 0.7, ...twoSided }),
      tire: std('#1a1a1c', { roughness: 0.9 }),
      headlight: std('#fff6d8', { emissive: '#fff1c4', emissiveIntensity: 0.6 }),
      taillight: std('#a3121b', { emissive: '#7a0a10', emissiveIntensity: 0.5 }),
      marker: std('#e08a1e', { emissive: '#7a4208', emissiveIntensity: 0.4 }),
    };
    byPaint.set(paint, m);
  }
  return m;
}

/** Builds the car from its blueprint: lofted body parts plus lights, grille, bumpers and wheels. */
export function buildCarModel(cfg: CarConfig, paint: string): CarModel {
  const mat = materialsFor(cfg, paint);
  const bp = cfg.blueprint;
  const gy = bp.groundY;
  const root = new THREE.Group();
  const pieces: CarPiece[] = [];

  /** Adds a piece. Geometry is recentred on its bounds so the mesh position is the part's centre. */
  const add = (name: string, geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], at?: THREE.Vector3) => {
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
    pieces.push({
      name,
      mesh,
      original: Float32Array.from(geometry.getAttribute('position').array),
      bounds: geometry.boundingBox!.clone().translate(mesh.position),
      detachable: DETACHABLE.has(name),
      attached: true,
      hp: cfg.damage.partHp,
    });
  };

  // Lofted body parts, one mesh per part with a material group per surface type.
  for (const [part, byMaterial] of buildPanels(bp)) {
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
