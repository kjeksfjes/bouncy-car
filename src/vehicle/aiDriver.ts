import * as THREE from 'three';
import type { TreeLayout } from '../world/trees';
import type { Car, CarInput } from './car';

/**
 * Tuning for the AI driver. Yaw is measured from straight downhill (−Z),
 * positive = turned left (toward −X).
 */
const AI = {
  /** Candidate headings: ±spread around downhill, `candidates` of them. */
  spread: 1.0,
  candidates: 17,
  /** How far ahead to look: base + per m/s of speed. */
  lookBase: 15,
  lookPerSpeed: 1.6,
  /** Cap on the look-ahead (m); also bounds the scan if speed is ever garbage. */
  lookMax: 80,
  sampleStep: 2.5,
  /** Gap to keep between the car's centre line and a trunk (≈ half car width + margin). */
  clearance: 2.2,
  /** Cost weights for picking a heading. */
  costOffDownhill: 0.8,
  costTurn: 0.6,
  costTree: 6,
  /** Steering gain: steer input per radian of heading error. */
  steerGain: 2.2,
  cruiseSpeed: 24,
  cautiousSpeed: 12,
  /** A tree on the chosen path closer than this (m) means slow down. */
  cautionDistance: 25,
  /** Allowed overspeed before braking (m/s); gravity alone keeps pushing downhill. */
  brakeMargin: 5,
  /** Below this speed with throttle on for `stuckTime` s → back out for `reverseTime` s. */
  stuckSpeed: 1,
  stuckTime: 1.5,
  reverseTime: 1.6,
  /** Upside down / on its side for this long → reset. */
  flippedTime: 1.5,
};

export interface AiDecision {
  input: CarInput;
  /** The car should be put back on its wheels. */
  reset: boolean;
}

const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();

/** Simple look-ahead driver: picks the clearest downhill heading and steers for it. */
export class AiDriver {
  /** Chosen heading as a world-space direction, for the debug arrow. */
  readonly heading = new THREE.Vector3(0, 0, -1);
  private reversing = 0;
  private stuck = 0;
  private flipped = 0;
  private reverseSteer = 0;

  /** @param cruiseSpeed preferred speed in m/s; varies per car so traffic spreads out */
  constructor(
    private readonly trees: TreeLayout,
    private readonly cruiseSpeed = AI.cruiseSpeed,
  ) {}

  update(dt: number, car: Car): AiDecision {
    const q = car.model.root.quaternion;
    _fwd.set(0, 0, -1).applyQuaternion(q);
    _up.set(0, 1, 0).applyQuaternion(q);
    const pos = car.position;
    const speed = car.forwardSpeed;
    const idle: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };

    // Upside down or on its side and not getting anywhere: reset.
    this.flipped = _up.y < 0.3 && car.velocity.length() < 3 ? this.flipped + dt : 0;
    if (this.flipped > AI.flippedTime) {
      this.flipped = 0;
      this.stuck = 0;
      this.reversing = 0;
      return { input: idle, reset: true };
    }

    // Airborne: hold S to engage the air levelling.
    if (car.groundedWheels === 0) return { input: { ...idle, brake: 1 }, reset: false };

    // Backing out after getting stuck.
    if (this.reversing > 0) {
      this.reversing -= dt;
      return { input: { ...idle, brake: 1, steer: this.reverseSteer }, reset: false };
    }

    const carYaw = Math.atan2(-_fwd.x, -_fwd.z);
    const look = Math.min(AI.lookMax, AI.lookBase + Math.max(0, speed) * AI.lookPerSpeed);
    let bestYaw = 0;
    let bestCost = Infinity;
    let bestTreeDist = Infinity;
    for (let i = 0; i < AI.candidates; i++) {
      const yaw = -AI.spread + (2 * AI.spread * i) / (AI.candidates - 1);
      const treeDist = this.firstTree(pos, yaw, look);
      const cost =
        Math.abs(yaw) * AI.costOffDownhill +
        Math.abs(wrapAngle(yaw - carYaw)) * AI.costTurn +
        (treeDist < look ? ((look - treeDist) / look) * AI.costTree : 0);
      if (cost < bestCost) {
        bestCost = cost;
        bestYaw = yaw;
        bestTreeDist = treeDist;
      }
    }
    this.heading.set(-Math.sin(bestYaw), 0, -Math.cos(bestYaw));

    const error = wrapAngle(bestYaw - carYaw);
    const steer = THREE.MathUtils.clamp(error * AI.steerGain, -1, 1);

    let target = bestTreeDist < AI.cautionDistance ? AI.cautiousSpeed : this.cruiseSpeed;
    target *= 1 - Math.min(0.5, Math.abs(error) * 0.6);
    const input: CarInput = {
      throttle: speed < target ? 1 : 0,
      brake: speed > target + AI.brakeMargin ? 1 : 0,
      steer,
      handbrake: false,
    };

    // Stuck: pushing but not moving. Back out, turning the other way.
    this.stuck = input.throttle > 0 && Math.abs(speed) < AI.stuckSpeed ? this.stuck + dt : 0;
    if (this.stuck > AI.stuckTime) {
      this.stuck = 0;
      this.reversing = AI.reverseTime;
      this.reverseSteer = steer >= 0 ? -1 : 1;
    }
    return { input, reset: false };
  }

  /** Distance along heading `yaw` to the first blocking tree, or Infinity. */
  private firstTree(from: THREE.Vector3, yaw: number, look: number): number {
    const dx = -Math.sin(yaw);
    const dz = -Math.cos(yaw);
    for (let d = AI.sampleStep; d <= look; d += AI.sampleStep) {
      if (this.trees.blocking(from.x + dx * d, from.z + dz * d, AI.clearance)) return d;
    }
    return Infinity;
  }
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
