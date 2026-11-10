import { createNoise3D } from 'simplex-noise';
import * as THREE from 'three';
import { sample, type CarBlueprint } from './blueprint';
import type { CarPiece } from './carModel';

/** Crumple-zone feel values (part of the car's damage config). */
export interface CrushTuning {
  /** Crush depth (m) per m/s of Δv over toughness, for a hit straight on. */
  crushPerDv: number;
  /** Most the nose and tail can be pushed in (m); also capped so the body never folds through itself. */
  crushMaxFront: number;
  crushMaxRear: number;
  /** How wide (m, Gaussian σ) a hit spreads across the car: trees punch a notch, walls, ground and cars push wide. */
  crushSpreadTree: number;
  crushSpreadWide: number;
  /** Trees concentrate the force into a deeper notch. */
  crushTreeFactor: number;
  /**
   * How much the body wraps round a notch. The skin can't stretch: where the crush slopes across
   * the car, each span between crush columns keeps its length, which draws everything outside
   * the deepest point in toward it (corners, headlights, bumper ends). 1 = a skin that bends
   * smoothly along the crush profile between the columns; a real skin kinks at the notch, which
   * takes up more of its width, so more than 1 (see WRAP_FOLD_MAX for the limit).
   */
  crushWrap: number;
  /** Hood/trunk lid tenting up at the crease, in metres per metre of the tent (see crushFoldSpread). */
  crushFold: number;
  /**
   * How much (0..1) of its ideal bow a fender takes. The accordion shortens the fender between
   * the tip and the wheel arch, and a strip of length L shortened by δ bows out by ≈ (2/π)·√(L·δ)
   * (its first buckling mode); real panels wrinkle instead of bowing cleanly, so less than all.
   */
  crushBuckle: number;
  /**
   * How far across the car (m, Gaussian σ) the hood or trunk lid tents from where it's pushed in
   * deepest: a stiff panel buckles up as a ridge across its width, even over a narrow tree notch.
   */
  crushFoldSpread: number;
  /** Crumple wrinkles: amplitude per metre of local crush, and their size (m). */
  crushWrinkle: number;
  crushWrinkleSize: number;
  /** Most the roof can be pushed down toward the beltline (m). */
  roofCrushMax: number;
  /** Sideways lean of the roof (m) per metre of crush from a hit on its corner. */
  roofLean: number;
  /** Pillars bowing outward at mid-height, per metre of roof crush. */
  roofBuckle: number;
}

export type CrushEnd = 'front' | 'rear';

interface Zone {
  /** −1 = front (−Z), +1 = rear. */
  sign: -1 | 1;
  /** Z of the nose/tail tip and of the bulkhead where crushing stops. */
  tip: number;
  length: number;
  max: number;
  /** Where along the zone (0 = tip, 1 = bulkhead) the nearest wheel arch begins. */
  arch: number;
  /** Crush depth (m) per column across the car's width. */
  columns: Float32Array;
  /** Sideways shift (m, signed along x) per column from the body wrapping round the deepest column (see updatePull). */
  pull: Float32Array;
}

/** The roof: how far it's pushed down per column across the width, and its sideways lean. */
interface Roof {
  columns: Float32Array;
  max: number;
  /** Sideways shift of the roof line (m, car-local x). */
  lean: number;
  /** Z range of the greenhouse. */
  from: number;
  to: number;
}

/** A point counts as cabin (greenhouse) once it's this far above the beltline (m). */
const ABOVE_BELTLINE = 0.05;

/** Columns across the car's width the crush depth is tracked in. */
const COLUMNS = 9;
/**
 * Crush falls off from tip to bulkhead as (1 − t)^FALLOFF: the tip takes the most and the
 * cabin end none. Steeper than linear, so the outer part crumples while the bulkhead stays put.
 */
