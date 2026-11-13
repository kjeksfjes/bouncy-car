import * as THREE from 'three';
import { IMPRINT } from '../world/imprints';

/**
 * Torn-up turf where the car gouged or slid through grass. The terrain can't be dug into cheaply,
 * so a scar is cut the other way round: its soil floor lies on the ground, and the turf round it is
 * pushed up into a lip (coloured like the grass there) with a dark soil wall facing in, so the
 * floor sits below the grass beside it. Feel values.
 */
export const SCARS = {
  /** Triangles kept; past this the oldest scars go first (a ring). */
  capacity: 30000,
  /** How far above the ground (m) the floor lies, on top of a little polygon offset. */
  lift: 0.015,
  /** A streak's segments (m): short enough to follow the ground's 2 m faces closely. */
  segment: 0.3,
  /** A streak that jumps further than this (m) between calls starts again instead of bridging the gap. */
  gap: 2,
  /** How ragged a scar's edge is (share of its width or radius, ±). */
  ragged: 0.3,
  /**
   * A gouge's outline: on top of the ragged edge, up to `lopsided` one-sided bulge (an egg or a
   * kidney), `oval` two-sided and `lobed` three-sided waviness, each picked at random per gouge.
   */
  lopsided: 0.35,
  oval: 0.3,
  lobed: 0.25,
  gougeRagged: 0.15,
  /**
   * The turf lip: how high it stands over the floor (m) for a tyre's rut and a gouge (plus
   * `gougeDepthPerRadius` per m of radius), how far the wall leans back from the floor's edge, and
   * how far out the lip slopes down to the ground (× the scar's half-width or radius, at least `minLip` m).
   */
  rutDepth: 0.05,
  gougeDepth: 0.06,
  gougeDepthPerRadius: 0.05,
  wall: 0.03,
  lip: 0.4,
  minLip: 0.08,
};

/** One cross-section of a streak: the floor's edges, the lip tops and where the lips meet the ground, left to right. */
interface Station {
  at: THREE.Vector3;
  points: THREE.Vector3[];
  turf: THREE.Color;
}

const _dir = new THREE.Vector3();
const _side = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
const _colour = new THREE.Color();
const _turf = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Scars in the ground where the car tore up the turf: a heavy hit leaves a gouge (a hollow of
 * its own shape, stretched along the way the car was going); a slide leaves a rut behind each
 * tyre. All of it is one mesh, its triangles written into a ring so the oldest scars
 * make way for new ones.
 */
export class GroundScars {
  private readonly geometry = new THREE.BufferGeometry();
  private readonly positions: THREE.BufferAttribute;
  private readonly colours: THREE.BufferAttribute;
  private readonly normals: THREE.BufferAttribute;
  /** Next triangle to write, and how many have been written in all. */
  private next = 0;
  private written = 0;
  /** Triangles written since the last flush (from `dirtyFrom`, wrapping), to upload. */
  private dirtyFrom = 0;
  private dirty = 0;
  private readonly streaks = new WeakMap<object, Station>();

