import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { createNoise3D } from 'simplex-noise';
import { cutSightLine, sightBlockers } from '../render/sightCut';
import { mulberry32 } from './noise';
import { blendedField, chain, surfaceNets, type Segment } from './sdfMesh';
import { OAK, SPECIES, TREE_CELL, type Tree, type TreeLayout } from './trees';
import type { EnvGrid } from './environment';

export const COLORS = {
  trunk: new THREE.Color('#5b4636'),
  needles: new THREE.Color('#2f5a46'),
  needlesDark: new THREE.Color('#244838'),
  snow: new THREE.Color('#f3f6fa'),
  /** Snow in its own shade, under a clump. */
  snowShade: new THREE.Color('#d5dfea'),
  /** Pine: reddish upper bark and a darker, bluer crown. */
  pineBark: new THREE.Color('#8a5a3c'),
  pineNeedles: new THREE.Color('#2c5236'),
  pineNeedlesDark: new THREE.Color('#223f2b'),
  /** Broadleaf: grey-brown trunk, two greens so the canopy reads as clumps. */
  broadTrunk: new THREE.Color('#6a5a4a'),
  leaves: new THREE.Color('#5d8f37'),
  leavesDark: new THREE.Color('#467429'),
  /** Oak: warm brown bark, lit faces lighter, and a crown of fresh greens, yellower where the sun hits. */
  oakBark: new THREE.Color('#6b4e3a'),
  oakBarkLight: new THREE.Color('#8a6a4c'),
  oakLeafSun: new THREE.Color('#c9e35c'),
  oakLeafLight: new THREE.Color('#a8d24c'),
  oakLeafMid: new THREE.Color('#82b840'),
  oakLeafDeep: new THREE.Color('#5c9536'),
  oakLeafShade: new THREE.Color('#3d6e2c'),
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

/**
 * Marks a part as leaves: its `crown` attribute is 1 (wood is 0), so the see-through cut thins it
 * when the tree hides the car (see cutSightLine).
 */
function leafy(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  geo.setAttribute('crown', new THREE.BufferAttribute(new Float32Array(geo.getAttribute('position').count).fill(1), 1));
  return geo;
}

/** Merges flat-coloured parts into one tree geometry; parts not marked as leaves (see leafy) are wood. */
function mergeTree(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts.map((g) => {
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    if (!g.hasAttribute('crown')) g.setAttribute('crown', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count), 1));
    return g;
  }));
  if (!merged) throw new Error('Tree geometry merge failed: part attributes differ');
  merged.computeVertexNormals();
  return merged;
}

/** A spruce: three stacked cones, each under a mantle of snow if it carries a `load`. ≈6.1 m tall. */
function buildSpruce(load: SnowLoad | null): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.22, 0.32, 1.8, 6).toNonIndexed();
  trunk.translate(0, 0.9, 0);
  paintFaces(trunk, () => COLORS.trunk);

  const layers = [
    { r: 2.1, h: 2.6, y: 1.3, color: COLORS.needlesDark },
    { r: 1.6, h: 2.2, y: 2.8, color: COLORS.needles },
    { r: 1.05, h: 1.9, y: 4.2, color: COLORS.needles },
  ];
  const parts = [trunk];
  const random = mulberry32(load?.seed ?? 0);
  for (const l of layers) {
    const cone = new THREE.ConeGeometry(l.r, l.h, SPRUCE_SIDES, 2).toNonIndexed();
    cone.translate(0, l.y + l.h / 2, 0);
    paintFaces(cone, () => l.color);
    parts.push(leafy(cone));
    if (load) parts.push(leafy(snowMantle(l.r, l.h, l.y, load, random)));
  }
  return mergeTree(parts);
}

/** Faces round a spruce tier's cone. */
const SPRUCE_SIDES = 7;

