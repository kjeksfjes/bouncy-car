/**
 * The way out of a wood, for the AI driver: a least-cost search over a grid round the car, through
 * the gaps between the trunks, to the nearest open ground (the driver says what counts as open),
 * leaning downhill.
 *
 * Feel values: change freely.
 * - `cell` m grid squares, out to `reach` m each way from the car.
 * - A square is passable when no trunk or boulder comes within the clearance the driver asks for.
 *   Within `startZone` m of the car, only the trunks themselves (`startClearance`) block: a car
 *   that's wedged has a trunk within the clearance already, and has to be able to plan a way out.
 * - Each m costs 1, plus `costClimb` × how steeply it rises (rise per m); going down costs nothing extra.
 * - The goal is checked every `goalEvery` squares (it's the dearest test), from `goalMin` m off the
 *   car (a car standing in a clearing plans on to the next). Failing open ground, the grid's edge
 *   counts as a goal at `costEdge` more: the way out may lie further off. Either only counts within
 *   `goalSpread` rad of straight downhill from the car (the way back out of a wood it has just
 *   driven into is the nearest, but it went in to get further down), and costs `costOff` more per
 *   rad off downhill: of two ways out about as far, it takes the one further down.
 * - The search gives up after `maxSquares` squares.
 */
export const WOODS = {
  cell: 1,
  reach: 45,
  startZone: 3,
  startClearance: 0.5,
  costClimb: 4,
  goalEvery: 3,
  costEdge: 25,
  goalMin: 8,
  goalSpread: 1.8,
  costOff: 6,
  maxSquares: 9000,
};

export interface PathPoint {
  x: number;
  z: number;
}

const UNKNOWN = 0;
const FREE = 1;
const BLOCKED = 2;
const DIAGONAL = Math.SQRT2;
const STEPS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, DIAGONAL],
  [1, -1, DIAGONAL],
  [-1, 1, DIAGONAL],
  [-1, -1, DIAGONAL],
] as const;

/**
 * Plans paths on one grid it reuses (squares are looked at only when the search reaches them, so a
 * short way out costs little).
 */
export class WoodsPlanner {
  private readonly size = 2 * Math.round(WOODS.reach / WOODS.cell) + 1;
  private readonly state = new Uint8Array(this.size * this.size);
  private readonly height = new Float32Array(this.size * this.size);
  private readonly cost = new Float32Array(this.size * this.size);
  private readonly from = new Int32Array(this.size * this.size);
  private readonly done = new Uint8Array(this.size * this.size);
  /** Goal tests, by goalEvery-square block: 0 not tested, 1 goal, 2 not. */
  private readonly goals = new Uint8Array(this.size * this.size);
  private readonly heap = new MinHeap();
  /** The last plan's grid origin (in squares). */
  private ox = 0;
  private oz = 0;

  /**
   * @param passable whether a car's centre at (x, z) keeps `clearance` m off every trunk and boulder
   * @param heightAt the ground's height at (x, z)
   * @param goal whether (x, z) is out of the wood
   */
  constructor(
    private readonly passable: (x: number, z: number, clearance: number) => boolean,
    private readonly heightAt: (x: number, z: number) => number,
    private readonly goal: (x: number, z: number) => boolean,
  ) {}

