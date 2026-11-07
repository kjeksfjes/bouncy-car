import * as THREE from 'three';
import type { TerrainField } from '../world/terrainField';

export interface SightLineOptions {
  /** Clearance (m) the sight line must keep above the snow. */
  margin: number;
  /** Spacing (m) between terrain samples along the line; narrower bumps can slip through. */
  step: number;
  /** Most samples per check, so very long lines stay cheap (the spacing widens instead). */
  maxSamples: number;
  /** Stretch next to the target (m) left unchecked: the ground under the car itself. */
  skipNear: number;
}

/**
 * How far (m) `eye` has to rise for its line of sight to `target` to clear the terrain
 * by `margin`; 0 when the view is already clear.
 *
 * Raising the eye by L lifts the line at fraction t (0 = target, 1 = eye) by t·L, so
 * each sample needs L ≥ (ground + margin − line) / t, and the answer is the largest of those.
 */
export function sightLift(field: TerrainField, eye: THREE.Vector3, target: THREE.Vector3, o: SightLineOptions): number {
  const dx = eye.x - target.x;
  const dz = eye.z - target.z;
  const length = Math.hypot(dx, dz);
  if (length <= o.skipNear) return 0;
  const tStart = o.skipNear / length;
  const samples = Math.min(o.maxSamples, Math.ceil((length - o.skipNear) / o.step));
  let lift = 0;
  for (let i = 0; i < samples; i++) {
    const t = tStart + ((1 - tStart) * i) / samples;
    const line = target.y + (eye.y - target.y) * t;
    const ground = field.height(target.x + dx * t, target.z + dz * t);
    lift = Math.max(lift, (ground + o.margin - line) / t);
  }
  return lift;
}

/**
 * Smooths a sight-line lift: rises quickly so a crest hides the car only briefly, sinks
 * slowly so the camera doesn't bob over every bump.
 */
export class SightLiftFilter {
  value = 0;

  constructor(
    private readonly rise: number,
    private readonly fall: number,
    private readonly max: number,
  ) {}

  update(needed: number, dt: number): number {
    const goal = Math.min(needed, this.max);
    const rate = goal > this.value ? this.rise : this.fall;
    this.value += (goal - this.value) * (1 - Math.exp(-rate * dt));
    return this.value;
  }

  reset(): void {
    this.value = 0;
  }
}