/**
 * The snow on a spruce tier: a mantle lying on its cone from the top down to its load's `edge` of
 * the way up from the branch tips (0 tips, 1 top; see SNOW_LOADS), its hem waving by ±`wave` round
 * the tier (`perSide` points per cone face), so the green tips show below it. At the hem it's the
 * load's `lip` m thick, and its underside tucks back onto the branches `tuck` m lower.
 */
const SPRUCE_SNOW = {
  wave: 0.13,
  perSide: 3,
  tuck: 0.1,
  /** Lifted this far off the cone (m), so the two don't flicker through each other. */
  lift: 0.02,
};

/**
 * The snow loads a snowy spruce is drawn with, by its Tree.snow (up to `upTo`): how far down its
 * mantles reach and how thick their lip is (see SPRUCE_SNOW); how high the far stand-in's white
 * starts (`farFrom`, m); and a seed for the hems' waves, so each load hangs differently.
 */
const SNOW_LOADS = [
  { kind: 'spruceSnowMid', upTo: 0.7, edge: 0.4, lip: 0.07, farFrom: 2.9, seed: 2208 },
  { kind: 'spruceSnowHeavy', upTo: 1, edge: 0.18, lip: 0.1, farFrom: 2.0, seed: 2209 },
] as const;
type SnowLoad = (typeof SNOW_LOADS)[number];

/** A spruce tier's snow mantle (see SPRUCE_SNOW) on its cone, `r` m wide at the foot `y` and `h` m tall. */
function snowMantle(r: number, h: number, y: number, load: SnowLoad, random: () => number): THREE.BufferGeometry {
  const S = SPRUCE_SNOW;
  const apex = new THREE.Vector3(0, y + h, 0);
  // The cone's corners at its foot, placed as ConeGeometry places them (x = r sin θ, z = r cos θ).
  const corners = Array.from({ length: SPRUCE_SIDES + 1 }, (_, k) => {
    const a = (k / SPRUCE_SIDES) * Math.PI * 2;
    return new THREE.Vector3(r * Math.sin(a), y, r * Math.cos(a));
  });
  const faceNormals = corners.slice(0, SPRUCE_SIDES).map((c, k) =>
    new THREE.Vector3().crossVectors(c.clone().sub(apex), corners[k + 1].clone().sub(apex)).normalize(),
  );
  // On a ridge between two faces, out along both.
  const ridgeNormals = faceNormals.map((n, k) => n.clone().add(faceNormals[(k + SPRUCE_SIDES - 1) % SPRUCE_SIDES]).normalize());
  const p1 = random() * Math.PI * 2;
  const p2 = random() * Math.PI * 2;
  const cols = SPRUCE_SIDES * S.perSide;

  /** The point on the cone at column `j` and `up` of the way up from the tips, raised `lift` m off it. */
  const at = (j: number, up: number, lift: number) => {
    const k = Math.floor(j / S.perSide) % SPRUCE_SIDES;
    const s = (j % S.perSide) / S.perSide;
    const p = corners[k].clone().lerp(corners[k + 1], s).lerp(apex, up);
    return p.addScaledVector(s === 0 ? ridgeNormals[k] : faceNormals[k], lift);
  };
  const positions: number[] = [];
  const shaded: boolean[] = [];
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, shade: boolean) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    shaded.push(shade);
  };
  const top = apex.clone().setY(apex.y + S.lift);
  for (let j = 0; j < cols; j++) {
    const hem = (i: number) => {
      const a = (i / cols) * Math.PI * 2;
      return load.edge + S.wave * (0.65 * Math.sin(3 * a + p1) + 0.35 * Math.sin(5 * a + p2));
    };
    const h0 = hem(j);
    const h1 = hem(j + 1);
    const lip0 = at(j, h0, load.lip);
    const lip1 = at(j + 1, h1, load.lip);
    const under0 = at(j, h0 - S.tuck / h, S.lift);
    const under1 = at(j + 1, h1 - S.tuck / h, S.lift);
    // Wound so the faces look out of the cone.
    tri(top, lip0, lip1, false);
    tri(lip0, under0, lip1, true);
    tri(lip1, under0, under1, true);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  // The lip's underside, turned from the sky, in the snow's shade.
  let face = 0;
  paintFaces(geometry, () => (shaded[face++] ? COLORS.snowShade : COLORS.snow));
  return geometry;
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
    parts.push(leafy(cloud));
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
    parts.push(leafy(blob));
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

/**
 * A gnarled bough (or trunk, or root): a faceted tube bending smoothly through `points`, `radii` thick
 * at each of them, `sides` around. Its rings twist a little and bulge at random by up to `gnarl`, and
 * its tip is capped. Its base is left open: it starts inside whatever it grows from (or underground).
 */
function bough(points: THREE.Vector3[], radii: number[], sides: number, random: () => number, gnarl = 0.1): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const segments = (points.length - 1) * 3;
  const frames = curve.computeFrenetFrames(segments, false);
  const position: number[] = [];
  const index: number[] = [];
  const p = new THREE.Vector3();
  const v = new THREE.Vector3();
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    curve.getPointAt(t, p);
    const at = t * (radii.length - 1);
    const k = Math.min(Math.floor(at), radii.length - 2);
    const r = THREE.MathUtils.lerp(radii[k], radii[k + 1], at - k);
    for (let j = 0; j < sides; j++) {
      const a = ((j + i * 0.3) / sides) * Math.PI * 2;
      v.copy(frames.normals[i]).multiplyScalar(Math.cos(a)).addScaledVector(frames.binormals[i], Math.sin(a));
      const rr = r * (1 + (random() - 0.5) * 2 * gnarl);
      v.multiplyScalar(rr).add(p);
      position.push(v.x, v.y, v.z);
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < sides; j++) {
      const a = i * sides + j;
      const b = i * sides + ((j + 1) % sides);
      index.push(a, b, a + sides, b, b + sides, a + sides);
    }
  }
  // A blunt tip, a little past the last ring.
  curve.getPointAt(1, p).addScaledVector(frames.tangents[segments], radii[radii.length - 1] * 0.6);
  const tip = position.length / 3;
  position.push(p.x, p.y, p.z);
  const last = segments * sides;
  for (let j = 0; j < sides; j++) index.push(last + j, last + ((j + 1) % sides), tip);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  g.setIndex(index);
  return g.toNonIndexed();
}

