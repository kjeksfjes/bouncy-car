import * as THREE from 'three';
import type { Obstacles } from '../world/details';
import type { Varde } from '../world/landmarks';
import type { TerrainField } from '../world/terrainField';
import type { Car, CarInput } from './car';

/**
 * Tuning for the AI driver. Yaw is measured from straight downhill (−Z),
 * positive = turned left (toward −X).
 */
const AI = {
  /** Short range: candidate headings ±spread around the route, `candidates` of them. */
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
  /** Cost weights for picking a heading: off the route, turning, a tree in the way. */
  costOffRoute: 0.8,
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
  /**
   * Long range: every `routeEvery` s the route is planned `routeRange` m out, along `routeCandidates`
   * headings ±`routeSpread` around downhill, sampled every `routeStep` m in a corridor ±`routeWidth`
   * m wide. Each heading costs its turn off downhill, plus what it runs through (nearer counts more):
   * forest (share of the corridor's samples a trunk blocks), bare rock face, and side slopes that
   * tip the car (sideways tilt from `tiltFrom` to `tiltFull`, as the sine of the angle). A new
   * route has to beat the current one by `routeKeep` to replace it.
   */
  routeEvery: 0.4,
  routeRange: 180,
  routeStep: 10,
  routeCandidates: 13,
  routeSpread: 1.3,
  routeWidth: 4,
  routeClearance: 2.5,
  costRouteOff: 0.8,
  costRouteTrees: 5,
  costRouteRock: 2,
  costRouteTilt: 2.5,
  tiltFrom: 0.3,
  tiltFull: 0.55,
  /**
   * Bare rock face, read from the slope alone (normal Y from `rockFrom` to `rockFull`): the terrain
   * shows rock on ground that steep (SNOW_SURFACE rockFrom/rockTo), and the full test (cover, wind
   * scour) costs an environment sample per point.
   */
  rockFrom: 0.6,
  rockFull: 0.47,
  routeKeep: 0.15,
  /**
   * Speed: `cruiseSpeed` on snow, scaled by the grip under the tyres to the power `gripSpeed` (so
   * faster on grass and rock); `cautiousSpeed` with a tree on the chosen path within
   * `cautionDistance` m; × `hazardSlow` with rock face or a tipping side slope on the route within
   * `hazardDistance` m. Corners slow it by `cornerSlow` per radian off the heading (less where it grips).
   */
  cruiseSpeed: 24,
  cautiousSpeed: 12,
  cautionDistance: 25,
  gripSpeed: 0.7,
  hazardDistance: 30,
  hazardSlow: 0.7,
  cornerSlow: 0.6,
  /** Steering gain: steer input per radian of heading error. */
  steerGain: 2.2,
  /** Allowed overspeed before braking (m/s); gravity alone keeps pushing downhill. */
  brakeMargin: 5,
  /**
   * Cairns: a standing varde ahead, `cairnRange` (min..max) m away and within `cairnCone` rad of
   * downhill, becomes the target: the route aims at it (`costCairn` per radian off it, downhill
   * mattering only `cairnDownhill` as much) and it isn't an obstacle any more. Given up once
   * knocked over, passed (`cairnPassed` m uphill of the car) or after `cairnGiveUp` s.
   */
  cairnRange: [20, 160],
  cairnCone: 0.9,
  costCairn: 3,
  cairnDownhill: 0.3,
  cairnPassed: 3,
  cairnGiveUp: 25,
  /**
   * Stuck: on the throttle for `stuckTime` s without getting `stuckProgress` m from where it was.
   * Judged by progress, not speed: a car pinned nose-first against a trunk on a steep slope bounces
   * off it and back at ±2 m/s for ever. Stuck again within `stuckArea` m and `stuckMemory` s is the
   * next attempt, and each tries something else (see `stuck`). Backing out lasts until it has
   * reversed the attempt's distance, `reverseTime` s have passed, or it stops making headway
   * (`reverseStall` s without `reverseStallProgress` m: backed into something).
   */
  stuckProgress: 2.5,
  stuckTime: 2,
  stuckArea: 15,
  stuckMemory: 30,
  reverseDistance: [4, 7, 8],
  reverseTime: 4,
  reverseStall: 1,
  reverseStallProgress: 0.5,
  /** After an attempt, the heading that got it stuck is shunned (± `tabooWidth` rad, growing per attempt) for `tabooTime` s. */
  tabooWidth: 0.35,
  tabooGrowth: 0.2,
  tabooTime: 8,
  costTaboo: 5,
  /** The third attempt drives off any way it can, across the slope too (± `escapeSpread` rad) for `escapeTime` s. */
  escapeSpread: 1.9,
  escapeTime: 6,
  /** Upside down / on its side for this long → reset. */
  flippedTime: 1.5,
  /**
   * Broken (engine dead, or `brokenWheelsLost` wheels gone) and lying still (slower than
   * `stillSpeed` m/s) for `brokenTime` s: ask for a new car.
   */
  brokenWheelsLost: 2,
  stillSpeed: 1.5,
  brokenTime: 5,
};

