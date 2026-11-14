import type { Obstacles } from '../world/details';

/**
 * The car's body seen from above, for keeping it clear of trunks and boulders: circles along its
 * middle at these car-local z (m, front negative), each touching an obstacle that comes within
 * `clearance` m of its centre (≈ the body's half-width plus a little).
 */
export const FOOTPRINT = {
  circles: [-1.7, 0, 1.7],
  clearance: 1.15,
};

/**
 * Where a reset puts a car that's against a trunk: rings round it, `ringStep` m apart out to
 * `maxReach` m, `perRing` spots on the first ring (more further out, so they stay about as far
 * apart), each tried at `yaws` headings. A spot fits when the whole footprint is `margin` m clearer
 * than touching. Of the fits on the nearest ring, the best faces the longest clear run ahead (up
 * to `lookAhead` m), less `costOffDownhill` per radian off downhill.
 */
const RESET = {
  ringStep: 0.75,
  maxReach: 10,
  perRing: 8,
  yaws: 16,
  margin: 0.3,
  lookAhead: 15,
  costOffDownhill: 3,
};

export interface Pose {
  x: number;
  z: number;
  /** From straight downhill (−Z), positive turned left (toward −X). */
  yaw: number;
}

/** Whether footprint circle `local` (car-local z) at pose (x, z, yaw) touches an obstacle within `clearance` m. */
export function circleBlocked(obstacles: Obstacles, x: number, z: number, yaw: number, local: number, clearance = FOOTPRINT.clearance): boolean {
  return obstacles.blocking(x + Math.sin(yaw) * local, z + Math.cos(yaw) * local, clearance);
}

/** Whether the whole footprint at (x, z, yaw) is clear of obstacles by `clearance` m. */
export function footprintClear(obstacles: Obstacles, x: number, z: number, yaw: number, clearance = FOOTPRINT.clearance): boolean {
  return FOOTPRINT.circles.every((local) => !circleBlocked(obstacles, x, z, yaw, local, clearance));
}

/**
 * Where to put a car back on its wheels when it's up against a trunk or boulder: the nearest spot
 * the whole car fits, facing the most open way (leaning downhill). Null when it isn't touching
 * anything (then it goes back on its wheels where it is, facing as it was), or when nothing fits
 * within reach.
 */
export function clearPose(obstacles: Obstacles, x: number, z: number, yaw: number): Pose | null {
  const R = RESET;
  const clearance = FOOTPRINT.clearance + R.margin;
  if (footprintClear(obstacles, x, z, yaw, FOOTPRINT.clearance)) return null;
  for (let r = 0; r <= R.maxReach + 1e-6; r += R.ringStep) {
    const spots = r === 0 ? 1 : Math.max(R.perRing, Math.round((R.perRing * r) / R.ringStep));
    let best: Pose | null = null;
    let bestScore = -Infinity;
    for (let s = 0; s < spots; s++) {
      const angle = (s / spots) * Math.PI * 2;
      const sx = x + Math.cos(angle) * r;
      const sz = z + Math.sin(angle) * r;
      for (let k = 0; k < R.yaws; k++) {
        const facing = ((k / R.yaws) * 2 - 1) * Math.PI;
        if (!footprintClear(obstacles, sx, sz, facing, clearance)) continue;
        const score = clearRun(obstacles, sx, sz, facing) - Math.abs(facing) * R.costOffDownhill;
        if (score > bestScore) {
          bestScore = score;
          best = { x: sx, z: sz, yaw: facing };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/** How far (m, up to RESET.lookAhead) the car could drive straight on from (x, z, yaw) before its footprint touches anything. */
function clearRun(obstacles: Obstacles, x: number, z: number, yaw: number): number {
  const dx = -Math.sin(yaw);
  const dz = -Math.cos(yaw);
  for (let d = 1; d <= RESET.lookAhead; d++) {
    if (!footprintClear(obstacles, x + dx * d, z + dz * d, yaw)) return d - 1;
  }
  return RESET.lookAhead;
}
