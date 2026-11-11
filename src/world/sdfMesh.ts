import * as THREE from 'three';

/**
 * Organic shapes that grow into each other without a seam: limbs described as chains of tapering
 * segments, merged with a smooth union (the joins fill in as rounded fillets), and turned into a
 * faceted mesh by surface nets. For trunks and roots, where tubes pushed into each other show a crease.
 */

/** A tapering segment: from `a` (radius `ra`) to `b` (radius `rb`). */
export type Segment = { a: THREE.Vector3; b: THREE.Vector3; ra: number; rb: number };

/** Segments following a smooth curve through `points`, `radii` thick at each of them, `perSpan` per span. */
export function chain(points: THREE.Vector3[], radii: number[], perSpan = 3): Segment[] {
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const steps = (points.length - 1) * perSpan;
  const radiusAt = (t: number) => {
    const at = t * (radii.length - 1);
    const k = Math.min(Math.floor(at), radii.length - 2);
    return THREE.MathUtils.lerp(radii[k], radii[k + 1], at - k);
  };
  const out: Segment[] = [];
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps;
    const t1 = (i + 1) / steps;
    out.push({ a: curve.getPointAt(t0), b: curve.getPointAt(t1), ra: radiusAt(t0), rb: radiusAt(t1) });
  }
  return out;
}

/** Signed distance (roughly: exact for capsules, close for tapers) from `p` to a segment's surface. */
function segmentDistance(p: THREE.Vector3, s: Segment, ab: THREE.Vector3, ap: THREE.Vector3): number {
  ab.subVectors(s.b, s.a);
  ap.subVectors(p, s.a);
  const t = THREE.MathUtils.clamp(ap.dot(ab) / ab.lengthSq(), 0, 1);
  return ap.addScaledVector(ab, -t).length() - THREE.MathUtils.lerp(s.ra, s.rb, t);
}

/** Polynomial smooth minimum: like Math.min, but rounded over a band `k` wide where the two meet. */
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (h * h * k) / 4;
}

/** The smooth union of `parts` (each a chain of segments), joined with fillets `k` wide. */
export function blendedField(parts: Segment[][], k: number): (p: THREE.Vector3) => number {
  const ab = new THREE.Vector3();
  const ap = new THREE.Vector3();
  // Each part's bounds (with its thickness): a part further than `k` beyond the nearest surface so far
  // can't change the result (the smooth union is a plain minimum there), so it's skipped.
  const bounds = parts.map((part) => {
    const box = new THREE.Box3();
    for (const s of part) {
      box.expandByPoint(s.a.clone().subScalar(s.ra)).expandByPoint(s.a.clone().addScalar(s.ra));
      box.expandByPoint(s.b.clone().subScalar(s.rb)).expandByPoint(s.b.clone().addScalar(s.rb));
    }
    return box;
  });
  return (p) => {
    let d = Infinity;
    for (let i = 0; i < parts.length; i++) {
      if (d !== Infinity && bounds[i].distanceToPoint(p) > d + k) continue;
      let own = Infinity;
      for (const s of parts[i]) own = Math.min(own, segmentDistance(p, s, ab, ap));
      d = d === Infinity ? own : smin(d, own, k);
    }
    return d;
  };
}

/**
 * The surface where `field` crosses zero (negative inside), sampled on a grid of `cell`-sized cells
 * over the box `min`..`max`, as a non-indexed mesh of quads (surface nets: one vertex per cell the
 * surface passes through, at the average of its edge crossings). Open where it meets the box.
 */