  /**
   * The cheapest way from (x, z) out of the wood, keeping `clearance` m off the trunks: points
   * `cell` m apart from the car's square to the goal, or null if there's none within reach.
   */
  plan(x: number, z: number, clearance: number): PathPoint[] | null {
    const W = WOODS;
    const n = this.size;
    const half = (n - 1) / 2;
    const ox = (this.ox = Math.round(x / W.cell) - half);
    const oz = (this.oz = Math.round(z / W.cell) - half);
    this.state.fill(UNKNOWN);
    this.goals.fill(0);
    this.done.fill(0);
    this.cost.fill(Infinity);
    const heap = this.heap;
    heap.clear();

    const start = half * n + half;
    this.cost[start] = 0;
    this.from[start] = -1;
    this.state[start] = FREE;
    this.height[start] = this.heightAt((ox + half) * W.cell, (oz + half) * W.cell);
    heap.push(start, 0);

    let bestEnd = -1;
    let bestTotal = Infinity;
    let squares = 0;
    while (heap.size > 0) {
      const i = heap.pop();
      const c = heap.lastKey;
      if (this.done[i]) continue;
      if (c >= bestTotal) break;
      this.done[i] = 1;
      if (++squares > W.maxSquares) break;
      const ix = i % n;
      const iz = (i - ix) / n;

      const edge = ix === 0 || iz === 0 || ix === n - 1 || iz === n - 1;
      // How far off downhill (yaw from −Z) the square lies, seen from the car.
      const off = Math.abs(Math.atan2(half - ix, half - iz));
      const far = Math.hypot(ix - half, iz - half) * W.cell >= W.goalMin;
      let total = Infinity;
      if (off <= W.goalSpread && far) {
        if (this.isGoal(ix, iz, ox, oz)) total = c + W.costOff * off;
        else if (edge) total = c + W.costEdge + W.costOff * off;
      }
      if (total < bestTotal) {
        bestTotal = total;
        bestEnd = i;
      }

      for (const [sx, sz, len] of STEPS) {
        const jx = ix + sx;
        const jz = iz + sz;
        if (jx < 0 || jz < 0 || jx >= n || jz >= n) continue;
        const j = jz * n + jx;
        if (this.done[j]) continue;
        if (this.state[j] === UNKNOWN) {
          const px = (ox + jx) * W.cell;
          const pz = (oz + jz) * W.cell;
          const near = Math.hypot(jx - half, jz - half) * W.cell <= W.startZone;
          const ok = this.passable(px, pz, near ? W.startClearance : clearance);
          this.state[j] = ok ? FREE : BLOCKED;
          if (ok) this.height[j] = this.heightAt(px, pz);
        }
        if (this.state[j] === BLOCKED) continue;
        const run = len * W.cell;
        const rise = Math.max(0, this.height[j] - this.height[i]);
        const next = c + run + W.costClimb * rise;
        if (next < this.cost[j]) {
          this.cost[j] = next;
          this.from[j] = i;
          heap.push(j, next);
        }
      }
    }
    if (bestEnd < 0) return null;
    const path: PathPoint[] = [];
    for (let i = bestEnd; i >= 0; i = this.from[i]) {
      const ix = i % n;
      path.push({ x: (ox + ix) * W.cell, z: (oz + (i - ix) / n) * W.cell });
    }
    return path.reverse();
  }

  /** Calls `visit` for every square the last plan looked at, with whether a trunk or boulder blocks it (for the debug view). */
  forEachSquare(visit: (x: number, z: number, blocked: boolean) => void): void {
    const n = this.size;
    for (let i = 0; i < this.state.length; i++) {
      if (this.state[i] === UNKNOWN) continue;
      const ix = i % n;
      visit((this.ox + ix) * WOODS.cell, (this.oz + (i - ix) / n) * WOODS.cell, this.state[i] === BLOCKED);
    }
  }

  /** Whether square (ix, iz) is out of the wood, judged once per goalEvery-square block at its middle. */
  private isGoal(ix: number, iz: number, ox: number, oz: number): boolean {
    const W = WOODS;
    const n = this.size;
    const bx = Math.min(n - 1, Math.floor(ix / W.goalEvery) * W.goalEvery + (W.goalEvery >> 1));
    const bz = Math.min(n - 1, Math.floor(iz / W.goalEvery) * W.goalEvery + (W.goalEvery >> 1));
    const b = bz * n + bx;
    if (this.goals[b] === 0) this.goals[b] = this.goal((ox + bx) * W.cell, (oz + bz) * W.cell) ? 1 : 2;
    return this.goals[b] === 1;
  }
}

/** A binary min-heap of grid indices keyed by cost (duplicates allowed: stale entries are skipped by the search). */
class MinHeap {
  private items = new Int32Array(1024);
  private keys = new Float32Array(1024);
  size = 0;
  /** The key of the item pop returned last. */
  lastKey = 0;

  clear(): void {
    this.size = 0;
  }

  push(item: number, key: number): void {
    if (this.size === this.items.length) {
      const items = new Int32Array(this.size * 2);
      const keys = new Float32Array(this.size * 2);
      items.set(this.items);
      keys.set(this.keys);
      this.items = items;
      this.keys = keys;
    }
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.items[i] = this.items[parent];
      this.keys[i] = this.keys[parent];
      i = parent;
    }
    this.items[i] = item;
    this.keys[i] = key;
  }

  pop(): number {
    const top = this.items[0];
    this.lastKey = this.keys[0];
    const item = this.items[--this.size];
    const key = this.keys[this.size];
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= this.size) break;
      if (child + 1 < this.size && this.keys[child + 1] < this.keys[child]) child++;
      if (this.keys[child] >= key) break;
      this.items[i] = this.items[child];
      this.keys[i] = this.keys[child];
      i = child;
    }
    this.items[i] = item;
    this.keys[i] = key;
    return top;
  }
}
