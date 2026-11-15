import * as THREE from 'three';
import type { Obstacles } from '../world/details';
import type { Varde } from '../world/landmarks';
import type { TerrainField } from '../world/terrainField';
import type { Car, CarInput } from './car';
import { circleBlocked, FOOTPRINT } from './clearPose';
import { WoodsPlanner, WOODS, type PathPoint } from './woodsPath';

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
   * A cairn or car to go for has to be in sight: no trunk or boulder within `goalSight` m of the
   * straight way to it (checked every sampleStep m, each time the route is planned). A cairn that
   * goes out of sight is given up; a car out of sight doesn't pull (but one too close still pushes).
   */
  goalSight: 1.6,
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
  /**
   * Allowed overspeed before braking (m/s); gravity alone keeps pushing downhill. `carefulMargin`
   * where it's taking care (a tree on its path, or among many): the slope would carry it well past
   * the careful speed otherwise.
   */
  brakeMargin: 5,
  carefulMargin: 1.5,
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
   * next attempt (see `stuck`). Backing out ends early after `reverseTime` s, or once it stops
   * making headway (`reverseStall` s without `reverseStallProgress` m).
   */
  stuckProgress: 2.5,
  stuckTime: 2,
  stuckArea: 15,
  stuckMemory: 30,
  reverseTime: 5,
  reverseStall: 1,
  reverseStallProgress: 0.5,
  /**
   * Getting loose (see planEscape), with the car's body as FOOTPRINT's circles. Reversing arcs are tried at
   * `backSteers`, stopping at `backStops` m (out to `maxBack`, or `maxBackLater` from the second
   * attempt); from the stops at `swapStops`, it also tries backing on with the steering the other
   * way (pulling the nose off a trunk, then swinging it round); from each stop, forward arcs at
   * `outSteers`, out to `outLength` m in `outStep` m steps,
   * turning at most `outTurn` rad before going straight. A way out runs clear at least `minOut`
   * m; it scores its clear run (up to outLength), `exitRoute` × how well it heads the way the
   * route goes, less `costBack` per m reversed. While backing it stops short of a trunk
   * `backLookout` m behind its tail. Driving out it creeps at `outSpeed` m/s for up to `outDistance`
   * m, then holds that heading `exitHold` s. `replans` more reverses are tried before it counts as stuck again.
   * Ground rising more than `maxClimb` (rise per m) the way it's going, at its leading edge, blocks
   * an arc like a trunk does: it can't drive up a rock face. On every arc the body keeps `planMargin`
   * m more off the trunks than touching (the car doesn't follow an arc that exactly), or as much of it,
   * in `planMarginStep` m steps, as it has where the arc starts.
   */
  backSteers: [-1, -0.5, 0, 0.5, 1],
  backStops: [1.5, 3, 4.5, 6, 8, 10, 12],
  backStep: 0.5,
  swapStops: [1.5, 3],
  planMargin: 0.3,
  planMarginStep: 0.1,
  maxBack: 8,
  maxBackLater: 12,
  outSteers: [-1, -0.5, 0, 0.5, 1],
  outLength: 12,
  outStep: 1,
  outTurn: 1.3,
  minOut: 5,
  exitRoute: 2,
  costBack: 0.4,
  backLookout: 0.8,
  outSpeed: 3.5,
  outDistance: 8,
  outTime: 4,
  exitHold: 2,
  replans: 2,
  maxClimb: 1,
  /** After an attempt, the heading that got it stuck is shunned (± `tabooWidth` rad, growing per attempt) for `tabooTime` s. */
  tabooWidth: 0.35,
  tabooGrowth: 0.2,
  tabooTime: 8,
  costTaboo: 5,
  /** The third attempt drives off any way it can, across the slope too (± `escapeSpread` rad) for `escapeTime` s. */
  escapeSpread: 1.9,
  escapeTime: 6,
  /**
   * Forest mode, among many trees: checked every routeEvery s by counting the trees within
   * `forestRadius` m of the car. It goes in at `forestEnter` of them and out under `forestExit`.
   * Trees about cap its speed, by how many stand within forestRadius m: `treeSpeeds[n]` m/s with n
   * of them (none past the list: forestSpeed). They're looked for at the same time where it is and
   * `woodsStep` m at a time out to `woodsLook` m the way it's going, and it slows in time to be down
   * to each spot's cap there, counting on braking only `woodsBrake` m/s² (it's often in the air
   * over the bumps, where it can neither brake nor steer).
   * (Trees stand at most one to a 6 m cell, so a full wood has about 12 within 12 m; 4 is about a
   * tree every 10 m, measured over the map.)
   * In it, the car drives at most `forestSpeed` m/s (`forestCreep` with a trunk within
   * `forestCaution` m ahead), and instead of the long-range route it seeks the nearest open ground
   * (see seekOpen), steering among the trunks with a closer, finer look (`forestLook` m in
   * `forestStep` m steps, `forestCandidates` headings ±`forestSpread`, `forestTreeClearance` m off a trunk).
   */
  forestRadius: 12,
  treeSpeeds: [Infinity, Infinity, 16, 12],
  woodsLook: 120,
  woodsStep: 8,
  woodsBrake: 3,
  forestEnter: 4,
  forestExit: 3,
  forestSpeed: 8,
  forestCreep: 4,
  forestCaution: 8,
  forestLook: 20,
  forestStep: 1,
  forestCandidates: 25,
  forestSpread: 1.4,
  forestTreeClearance: 1.6,
  costForestTree: 9,
  /**
   * In forest mode it plans a way out of the wood through the gaps (see WoodsPlanner) every
   * routeEvery s, and follows it, steering for the furthest point of the path within `pathLook` m
   * that it can see past the trunks (keeping `pathSight` m off them). Should that point lie more
   * than `pathBehind` rad off the way the car faces, it brakes to under `pathTurnSpeed` m/s, then
   * backs and turns to face it (see planEscape, the path's way weighing `exitPath` there), trying
   * that at most every `pathTurnEvery` s. It creeps where the path bends more than `pathBend` rad within `pathBendLook` m.
   * With no way out within reach, it seeks open ground along straight lines instead (see seekOpen).
   */
  pathLook: 8,
  pathSight: 1.15,
  pathBehind: 1.9,
  pathTurnSpeed: 3,
  exitPath: 6,
  pathTurnEvery: 1.5,
  pathBend: 0.6,
  pathBendLook: 10,
  /**
   * Seeking open ground: `openCandidates` headings ±`openSpread` round downhill, walked out to
   * `openRange` m in `openStep` m steps; open ground is a spot with no trunk within `openRadius`
   * m (checked at its middle and `openRing` spots round it). Each heading costs how far its open
   * ground is (per `openRange`), `costOpenTrunk` per trunk on the way, and its turn off downhill;
   * one with no open ground costs `costNoOpen`.
   */
  openCandidates: 19,
  openSpread: 1.8,
  openRange: 60,
  openStep: 4,
  openRadius: 6,
  openRing: 6,
  costOpenFar: 2,
  costOpenTrunk: 0.6,
  costOpenOff: 0.4,
  costNoOpen: 6,
  /** Upside down / on its side for this long → reset. */
  flippedTime: 1.5,
  /**
   * Engine dead and lying still (slower than `stillSpeed` m/s) for `brokenTime` s: ask for a new car.
   */
  stillSpeed: 1.5,
  brokenTime: 5,
  /**
   * Limping on lost wheels: with n gone, `limp[n − 1]` (the last entry for more). `after` s from
   * losing the latest, it asks for a new car as soon as it's slower than `speed` m/s; going well, it limps on.
   */
  limp: [
    { after: 15, speed: 5 },
    { after: 5, speed: 8 },
  ],
};