const FALLOFF = 1.5;
/** Fold crease position along the zone (0 = tip, 1 = bulkhead) and where the fold dies out. */
const CREASE = 0.35;
const FOLD_END = 0.8;
/**
 * The body would fold through itself where the displacement's slope along Z reaches 1
 * (crush × FALLOFF / length); stay well short of that.
 */
const MAX_STRAIN = 0.8;
/**
 * Wrapping round a notch can draw a span between two crush columns in to this fraction of its
 * width at most: narrower and the columns can't tell the shape apart from the panel folded
 * over itself.
 */
const WRAP_FOLD_MAX = 0.5;

const _p = new THREE.Vector3();
const _shift = new THREE.Vector3();

/**
 * Front and rear crumple zones. Each end tracks how far it has been pushed in, per
 * column across the width, and deforms every closed piece by a pure function of its
 * rest position: an accordion compression along the length, the hood or trunk lid
 * tenting up at a crease, fenders bowing out, and noise wrinkles. Because the shape
 * only depends on rest positions, pieces that meet stay together.
 */
export class Crush {
  private readonly zones: Record<CrushEnd, Zone>;
  private readonly roof: Roof;
  private readonly halfWidth: number;
  /** Distance (m) between neighbouring crush columns. */
  private readonly columnGap: number;
  private readonly noise = [createNoise3D(), createNoise3D(), createNoise3D()];
  /** Per piece: indices of the vertices inside a crumple zone (computed on first use). */
  private readonly affected = new Map<CarPiece, Uint32Array>();
  private readonly everyVertex = new Map<CarPiece, Uint32Array>();

  constructor(
    private readonly bp: CarBlueprint,
    private readonly tuning: CrushTuning,
  ) {
    const gh = bp.greenhouse;
    // Crumple zones end at the cabin's bulkheads: firewall at the front, rear-seat wall at the back.
    const firewall = gh.roof[0][0];
    const rearWall = gh.roof[gh.roof.length - 1][0];
    const zone = (sign: -1 | 1, tip: number, end: number, max: number): Zone => {
      const length = Math.abs(end - tip);
      // The wheel arch nearest this end: the fender between tip and arch is the strip that bows out.
      const edges = bp.arches.map((a) => (sign < 0 ? a.z - a.radius : a.z + a.radius));
      const archZ = sign < 0 ? Math.min(...edges) : Math.max(...edges);
      return {
        sign, tip, length,
        max: Math.min(max, (MAX_STRAIN * length) / FALLOFF),
        arch: THREE.MathUtils.clamp(Math.abs(archZ - tip) / length, 0.1, 1),
        columns: new Float32Array(COLUMNS),
        pull: new Float32Array(COLUMNS),
      };
    };
    this.zones = {
      front: zone(-1, bp.front, firewall, tuning.crushMaxFront),
      rear: zone(1, bp.rear, rearWall, tuning.crushMaxRear),
    };
    this.halfWidth = Math.max(...bp.halfWidth.map(([, w]) => w));
    this.columnGap = (2 * this.halfWidth) / (COLUMNS - 1);
    this.roof = { columns: new Float32Array(COLUMNS), max: tuning.roofCrushMax, lean: 0, from: firewall, to: rearWall };
  }

  /** True for car-local points on the cabin above the beltline (where the roof crush applies). */
  inRoof(p: THREE.Vector3): boolean {
    return p.z > this.roof.from && p.z < this.roof.to && p.y > this.deckY(p.z) + ABOVE_BELTLINE;
  }

  /**
   * Pushes the roof down around car-local `x`. `amount` is Δv over toughness (m/s), already
   * scaled by how squarely the hit lands from above; `sideways` (−1..1) leans the roof that way.
   */
  hitRoof(x: number, amount: number, sideways: number): void {
    const T = this.tuning;
    const R = this.roof;
    const depth = amount * T.crushPerDv;
    for (let i = 0; i < COLUMNS; i++) {
      const dx = this.columnX(i) - x;
      R.columns[i] = Math.min(R.max, R.columns[i] + depth * Math.exp((-dx * dx) / (2 * T.crushSpreadWide * T.crushSpreadWide)));
    }
    R.lean = THREE.MathUtils.clamp(R.lean + sideways * depth * T.roofLean, -R.max, R.max);
  }

