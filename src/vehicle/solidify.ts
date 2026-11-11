import * as THREE from 'three';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m = new THREE.Vector3();

/**
 * Gives a triangle surface real wall thickness, like Blender's Solidify:
 * the outer surface, an inner copy offset inward along the vertex normals
 * (winding reversed), and rim quads along every open edge.
 *
 * Expects outward-wound triangles as a flat position array; returns the same format, split into
 * the outer surface with its rims, and the inner copy (the panel's underside).
 */
export function solidify(triangles: readonly number[], thickness: number): { outer: number[]; inner: number[] } {
  // Weld coincident corners so neighbouring triangles share normals and edges.
  const ids = new Map<string, number>();
  const verts: number[] = [];
  const faces: number[] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    const x = triangles[i];
    const y = triangles[i + 1];
    const z = triangles[i + 2];
    const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = verts.length / 3;
      ids.set(key, id);
      verts.push(x, y, z);
    }
    faces.push(id);
  }

  // Area-weighted vertex normals.
  const normals = new Float32Array(verts.length);
  for (let f = 0; f < faces.length; f += 3) {
    _a.fromArray(verts, faces[f] * 3);
    _b.fromArray(verts, faces[f + 1] * 3);
    _c.fromArray(verts, faces[f + 2] * 3);
    _n.crossVectors(_b.sub(_a), _c.sub(_a));
    for (let k = 0; k < 3; k++) {
      const o = faces[f + k] * 3;
      normals[o] += _n.x;
      normals[o + 1] += _n.y;
      normals[o + 2] += _n.z;
    }
  }
  const inner = new Float32Array(verts.length);
  for (let i = 0; i < verts.length; i += 3) {
    _n.fromArray(normals, i).normalize();
    inner[i] = verts[i] - _n.x * thickness;
    inner[i + 1] = verts[i + 1] - _n.y * thickness;
    inner[i + 2] = verts[i + 2] - _n.z * thickness;
  }

  // Open edges are used by exactly one triangle; remember that triangle's third corner.
  const edges = new Map<string, { a: number; b: number; c: number; count: number }>();
  for (let f = 0; f < faces.length; f += 3) {
    for (let k = 0; k < 3; k++) {
      const a = faces[f + k];
      const b = faces[f + ((k + 1) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const e = edges.get(key);
      if (e) e.count++;
      else edges.set(key, { a, b, c: faces[f + ((k + 2) % 3)], count: 1 });
    }
  }

  const out: number[] = [];
  const under: number[] = [];
  const push = (src: ArrayLike<number>, id: number, into = out) => into.push(src[id * 3], src[id * 3 + 1], src[id * 3 + 2]);
  for (let f = 0; f < faces.length; f += 3) {
    push(verts, faces[f]);
    push(verts, faces[f + 1]);
    push(verts, faces[f + 2]);
    push(inner, faces[f], under);
    push(inner, faces[f + 2], under);
    push(inner, faces[f + 1], under);
  }
  for (const { a, b, c, count } of edges.values()) {
    if (count !== 1) continue;
    // Rim quad a → b → b' → a', wound to face away from the triangle it closes off.
    _a.fromArray(verts, a * 3);
    _b.fromArray(verts, b * 3);
    _c.fromArray(inner, b * 3);
    _n.crossVectors(_m.subVectors(_b, _a), _c.sub(_a));
    _m.addVectors(_a, _b).multiplyScalar(0.5).sub(_c.fromArray(verts, c * 3));
    const flip = _n.dot(_m) < 0;
    const quad: [ArrayLike<number>, number][] = [[verts, a], [verts, b], [inner, b], [inner, a]];
    const order = flip ? [0, 3, 2, 0, 2, 1] : [0, 1, 2, 0, 2, 3];
    for (const i of order) push(quad[i][0], quad[i][1]);
  }
  return { outer: out, inner: under };
}