/**
 * One mass of oak leaves (after ref/old-oak/old-oak-01.png): a dark core covered all round in
 * chunky, faceted leaves, each a flattened lump turned to face outwards. Upward faces catch the
 * light in yellow-greens; faces turned away from it, and the mass's underside, go darker.
 */
function leafMass(at: THREE.Vector3, r: number, random: () => number): THREE.BufferGeometry[] {
  const SQUASH = 0.82;
  const core = new THREE.IcosahedronGeometry(r * 0.8, 1).toNonIndexed();
  core.scale(1, SQUASH, 1).translate(at.x, at.y, at.z);
  paintFaces(core, () => COLORS.oakLeafShade);
  const parts = [leafy(core)];

  const shades = [COLORS.oakLeafShade, COLORS.oakLeafDeep, COLORS.oakLeafMid, COLORS.oakLeafLight, COLORS.oakLeafSun];
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  const tilt = new THREE.Quaternion();
  // Roughly even cover: a golden-angle spiral over the sphere, jittered.
  const count = Math.round(3.4 * r * r);
  const turn = random() * Math.PI * 2;
  for (let k = 0; k < count; k++) {
    const y = 1 - (2 * (k + 0.5)) / count;
    const ring = Math.sqrt(1 - y * y);
    const a = turn + k * 2.39996;
    dir.set(Math.cos(a) * ring, y, Math.sin(a) * ring);
    dir.x += (random() - 0.5) * 0.3;
    dir.y += (random() - 0.5) * 0.3;
    dir.z += (random() - 0.5) * 0.3;
    dir.normalize();

    const size = (0.7 + random() * 0.45) * (0.75 + 0.1 * r);
    const leaf = mergeVertices(new THREE.IcosahedronGeometry(size, 0).deleteAttribute('normal').deleteAttribute('uv'));
    const pos = leaf.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const s = 0.75 + random() * 0.45;
      pos.setXYZ(i, pos.getX(i) * s, pos.getY(i) * s * 0.5, pos.getZ(i) * s);
    }
    const g = leaf.toNonIndexed();
    // Flat side out, tipped a little at random, then out to the mass's skin.
    const facing = dir.clone().add(new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).multiplyScalar(0.7)).normalize();
    g.rotateY(random() * Math.PI * 2).applyQuaternion(tilt.setFromUnitVectors(up, facing));
    const out = r * (0.82 + random() * 0.16);
    g.translate(at.x + dir.x * out, at.y + dir.y * out * SQUASH, at.z + dir.z * out);
    // Some leaves sit a shade darker; the underside is in the crown's own shadow.
    const dim = (random() < 0.3 ? 1 : 0) + (dir.y < -0.35 ? 1 : 0);
    paintFaces(g, (_, n) => {
      const lit = n.y > 0.55 ? 4 : n.y > 0.1 ? 3 : n.y > -0.4 ? 2 : 1;
      return shades[Math.max(0, lit - dim)];
    });
    parts.push(leafy(g));
  }
  return parts;
}