  /** How far (m) the roof has been pushed down at its deepest. */
  roofDepth(): number {
    return Math.max(...this.roof.columns);
  }

  /** Which zone a car-local point lies in, if any. */
  zoneAt(z: number): CrushEnd | null {
    if (this.inward(this.zones.front, z) < this.zones.front.length) return 'front';
    if (this.inward(this.zones.rear, z) < this.zones.rear.length) return 'rear';
    return null;
  }

  /** How far (m) an end's tip has moved in at car-local `x`. */
  tipDepth(end: CrushEnd, x: number): number {
    return this.crushAt(this.zones[end], x);
  }

  /** Deepest crush (m) at an end: how far its tip has moved in. */
  depth(end: CrushEnd): number {
    return Math.max(...this.zones[end].columns);
  }

  /**
   * Pushes an end in around car-local `x`. `amount` is Δv over toughness (m/s), already
   * scaled by how squarely the hit lands on the end.
   */
  hit(end: CrushEnd, x: number, amount: number, tree: boolean): void {
    const T = this.tuning;
    const zone = this.zones[end];
    const depth = amount * T.crushPerDv * (tree ? T.crushTreeFactor : 1);
    const spread = tree ? T.crushSpreadTree : T.crushSpreadWide;
    for (let i = 0; i < COLUMNS; i++) {
      const dx = this.columnX(i) - x;
      const add = depth * Math.exp((-dx * dx) / (2 * spread * spread));
      zone.columns[i] = Math.min(zone.max, zone.columns[i] + add);
    }
    this.updatePull(zone);
  }

  /**
   * How far the body is drawn sideways toward the deepest column, per column: the skin can't
   * stretch, so a span between two columns that's pushed in more at one end than the other
   * keeps its length and gets shorter across the car (by crushWrap times what the smooth
   * profile alone implies). The deepest column stays where it is (pinned by what hit it); the
   * pull adds up from there outward on either side.
   */
  private updatePull(zone: Zone): void {
    const c = zone.columns;
    const gap = this.columnGap;
    let deepest = 0;
    for (let i = 1; i < COLUMNS; i++) if (c[i] > c[deepest]) deepest = i;
    const shortening = (i: number, j: number) =>
      Math.min(WRAP_FOLD_MAX * gap, this.tuning.crushWrap * (gap - Math.sqrt(Math.max(0, gap * gap - (c[i] - c[j]) ** 2))));
    zone.pull[deepest] = 0;
    for (let i = deepest + 1; i < COLUMNS; i++) zone.pull[i] = zone.pull[i - 1] - shortening(i, i - 1);
    for (let i = deepest - 1; i >= 0; i--) zone.pull[i] = zone.pull[i + 1] + shortening(i, i + 1);
  }

