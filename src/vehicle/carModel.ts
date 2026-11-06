import * as THREE from 'three';
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
  roof: THREE.Material;
  glass: THREE.Material;
  chrome: THREE.Material;
  dark: THREE.Material;
  tire: THREE.Material;
  headlight: THREE.Material;
  taillight: THREE.Material;
}

// Materials are shared between every car built from the same config (and their debris),
// so they are never disposed with an individual car.
const materialCache = new WeakMap<CarConfig, CarMaterials>();

function materialsFor(cfg: CarConfig): CarMaterials {
  let m = materialCache.get(cfg);
  if (!m) {
    const std = (color: string, extra: THREE.MeshStandardMaterialParameters = {}) =>
      new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.55, metalness: 0.1, ...extra });
    m = {
      paint: std(cfg.look.paint, { roughness: 0.4, metalness: 0.25 }),
      roof: std(cfg.look.roof, { roughness: 0.85 }),
      glass: std('#1e2a33', { roughness: 0.08, metalness: 0.4 }),
      chrome: std('#d9dde2', { roughness: 0.2, metalness: 0.9 }),
      dark: std('#1c1d20', { roughness: 0.7 }),
      tire: std('#1a1a1c', { roughness: 0.9 }),
      headlight: std('#fff6d8', { emissive: '#fff1c4', emissiveIntensity: 0.6 }),
      taillight: std('#a3121b', { emissive: '#7a0a10', emissiveIntensity: 0.5 }),
    };
    materialCache.set(cfg, m);
  }
  return m;
}

/** Procedural boxy 70s sedan. Boxes are subdivided so dents have vertices to push. */
export function buildCarModel(cfg: CarConfig): CarModel {
  const mat = materialsFor(cfg);
  const root = new THREE.Group();
  const pieces: CarPiece[] = [];
  const B = cfg.body;
  const C = cfg.cabin;
  const hy = B.height / 2;

  const add = (
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    position: [number, number, number],
    detachable: boolean,
  ) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    geometry.computeBoundingBox();
    const bounds = geometry.boundingBox!.clone().translate(mesh.position);
    const original = Float32Array.from(geometry.getAttribute('position').array);
    pieces.push({ name, mesh, original, bounds, detachable, attached: true, hp: cfg.damage.partHp });
  };

  add('shell', new THREE.BoxGeometry(B.width, B.height, B.length, 6, 3, 16), mat.paint, [0, 0, 0], false);

  // Greenhouse: tapered box, top pulled in and back for a sloped windscreen.
  const cabin = new THREE.BoxGeometry(C.width, C.height, C.length, 4, 2, 6);
  const cp = cabin.getAttribute('position');
  for (let i = 0; i < cp.count; i++) {
    if (cp.getY(i) > 0) {
      cp.setX(i, cp.getX(i) * 0.88);
      cp.setZ(i, cp.getZ(i) * 0.78 + 0.1);
    }
  }
  add('cabin', cabin, mat.glass, [0, hy + C.height / 2, C.z], false);
  add(
    'roof',
    new THREE.BoxGeometry(C.width * 0.9, 0.07, C.length * 0.8, 4, 1, 5),
    mat.roof,
    [0, hy + C.height + 0.035, C.z + 0.1],
    false,
  );

  add('hood', new THREE.BoxGeometry(B.width - 0.1, 0.06, 1.55, 5, 1, 5), mat.paint, [0, hy + 0.03, -B.length / 2 + 0.8], true);
  add('trunk', new THREE.BoxGeometry(B.width - 0.1, 0.06, 1.15, 5, 1, 4), mat.paint, [0, hy + 0.03, B.length / 2 - 0.62], true);

  for (const side of [-1, 1]) {
    add(
      side < 0 ? 'door-left' : 'door-right',
      new THREE.BoxGeometry(0.05, B.height * 0.86, 2.1, 1, 2, 6),
      mat.paint,
      [side * (B.width / 2 + 0.025), 0.02, 0.05],
      true,
    );
  }

  for (const end of [-1, 1]) {
    add(
      end < 0 ? 'bumper-front' : 'bumper-rear',
      new THREE.BoxGeometry(B.width + 0.06, 0.16, 0.16, 8, 1, 1),
      mat.chrome,
      [0, -hy + 0.14, end * (B.length / 2 + 0.06)],
      true,
    );
  }

  add('grille', new THREE.BoxGeometry(B.width * 0.55, B.height * 0.45, 0.04, 4, 1, 1), mat.dark, [0, 0.04, -B.length / 2 - 0.015], false);
  for (const side of [-1, 1]) {
    add(`headlight-${side}`, new THREE.BoxGeometry(0.26, 0.16, 0.04), mat.headlight, [side * 0.75, 0.05, -B.length / 2 - 0.015], false);
    add(`taillight-${side}`, new THREE.BoxGeometry(0.4, 0.13, 0.04), mat.taillight, [side * 0.68, 0.08, B.length / 2 + 0.015], false);
  }

  const W = cfg.wheels;
  const wheels: WheelVisual[] = [];
  for (const z of [W.frontZ, W.rearZ]) {
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * W.halfTrack, W.mountY - cfg.suspension.restLength, z);
      const spin = new THREE.Group();
      // Per-wheel geometry: a lost wheel takes (and later disposes) its own buffers.
      const tireGeo = new THREE.CylinderGeometry(W.radius, W.radius, W.width, 14).rotateZ(Math.PI / 2);
      const hubGeo = new THREE.CylinderGeometry(W.radius * 0.55, W.radius * 0.55, W.width + 0.02, 8).rotateZ(Math.PI / 2);
      const tire = new THREE.Mesh(tireGeo, mat.tire);
      const hub = new THREE.Mesh(hubGeo, mat.chrome);
      tire.castShadow = true;
      hub.castShadow = true;
      spin.add(tire, hub);
      pivot.add(spin);
      root.add(pivot);
      wheels.push({ pivot, spin });
    }
  }

  return { root, pieces, wheels };
}