/** How far the oak is set into the ground (m). */
const OAK_SINK = 0.65;
/** Tree trunks' collider friction (Rapier's default is 0.5): slippery, so cars slide off them rather than getting pinned. */
const TRUNK_FRICTION = 0.1;
/**
 * The oak's trunk and roots surface (see sdfMesh): facet size (`cell`, m), how wide the filled-in
 * joins between trunk and roots are (`fillet`, m), and the bark's lumps (`gnarl` m deep, `gnarlScale`
 * per m: higher is smaller lumps).
 */
const BARK = { cell: 0.32, fillet: 0.6, gnarl: 0.04, gnarlScale: 0.7 };
/**
 * How the oak's foot follows the ground under it (see PropScatter.drapedFoot): fully at the ground,
 * fading out by `height` (m) up the trunk.
 */
const DRAPE = { height: 2.5 };

/**
 * A great old oak, a landmark (shape after ref/old-oak/old-oak-02.png): a massive, twisting trunk
 * spreading into roots, splitting low into a few thick, crooked limbs that reach out and up
 * and carry the crown as separate rounded masses, with the limbs showing in the gaps between them.
 * ≈15 m tall, ≈20 m across; the lowest leaves hang ≈6 m up, so a car fits under them.
 * Comes in two parts: the crown (limbs and leaves), shared by every oak, and the foot (trunk and
 * roots), which each oak drapes over its own ground.
 */