  /**
   * Reshapes every closed body piece to the current crush. Dents made so far ride along:
   * each piece's `base` (rest shape after crush) moves, and the dent offset on top is kept.
   * @param loose hinged panels that broke loose in this same crash: they're still being pushed
   *   in with the body around them, so they take the crush too (in their own frame, as if still
   *   closed), instead of keeping the shape they had when they broke loose
   */
  deform(pieces: readonly CarPiece[], root: THREE.Object3D, loose: { has(piece: CarPiece): boolean } = new Set()): void {
    for (const piece of pieces) {
      // Glass panes crack instead; pieces parented to another piece aren't in car-local space.
      if (piece.glass) continue;
      const onCar = piece.state === 'closed' && piece.mesh.parent === root;
      if (!onCar && !(piece.state === 'hinged' && loose.has(piece))) continue;
      const pos = piece.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const o = piece.origin;
      const rest = piece.original;
      const base = piece.base;
      // A rigid piece moves as a whole, by the displacement at its origin; the rest crumples.
      const shift = piece.rigid ? this.displace(_shift.copy(o)).sub(o) : null;
      const indices = shift ? this.allVertices(piece) : this.affectedVertices(piece);
      if (indices.length === 0) continue;
      for (const i of indices) {
        const k = i * 3;
        if (shift) _p.set(rest[k], rest[k + 1], rest[k + 2]).add(shift);
        else this.displace(_p.set(rest[k] + o.x, rest[k + 1] + o.y, rest[k + 2] + o.z)).sub(o);
        pos.setXYZ(i, _p.x + pos.getX(i) - base[k], _p.y + pos.getY(i) - base[k + 1], _p.z + pos.getZ(i) - base[k + 2]);
        base[k] = _p.x;
        base[k + 1] = _p.y;
        base[k + 2] = _p.z;
      }
      pos.needsUpdate = true;
      // The fold can lift past the build-time bounds; stale bounds get the piece culled at screen edges.
      piece.mesh.geometry.computeBoundingSphere();
    }
  }

  /** Moves a car-local rest position to its crushed place (in place). */
  displace(p: THREE.Vector3): THREE.Vector3 {
    const T = this.tuning;
    const bp = this.bp;
    for (const zone of [this.zones.front, this.zones.rear]) {
      const t = Math.max(0, this.inward(zone, p.z)) / zone.length;
      if (t >= 1) continue;
      const crush = this.crushAt(zone, p.x);
      // The panel tents up over its width, from the crush nearby (not just here).
      const tent = this.tentAt(zone, p.x);
      if (crush <= 0 && tent <= 0) continue;

      // Where this point sits on the body: 0 at the rocker, 1 at the deck; 0 at the centre line, 1 at the side.
      const rocker = sample(bp.rocker, p.z) + bp.groundY;
      const deck = sample(bp.deck, p.z) + bp.groundY;
      const height = (p.y - rocker) / Math.max(0.05, deck - rocker);
      const side = Math.abs(p.x) / Math.max(0.05, sample(bp.halfWidth, p.z));
      const up = THREE.MathUtils.smoothstep(height, 0.55, 0.95);
      const out = THREE.MathUtils.smoothstep(side, 0.6, 0.95);
      // Fold: zero at the tip, peaking at the crease, gone by FOLD_END.
      const fold = t < CREASE ? t / CREASE : Math.max(0, 1 - (t - CREASE) / (FOLD_END - CREASE));
      // Fender bow: the strip from the tip to the wheel arch, shortened by the accordion over its
      // length, bows out as a half sine between its ends (see crushBuckle).
      const arch = zone.arch;
      const shortened = crush * (1 - (1 - arch) ** FALLOFF);
      const bow = t < arch ? (2 / Math.PI) * Math.sqrt(arch * zone.length * shortened) * Math.sin((Math.PI * t) / arch) : 0;

      const s = 1 / T.crushWrinkleSize;
      const wrinkle = T.crushWrinkle * crush * (1 - t);
      const nx = this.noise[0](p.x * s, p.y * s, p.z * s);
      const ny = this.noise[1](p.x * s, p.y * s, p.z * s);
      const nz = this.noise[2](p.x * s, p.y * s, p.z * s);

      // Wrapping round the notch: drawn toward the deepest column, gone by the wheel arch (the
      // fender stays off the wheel; behind the arch the body is held by the frame anyway).
      const wrap = this.sampleColumns(zone.pull, p.x) * Math.max(0, 1 - t / arch);
      p.z -= zone.sign * crush * (1 - t) ** FALLOFF;
      p.y += T.crushFold * tent * fold * up + ny * wrinkle;
      p.x += wrap + Math.sign(p.x) * T.crushBuckle * bow * out * (1 - up * 0.5) + nx * wrinkle;
      p.z += nz * wrinkle;
    }

    // Roof: everything above the beltline sinks in proportion to its height over it (the roof
    // the most, the beltline not at all), leans sideways, and the pillars bow out at mid-height.
    const R = this.roof;
    if (p.z > R.from && p.z < R.to) {
      const deck = this.deckY(p.z);
      if (p.y > deck) {
        const roof = Math.max(deck + ABOVE_BELTLINE, sample(bp.greenhouse.roof, p.z) + bp.crown + bp.groundY);
        const h = Math.min(1, (p.y - deck) / (roof - deck));
        const crush = this.crushAt(R, p.x);
        if (crush > 0 || R.lean !== 0) {
          const s = 1 / T.crushWrinkleSize;
          const wrinkle = T.crushWrinkle * crush * h;
          p.y += -crush * h + this.noise[1](p.x * s, p.y * s, p.z * s) * wrinkle;
          p.x += R.lean * h + Math.sign(p.x) * T.roofBuckle * crush * Math.sin(Math.PI * h) + this.noise[0](p.x * s, p.y * s, p.z * s) * wrinkle;
        }
      }
    }
    return p;
  }