export function surfaceNets(field: (p: THREE.Vector3) => number, min: THREE.Vector3, max: THREE.Vector3, cell: number): THREE.BufferGeometry {
  const n = [0, 1, 2].map((a) => Math.ceil((max.getComponent(a) - min.getComponent(a)) / cell) + 1);
  const [nx, ny, nz] = n;
  const id = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const values = new Float32Array(nx * ny * nz);
  const p = new THREE.Vector3();
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) values[id(i, j, k)] = field(p.set(min.x + i * cell, min.y + j * cell, min.z + k * cell));
    }
  }

  // One vertex per cell the surface crosses.
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((c) => [c & 1, (c >> 1) & 1, (c >> 2) & 1]);
  const edges = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const vertexOf = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cellId = (i: number, j: number, k: number) => i + (nx - 1) * (j + (ny - 1) * k);
  const verts: number[] = [];
  const v = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        let inside = 0;
        for (let c = 0; c < 8; c++) {
          v[c] = values[id(i + corners[c][0], j + corners[c][1], k + corners[c][2])];
          if (v[c] < 0) inside++;
        }
        if (inside === 0 || inside === 8) continue;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let count = 0;
        for (const [e0, e1] of edges) {
          if (v[e0] < 0 === v[e1] < 0) continue;
          const t = v[e0] / (v[e0] - v[e1]);
          sx += corners[e0][0] + (corners[e1][0] - corners[e0][0]) * t;
          sy += corners[e0][1] + (corners[e1][1] - corners[e0][1]) * t;
          sz += corners[e0][2] + (corners[e1][2] - corners[e0][2]) * t;
          count++;
        }
        vertexOf[cellId(i, j, k)] = verts.length / 3;
        verts.push(min.x + (i + sx / count) * cell, min.y + (j + sy / count) * cell, min.z + (k + sz / count) * cell);
      }
    }
  }

  // Settle each vertex onto the surface itself (a couple of Newton steps along the field's slope):
  // the averaged edge crossings only roughly follow it, which reads as lumps.
  const grad = new THREE.Vector3();
  const q = new THREE.Vector3();
  const h = cell * 0.25;
  const slopeAlong = (axis: number) => {
    const plus = field(q.copy(p).setComponent(axis, p.getComponent(axis) + h));
    const minus = field(q.copy(p).setComponent(axis, p.getComponent(axis) - h));
    return (plus - minus) / (2 * h);
  };
  for (let i = 0; i < verts.length; i += 3) {
    p.fromArray(verts, i);
    for (let step = 0; step < 2; step++) {
      const f = field(p);
      grad.set(slopeAlong(0), slopeAlong(1), slopeAlong(2));
      const slope = grad.length();
      if (slope < 1e-3) break;
      // Never further than half a cell, so a vertex stays near its own cell.
      p.addScaledVector(grad, -THREE.MathUtils.clamp(f / slope, -cell / 2, cell / 2) / slope);
    }
    p.toArray(verts, i);
  }

  // A quad around every grid edge the surface crosses, joining the four cells that share the edge.
  // The cells are listed counter-clockwise seen from the edge's positive end, except along y, where
  // they run clockwise; each quad is turned to face out of the shape.
  const out: number[] = [];
  const emit = (q: number[], flip: boolean) => {
    for (const o of flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]) out.push(verts[q[o] * 3], verts[q[o] * 3 + 1], verts[q[o] * 3 + 2]);
  };
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const v0 = values[id(i, j, k)];
        // Edges along x, y and z from this grid point; the four cells around each.
        if (i < nx - 1 && j > 0 && k > 0 && j < ny - 1 && k < nz - 1) {
          const v1 = values[id(i + 1, j, k)];
          if (v0 < 0 !== v1 < 0) {
            emit([cellId(i, j - 1, k - 1), cellId(i, j, k - 1), cellId(i, j, k), cellId(i, j - 1, k)].map((q) => vertexOf[q]), v0 >= 0);
          }
        }
        if (j < ny - 1 && i > 0 && k > 0 && i < nx - 1 && k < nz - 1) {
          const v1 = values[id(i, j + 1, k)];
          if (v0 < 0 !== v1 < 0) {
            emit([cellId(i - 1, j, k - 1), cellId(i, j, k - 1), cellId(i, j, k), cellId(i - 1, j, k)].map((q) => vertexOf[q]), v0 < 0);
          }
        }
        if (k < nz - 1 && i > 0 && j > 0 && i < nx - 1 && j < ny - 1) {
          const v1 = values[id(i, j, k + 1)];
          if (v0 < 0 !== v1 < 0) {
            emit([cellId(i - 1, j - 1, k), cellId(i, j - 1, k), cellId(i, j, k), cellId(i - 1, j, k)].map((q) => vertexOf[q]), v0 >= 0);
          }
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  return g;
}