function buildOak(): { crown: THREE.BufferGeometry; foot: THREE.BufferGeometry } {
  // The crown's layout, and the bark and roots, draw from separate streams, so tuning one
  // doesn't reshuffle the other.
  const random = mulberry32(4711);
  const barkRandom = mulberry32(1307);
  const parts: THREE.BufferGeometry[] = [];
  const wood = (points: THREE.Vector3[], radii: number[], sides: number, gnarl?: number) => {
    const g = bough(points, radii, sides, barkRandom, gnarl);
    // The limbs' upper and sunward faces catch the light (the trunk is left to the lighting).
    paintFaces(g, (_, n) => (n.y > 0.35 || n.x + n.z > 0.9 ? COLORS.oakBarkLight : COLORS.oakBark));
    parts.push(g);
  };
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  // The trunk and its roots, as one blended surface so the roots grow out of the trunk with filled-in
  // joins (see sdfMesh). The trunk leans and twists up, thick and short, widening towards the foot,
  // and reaches well underground so it stays rooted on a slope. Each root bends out along the ground
  // and dives into the earth (deep enough to stay under it on the steepest ground an oak stands on).
  const crotch = V(0.3, 5.6, 0.25);
  const body: Segment[][] = [chain([V(0, -2.2, 0), V(0.15, 1.3, 0.1), V(0.5, 3.0, 0.35), V(0.2, 4.5, 0.45), crotch], [1.8, 1.55, 1.3, 1.15, 0.95])];
  const roots = 5;
  const phase = barkRandom() * Math.PI * 2;
  for (let k = 0; k < roots; k++) {
    const a = phase + (k / roots) * Math.PI * 2 + (barkRandom() - 0.5) * 0.4;
    const out = V(Math.cos(a), 0, Math.sin(a));
    const reach = 0.85 + barkRandom() * 0.3;
    // Out from the trunk's leaning middle, by height above the ground.
    const at = (o: number, y: number) => out.clone().multiplyScalar(o * reach).add(V(0.25, y + OAK_SINK, 0.2));
    body.push(chain([at(0.4, 2.0), at(1.2, 0.7), at(2.0, 0.35), at(3.0, 0.05), at(3.9, -0.35), at(4.6, -0.95), at(5.2, -2.0)], [0.5, 0.5, 0.44, 0.38, 0.32, 0.26, 0.2]));
  }
  const smooth = blendedField(body, BARK.fillet);
  const bumps = createNoise3D(barkRandom);
  const trunk = surfaceNets(
    (p) => smooth(p) + BARK.gnarl * bumps(p.x * BARK.gnarlScale, p.y * BARK.gnarlScale, p.z * BARK.gnarlScale),
    V(-7.4, -2.2, -7.4),
    V(7.8, crotch.y + 1.6, 7.8),
    BARK.cell,
  );
  paintFaces(trunk, () => COLORS.oakBark);

  const masses: { at: THREE.Vector3; r: number }[] = [];
  // The limbs: out from the crotch, bending up as they go; one forks to the side halfway.
  const limbs = 5;
  for (let i = 0; i < limbs; i++) {
    const a = ((i + 0.2 + random() * 0.6) / limbs) * Math.PI * 2;
    const out = V(Math.cos(a), 0, Math.sin(a));
    const side = V(-out.z, 0, out.x).multiplyScalar(random() < 0.5 ? -1 : 1);
    const big = i < 3;
    const base = crotch.clone().addScaledVector(out, 0.3).add(V(0, -0.8 + random() * 1.0, 0));
    const p1 = base.clone().addScaledVector(out, 2.7).add(V(0, 1.1 + random() * 0.6, 0));
    const p2 = p1.clone().addScaledVector(out, 2.8).addScaledVector(side, (random() - 0.5) * 1.2).add(V(0, 1.0 + random() * 0.8, 0));
    const tip = p2.clone().addScaledVector(out, big ? 1.8 : 1.0).add(V(0, 1.6 + random() * 1.0, 0));
    wood([base, p1, p2, tip], big ? [0.85, 0.65, 0.42, 0.2] : [0.6, 0.45, 0.3, 0.14], 6);
    masses.push({ at: tip.clone().add(V(0, 0.8, 0)), r: big ? 2.7 : 2.2 });
    const fork = p2.clone().addScaledVector(side, 1.6).addScaledVector(out, 0.7).add(V(0, 1.4 + random() * 0.6, 0));
    wood([p1.clone().lerp(p2, 0.5), fork, fork.clone().addScaledVector(side, 0.8).add(V(0, 1.2, 0))], [0.34, 0.22, 0.1], 5);
    masses.push({ at: fork.clone().addScaledVector(side, 0.8).add(V(0, 1.4, 0)), r: 2.0 + random() * 0.3 });
    // A lower mass hanging off the big limbs' outer bend.
    if (big) masses.push({ at: p2.clone().addScaledVector(out, 0.6).add(V(0, 0.4, 0)), r: 1.7 });
  }
  // A leader carries the crown's top.
  const leaderTip = V(-0.2, 11.4, 0.1);
  wood([crotch.clone().add(V(0, -0.5, 0)), V(0.1, 8.4, 0.35), leaderTip], [0.75, 0.5, 0.22], 6);
  masses.push({ at: leaderTip.clone().add(V(0, 1.4, 0)), r: 2.9 });
  for (let k = 0; k < 2; k++) {
    const a = ((k + random() * 0.5) / 2) * Math.PI * 2;
    masses.push({ at: V(Math.cos(a) * 2.4, 10.8 + random() * 0.8, Math.sin(a) * 2.4), r: 2.3 + random() * 0.3 });
  }

  for (const m of masses) parts.push(...leafMass(m.at, m.r * (0.92 + random() * 0.16), random));
  // Set down into the ground a little, so the roots' foot stays buried.
  return { crown: mergeTree(parts).translate(0, -OAK_SINK, 0), foot: mergeTree([trunk]).translate(0, -OAK_SINK, 0) };
}