/**
 * What the driver weighed, for the debug view: filled only while `AiDriver.debug` is set.
 * - `fan`: the headings it tried this frame (yaw) and how far each ran clear of trees, out to `look` m.
 * - `chosen`: the heading it went for; `route`: the long-range route's.
 * - `squares`: the squares the woods planner last looked at (blocked by a trunk or not), and `plans`
 *   counts the plans, so a view knows when they've changed.
 * - `reason`: what mainly sets the way it's going (see RouteReason); `cairn`: the cairn it's going
 *   for; `company`: the cars pulling it toward them (pull > 0) or pushing it off (< 0).
 */
export interface AiDebug {
  fan: { yaw: number; clear: number }[];
  look: number;
  chosen: number;
  route: number;
  squares: { x: number; z: number; blocked: boolean }[];
  plans: number;
  reason: string;
  cairn: { x: number; z: number } | null;
  company: { x: number; z: number; pull: number }[];
}

/** An empty AiDebug, to hand a driver. */
export function emptyAiDebug(): AiDebug {
  return { fan: [], look: 0, chosen: 0, route: 0, squares: [], plans: 0, reason: '', cairn: null, company: [] };
}

/**
 * What mainly sets the long-range route's way (see planRoute): downhill, a cairn, or what makes
 * straight downhill dearer (trees, rock face, a tipping side slope, the heading it got stuck on);
 * or none of those, when it keeps a route that's no longer the cheapest (AI.routeKeep).
 */
type RouteReason = 'downhill' | 'cairn' | 'round the trees' | 'off rock' | 'off side slope' | 'away from where it got stuck' | 'keeping its route';

/** What a heading runs through (see pathCost), each part as it adds to the cost. */
interface PathParts {
  trees: number;
  rock: number;
  tilt: number;
}

export interface AiDecision {
  input: CarInput;
  /**
   * The car should be put back on its wheels: clear of anything it's against (see clearPose),
   * otherwise at `resetTo` if given (where it is, facing the most open way), or where it is.
   */
  reset: boolean;
  resetTo?: { x: number; z: number; yaw: number };
  /** The car is wrecked (come to rest with its engine dead, or limping too slowly on lost wheels): it wants a new one. */
  newCar?: boolean;
}

/**
 * Getting loose: backing `back` m along the arc at `backSteer` (then on `back2` m at `backSteer2`),
 * then driving out `out` m along the arc at `outSteer` toward `exitYaw`. `from` is where the current
 * phase (or part of the reverse) started, `time` how long it's run.
 */
interface Manoeuvre {
  phase: 'back' | 'out';
  back: number;
  backSteer: number;
  back2: number;
  backSteer2: number;
  outSteer: number;
  exitYaw: number;
  out: number;
  from: THREE.Vector3;
  time: number;
  /** How much heading the route's way counts for, choosing the way out (see bestOut). */
  routeWeight: number;
}

const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _n = new THREE.Vector3();

/**
 * Look-ahead driver. A long-range route (a few times a second) finds the open way far ahead: lanes
 * through forest or round it, off rock faces and steep side slopes, or at a cairn to knock over.
 * Each frame it picks the clearest heading near that route and steers for it, at a speed for the
 * grip under its tyres. Among many trees it slows right down and follows a path it plans through
 * the gaps between the trunks to the nearest open ground, backing and turning first if that path
 * lies behind it. Stuck, it tries something new each time.
 */
export class AiDriver {
  /** Set it to have the driver report what it weighs (see AiDebug); null, the default, costs nothing. */
  debug: AiDebug | null = null;
  /** The long-range route's yaw, when it was last planned, and how far along it the first hazard is (m). */
  private routeYaw = 0;
  /** Starts at a random point of its period, so the cars don't all plan in the same frame. */
  private routeTimer = Math.random() * AI.routeEvery;
  private hazardAt = Infinity;
  /** The cairn it's going for, and for how long. */
  private cairn: Varde | null = null;
  private cairnTime = 0;

