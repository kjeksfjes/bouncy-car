import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash2 } from './noise';
import type { TerrainField } from './terrainField';

const COLORS = {
  trunk: new THREE.Color('#5b4636'),
  needles: new THREE.Color('#2f5a46'),
  needlesDark: new THREE.Color('#244838'),
  snow: new THREE.Color('#f3f6fa'),
  rock: new THREE.Color('#6e717a'),
};

/** No props within this radius of the spawn point, so the first seconds are clear. */
const SPAWN_CLEAR_RADIUS = 35;
const TREE_CELL = 9;
const ROCK_CELL = 16;

/** Writes one flat colour per triangle into a non-indexed geometry. */
function paintFaces(
  geo: THREE.BufferGeometry,
  pick: (centroid: THREE.Vector3, normal: THREE.Vector3) => THREE.Color,
): void {
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  const normal = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    centroid.copy(a).add(b).add(c).divideScalar(3);
    normal.subVectors(b, a).cross(c.clone().sub(a)).normalize();
    const col = pick(centroid, normal);
    for (let k = 0; k < 3; k++) col.toArray(colors, (i + k) * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

function buildTreeGeometry(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.22, 0.32, 1.8, 6).toNonIndexed();
  trunk.translate(0, 0.9, 0);
  paintFaces(trunk, () => COLORS.trunk);

  const layers = [
    { r: 2.1, h: 2.6, y: 1.3, color: COLORS.needlesDark },
    { r: 1.6, h: 2.2, y: 2.8, color: COLORS.needles },
    { r: 1.05, h: 1.9, y: 4.2, color: COLORS.needles },
  ];
  const parts = [trunk];
  for (const l of layers) {
    const cone = new THREE.ConeGeometry(l.r, l.h, 7, 2).toNonIndexed();
    cone.translate(0, l.y + l.h / 2, 0);
    const snowLine = l.y + l.h * 0.5;
    paintFaces(cone, (centroid, n) => (centroid.y > snowLine && n.y > 0 ? COLORS.snow : l.color));
    parts.push(cone);
  }
  const merged = mergeGeometries(parts);
  if (!merged) throw new Error('Tree geometry merge failed: part attributes differ');
  return merged;
}

/** A jittered icosahedron. Duplicate corners are moved identically so the hull stays closed. */
function buildRockGeometry(): { geometry: THREE.BufferGeometry; hullPoints: THREE.Vector3[] } {
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const pos = geo.getAttribute('position');
  const v = new THREE.Vector3();
  const unique = new Map<string, THREE.Vector3>();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
    let moved = unique.get(key);
    if (!moved) {
      const j = 0.75 + hash2(unique.size * 17, 3, 99) * 0.45;
      moved = v.clone().multiplyScalar(j);
      unique.set(key, moved);
    }
    pos.setXYZ(i, moved.x, moved.y, moved.z);
  }
  geo.computeVertexNormals();
  paintFaces(geo, (_c, n) => (n.y > 0.55 ? COLORS.snow : COLORS.rock));
  return { geometry: geo, hullPoints: [...unique.values()] };
}

export interface ChunkProps {
  objects: THREE.Object3D[];
  dispose(): void;
}

/** Scatters snowy pines and rocks over terrain chunks, with fixed colliders. */
export class PropScatter {
  private readonly treeGeometry = buildTreeGeometry();
  private readonly rock = buildRockGeometry();
  private readonly material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.85,
  });

  constructor(
    private readonly field: TerrainField,
    private readonly world: RAPIER.World,
  ) {}

  populate(x0: number, z0: number, size: number, body: RAPIER.RigidBody): ChunkProps {
    const seed = this.field.seed;
    const n = new THREE.Vector3();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    const treeMatrices: THREE.Matrix4[] = [];
    for (let gz = 0; gz <= size / TREE_CELL; gz++) {
      for (let gx = 0; gx <= size / TREE_CELL; gx++) {
        const cellX = Math.floor(x0 / TREE_CELL) + gx;
        const cellZ = Math.floor(z0 / TREE_CELL) + gz;
        const x = (cellX + hash2(cellX, cellZ, seed + 11)) * TREE_CELL;
        const z = (cellZ + hash2(cellX, cellZ, seed + 12)) * TREE_CELL;
        if (x < x0 || x >= x0 + size || z < z0 || z >= z0 + size) continue;
        if (Math.hypot(x, z) < SPAWN_CLEAR_RADIUS) continue;
        if (hash2(cellX, cellZ, seed + 13) > this.field.forestDensity(x, z) * 0.7) continue;
        if (this.field.normal(x, z, n).y < 0.82) continue;

        const scale = 0.8 + hash2(cellX, cellZ, seed + 14) * 0.8;
        const y = this.field.height(x, z) - 0.2;
        q.setFromAxisAngle(up, hash2(cellX, cellZ, seed + 15) * Math.PI * 2);
        treeMatrices.push(new THREE.Matrix4().compose(p.set(x, y, z), q, s.setScalar(scale)));

        const halfHeight = 2.2 * scale;
        this.world.createCollider(
          RAPIER.ColliderDesc.cylinder(halfHeight, 0.45 * scale).setTranslation(x, y + halfHeight, z),
          body,
        );
      }
    }

    const rockMatrices: THREE.Matrix4[] = [];
    for (let gz = 0; gz < size / ROCK_CELL; gz++) {
      for (let gx = 0; gx < size / ROCK_CELL; gx++) {
        const cellX = Math.floor(x0 / ROCK_CELL) + gx;
        const cellZ = Math.floor(z0 / ROCK_CELL) + gz;
        if (hash2(cellX, cellZ, seed + 21) > 0.25) continue;
        const x = (cellX + hash2(cellX, cellZ, seed + 22)) * ROCK_CELL;
        const z = (cellZ + hash2(cellX, cellZ, seed + 23)) * ROCK_CELL;
        if (Math.hypot(x, z) < SPAWN_CLEAR_RADIUS) continue;

        const size3 = 1.0 + hash2(cellX, cellZ, seed + 24) * 2.2;
        s.set(size3 * (0.9 + hash2(cellX, cellZ, seed + 25) * 0.4), size3 * 0.7, size3);
        q.setFromAxisAngle(up, hash2(cellX, cellZ, seed + 26) * Math.PI * 2);
        p.set(x, this.field.height(x, z) - size3 * 0.25, z);
        m.compose(p, q, s);
        rockMatrices.push(m.clone());

        const pts = new Float32Array(this.rock.hullPoints.length * 3);
        this.rock.hullPoints.forEach((hp, i) => hp.clone().applyMatrix4(m).toArray(pts, i * 3));
        const hull = RAPIER.ColliderDesc.convexHull(pts);
        if (!hull) throw new Error('Rock convex hull failed: degenerate points');
        this.world.createCollider(hull, body);
      }
    }

    const objects: THREE.Object3D[] = [];
    const toInstanced = (geo: THREE.BufferGeometry, mats: THREE.Matrix4[]) => {
      if (mats.length === 0) return;
      const mesh = new THREE.InstancedMesh(geo, this.material, mats.length);
      mats.forEach((mat, i) => mesh.setMatrixAt(i, mat));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      objects.push(mesh);
    };
    toInstanced(this.treeGeometry, treeMatrices);
    toInstanced(this.rock.geometry, rockMatrices);

    return {
      objects,
      // Geometry and material are shared across chunks; only the instance buffers are per-chunk.
      dispose: () => objects.forEach((o) => (o as THREE.InstancedMesh).dispose()),
    };
  }
}