/** The tree meshes: one geometry per kind of tree (spruce bare and under each snow load), and the landmark oak. */
export type TreeKind = SnowLoad['kind'] | 'spruce' | 'pine' | 'broadleaf' | 'oak';
export const kindOf = (t: Tree): TreeKind => {
  if (t.oak) return 'oak';
  if (t.species !== 'spruce') return t.species;
  return t.snow > 0 ? SNOW_LOADS.find((l) => t.snow <= l.upTo)!.kind : 'spruce';
};

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
  const spruce = (load: SnowLoad | null) => {
    const cone = new THREE.ConeGeometry(2, 5.4, 6, 4).toNonIndexed();
    cone.translate(0, 0.7 + 2.7, 0);
    // About as much white as the near tree's mantles show (see SNOW_LOADS).
    paintFaces(cone, (c, n) => (load && c.y > load.farFrom && n.y > 0 ? COLORS.snow : COLORS.needles));
    return mergeTree([cone]);
  };
  return {
    spruceSnowMid: spruce(SNOW_LOADS[0]),
    spruceSnowHeavy: spruce(SNOW_LOADS[1]),
    spruce: spruce(null),
    pine: mergeTree([limb(new THREE.Vector3(), new THREE.Vector3(0, 5, 0), 0.25, 0.13, COLORS.pineBark), blob(1.7, 5, 0.55, COLORS.pineNeedles)]),
    broadleaf: mergeTree([limb(new THREE.Vector3(), new THREE.Vector3(0, 2.6, 0), 0.26, 0.16, COLORS.broadTrunk), blob(2, 3.5, 0.85, COLORS.leaves)]),
    oak: mergeTree([
      limb(new THREE.Vector3(0, -0.3, 0), new THREE.Vector3(0, 6, 0), 1.6, 1.1, COLORS.oakBark),
      blob(4.2, 11.5, 0.7, COLORS.oakLeafMid),
      ...[0, 1, 2, 3, 4].map((i) => blob(3.4, 9.5, 0.7, i % 2 ? COLORS.oakLeafLight : COLORS.oakLeafDeep, Math.cos(i * 1.26) * 5.5, Math.sin(i * 1.26) * 5.5)),
    ]),
  };
}

export interface ChunkProps {
  objects: THREE.Object3D[];
  dispose(): void;
}

