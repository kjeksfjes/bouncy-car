import * as THREE from 'three';
import type { CarPiece } from './carModel';

const _v = new THREE.Vector3();
const _o = new THREE.Vector3();

/**
 * Pushes vertices of every closed (on-car) piece near `point` along `dir`, with a
 * smooth falloff. All coordinates are car-local. Pieces are unrotated children
 * of the car root, so car-local → mesh-local is just subtracting the position.
 * Coincident vertices on box edges move identically, so no cracks open up.
 */
export function applyDent(
  pieces: CarPiece[],
  point: THREE.Vector3,
  dir: THREE.Vector3,
  depth: number,
  radius: number,
  maxDent: number,
): void {
  for (const piece of pieces) {
    // Glass cracks instead of denting (see Car.applyImpact).
    if (piece.glass || piece.state !== 'closed' || piece.bounds.distanceToPoint(point) > radius) continue;
    const pos = piece.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const offset = piece.mesh.position;
    let changed = false;
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).add(offset);
      const d = _v.distanceTo(point);
      if (d >= radius) continue;
      const falloff = (1 - d / radius) ** 2;
      _v.addScaledVector(dir, depth * falloff).sub(offset);
      // Cap total displacement from the rest shape.
      _o.fromArray(piece.original, i * 3);
      const delta = _v.sub(_o);
      if (delta.length() > maxDent) delta.setLength(maxDent);
      _v.addVectors(_o, delta);
      pos.setXYZ(i, _v.x, _v.y, _v.z);
      changed = true;
    }
    // Flat-shaded materials derive normals in the shader, so no normal update is needed.
    if (changed) pos.needsUpdate = true;
  }
}

/**
 * Direction pointing into the car from a car-local surface point: the inward
 * normal of the nearest face of `halfExtents` (centred at `center`), blended
 * at edges and corners.
 */
export function inwardDirection(
  point: THREE.Vector3,
  center: THREE.Vector3,
  halfExtents: THREE.Vector3,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  const nx = (point.x - center.x) / halfExtents.x;
  const ny = (point.y - center.y) / halfExtents.y;
  const nz = (point.z - center.z) / halfExtents.z;
  out.set(-Math.sign(nx) * nx ** 4, -Math.sign(ny) * ny ** 4, -Math.sign(nz) * nz ** 4);
  if (out.lengthSq() < 1e-8) return out.set(0, -1, 0);
  return out.normalize();
}