  /** Getting loose: backing out, then driving out (see planEscape), and how many reverses it has planned there. */
  private manoeuvre: Manoeuvre | null = null;
  private replanned = 0;
  /** Where the car last made progress, and how long it's been on the throttle since without making more. */
  private readonly anchor = new THREE.Vector3();
  private sinceProgress = 0;
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
  /** Among many trees: slow, careful, seeking open ground (see AI forest mode). */
  private forest = false;
  /** The speed the trees about allow, here and ahead (m/s; see AI.treeSpeeds). */
  private treeCap = Infinity;
  /** Cars it can't see for trees (their positions, as the others list hands them over; see AI.goalSight). */
  private readonly hidden = new Set<THREE.Vector3>();
  /** What mainly sets the route's way, worked out only for the debug view. */
  private routeReason: RouteReason = 'downhill';
  /** How long the car has lain with its engine dead and still (s). */
  private wrecked = 0;
  /** How many wheels the car had lost when last looked, and how long since it lost the latest (s; see AI.limp). */
  private wheelsLost = 0;
  private limping = 0;
  /** In forest mode, the way out of the wood it's following (see AI.pathLook), and the point of it nearest the car. */
  private readonly woods: WoodsPlanner;
  private path: PathPoint[] | null = null;
  private pathAt = 0;
  /** Seconds until it may back and turn to face its path again. */
  private turnWait = 0;

  /** @param cruiseSpeed preferred speed on snow in m/s; varies per car so traffic spreads out */
  constructor(
    private readonly field: TerrainField,
    private readonly obstacles: Obstacles,
    private readonly cruiseSpeed = AI.cruiseSpeed,
  ) {
    this.woods = new WoodsPlanner(
      (x, z, clearance) => !obstacles.blocking(x, z, clearance),
      (x, z) => field.height(x, z),
      (x, z) => this.open(x, z),
    );
  }

  /** The way out of the wood it's following, for the debug view. */
  get woodsPath(): readonly PathPoint[] | null {
    return this.forest ? this.path : null;
  }

  /** @param others world positions of the other cars (the player included) */
  update(dt: number, car: Car, others: readonly THREE.Vector3[]): AiDecision {
    this.time += dt;
    this.tabooLeft = Math.max(0, this.tabooLeft - dt);
    this.escape = Math.max(0, this.escape - dt);
    this.turnWait = Math.max(0, this.turnWait - dt);
    const q = car.model.root.quaternion;
    _fwd.set(0, 0, -1).applyQuaternion(q);
    _up.set(0, 1, 0).applyQuaternion(q);
    const pos = car.position;
    const speed = car.forwardSpeed;
    const idle: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };

    // Engine dead and come to rest: ask for a new car (one rolling on downhill isn't still, so it keeps going).
    const moving = car.velocity.length();
    this.wrecked = !car.engineAlive && moving < AI.stillSpeed ? this.wrecked + dt : 0;
    // On lost wheels: a while to limp on, then a new car unless it's going well (see AI.limp).
    if (car.wheelsLost !== this.wheelsLost) {
      this.wheelsLost = car.wheelsLost;
      this.limping = 0;
    } else this.limping += dt;
    const limp = this.wheelsLost > 0 ? AI.limp[Math.min(this.wheelsLost, AI.limp.length) - 1] : null;
    if (this.wrecked > AI.brokenTime || (limp && this.limping > limp.after && moving < limp.speed)) {
      this.wrecked = 0;
      return { input: idle, reset: false, newCar: true };
    }

    // Upside down or on its side and not getting anywhere: reset.
    this.flipped = _up.y < 0.3 && car.velocity.length() < 3 ? this.flipped + dt : 0;
    if (this.flipped > AI.flippedTime) {
      this.flipped = 0;
      this.manoeuvre = null;
      this.madeProgress(pos);
      return { input: idle, reset: true };
    }

    // Airborne: hold S to engage the air levelling. Flying isn't being stuck.
    if (car.groundedWheels === 0) {
      this.madeProgress(pos);
      return { input: { ...idle, brake: 1 }, reset: false };
    }

    const carYaw = Math.atan2(-_fwd.x, -_fwd.z);
    // Getting loose: backing out, then driving out, each step looked over first.
    if (this.manoeuvre) {
      const decision = this.loosen(dt, car, pos, carYaw);
      if (decision) return decision;
    }

    this.routeTimer -= dt;
    if (this.routeTimer <= 0) {
      this.routeTimer = AI.routeEvery;
      this.hidden.clear();
      for (const o of others) {
        const d = Math.hypot(o.x - pos.x, o.z - pos.z);
        if (d < AI.companyRange && d >= AI.personalSpace && !this.inSightOf(pos, o.x, o.z)) this.hidden.add(o);
      }
      const trees = this.obstacles.treesWithin(pos.x, pos.z, AI.forestRadius);
      this.treeCap = this.treeLimit(pos, car.velocity, trees);
      this.forest = trees >= (this.forest ? AI.forestExit : AI.forestEnter);
      if (this.forest) {
        this.cairn = null;
        this.path = this.woods.plan(pos.x, pos.z, AI.forestTreeClearance);
        this.pathAt = 0;
        if (this.debug) {
          const squares: AiDebug['squares'] = [];
          this.woods.forEachSquare((x, z, blocked) => squares.push({ x, z, blocked }));
          this.debug.squares = squares;
          this.debug.plans++;
        }
        if (this.path) this.hazardAt = Infinity;
        else this.seekOpen(pos);
      } else {
        this.path = null;
        this.pickCairn(pos);
        this.planRoute(pos);
      }
    }