/** Scatters trees over terrain chunks, with fixed trunk colliders. */
export class PropScatter {
  private readonly oak = buildOak();
  private readonly geometries: Record<TreeKind, THREE.BufferGeometry> = {
    spruceSnowMid: buildSpruce(SNOW_LOADS[0]),
    spruceSnowHeavy: buildSpruce(SNOW_LOADS[1]),
    spruce: buildSpruce(null),
    pine: buildPine(),
    broadleaf: buildBroadleaf(),
    oak: this.oak.crown,
  };
  /** A tree that hides the car thins its leaves, so it doesn't hide it (see cutSightLine). */
  private readonly material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.85,
  });

  constructor(
    private readonly trees: TreeLayout,
    private readonly world: RAPIER.World,
    private readonly groundHeight: (x: number, z: number) => number,
  ) {
    cutSightLine(this.material);
  }

  populate(x0: number, z0: number, size: number, env: EnvGrid, body: RAPIER.RigidBody): ChunkProps {
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    const matrices = new Map<TreeKind, THREE.Matrix4[]>();
    const objects: THREE.Object3D[] = [];
    // Cells don't align with chunk edges (64 / 9), so scan one extra and keep what falls inside.
    for (let gz = 0; gz <= size / TREE_CELL; gz++) {
      for (let gx = 0; gx <= size / TREE_CELL; gx++) {
        const t = this.trees.inCell(Math.floor(x0 / TREE_CELL) + gx, Math.floor(z0 / TREE_CELL) + gz, env);
        if (!t || t.x < x0 || t.x >= x0 + size || t.z < z0 || t.z >= z0 + size) continue;

        q.setFromAxisAngle(up, t.yaw);
        const kind = kindOf(t);
        if (!matrices.has(kind)) matrices.set(kind, []);
        matrices.get(kind)!.push(new THREE.Matrix4().compose(p.set(t.x, t.y, t.z), q, s.setScalar(t.scale)));
        if (t.oak) objects.push(this.drapedFoot(t));
        const halfHeight = (t.oak ? OAK.halfHeight : SPECIES[t.species].halfHeight) * t.scale;
        this.world.createCollider(
          // Slippery bark (averaged with the car body's 0.2): a car pressed against a trunk slides
          // off it instead of hanging there.
          RAPIER.ColliderDesc.cylinder(halfHeight, t.radius).setTranslation(t.x, t.y + halfHeight, t.z).setFriction(TRUNK_FRICTION),
          body,
        );
      }
    }

    for (const [kind, list] of matrices) {
      const mesh = new THREE.InstancedMesh(this.geometries[kind], this.material, list.length);
      list.forEach((mat, i) => mesh.setMatrixAt(i, mat));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      objects.push(mesh);
    }
    objects.forEach((o) => sightBlockers.add(o));

    return {
      objects,
      // Tree geometry and the material are shared across chunks; the instance buffers and the oaks'
      // draped feet are the chunk's own.
      dispose: () =>
        objects.forEach((o) => {
          sightBlockers.delete(o);
          if (o instanceof THREE.InstancedMesh) o.dispose();
          else (o as THREE.Mesh).geometry.dispose();
        }),
    };
  }

  /**
   * An oak's own trunk and roots, draped over the ground it stands on: each vertex near the ground
   * moves up or down by how far the ground under it lies above or below the ground at the trunk, so
   * on a slope the roots follow the slope down instead of reaching out over it.
   */
  private drapedFoot(t: Tree): THREE.Mesh {
    const geo = this.oak.foot.clone();
    const pos = geo.getAttribute('position');
    const cos = Math.cos(t.yaw);
    const sin = Math.sin(t.yaw);
    const ground = this.groundHeight(t.x, t.z);
    // Vertices are repeated per face: look each spot's ground up once.
    const heights = new Map<string, number>();
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y >= DRAPE.height) continue;
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const key = `${x},${z}`;
      let h = heights.get(key);
      if (h === undefined) {
        // The model turned by the tree's yaw (about y) and scaled, into the world.
        h = this.groundHeight(t.x + (x * cos + z * sin) * t.scale, t.z + (z * cos - x * sin) * t.scale);
        heights.set(key, h);
      }
      const follow = Math.min(1, 1 - y / DRAPE.height);
      pos.setY(i, y + ((h - ground) / t.scale) * follow);
    }
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.set(t.x, t.y, t.z);
    mesh.rotation.y = t.yaw;
    mesh.scale.setScalar(t.scale);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }
}