  /** Car-local height of the beltline (deck) at `z`. */
  private deckY(z: number): number {
    return sample(this.bp.deck, z) + this.bp.groundY;
  }

  /** Distance (m) from a zone's tip toward the cabin; negative beyond the tip (bumper overhang). */
  private inward(zone: Zone, z: number): number {
    return zone.sign < 0 ? z - zone.tip : zone.tip - z;
  }

  private columnX(i: number): number {
    return -this.halfWidth + (2 * this.halfWidth * i) / (COLUMNS - 1);
  }

  /** Crush depth at car-local `x`, interpolated between columns (clamped at the sides). */
  private crushAt(zone: { columns: Float32Array }, x: number): number {
    return this.sampleColumns(zone.columns, x);
  }

  /** A per-column value at car-local `x`, interpolated between columns (clamped at the sides). */
  private sampleColumns(values: Float32Array, x: number): number {
    const f = THREE.MathUtils.clamp(((x + this.halfWidth) / (2 * this.halfWidth)) * (COLUMNS - 1), 0, COLUMNS - 1);
    const i = Math.min(COLUMNS - 2, Math.floor(f));
    return THREE.MathUtils.lerp(values[i], values[i + 1], f - i);
  }

  /**
   * How far the hood or trunk lid tents at car-local `x`: the deepest crush of any column, falling
   * off with its distance across the car (crushFoldSpread). Never below the crush right here, and
   * as high as the deepest crush at its own column, so it widens the tent without lowering it.
   */
  private tentAt(zone: Zone, x: number): number {
    const spread = this.tuning.crushFoldSpread;
    let tent = this.crushAt(zone, x);
    for (let i = 0; i < COLUMNS; i++) {
      const dx = this.columnX(i) - x;
      tent = Math.max(tent, zone.columns[i] * Math.exp((-dx * dx) / (2 * spread * spread)));
    }
    return tent;
  }

  /** Every vertex of a piece, by index (for a rigid piece, which moves as a whole). */
  private allVertices(piece: CarPiece): Uint32Array {
    let indices = this.everyVertex.get(piece);
    if (!indices) this.everyVertex.set(piece, (indices = Uint32Array.from({ length: piece.original.length / 3 }, (_, i) => i)));
    return indices;
  }

  private affectedVertices(piece: CarPiece): Uint32Array {
    let indices = this.affected.get(piece);
    if (!indices) {
      const list: number[] = [];
      const rest = piece.original;
      const o = piece.origin;
      const R = this.roof;
      for (let i = 0; i < rest.length / 3; i++) {
        const z = rest[i * 3 + 2] + o.z;
        const y = rest[i * 3 + 1] + o.y;
        if (this.zoneAt(z) || (z > R.from && z < R.to && y > this.deckY(z))) list.push(i);
      }
      this.affected.set(piece, (indices = Uint32Array.from(list)));
    }
    return indices;
  }
}
