import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './noise';
import { OAK, SPECIES, TREE_CELL, type Tree, type TreeLayout } from './trees';
import type { EnvGrid } from './environment';

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
  /** Oak: warm brown bark, lit faces lighter, and a crown of fresh greens. */
  oakBark: new THREE.Color('#6b4e3a'),
  oakBarkLight: new THREE.Color('#8a6a4c'),
  oakLeaves: new THREE.Color('#4f8a3a'),
  oakLeavesLight: new THREE.Color('#6fa543'),
  oakLeavesDeep: new THREE.Color('#3f7a3c'),
  oakLeavesDark: new THREE.Color('#2f5a2c'),
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

/** A tapering branch (or trunk) from `from` to `to`, `r0` thick at its base and `r1` at its tip. */
function limb(from: THREE.Vector3, to: THREE.Vector3, r0: number, r1: number, color: THREE.Color): THREE.BufferGeometry {
  const dir = to.clone().sub(from);
  const g = new THREE.CylinderGeometry(r1, r0, dir.length(), 6).toNonIndexed();
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize()));
  g.translate((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
  paintFaces(g, () => color);
  return g;
}

/** A faceted lump of foliage: an icosahedron with its corners pushed in and out, squashed a little. */
function leafClump(r: number, random: () => number): THREE.BufferGeometry {
  const merged = mergeVertices(new THREE.IcosahedronGeometry(r, 0).deleteAttribute('normal').deleteAttribute('uv'));
  const pos = merged.getAttribute('position');
  for (let v = 0; v < pos.count; v++) {
    const k = 0.8 + random() * 0.4;
    pos.setXYZ(v, pos.getX(v) * k, pos.getY(v) * k * 0.8, pos.getZ(v) * k);
  }
  return merged.toNonIndexed();
}

/**
 * A great old oak, a landmark (after ref/old-oak/): a massive, twisting trunk on
 * buttress roots, forking about halfway up into thick crooked limbs that show between the leaves,
 * under a broad, lumpy dome of faceted clumps. ≈16 m tall, ≈20 m across; the lowest leaves hang
 * ≈6 m up, so a car fits under them.
 */
function buildOak(): THREE.BufferGeometry {
  const random = mulberry32(4711);
  const bark = (_: THREE.Vector3, n: THREE.Vector3) => (n.y > 0.35 || n.x + n.z > 0.9 ? COLORS.oakBarkLight : COLORS.oakBark);
  const parts: THREE.BufferGeometry[] = [];
  const branch = (from: THREE.Vector3, to: THREE.Vector3, r0: number, r1: number) => {
    const g = limb(from, to, r0, r1, COLORS.oakBark);
    paintFaces(g, bark);
    parts.push(g);
  };
  // The trunk twists up in a few lengths, thinning.
  const spine = [new THREE.Vector3(0, -0.3, 0), new THREE.Vector3(0.35, 2, 0.2), new THREE.Vector3(-0.15, 3.8, 0.45), new THREE.Vector3(0.25, 5.4, 0.1)];
  const girth = [1.75, 1.5, 1.3, 1.1];
  for (let i = 0; i < spine.length - 1; i++) branch(spine[i], spine[i + 1], girth[i], girth[i + 1] * 1.04);
  // Buttress roots flaring out into the ground.
  for (let k = 0; k < 6; k++) {
    const a = ((k + random() * 0.5) / 6) * Math.PI * 2;
    const out = 2.8 + random() * 0.8;
    branch(new THREE.Vector3(Math.cos(a) * 0.7, 1.7, Math.sin(a) * 0.7), new THREE.Vector3(Math.cos(a) * out, -0.25, Math.sin(a) * out), 0.75, 0.18);
  }

  const clumps: { at: THREE.Vector3; r: number }[] = [];
  const around = (at: THREE.Vector3, n: number, r: number, spread: number) => {
    for (let k = 0; k < n; k++) {
      clumps.push({ at: at.clone().add(new THREE.Vector3((random() - 0.5) * spread, (random() - 0.3) * spread * 0.6, (random() - 0.5) * spread)), r: r * (0.8 + random() * 0.4) });
    }
  };
  const top = spine[spine.length - 1];
  const limbs = 6;
  for (let i = 0; i < limbs; i++) {
    const a = ((i + random() * 0.6) / limbs) * Math.PI * 2;
    const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const side = new THREE.Vector3(-out.z, 0, out.x);
    // Each limb leaves the trunk's top, reaches out and up to an elbow, then bends up to its tip;
    // a side branch forks off at the elbow.
    const base = top.clone().addScaledVector(out, 0.5).add(new THREE.Vector3(0, -0.8 + random() * 0.9, 0));
    const elbow = base.clone().addScaledVector(out, 3.8 + random() * 1.6).add(new THREE.Vector3(0, 1.8 + random() * 1.2, 0));
    const tip = elbow.clone().addScaledVector(out, 2.2 + random() * 1.4).add(new THREE.Vector3(0, 2.4 + random() * 1.4, 0));
    const fork = elbow.clone().addScaledVector(side, (random() < 0.5 ? -1 : 1) * (2 + random())).add(new THREE.Vector3(0, 2.2 + random(), 0));
    branch(base, elbow, 0.78, 0.5);
    branch(elbow, tip, 0.5, 0.22);
    branch(elbow, fork, 0.36, 0.16);
    around(tip, 3, 2.5, 2.6);
    around(fork, 2, 2.1, 2);
    around(elbow.clone().add(new THREE.Vector3(0, 1.4, 0)), 1, 1.9, 1);
  }
  // The dome's crown closes over the middle.
  around(new THREE.Vector3(0, 12.5, 0), 5, 3.1, 4.5);
  around(new THREE.Vector3(0, 14.2, 0), 2, 2.6, 2.5);

  const shades = [COLORS.oakLeaves, COLORS.oakLeavesLight, COLORS.oakLeavesDeep];
  for (const c of clumps) {
    const blob = leafClump(c.r, random);
    blob.rotateY(random() * Math.PI).translate(c.at.x, c.at.y, c.at.z);
    const shade = shades[Math.floor(random() * shades.length)];
    // Faces turned down sit in the crown's shade.
    paintFaces(blob, (_, n) => (n.y < -0.3 ? COLORS.oakLeavesDark : shade));
    parts.push(blob);
  }
  return mergeTree(parts);
}

/** The tree meshes: one geometry per kind of tree (spruce with and without snow), and the landmark oak. */
export type TreeKind = 'spruceSnowy' | 'spruce' | 'pine' | 'broadleaf' | 'oak';
export const kindOf = (t: Tree): TreeKind => (t.oak ? 'oak' : t.species === 'spruce' ? (t.snowy ? 'spruceSnowy' : 'spruce') : t.species);

/**
 * Far-view stand-ins for the trees (FarTerrain), the same size at scale 1 and in the same colours
 * but a handful of faces each: seen from past the streamed chunks, only the outline and colour tell.
 */
export function buildFarTrees(): Record<TreeKind, THREE.BufferGeometry> {
  const blob = (r: number, y: number, squash: number, color: THREE.Color, x = 0, z = 0) => {
    const g = new THREE.IcosahedronGeometry(r, 0);
    g.scale(1, squash, 1).translate(x, y, z);
    paintFaces(g, () => color);
    return g;
  };
  const spruce = (snowy: boolean) => {
    const cone = new THREE.ConeGeometry(2, 5.4, 6, 1).toNonIndexed();
    cone.translate(0, 0.7 + 2.7, 0);
    paintFaces(cone, (c, n) => (snowy && c.y > 3.6 && n.y > 0 ? COLORS.snow : COLORS.needles));
    return mergeTree([cone]);
  };
  return {
    spruceSnowy: spruce(true),
    spruce: spruce(false),
    pine: mergeTree([limb(new THREE.Vector3(), new THREE.Vector3(0, 5, 0), 0.25, 0.13, COLORS.pineBark), blob(1.7, 5, 0.55, COLORS.pineNeedles)]),
    broadleaf: mergeTree([limb(new THREE.Vector3(), new THREE.Vector3(0, 2.6, 0), 0.26, 0.16, COLORS.broadTrunk), blob(2, 3.5, 0.85, COLORS.leaves)]),
    oak: mergeTree([
      limb(new THREE.Vector3(0, -0.3, 0), new THREE.Vector3(0, 6, 0), 1.6, 1.1, COLORS.oakBark),
      blob(4.2, 11.5, 0.7, COLORS.oakLeaves),
      ...[0, 1, 2, 3, 4].map((i) => blob(3.4, 9.5, 0.7, i % 2 ? COLORS.oakLeavesLight : COLORS.oakLeavesDeep, Math.cos(i * 1.26) * 5.5, Math.sin(i * 1.26) * 5.5)),
    ]),
  };
}

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
    oak: buildOak(),
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

  populate(x0: number, z0: number, size: number, env: EnvGrid, body: RAPIER.RigidBody): ChunkProps {
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    const matrices = new Map<TreeKind, THREE.Matrix4[]>();
    // Cells don't align with chunk edges (64 / 9), so scan one extra and keep what falls inside.
    for (let gz = 0; gz <= size / TREE_CELL; gz++) {
      for (let gx = 0; gx <= size / TREE_CELL; gx++) {
        const t = this.trees.inCell(Math.floor(x0 / TREE_CELL) + gx, Math.floor(z0 / TREE_CELL) + gz, env);
        if (!t || t.x < x0 || t.x >= x0 + size || t.z < z0 || t.z >= z0 + size) continue;

        q.setFromAxisAngle(up, t.yaw);
        const kind = kindOf(t);
        if (!matrices.has(kind)) matrices.set(kind, []);
        matrices.get(kind)!.push(new THREE.Matrix4().compose(p.set(t.x, t.y, t.z), q, s.setScalar(t.scale)));
        const halfHeight = (t.oak ? OAK.halfHeight : SPECIES[t.species].halfHeight) * t.scale;
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
