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
  /**
   * Company: headings toward other cars within `companyRange` (m) cost less, nearer
   * cars pulling harder. Inside `personalSpace` (m) the pull flips to a gentle push,
   * so they run as a pack instead of ramming each other on purpose.
   */
  costCompany: 1.2,
  companyRange: 100,
  personalSpace: 10,
  /** Steering gain: steer input per radian of heading error. */
  steerGain: 2.2,
  cruiseSpeed: 24,
  cautiousSpeed: 12,
  /** A tree on the chosen path closer than this (m) means slow down. */
  cautionDistance: 25,
  /** Allowed overspeed before braking (m/s); gravity alone keeps pushing downhill. */
  brakeMargin: 5,
  /**
   * Stuck: on the throttle for `stuckTime` s without getting `stuckProgress` m from where it was.
   * Judged by progress, not speed: a car pinned nose-first against a trunk on a steep slope bounces
   * off it and back at ±2 m/s for ever. Then it backs out, turning the other way, until it has
   * reversed `reverseDistance` m, `reverseTime` s have passed, or it stops making headway
   * (`reverseStall` s without `reverseStallProgress` m: backed into something).
   */
  stuckProgress: 2.5,
  stuckTime: 2,
  reverseTime: 3,
  reverseDistance: 4,
  reverseStall: 1,
  reverseStallProgress: 0.5,
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
  /** Where the car last made progress, and how long it's been on the throttle since without making more. */
  private readonly anchor = new THREE.Vector3();
  private sinceProgress = 0;
  /** Where backing out started. */
  private readonly reverseFrom = new THREE.Vector3();
  private flipped = 0;
  private reverseSteer = 0;

  /** @param cruiseSpeed preferred speed in m/s; varies per car so traffic spreads out */
  constructor(
    private readonly trees: TreeLayout,
    private readonly cruiseSpeed = AI.cruiseSpeed,
  ) {}

  /** @param others world positions of the other cars (the player included) */
  update(dt: number, car: Car, others: readonly THREE.Vector3[]): AiDecision {
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
      this.reversing = 0;
      this.madeProgress(pos);
      return { input: idle, reset: true };
    }

    // Airborne: hold S to engage the air levelling. Flying isn't being stuck.
    if (car.groundedWheels === 0) {
      this.madeProgress(pos);
      return { input: { ...idle, brake: 1 }, reset: false };
    }

    // Backing out after getting stuck, until far enough back, out of time, or backed into something.
    if (this.reversing > 0) {
      this.reversing -= dt;
      const backed = pos.distanceTo(this.reverseFrom);
      const elapsed = AI.reverseTime - this.reversing;
      const stalled = elapsed > AI.reverseStall && backed < AI.reverseStallProgress;
      if (this.reversing > 0 && backed < AI.reverseDistance && !stalled) {
        return { input: { ...idle, brake: 1, steer: this.reverseSteer }, reset: false };
      }
      this.reversing = 0;
      this.madeProgress(pos);
    }

    const carYaw = Math.atan2(-_fwd.x, -_fwd.z);
    const company = this.companyBearings(pos, others);
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
        (treeDist < look ? ((look - treeDist) / look) * AI.costTree : 0) +
        this.companyCost(yaw, company);
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

    // Stuck: pushing without getting anywhere. Back out, turning the other way.
    if (input.throttle === 0 || pos.distanceTo(this.anchor) > AI.stuckProgress) this.madeProgress(pos);
    else this.sinceProgress += dt;
    if (this.sinceProgress > AI.stuckTime) {
      this.reversing = AI.reverseTime;
      this.reverseFrom.copy(pos);
      this.reverseSteer = steer >= 0 ? -1 : 1;
      this.madeProgress(pos);
    }
    return { input, reset: false };
  }

  private madeProgress(pos: THREE.Vector3): void {
    this.anchor.copy(pos);
    this.sinceProgress = 0;
  }

  /** Yaw toward each nearby car and how strongly it pulls (+) or pushes (−). */
  private companyBearings(from: THREE.Vector3, others: readonly THREE.Vector3[]): { yaw: number; pull: number }[] {
    const out: { yaw: number; pull: number }[] = [];
    for (const o of others) {
      const dx = o.x - from.x;
      const dz = o.z - from.z;
      const d = Math.hypot(dx, dz);
      if (d >= AI.companyRange || d < 0.1) continue;
      const pull = d < AI.personalSpace ? -(1 - d / AI.personalSpace) : 1 - d / AI.companyRange;
      out.push({ yaw: Math.atan2(-dx, -dz), pull });
    }
    return out;
  }

  /** Lower for headings that point toward pulling cars (and away from pushing ones). */
  private companyCost(yaw: number, company: readonly { yaw: number; pull: number }[]): number {
    let cost = 0;
    for (const c of company) cost += (Math.abs(wrapAngle(yaw - c.yaw)) / Math.PI) * c.pull * AI.costCompany;
    return cost;
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