    // In the wood with a way out: follow it, first backing and turning to face it if it lies behind.
    const way = this.forest && this.path ? this.followPath(pos) : null;
    const behind = way !== null && Math.abs(wrapAngle(way.yaw - carYaw)) > AI.pathBehind;
    // Swinging round at speed would throw it into the trunks: straight on, braking, first.
    if (behind && Math.abs(speed) > AI.pathTurnSpeed) {
      this.madeProgress(pos);
      return { input: { ...idle, brake: speed > 0 ? 1 : 0, throttle: speed < 0 ? 1 : 0 }, reset: false };
    }
    if (behind && this.turnWait <= 0) {
      this.turnWait = AI.pathTurnEvery;
      this.routeYaw = way.yaw;
      const plan = this.planEscape(car, pos, carYaw, AI.maxBack, AI.exitPath);
      if (plan) {
        this.manoeuvre = plan;
        this.replanned = 0;
        const decision = this.loosen(0, car, pos, carYaw);
        if (decision) return decision;
      }
    }

    const company = this.companyBearings(pos, others);
    const forest = this.forest;
    const look = forest ? AI.forestLook : Math.min(AI.lookMax, AI.lookBase + Math.max(0, speed) * AI.lookPerSpeed);
    const step = forest ? AI.forestStep : AI.sampleStep;
    const clearance = forest ? AI.forestTreeClearance : AI.clearance;
    const candidates = forest ? AI.forestCandidates : AI.candidates;
    const spread = this.escape > 0 ? AI.escapeSpread : forest ? AI.forestSpread : AI.spread;
    const costTree = forest ? AI.costForestTree : AI.costTree;
    let bestYaw = way ? way.yaw : this.routeYaw;
    let bestCost = Infinity;
    let bestTreeDist = Infinity;
    const debug = this.debug;
    if (debug) {
      debug.fan.length = 0;
      debug.look = look;
    }
    for (let i = 0; i < (way ? 0 : candidates); i++) {
      const off = -spread + (2 * spread * i) / (candidates - 1);
      const yaw = wrapAngle(this.routeYaw + off);
      const treeDist = this.firstTree(pos, yaw, look, step, clearance);
      debug?.fan.push({ yaw, clear: Math.min(treeDist, look) });
      const cost =
        Math.abs(off) * AI.costOffRoute +
        Math.abs(wrapAngle(yaw - carYaw)) * AI.costTurn +
        (treeDist < look ? ((look - treeDist) / look) * costTree : 0) +
        this.companyCost(yaw, company) +
        this.tabooCost(yaw);
      if (cost < bestCost) {
        bestCost = cost;
        bestYaw = yaw;
        bestTreeDist = treeDist;
      }
    }
    if (debug) {
      debug.chosen = bestYaw;
      debug.route = this.routeYaw;
      debug.reason = this.escape > 0 ? 'escaping, any way it can' : way ? 'path out of the woods' : forest ? 'to open ground' : this.routeReason;
      debug.cairn = this.cairn && { x: this.cairn.x, z: this.cairn.z };
      debug.company.length = 0;
      for (const o of others) {
        const d = Math.hypot(o.x - pos.x, o.z - pos.z);
        if (d >= AI.companyRange || d < 0.1 || this.hidden.has(o)) continue;
        debug.company.push({ x: o.x, z: o.z, pull: d < AI.personalSpace ? -(1 - d / AI.personalSpace) : 1 - d / AI.companyRange });
      }
    }

    const error = wrapAngle(bestYaw - carYaw);
    const steer = THREE.MathUtils.clamp(error * AI.steerGain, -1, 1);

    // Faster where the tyres grip, slower for trees, hazards and corners (less so where it grips).
    const grip = car.grip;
    const hunting = this.cairn !== null;
    const cautious = bestTreeDist < AI.cautionDistance && !hunting;
    let target = (cautious ? AI.cautiousSpeed : this.cruiseSpeed) * Math.pow(grip, AI.gripSpeed);
    if (this.hazardAt < AI.hazardDistance && !hunting) target *= AI.hazardSlow;
    // Among many trees: slowly, creeping past a trunk close ahead or round a bend in its path.
    const creep = way ? way.bend > AI.pathBend : bestTreeDist < AI.forestCaution;
    if (forest) target = Math.min(target, creep ? AI.forestCreep : AI.forestSpeed * Math.pow(grip, AI.gripSpeed));
    // Trees about, here and ahead: slow enough to be down to their cap by the time it's there.
    else target = Math.min(target, this.treeCap);
    target *= 1 - Math.min(0.5, (Math.abs(error) * AI.cornerSlow) / grip);
    const input: CarInput = {
      throttle: speed < target ? 1 : 0,
      brake: speed > target + (cautious || forest ? AI.carefulMargin : AI.brakeMargin) ? 1 : 0,
      steer,
      handbrake: false,
    };

