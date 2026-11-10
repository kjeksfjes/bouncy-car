import * as THREE from 'three';
import { endShift, sample, type CarBlueprint } from './blueprint';
import type { CarPiece } from './carModel';
import type { Crush } from './crush';

/** Bumpers stick out past the body's tips; they're part of the outline while they're on. */
const BUMPERS = ['bumper-front', 'bumper-rear'] as const;

const _box = new THREE.Box3();

/**
 * The car's visible outline in car-local space, for things that must stay outside the
 * body without physics colliders (dangling lights): the lower body from the blueprint
 * profiles (width, rocker and deck along Z, ends shaped like the nose and tail and moved in by
 * crush) plus the bumpers. The ends aren't flat: the shark nose and the tail recede toward the
 * corners (endShift), so a flat face at the tip would stand in front of the real body at the
 * sides, with the headlight sockets inside it, and a lamp hanging there pushed out every frame.
 * Dents and the greenhouse are ignored; dangling lights hang well below the beltline.
 */
export class BodyOutline {
  private readonly bumpers: CarPiece[];

  constructor(
    private readonly bp: CarBlueprint,
    private readonly crush: Crush,
    pieces: readonly CarPiece[],
  ) {
    this.bumpers = BUMPERS.map((name) => pieces.find((p) => p.name === name)!);
  }

  /**
   * Moves a car-local point (a sphere of `radius`) out to the nearest outside spot, in place.
   * With a tether (`anchor` + `reach`), exits the tether can't reach are skipped when another
   * one can: a light on a wire pops out in front of the bumper, not far below it.
   */
  pushOut(p: THREE.Vector3, radius: number, anchor?: THREE.Vector3, reach = Infinity): void {
    const bp = this.bp;
    const h = p.y - bp.groundY;
    for (const bumper of this.bumpers) {
      if (bumper.state !== 'closed') continue;
      // Build-time bounds (spanning its middle, which stands furthest out), moved along Z by how
      // far the end recedes at this x and by the crush there (the bumper is crushed rigidly enough).
      _box.copy(bumper.bounds);
      const end = bumper.name === 'bumper-front' ? 'front' : 'rear';
      const tip = end === 'front' ? bp.front : bp.rear;
      const recede = endShift(bp, p.x, h, tip) - endShift(bp, 0, h, tip);
      const shift = recede + this.crush.tipDepth(end, p.x) * (end === 'front' ? 1 : -1);
      _box.min.z += shift;
      _box.max.z += shift;
      pushOutOfBox(p, _box, radius, anchor, reach);
    }

    const front = bp.front + endShift(bp, p.x, h, bp.front) + this.crush.tipDepth('front', p.x);
    const rear = bp.rear + endShift(bp, p.x, h, bp.rear) - this.crush.tipDepth('rear', p.x);
    if (p.z <= front - radius || p.z >= rear + radius) return;
    const z = THREE.MathUtils.clamp(p.z, bp.front, bp.rear);
    const half = sample(bp.halfWidth, z) + radius;
    const bottom = sample(bp.rocker, z) + bp.groundY - radius;
    const top = sample(bp.deck, z) + bp.crown + bp.groundY + radius;
    if (Math.abs(p.x) >= half || p.y <= bottom || p.y >= top) return;
    _box.min.set(-half, bottom, front - radius);
    _box.max.set(half, top, rear + radius);
    pushOutOfBox(p, _box, 0, anchor, reach);
  }
}

const AXES = ['x', 'y', 'z'] as const;
const _q = new THREE.Vector3();

/**
 * Pushes `p` out through the nearest face of `box` grown by `radius`, if it's inside;
 * preferring faces whose exit point stays within `reach` of `anchor`. If the tether reaches
 * none, it takes the exit closest to the anchor, so the tether can pull it back down from there.
 */
function pushOutOfBox(p: THREE.Vector3, box: THREE.Box3, radius: number, anchor?: THREE.Vector3, reach = Infinity): void {
  const exits = [
    box.min.x - radius - p.x, box.max.x + radius - p.x,
    box.min.y - radius - p.y, box.max.y + radius - p.y,
    box.min.z - radius - p.z, box.max.z + radius - p.z,
  ];
  // Inside only if every min exit is negative and every max exit positive.
  if (exits[0] >= 0 || exits[1] <= 0 || exits[2] >= 0 || exits[3] <= 0 || exits[4] >= 0 || exits[5] <= 0) return;
  let best = -1;
  let fallback = 0;
  let fallbackDist = Infinity;
  for (let i = 0; i < 6; i++) {
    if (anchor) {
      _q.copy(p);
      _q[AXES[i >> 1]] += exits[i];
      const dist = _q.distanceTo(anchor);
      if (dist < fallbackDist) {
        fallbackDist = dist;
        fallback = i;
      }
      if (dist > reach) continue;
    }
    if (best < 0 || Math.abs(exits[i]) < Math.abs(exits[best])) best = i;
  }
  if (best < 0) best = fallback;
  p[AXES[best >> 1]] += exits[best];
}
