import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SPECIES, TREE_CELL, type Tree, type TreeLayout } from './trees';

const COLORS = {
  trunk: new THREE.Color('#5b4636'),
  needles: new THREE.Color('#2f5a46'),
  needlesDark: new THREE.Color('#244838'),
  snow: new THREE.Color('#f3f6fa'),
  /** Pine: reddish upper bark and a darker, bluer crown. */
  pineBark: new THREE.Color('#8a5a3c'),
  pineNeedles: new THREE.Color('#2c5236'),
  pineNeedlesDark: new THREE.Color('#223f2b'),
  /** Broadleaf: grey-brown trunk, two greens so the canopy reads as clumps. */
  broadTrunk: new THREE.Color('#6a5a4a'),
  leaves: new THREE.Color('#5d8f37'),
  leavesDark: new THREE.Color('#467429'),
};


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

/** Merges flat-coloured parts into one tree geometry. */
function mergeTree(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts.map((g) => {
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    return g;
  }));
  if (!merged) throw new Error('Tree geometry merge failed: part attributes differ');
  merged.computeVertexNormals();
  return merged;
}

/** A spruce: three stacked cones, snow on their upper sides if `snowy`. ≈6.1 m tall. */
function buildSpruce(snowy: boolean): THREE.BufferGeometry {
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
    paintFaces(cone, (centroid, n) => (snowy && centroid.y > snowLine && n.y > 0 ? COLORS.snow : l.color));
    parts.push(cone);
  }
  return mergeTree(parts);
}

/**
 * A Scots pine: a tall trunk, bare below and reddish above, with a few branches reaching out to
 * an irregular crown of flattened needle clouds. ≈6.4 m tall.
 */
function buildPine(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.13, 0.25, 5.4, 6).toNonIndexed();
  trunk.translate(0, 2.7, 0);
  paintFaces(trunk, (c) => (c.y > 2.4 ? COLORS.pineBark : COLORS.trunk));
  const parts = [trunk];
  // Needle clouds: offset from the trunk at different heights, each fed by a branch.
  const clouds = [
    { r: 1.35, x: 0.75, y: 3.7, z: 0.2 },
    { r: 1.2, x: -0.7, y: 4.3, z: -0.35 },
    { r: 1.25, x: 0.2, y: 5.0, z: 0.6 },
    { r: 1.0, x: 0, y: 5.8, z: -0.1 },
  ];
  for (const c of clouds) {
    const cloud = new THREE.IcosahedronGeometry(c.r, 0).toNonIndexed();
    cloud.scale(1, 0.42, 1).translate(c.x, c.y, c.z);
    paintFaces(cloud, (_, n) => (n.y > 0.3 ? COLORS.pineNeedles : COLORS.pineNeedlesDark));
    parts.push(cloud);
    const reach = Math.hypot(c.x, c.z);
    if (reach < 0.3) continue;
    // A branch from the trunk, rising a little, to the cloud's middle.
    const branch = new THREE.CylinderGeometry(0.05, 0.08, reach, 5).toNonIndexed();
    branch.translate(0, reach / 2, 0).rotateZ(-Math.PI / 2 + 0.35).rotateY(-Math.atan2(c.z, c.x)).translate(0, c.y - 0.35, 0);
    paintFaces(branch, () => COLORS.pineBark);
    parts.push(branch);
  }
  return mergeTree(parts);
}

/** A broadleaf tree: a short trunk with a round canopy of a few faceted clumps. ≈5.2 m tall. */
function buildBroadleaf(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.16, 0.26, 2.6, 6).toNonIndexed();
  trunk.translate(0, 1.3, 0);
  paintFaces(trunk, () => COLORS.broadTrunk);
  const parts = [trunk];
  const clumps = [
    { r: 1.6, x: 0, y: 3.4, z: 0 },
    { r: 1.2, x: 0.9, y: 3.0, z: 0.4 },
    { r: 1.15, x: -0.8, y: 3.1, z: -0.5 },
    { r: 1.05, x: 0.2, y: 4.2, z: -0.3 },
  ];
  clumps.forEach((c, i) => {
    const blob = new THREE.IcosahedronGeometry(c.r, 0).toNonIndexed();
    blob.scale(1, 0.85, 1).translate(c.x, c.y, c.z);
    // Faces turned down sit in the canopy's shade.
    paintFaces(blob, (_, n) => (n.y < -0.2 || i === 1 ? COLORS.leavesDark : COLORS.leaves));
    parts.push(blob);
  });
  return mergeTree(parts);
}

/** The tree meshes: one geometry per kind of tree (spruce with and without snow). */
type TreeKind = 'spruceSnowy' | 'spruce' | 'pine' | 'broadleaf';
const kindOf = (t: Tree): TreeKind => (t.species === 'spruce' ? (t.snowy ? 'spruceSnowy' : 'spruce') : t.species);

export interface ChunkProps {
  objects: THREE.Object3D[];
  dispose(): void;
}

/** Scatters trees over terrain chunks, with fixed trunk colliders. */
export class PropScatter {
  private readonly geometries: Record<TreeKind, THREE.BufferGeometry> = {
    spruceSnowy: buildSpruce(true),
    spruce: buildSpruce(false),
    pine: buildPine(),
    broadleaf: buildBroadleaf(),
  };
  private readonly material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.85,
  });

  constructor(
    private readonly trees: TreeLayout,
    private readonly world: RAPIER.World,
  ) {}

  populate(x0: number, z0: number, size: number, body: RAPIER.RigidBody): ChunkProps {
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    const matrices = new Map<TreeKind, THREE.Matrix4[]>();
    // Cells don't align with chunk edges (64 / 9), so scan one extra and keep what falls inside.
    for (let gz = 0; gz <= size / TREE_CELL; gz++) {
      for (let gx = 0; gx <= size / TREE_CELL; gx++) {
        const t = this.trees.inCell(Math.floor(x0 / TREE_CELL) + gx, Math.floor(z0 / TREE_CELL) + gz);
        if (!t || t.x < x0 || t.x >= x0 + size || t.z < z0 || t.z >= z0 + size) continue;

        q.setFromAxisAngle(up, t.yaw);
        const kind = kindOf(t);
        if (!matrices.has(kind)) matrices.set(kind, []);
        matrices.get(kind)!.push(new THREE.Matrix4().compose(p.set(t.x, t.y, t.z), q, s.setScalar(t.scale)));
        const halfHeight = SPECIES[t.species].halfHeight * t.scale;
        this.world.createCollider(
          RAPIER.ColliderDesc.cylinder(halfHeight, t.radius).setTranslation(t.x, t.y + halfHeight, t.z),
          body,
        );
      }
    }

    const objects: THREE.Object3D[] = [];
    for (const [kind, list] of matrices) {
      const mesh = new THREE.InstancedMesh(this.geometries[kind], this.material, list.length);
      list.forEach((mat, i) => mesh.setMatrixAt(i, mat));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      objects.push(mesh);
    }

    return {
      objects,
      // Geometry and material are shared across chunks; only the instance buffer is per-chunk.
      dispose: () => objects.forEach((o) => (o as THREE.InstancedMesh).dispose()),
    };
  }
}