    // Stuck: pushing without getting anywhere.
    if (input.throttle === 0 || pos.distanceTo(this.anchor) > AI.stuckProgress) this.madeProgress(pos);
    else this.sinceProgress += dt;
    if (this.sinceProgress > AI.stuckTime) return this.stuck(car, pos, carYaw, input);
    return { input, reset: false };
  }

  /**
   * Got stuck. It shuns the heading that got it stuck and plans a way loose (see planEscape),
   * reversing further from the second attempt; the third also drives off any way it can for a
   * while, across the slope too. With no way loose, or on the fourth attempt in the same spot, it
   * goes back on its wheels where it is, facing the most open way.
   */
  private stuck(car: Car, pos: THREE.Vector3, yaw: number, input: CarInput): AiDecision {
    const again = this.time - this.stuckWhen < AI.stuckMemory && pos.distanceTo(this.stuckAt) < AI.stuckArea;
    this.attempts = again ? this.attempts + 1 : 1;
    this.stuckAt.copy(pos);
    this.stuckWhen = this.time;
    this.madeProgress(pos);
    // Whatever it tries, it stops going for the heading that got it stuck.
    this.tabooYaw = yaw;
    this.tabooWidth = AI.tabooWidth + AI.tabooGrowth * (this.attempts - 1);
    this.tabooLeft = AI.tabooTime;
    if (this.attempts >= 4) return this.giveUp(pos, input);
    // A cairn it keeps getting stuck going for isn't worth it.
    if (this.attempts >= 2) this.cairn = null;
    // Counted from now, so it runs on after getting loose.
    if (this.attempts >= 3) this.escape = AI.reverseTime + AI.outTime + AI.escapeTime;
    this.replanned = 0;
    const plan = this.planEscape(car, pos, yaw, this.attempts >= 2 ? AI.maxBackLater : AI.maxBack);
    if (!plan) return this.giveUp(pos, input);
    this.manoeuvre = plan;
    return this.loosen(0, car, pos, yaw) ?? { input, reset: false };
  }

  /** No way loose: back on its wheels where it is, facing the most open way. */
  private giveUp(pos: THREE.Vector3, input: CarInput): AiDecision {
    this.attempts = 0;
    this.cairn = null;
    this.manoeuvre = null;
    const to = { x: pos.x, z: pos.z, yaw: this.openestYaw(pos) };
    this.routeYaw = to.yaw;
    return { input, reset: true, resetTo: to };
  }

  /**
   * One step of getting loose. Backing out: along the planned arc until it has reversed far
   * enough, sees a trunk close behind, stalls or runs out of time; then it looks over the ways out
   * from where it actually is, and drives out along the best (or plans another reverse, or gives
   * up as stuck). Driving out: creeping along that arc until it has gone far enough or faces the
   * way out, which it then holds for a moment. Null when it's done and normal driving takes over.
   */
  private loosen(dt: number, car: Car, pos: THREE.Vector3, yaw: number): AiDecision | null {
    const m = this.manoeuvre!;
    const A = AI;
    m.time += dt;
    if (this.debug) {
      this.debug.reason = m.phase === 'back' ? 'getting loose: backing' : 'getting loose: driving out';
      this.debug.fan.length = 0;
    }
    const idle: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
    if (m.phase === 'back' && m.back2 > 0 && pos.distanceTo(m.from) >= m.back) {
      // On to the reverse's second part, steering the other way.
      Object.assign(m, { back: m.back2, backSteer: m.backSteer2, back2: 0, time: 0 });
      m.from.copy(pos);
    }
    const moved = pos.distanceTo(m.from);
    if (m.phase === 'back') {
      // Its tail, and a little further back: stop before backing into a trunk.
      const tail = FOOTPRINT.circles[FOOTPRINT.circles.length - 1] + A.backLookout;
      const behind = circleBlocked(this.obstacles, pos.x, pos.z, yaw, tail, FOOTPRINT.clearance * 0.8);
      const stalled = m.time > A.reverseStall && moved < A.reverseStallProgress;
      if (moved < m.back && !behind && !stalled && m.time < A.reverseTime) {
        return { input: { ...idle, brake: 1, steer: m.backSteer }, reset: false };
      }
      // Look over the ways out from where it actually ended up.
      const out = this.bestOut(car, pos.x, pos.z, yaw, m.routeWeight);
      if (!out || out.clear < A.minOut) {
        if (this.replanned++ < A.replans) {
          const again = this.planEscape(car, pos, yaw, A.maxBackLater, m.routeWeight);
          if (again) {
            this.manoeuvre = again;
            return this.loosen(0, car, pos, yaw);
          }
        }
        this.manoeuvre = null;
        return this.stuck(car, pos, yaw, idle);
      }
      Object.assign(m, { phase: 'out', outSteer: out.steer, exitYaw: out.exitYaw, out: Math.min(A.outDistance, out.clear * 0.8), time: 0 });
      m.from.copy(pos);
      this.madeProgress(pos);
      return this.loosen(0, car, pos, yaw);
    }
    // Driving out: along the arc, then straighten onto the way out.
    const facing = Math.abs(wrapAngle(m.exitYaw - yaw)) < 0.15;
    if (moved < m.out && !facing && m.time < A.outTime) {
      const speed = car.forwardSpeed;
      const input: CarInput = { throttle: speed < A.outSpeed ? 1 : 0, brake: speed > A.outSpeed + 2 ? 1 : 0, steer: m.outSteer, handbrake: false };
      if (pos.distanceTo(this.anchor) > A.stuckProgress) this.madeProgress(pos);
      else this.sinceProgress += dt;
      if (this.sinceProgress > A.stuckTime) {
        this.manoeuvre = null;
        return this.stuck(car, pos, yaw, input);
      }
      return { input, reset: false };
    }
    this.manoeuvre = null;
    this.routeYaw = m.exitYaw;
    this.routeTimer = A.exitHold;
    this.madeProgress(pos);
    return null;
  }

  /**
   * Plans a way loose from (pos, yaw): a reverse (or none) and the arc to drive out along. Each
   * reversing arc runs until its tail would touch a trunk; from points along it, the forward arcs
   * are looked over (see bestOut), and the best pair wins, shorter reverses preferred. A reverse can
   * also swap its steering partway (see AI.swapStops). With its tail against a trunk it can't
   * reverse at all (nor drive out forwards with its nose against one: see bestOut). Null if no way
   * out runs clear far enough. `routeWeight`: how much heading the route's way counts (see bestOut).
   */
  private planEscape(car: Car, pos: THREE.Vector3, yaw: number, maxBack: number, routeWeight = AI.exitRoute): Manoeuvre | null {
    const A = AI;
    const pick: { best: { score: number; back: number; backSteer: number; back2: number; backSteer2: number } | null } = { best: null };
    const consider = (pose: { x: number; z: number; yaw: number }, back: number, backSteer: number, back2: number, backSteer2: number) => {
      const out = this.bestOut(car, pose.x, pose.z, pose.yaw, routeWeight);
      if (!out || out.clear < A.minOut) return;
      const score = out.score - A.costBack * (back + back2);
      if (!pick.best || score > pick.best.score) pick.best = { score, back, backSteer, back2, backSteer2 };
    };
    // Driving straight out, without reversing, if a way is open.
    consider({ x: pos.x, z: pos.z, yaw }, 0, 0, 0, 0);
    const F = FOOTPRINT.circles;
    const tailAgainst = circleBlocked(this.obstacles, pos.x, pos.z, yaw, F[F.length - 1]);
    for (const backSteer of tailAgainst ? [] : A.backSteers) {
      this.backArc(car, { x: pos.x, z: pos.z, yaw }, this.armed(pos.x, pos.z, yaw), backSteer, maxBack, (pose, armed, d) => {
        consider(pose, d, backSteer, 0, 0);
        if (backSteer === 0 || !A.swapStops.includes(d)) return;
        this.backArc(car, { ...pose }, [...armed], -backSteer, maxBack - d, (then, _, d2) => consider(then, d, backSteer, d2, -backSteer));
      });
    }
    const best = pick.best;
    if (!best) return null;
    return { phase: 'back', ...best, outSteer: 0, exitYaw: yaw, out: 0, from: pos.clone(), time: 0, routeWeight };
  }

  /**
   * Backs `pose` along the arc at `steer` until the body (`armed`, see footprintBlocked) would touch
   * a trunk or the ground behind it is too steep, out to `maxBack` m, calling `visit` at each of
   * AI.backStops on the way (with the pose and arming there, and how far it has backed).
   */
  private backArc(
    car: Car,
    pose: { x: number; z: number; yaw: number },
    armed: number[],
    steer: number,
    maxBack: number,
    visit: (pose: { x: number; z: number; yaw: number }, armed: number[], d: number) => void,
  ): void {
    const A = AI;
    let stop = 0;
    for (let d = A.backStep; d <= maxBack + 1e-6 && stop < A.backStops.length; d += A.backStep) {
      this.advance(car, pose, -A.backStep, steer, Math.PI);
      if (this.footprintBlocked(pose.x, pose.z, pose.yaw, armed) || this.tooSteep(pose.x, pose.z, pose.yaw, -1)) return;
      if (Math.abs(d - A.backStops[stop]) > 1e-6) continue;
      stop++;
      visit(pose, armed, d);
    }
  }

  /**
   * The best arc to drive off along from (x, z, yaw): each of AI.outSteers held until it has
   * turned AI.outTurn, then straight, as far as it runs clear (up to AI.outLength). It scores that
   * run, how well it ends up heading the route's way (× `routeWeight`), and none toward the shunned
   * heading. Null with its nose against a trunk: pulling on would only push into it (the body's
   * other circles may start against one, and count once they've come clear).
   */
  private bestOut(car: Car, x: number, z: number, yaw: number, routeWeight: number): { steer: number; clear: number; exitYaw: number; score: number } | null {
    const A = AI;
    if (circleBlocked(this.obstacles, x, z, yaw, FOOTPRINT.circles[0])) return null;
    let best: { steer: number; clear: number; exitYaw: number; score: number } | null = null;
    for (const steer of A.outSteers) {
      const armed = this.armed(x, z, yaw);
      const pose = { x, z, yaw };
      let clear = 0;
      for (let d = A.outStep; d <= A.outLength + 1e-6; d += A.outStep) {
        this.advance(car, pose, A.outStep, steer, A.outTurn, yaw);
        if (this.footprintBlocked(pose.x, pose.z, pose.yaw, armed) || this.tooSteep(pose.x, pose.z, pose.yaw, 1)) break;
        clear = d;
      }
      const score = clear + routeWeight * Math.cos(wrapAngle(pose.yaw - this.routeYaw)) - this.tabooCost(pose.yaw);
      if (!best || score > best.score) best = { steer, clear, exitYaw: pose.yaw, score };
    }
    return best;
  }

  /**
   * Moves `pose` `ds` m along (negative: backwards) with the steering at `steer` (−1..1), the car's
   * full lock and wheelbase giving the turn; it stops turning once `turn` rad from `fromYaw`.
   */
  private advance(car: Car, pose: { x: number; z: number; yaw: number }, ds: number, steer: number, turn: number, fromYaw = pose.yaw): void {
    const W = car.cfg.wheels;
    const wheelbase = W.rearZ - W.frontZ;
    if (Math.abs(wrapAngle(pose.yaw - fromYaw)) < turn) pose.yaw += (Math.tan(steer * car.cfg.steering.maxAngle) / wheelbase) * ds;
    pose.x += -Math.sin(pose.yaw) * ds;
    pose.z += -Math.cos(pose.yaw) * ds;
  }

  /**
   * How far each of the body's circles (FOOTPRINT) keeps off the trunks on an arc from (x, z, yaw):
   * its clearance plus AI.planMargin, or as much of the margin as it has there (see AI.planMarginStep);
   * 0 for one already against a trunk, which doesn't count until it's off it.
   */
  private armed(x: number, z: number, yaw: number): number[] {
    const A = AI;
    const base = FOOTPRINT.clearance;
    return FOOTPRINT.circles.map((local) => {
      for (let m = A.planMargin; m > -1e-6; m -= A.planMarginStep) {
        if (!circleBlocked(this.obstacles, x, z, yaw, local, base + m)) return base + Math.max(0, m);
      }
      return 0;
    });
  }

  /**
   * Whether the body at (x, z, yaw) comes closer to a trunk than its circles keep (see armed),
   * arming those that have come clear (at no margin).
   */
  private footprintBlocked(x: number, z: number, yaw: number, armed: number[]): boolean {
    const F = FOOTPRINT.circles;
    for (let i = 0; i < F.length; i++) {
      if (armed[i] === 0) {
        if (!circleBlocked(this.obstacles, x, z, yaw, F[i])) armed[i] = FOOTPRINT.clearance;
      } else if (circleBlocked(this.obstacles, x, z, yaw, F[i], armed[i])) return true;
    }
    return false;
  }

  /**
   * Whether the ground at the body's leading edge (its nose going forward, `dir` 1; its tail
   * reversing, −1) rises more than AI.maxClimb per m the way it's going.
   */
  private tooSteep(x: number, z: number, yaw: number, dir: 1 | -1): boolean {
    const F = FOOTPRINT;
    const edge = dir > 0 ? F.circles[0] - F.clearance : F.circles[F.circles.length - 1] + F.clearance;
    const n = this.field.normal(x + Math.sin(yaw) * edge, z + Math.cos(yaw) * edge, _n, 1);
    const ux = -Math.sin(yaw) * dir;
    const uz = -Math.cos(yaw) * dir;
    return -(n.x * ux + n.z * uz) / n.y > AI.maxClimb;
  }

  private madeProgress(pos: THREE.Vector3): void {
    this.anchor.copy(pos);
    this.sinceProgress = 0;
  }

  /** Keeps the cairn it's going for while it's in sight, or looks for a new one ahead in sight (see AI.goalSight). */
  private pickCairn(pos: THREE.Vector3): void {
    const A = AI;
    const landmarks = this.field.landmarks;
    if (this.cairn) {
      this.cairnTime += A.routeEvery;
      const passed = this.cairn.z > pos.z + A.cairnPassed;
      const hidden = !this.inSightOf(pos, this.cairn.x, this.cairn.z, this.cairn);
      if (!landmarks.standing(this.cairn) || passed || hidden || this.cairnTime > A.cairnGiveUp) this.cairn = null;
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
      if (!this.inSightOf(pos, v.x, v.z, v)) continue;
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
    const parts: PathParts[] = [];
    for (let i = 0; i < yaws.length; i++) {
      const yaw = yaws[i];
      const { cost: path, hazard, parts: through } = this.pathCost(pos, yaw, Math.min(A.routeRange, cairnDist));
      parts.push(through);
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
    if (this.debug) this.routeReason = this.reasonFor(yaws, parts);
  }

  /**
   * Why the route goes the way it does (see RouteReason): what costs straight downhill (the
   * candidate nearest it) more than the route's own heading, by the most.
   */
  private reasonFor(yaws: readonly number[], parts: readonly PathParts[]): RouteReason {
    if (this.cairn) return 'cairn';
    if (Math.abs(this.routeYaw) < 0.15) return 'downhill';
    const nearest = (target: number) => {
      let best = 0;
      for (let i = 1; i < yaws.length; i++) if (Math.abs(wrapAngle(yaws[i] - target)) < Math.abs(wrapAngle(yaws[best] - target))) best = i;
      return best;
    };
    const down = parts[nearest(0)];
    const route = parts[nearest(this.routeYaw)];
    const extra: [RouteReason, number][] = [
      ['round the trees', down.trees - route.trees],
      ['off rock', down.rock - route.rock],
      ['off side slope', down.tilt - route.tilt],
      ['away from where it got stuck', this.tabooCost(0) - this.tabooCost(this.routeYaw)],
    ];
    extra.sort((a, b) => b[1] - a[1]);
    return extra[0][1] > 0 ? extra[0][0] : 'keeping its route';
  }

  /**
   * What heading `yaw` runs through out to `range` m (nearer counts more): forest, bare rock face
   * and side slopes that tip the car; and how far along the first rock face or tipping slope is.
   */
  private pathCost(from: THREE.Vector3, yaw: number, range: number): { cost: number; hazard: number; parts: PathParts } {
    const A = AI;
    const dx = -Math.sin(yaw);
    const dz = -Math.cos(yaw);
    const parts: PathParts = { trees: 0, rock: 0, tilt: 0 };
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
      parts.trees += w * (trees / 3) * A.costRouteTrees;
      parts.rock += w * rock * A.costRouteRock;
      parts.tilt += w * tilt * A.costRouteTilt;
      weights += w;
    }
    if (weights > 0) {
      parts.trees /= weights;
      parts.rock /= weights;
      parts.tilt /= weights;
    }
    return { cost: parts.trees + parts.rock + parts.tilt, hazard, parts };
  }

  /** The heading round the car with the longest clear run, leaning toward its route: where a reset faces. */
  private openestYaw(pos: THREE.Vector3): number {
    let best = this.routeYaw;
    let bestScore = -Infinity;
    // Among many trees, with the closer look's narrower margin (a lane it can drive counts as clear).
    const clearance = this.forest ? AI.forestTreeClearance : AI.clearance;
    for (let i = 0; i < 24; i++) {
      const yaw = wrapAngle((i / 24) * Math.PI * 2);
      const clear = Math.min(30, this.firstTree(pos, yaw, 30, AI.sampleStep, clearance));
      // Turning off the route (to open ground, or downhill) costs, not off downhill as such.
      const score = clear - Math.abs(wrapAngle(yaw - this.routeYaw)) * 4 - this.tabooCost(yaw) * 4;
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

  /** Yaw toward each nearby car and how strongly it pulls (+) or pushes (−); cars out of sight for trees don't pull. */
  private companyBearings(from: THREE.Vector3, others: readonly THREE.Vector3[]): { yaw: number; pull: number }[] {
    const out: { yaw: number; pull: number }[] = [];
    for (const o of others) {
      const dx = o.x - from.x;
      const dz = o.z - from.z;
      const d = Math.hypot(dx, dz);
      if (d >= AI.companyRange || d < 0.1 || this.hidden.has(o)) continue;
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

  /**
   * Whether no trunk or boulder comes within AI.goalSight m of the straight way from `from` to
   * (x, z), short of its last couple of m (the cairn `except` doesn't count).
   */
  private inSightOf(from: THREE.Vector3, x: number, z: number, except?: Varde): boolean {
    const dist = Math.hypot(x - from.x, z - from.z);
    for (let d = AI.sampleStep; d < dist - 2; d += AI.sampleStep) {
      const t = d / dist;
      if (this.obstacles.blocking(from.x + (x - from.x) * t, from.z + (z - from.z) * t, AI.goalSight, except)) return false;
    }
    return true;
  }

  /**
   * Distance along heading `yaw` to the first tree or boulder within `clearance` m of the way,
   * checked every `step` m (the cairn it's going for doesn't count), or Infinity.
   */
  private firstTree(from: THREE.Vector3, yaw: number, look: number, step = AI.sampleStep, clearance = AI.clearance): number {
    const dx = -Math.sin(yaw);
    const dz = -Math.cos(yaw);
    for (let d = step; d <= look; d += step) {
      if (this.obstacles.blocking(from.x + dx * d, from.z + dz * d, clearance, this.cairn ?? undefined)) return d;
    }
    return Infinity;
  }

  /**
   * The speed the trees allow (see AI.treeSpeeds): `here` of them round the car, and ahead the way
   * `velocity` goes along the ground, each spot's cap raised by what braking can take off before
   * it's there.
   */
  private treeLimit(pos: THREE.Vector3, velocity: THREE.Vector3, here: number): number {
    const A = AI;
    const cap = (trees: number) => A.treeSpeeds[trees] ?? A.forestSpeed;
    let limit = cap(here);
    const along = Math.hypot(velocity.x, velocity.z);
    if (along < 1) return limit;
    const dx = velocity.x / along;
    const dz = velocity.z / along;
    for (let d = A.woodsStep; d <= A.woodsLook; d += A.woodsStep) {
      const at = cap(this.obstacles.treesWithin(pos.x + dx * d, pos.z + dz * d, A.forestRadius));
      if (at < Infinity) limit = Math.min(limit, Math.sqrt(at * at + 2 * A.woodsBrake * d));
    }
    return limit;
  }

  /**
   * Where to steer along the path out of the wood: the yaw to the furthest point of it within
   * AI.pathLook m that it can see past the trunks, and how sharply the path bends after that point
   * (rad). Null once it has come to the path's end.
   */
  private followPath(pos: THREE.Vector3): { yaw: number; bend: number } | null {
    const A = AI;
    const path = this.path!;
    // The point nearest the car, from the last one on: it moves along the path.
    let near = this.pathAt;
    let nearDist = Infinity;
    for (let i = this.pathAt; i < Math.min(path.length, this.pathAt + (4 * A.pathLook) / WOODS.cell); i++) {
      const d = Math.hypot(path[i].x - pos.x, path[i].z - pos.z);
      if (d < nearDist) {
        nearDist = d;
        near = i;
      }
    }
    this.pathAt = near;
    if (near >= path.length - 1) return null;
    let aim = near + 1;
    for (let i = near + 1; i < path.length; i++) {
      const d = Math.hypot(path[i].x - pos.x, path[i].z - pos.z);
      if (d > A.pathLook) break;
      if (this.inSight(pos, path[i], d)) aim = i;
    }
    const to = path[aim];
    const yaw = Math.atan2(-(to.x - pos.x), -(to.z - pos.z));
    const on = path[Math.min(path.length - 1, aim + Math.round(A.pathBendLook / WOODS.cell))];
    const bend = on === to ? 0 : Math.abs(wrapAngle(Math.atan2(-(on.x - to.x), -(on.z - to.z)) - yaw));
    return { yaw, bend };
  }

  /** Whether the straight way from `from` to `to`, `dist` m off, keeps AI.pathSight m off every trunk (from 1 m out). */
  private inSight(from: THREE.Vector3, to: PathPoint, dist: number): boolean {
    for (let d = 1; d < dist; d += 0.5) {
      const t = d / dist;
      if (this.obstacles.blocking(from.x + (to.x - from.x) * t, from.z + (to.z - from.z) * t, AI.pathSight)) return false;
    }
    return true;
  }

  /** Whether (x, z) is open ground: no trunk within AI.openRadius of it. */
  private open(x: number, z: number): boolean {
    const A = AI;
    if (this.obstacles.blocking(x, z, A.openRadius * 0.5)) return false;
    for (let k = 0; k < A.openRing; k++) {
      const angle = (k / A.openRing) * Math.PI * 2;
      if (this.obstacles.blocking(x + Math.cos(angle) * A.openRadius, z + Math.sin(angle) * A.openRadius, A.openRadius * 0.5)) return false;
    }
    return true;
  }

  /** Points the route at the nearest open ground it can reach past the fewest trunks, leaning downhill. */
  private seekOpen(pos: THREE.Vector3): void {
    const A = AI;
    const spread = this.escape > 0 ? A.escapeSpread : A.openSpread;
    let best = this.routeYaw;
    let bestCost = Infinity;
    for (let i = 0; i < A.openCandidates; i++) {
      const yaw = -spread + (2 * spread * i) / (A.openCandidates - 1);
      const dx = -Math.sin(yaw);
      const dz = -Math.cos(yaw);
      let trunks = 0;
      let found = Infinity;
      for (let d = A.openStep; d <= A.openRange; d += A.openStep) {
        const x = pos.x + dx * d;
        const z = pos.z + dz * d;
        if (this.open(x, z)) {
          found = d;
          break;
        }
        if (this.obstacles.blocking(x, z, AI.clearance)) trunks++;
      }
      const cost =
        (found === Infinity ? A.costNoOpen : (found / A.openRange) * A.costOpenFar) +
        trunks * A.costOpenTrunk +
        Math.abs(yaw) * A.costOpenOff +
        this.tabooCost(yaw) +
        // A little loyalty to the current way, so it doesn't swing between two openings.
        Math.abs(wrapAngle(yaw - this.routeYaw)) * 0.2;
      if (cost < bestCost) {
        bestCost = cost;
        best = yaw;
      }
    }
    this.routeYaw = best;
    this.hazardAt = Infinity;
  }
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