export interface AiDecision {
  input: CarInput;
  /** The car should be put back on its wheels; where and facing which way, if not where it is. */
  reset: boolean;
  resetTo?: { x: number; z: number; yaw: number };
  /** The car is wrecked and has come to rest: it wants a new one. */
  newCar?: boolean;
}

const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _n = new THREE.Vector3();

/**
 * Look-ahead driver. A long-range route (a few times a second) finds the open way far ahead: lanes
 * through forest or round it, off rock faces and steep side slopes, or at a cairn to knock over.
 * Each frame it picks the clearest heading near that route and steers for it, at a speed for the
 * grip under its tyres. Stuck, it tries something new each time.
 */
export class AiDriver {
  /** Chosen heading as a world-space direction, for the debug arrow. */
  readonly heading = new THREE.Vector3(0, 0, -1);
  /** The long-range route's yaw, when it was last planned, and how far along it the first hazard is (m). */
  private routeYaw = 0;
  /** Starts at a random point of its period, so the cars don't all plan in the same frame. */
  private routeTimer = Math.random() * AI.routeEvery;
  private hazardAt = Infinity;
  /** The cairn it's going for, and for how long. */
  private cairn: Varde | null = null;
  private cairnTime = 0;

  private reversing = 0;
  private reverseDistance = 0;
  private reverseSteer = 0;
  /** Where the car last made progress, and how long it's been on the throttle since without making more. */
  private readonly anchor = new THREE.Vector3();
  private sinceProgress = 0;
  /** Where backing out started. */
  private readonly reverseFrom = new THREE.Vector3();
  /** Where it last got stuck, when (s of its own time), and which attempt that was there. */
  private readonly stuckAt = new THREE.Vector3();
  private stuckWhen = -Infinity;
  private attempts = 0;
  private time = 0;
  /** A heading to shun for a while, and how widely. */
  private tabooYaw = 0;
  private tabooWidth = 0;
  private tabooLeft = 0;
  /** Seconds left of driving off any way it can. */
  private escape = 0;
  private flipped = 0;
  /** How long the car has lain broken and still (s). */
  private wrecked = 0;

  /** @param cruiseSpeed preferred speed on snow in m/s; varies per car so traffic spreads out */
  constructor(
    private readonly field: TerrainField,
    private readonly obstacles: Obstacles,
    private readonly cruiseSpeed = AI.cruiseSpeed,
  ) {}

  /** @param others world positions of the other cars (the player included) */
  update(dt: number, car: Car, others: readonly THREE.Vector3[]): AiDecision {
    this.time += dt;
    this.tabooLeft = Math.max(0, this.tabooLeft - dt);
    this.escape = Math.max(0, this.escape - dt);
    const q = car.model.root.quaternion;
    _fwd.set(0, 0, -1).applyQuaternion(q);
    _up.set(0, 1, 0).applyQuaternion(q);
    const pos = car.position;
    const speed = car.forwardSpeed;
    const idle: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };

    // Wrecked and come to rest: ask for a new car (a car that limps on isn't still, so it keeps trying).
    const broken = !car.engineAlive || car.wheelsLost >= AI.brokenWheelsLost;
    this.wrecked = broken && car.velocity.length() < AI.stillSpeed ? this.wrecked + dt : 0;
    if (this.wrecked > AI.brokenTime) {
      this.wrecked = 0;
      return { input: idle, reset: false, newCar: true };
    }

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
      if (this.reversing > 0 && backed < this.reverseDistance && !stalled) {
        return { input: { ...idle, brake: 1, steer: this.reverseSteer }, reset: false };
      }
      this.reversing = 0;
      this.madeProgress(pos);
    }

    const carYaw = Math.atan2(-_fwd.x, -_fwd.z);
    this.routeTimer -= dt;
    if (this.routeTimer <= 0) {
      this.routeTimer = AI.routeEvery;
      this.pickCairn(pos);
      this.planRoute(pos);
    }

    const company = this.companyBearings(pos, others);
    const look = Math.min(AI.lookMax, AI.lookBase + Math.max(0, speed) * AI.lookPerSpeed);
    const spread = this.escape > 0 ? AI.escapeSpread : AI.spread;
    let bestYaw = this.routeYaw;
    let bestCost = Infinity;
    let bestTreeDist = Infinity;
    for (let i = 0; i < AI.candidates; i++) {
      const off = -spread + (2 * spread * i) / (AI.candidates - 1);
      const yaw = wrapAngle(this.routeYaw + off);
      const treeDist = this.firstTree(pos, yaw, look);
      const cost =
        Math.abs(off) * AI.costOffRoute +
        Math.abs(wrapAngle(yaw - carYaw)) * AI.costTurn +
        (treeDist < look ? ((look - treeDist) / look) * AI.costTree : 0) +
        this.companyCost(yaw, company) +
        this.tabooCost(yaw);
      if (cost < bestCost) {
        bestCost = cost;
        bestYaw = yaw;
        bestTreeDist = treeDist;
      }
    }
    this.heading.set(-Math.sin(bestYaw), 0, -Math.cos(bestYaw));

    const error = wrapAngle(bestYaw - carYaw);
    const steer = THREE.MathUtils.clamp(error * AI.steerGain, -1, 1);

    // Faster where the tyres grip, slower for trees, hazards and corners (less so where it grips).
    const grip = car.grip;
    const hunting = this.cairn !== null;
    let target = (bestTreeDist < AI.cautionDistance && !hunting ? AI.cautiousSpeed : this.cruiseSpeed) * Math.pow(grip, AI.gripSpeed);
    if (this.hazardAt < AI.hazardDistance && !hunting) target *= AI.hazardSlow;
    target *= 1 - Math.min(0.5, (Math.abs(error) * AI.cornerSlow) / grip);
    const input: CarInput = {
      throttle: speed < target ? 1 : 0,
      brake: speed > target + AI.brakeMargin ? 1 : 0,
      steer,
      handbrake: false,
    };

    // Stuck: pushing without getting anywhere.
    if (input.throttle === 0 || pos.distanceTo(this.anchor) > AI.stuckProgress) this.madeProgress(pos);
    else this.sinceProgress += dt;
    if (this.sinceProgress > AI.stuckTime) return this.stuck(pos, steer, bestYaw, input);
    return { input, reset: false };
  }

  /**
   * Got stuck: each attempt in the same spot tries something else. 1: back out turning the other
   * way. 2: back out further, turning the opposite way to last time, and shun the heading that got
   * it stuck. 3: back out straight, then drive off any way it can, across the slope too. 4 and on:
   * back on its wheels where it is, facing the most open way.
   */
  private stuck(pos: THREE.Vector3, steer: number, yaw: number, input: CarInput): AiDecision {
    const again = this.time - this.stuckWhen < AI.stuckMemory && pos.distanceTo(this.stuckAt) < AI.stuckArea;
    this.attempts = again ? this.attempts + 1 : 1;
    this.stuckAt.copy(pos);
    this.stuckWhen = this.time;
    this.madeProgress(pos);
    // Whatever it tries, it stops going for the heading that got it stuck.
    this.tabooYaw = yaw;
    this.tabooWidth = AI.tabooWidth + AI.tabooGrowth * (this.attempts - 1);
    this.tabooLeft = AI.tabooTime;
    if (this.attempts >= 4) {
      this.attempts = 0;
      this.cairn = null;
      const to = { x: pos.x, z: pos.z, yaw: this.openestYaw(pos) };
      this.routeYaw = to.yaw;
      return { input, reset: true, resetTo: to };
    }
    const D = AI.reverseDistance;
    this.reversing = AI.reverseTime;
    this.reverseFrom.copy(pos);
    this.reverseDistance = D[Math.min(this.attempts, D.length) - 1];
    if (this.attempts === 1) this.reverseSteer = steer >= 0 ? -1 : 1;
    else if (this.attempts === 2) this.reverseSteer = -this.reverseSteer || (steer >= 0 ? 1 : -1);
    else {
      this.reverseSteer = 0;
      // Counted from now, so it runs on after backing out.
      this.escape = AI.reverseTime + AI.escapeTime;
    }
    // A cairn it keeps getting stuck going for isn't worth it.
    if (this.attempts >= 2) this.cairn = null;
    return { input: { throttle: 0, brake: 1, steer: this.reverseSteer, handbrake: false }, reset: false };
  }

  private madeProgress(pos: THREE.Vector3): void {
    this.anchor.copy(pos);
    this.sinceProgress = 0;
  }

  /** Keeps the cairn it's going for, or looks for a new one ahead. */
  private pickCairn(pos: THREE.Vector3): void {
    const A = AI;
    const landmarks = this.field.landmarks;
    if (this.cairn) {
      this.cairnTime += A.routeEvery;
      const passed = this.cairn.z > pos.z + A.cairnPassed;
      if (!landmarks.standing(this.cairn) || passed || this.cairnTime > A.cairnGiveUp) this.cairn = null;
      return;
    }
    const [near, far] = A.cairnRange;
    let best: Varde | null = null;
    let bestDist = Infinity;
    for (const v of landmarks.vardesWithin(pos.x - far, pos.z - far, 2 * far)) {
      const dx = v.x - pos.x;
      const dz = v.z - pos.z;
      const d = Math.hypot(dx, dz);
      if (d < near || d > far || d >= bestDist) continue;
      if (Math.abs(Math.atan2(-dx, -dz)) > A.cairnCone) continue;
      best = v;
      bestDist = d;
    }
    this.cairn = best;
    this.cairnTime = 0;
  }

  /** Plans the long-range route: the heading with the least forest, rock face and tipping slope ahead (or the cairn). */
  private planRoute(pos: THREE.Vector3): void {
    const A = AI;
    const cairn = this.cairn;
    const cairnYaw = cairn ? Math.atan2(-(cairn.x - pos.x), -(cairn.z - pos.z)) : 0;
    const cairnDist = cairn ? Math.hypot(cairn.x - pos.x, cairn.z - pos.z) : Infinity;
    const spread = this.escape > 0 ? AI.escapeSpread : A.routeSpread;
    let best = this.routeYaw;
    let bestCost = Infinity;
    let bestHazard = Infinity;
    let currentCost = Infinity;
    let currentHazard = Infinity;
    // The current route is weighed too, so it only changes for a clearly better one.
    const yaws = Array.from({ length: A.routeCandidates }, (_, i) => -spread + (2 * spread * i) / (A.routeCandidates - 1));
    yaws.push(this.routeYaw);
    if (cairn) yaws.push(cairnYaw);
    for (let i = 0; i < yaws.length; i++) {
      const yaw = yaws[i];
      const { cost: path, hazard } = this.pathCost(pos, yaw, Math.min(A.routeRange, cairnDist));
      let cost = path + this.tabooCost(yaw);
      cost += Math.abs(yaw) * A.costRouteOff * (cairn ? A.cairnDownhill : 1);
      if (cairn) cost += Math.abs(wrapAngle(yaw - cairnYaw)) * A.costCairn;
      if (i === A.routeCandidates) {
        currentCost = cost;
        currentHazard = hazard;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = yaw;
        bestHazard = hazard;
      }
    }
    if (bestCost < currentCost - A.routeKeep) {
      this.routeYaw = best;
      this.hazardAt = bestHazard;
    } else this.hazardAt = currentHazard;
  }

  /**
   * What heading `yaw` runs through out to `range` m (nearer counts more): forest, bare rock face
   * and side slopes that tip the car; and how far along the first rock face or tipping slope is.
   */
  private pathCost(from: THREE.Vector3, yaw: number, range: number): { cost: number; hazard: number } {
    const A = AI;
    const dx = -Math.sin(yaw);
    const dz = -Math.cos(yaw);
    let sum = 0;
    let weights = 0;
    let hazard = Infinity;
    for (let d = A.routeStep; d <= range; d += A.routeStep) {
      const x = from.x + dx * d;
      const z = from.z + dz * d;
      let trees = 0;
      for (const side of [-1, 0, 1]) {
        if (this.obstacles.blocking(x + dz * side * A.routeWidth, z - dx * side * A.routeWidth, A.routeClearance, this.cairn ?? undefined)) trees++;
      }
      const n = this.field.normal(x, z, _n, 1);
      // Sideways tilt: how much the ground leans across the way (the sine of the angle).
      const tilt = THREE.MathUtils.smoothstep(Math.abs(n.x * dz - n.z * dx), A.tiltFrom, A.tiltFull);
      const rock = 1 - THREE.MathUtils.smoothstep(n.y, A.rockFull, A.rockFrom);
      if ((rock > 0.5 || tilt > 0.5) && hazard === Infinity) hazard = d;
      const w = 1 - (0.5 * d) / A.routeRange;
      sum += w * ((trees / 3) * A.costRouteTrees + rock * A.costRouteRock + tilt * A.costRouteTilt);
      weights += w;
    }
    return { cost: weights > 0 ? sum / weights : 0, hazard };
  }

  /** The heading round the car with the longest clear run, leaning downhill: where a reset faces. */
  private openestYaw(pos: THREE.Vector3): number {
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < 24; i++) {
      const yaw = wrapAngle((i / 24) * Math.PI * 2);
      const clear = Math.min(30, this.firstTree(pos, yaw, 30));
      const score = clear - Math.abs(yaw) * 4 - this.tabooCost(yaw) * 4;
      if (score > bestScore) {
        bestScore = score;
        best = yaw;
      }
    }
    return best;
  }

  /** Extra cost for heading toward the yaw that got it stuck, while that's still fresh. */
  private tabooCost(yaw: number): number {
    if (this.tabooLeft <= 0) return 0;
    const off = Math.abs(wrapAngle(yaw - this.tabooYaw));
    return off < this.tabooWidth ? (1 - off / this.tabooWidth) * AI.costTaboo : 0;
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

  /** Distance along heading `yaw` to the first blocking tree or boulder (the cairn it's going for doesn't count), or Infinity. */
  private firstTree(from: THREE.Vector3, yaw: number, look: number): number {
    const dx = -Math.sin(yaw);
    const dz = -Math.cos(yaw);
    for (let d = AI.sampleStep; d <= look; d += AI.sampleStep) {
      if (this.obstacles.blocking(from.x + dx * d, from.z + dz * d, AI.clearance, this.cairn ?? undefined)) return d;
    }
    return Infinity;
  }
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