  /**
   * @param ground the drawn ground's height at (x, z) (see Terrain.surfaceHeight)
   * @param grassColour the ground's colour at (x, z), for the turf lips
   */
  constructor(
    scene: THREE.Scene,
    private readonly ground: (x: number, z: number) => number,
    private readonly grassColour: (x: number, z: number, out: THREE.Color) => THREE.Color,
  ) {
    const vertices = SCARS.capacity * 3;
    const attribute = () => new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.positions = attribute();
    this.colours = attribute();
    this.normals = attribute();
    this.geometry.setAttribute('position', this.positions);
    this.geometry.setAttribute('color', this.colours);
    this.geometry.setAttribute('normal', this.normals);
    this.geometry.setDrawRange(0, 0);
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 1,
      // A rut's open ends show the lips from inside.
      side: THREE.DoubleSide,
      // Over the ground's own faces, never flickering through them.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(this.geometry, material);
    // Scars lie all along the descent: one bounding sphere can't cover them usefully.
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  /**
   * A gouge at `at`: a ragged hollow `radius` m across, stretched `stretch` times along `along`
   * (horizontal; the way the car was going).
   */
  gouge(at: THREE.Vector3, along: THREE.Vector3, radius: number, stretch: number): void {
    const S = SCARS;
    _dir.set(along.x, 0, along.z);
    if (_dir.lengthSq() < 1e-6) _dir.set(Math.cos(Math.random() * 6.3), 0, Math.sin(Math.random() * 6.3));
    _dir.normalize();
    _side.crossVectors(UP, _dir);
    const depth = S.gougeDepth + S.gougeDepthPerRadius * radius;
    const lip = Math.max(S.minLip, radius * S.lip * 0.5);
    const turf = this.grassColour(at.x, at.z, _turf).clone();
    // Rings round the middle: the floor (two, so its triangles stay small enough to follow the
    // ground), the lip's top and where the lip meets the ground. The outline is a random mix of
    // one-, two- and three-sided waviness, ragged per spoke, so no two gouges share a shape.
    const sectors = 14;
    const spin = Math.random() * Math.PI * 2;
    const wave = [S.lopsided, S.oval, S.lobed].map((most, i) => ({ k: i + 1, size: most * Math.random(), phase: Math.random() * Math.PI * 2 }));
    const rings: THREE.Vector3[][] = [[], [], [], []];
    for (let k = 0; k < sectors; k++) {
      const angle = spin + (k / sectors) * Math.PI * 2;
      const cos = Math.cos(angle) * stretch;
      const sin = Math.sin(angle);
      let shape = 1 + (Math.random() - 0.5) * 2 * S.gougeRagged;
      for (const w of wave) shape += w.size * Math.cos(w.k * angle + w.phase);
      const r = radius * Math.max(0.35, shape);
      const point = (out: number, up: number) =>
        this.onGround(new THREE.Vector3().copy(at).addScaledVector(_dir, cos * out).addScaledVector(_side, sin * out), up);
      rings[0].push(point(r * 0.5, 0));
      rings[1].push(point(r, 0));
      rings[2].push(point(r + S.wall + lip * 0.3, depth));
      rings[3].push(point(r + S.wall + lip, -S.lift));
    }
    const middle = this.onGround(at.clone(), 0);
    for (let k = 0; k < sectors; k++) {
      const n = (k + 1) % sectors;
      this.triangle(middle, rings[0][k], rings[0][n], this.soil(0.8));
      this.quad(rings[0][k], rings[1][k], rings[1][n], rings[0][n], this.soil(0.6));
      this.quad(rings[1][k], rings[2][k], rings[2][n], rings[1][n], this.soil(1));
      this.quad(rings[2][k], rings[3][k], rings[3][n], rings[2][n], this.turf(turf));
    }
  }

  /**
   * Carries the rut `key` (a tyre) on to `at`, `width` m wide, while `tearing`; when not, the rut
   * ends there and the next one starts afresh.
   * @returns whether a new piece of rut was laid
   */
  streak(key: object, at: THREE.Vector3, along: THREE.Vector3, width: number, tearing: boolean): boolean {
    const S = SCARS;
    const last = this.streaks.get(key);
    if (!tearing) {
      if (last) this.streaks.delete(key);
      return false;
    }
    if (last && last.at.distanceTo(at) < S.segment) return false;
    _dir.set(along.x, 0, along.z);
    if (_dir.lengthSq() < 1e-6) return false;
    _dir.normalize();
    _side.crossVectors(UP, _dir);
    const half = (width / 2) * (1 + (Math.random() - 0.5) * S.ragged);
    const depth = S.rutDepth;
    const lip = Math.max(S.minLip, half * S.lip);
    // Left lip's foot, its top, the floor's edges, the right lip's top and foot.
    const offsets: [number, number][] = [
      [half + S.wall + lip, -S.lift],
      [half + S.wall + lip * 0.3, depth],
      [half, 0],
      [-half, 0],
      [-half - S.wall - lip * 0.3, depth],
      [-half - S.wall - lip, -S.lift],
    ];
    const station: Station = {
      at: at.clone(),
      points: offsets.map(([out, up]) => this.onGround(at.clone().addScaledVector(_side, out), up)),
      turf: this.grassColour(at.x, at.z, new THREE.Color()),
    };
    this.streaks.set(key, station);
    if (!last || last.at.distanceTo(at) > S.gap) return false;
    const [a, b, c, d, e, f] = last.points;
    const [A, B, C, D, E, F] = station.points;
    this.quad(a, b, B, A, this.turf(last.turf));
    this.quad(b, c, C, B, this.soil(1));
    this.quad(c, d, D, C, this.soil(0.5));
    this.quad(d, e, E, D, this.soil(1));
    this.quad(e, f, F, E, this.turf(last.turf));
    return true;
  }

  /** Whether the rut `key` is under way. */
  streaking(key: object): boolean {
    return this.streaks.has(key);
  }

  /** Uploads what was written since the last call. Call once a frame. */
  update(): void {
    if (this.dirty === 0) return;
    const first = this.dirtyFrom;
    const count = Math.min(this.dirty, SCARS.capacity);
    const end = first + count;
    for (const attribute of [this.positions, this.colours, this.normals]) {
      attribute.clearUpdateRanges();
      // Floats per triangle: 3 vertices × 3.
      if (end <= SCARS.capacity) attribute.addUpdateRange(first * 9, count * 9);
      else {
        attribute.addUpdateRange(first * 9, (SCARS.capacity - first) * 9);
        attribute.addUpdateRange(0, (end - SCARS.capacity) * 9);
      }
      attribute.needsUpdate = true;
    }
    this.geometry.setDrawRange(0, Math.min(this.written, SCARS.capacity) * 3);
    this.dirty = 0;
  }

  /** Puts `p` on the ground, `up` m above the floor's height. */
  private onGround(p: THREE.Vector3, up: number): THREE.Vector3 {
    p.y = this.ground(p.x, p.z) + SCARS.lift + up;
    return p;
  }

  /** A soil colour, `dark` (0..1) how likely it's the darker, damper soil from deeper down. */
  private soil(dark: number): THREE.Color {
    return _colour.copy(IMPRINT.soil).lerp(IMPRINT.soilDark, Math.random() < dark ? 0.5 + 0.5 * Math.random() : 0.3 * Math.random());
  }

  /** The grass colour, a touch darker or lighter so the lip's faces don't read as one flat sheet. */
  private turf(grass: THREE.Color): THREE.Color {
    return _colour.copy(grass).multiplyScalar(0.85 + Math.random() * 0.15);
  }

  private quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, colour: THREE.Color): void {
    this.triangle(a, b, c, colour);
    this.triangle(a, c, d, colour);
  }

  /** Writes one triangle into the ring, its normal facing up. */
  private triangle(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, colour: THREE.Color): void {
    _n.crossVectors(_a.subVectors(b, a), _b.subVectors(c, a));
    if (_n.y < 0) _n.negate();
    _n.normalize();
    const t = this.next;
    const corners = [a, b, c];
    for (let k = 0; k < 3; k++) {
      const v = t * 3 + k;
      this.positions.setXYZ(v, corners[k].x, corners[k].y, corners[k].z);
      this.colours.setXYZ(v, colour.r, colour.g, colour.b);
      this.normals.setXYZ(v, _n.x, _n.y, _n.z);
    }
    if (this.dirty === 0) this.dirtyFrom = t;
    this.dirty++;
    this.next = (t + 1) % SCARS.capacity;
    this.written++;
  }
}
