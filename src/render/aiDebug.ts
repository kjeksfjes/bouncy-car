import * as THREE from 'three';
import type { AiDebug } from '../vehicle/aiDriver';
import type { PathPoint } from '../vehicle/woodsPath';

/**
 * Looks of the autopilot's debug view (Shift+P), drawn as flat strips on the ground.
 * - The headings it tries each frame: a strip each, as far as it runs clear (`clear`, or `blocked`
 *   where a tree stops it), `fanWidth` m wide; the one it goes for in `chosen`.
 * - The long-range route: `route`, `routeLength` m out.
 * - The woods planner: the squares it looked at (open ones as faint `free` dots, `freeSize` m
 *   across; ones a trunk blocks as `wall` squares, `wallSize` m), the path (`path`, `pathWidth` m
 *   wide) and where it ends (a `goalSize` m square).
 * - The cairn it's going for: a `cairn` ring; cars pulling it toward them: `pull` rings (pushing
 *   it off: `push`), `ring` m round, thicker the harder they pull.
 * - Over the car: what mainly sets the way it's going (AiDebug.reason), `labelHeight` m up. In the
 *   map view, which looks straight down, it hangs under the car on screen instead, `labelGap` label
 *   heights below a box `carBox` m round it (half width, half height, half length).
 * Everything sits `lift` m over the ground and is sampled every `step` m along a strip.
 */
const LOOK = {
  fanWidth: 0.15,
  clear: new THREE.Color(0xffe14d),
  blocked: new THREE.Color(0xff4b2b),
  chosen: new THREE.Color(0x1f6fff),
  chosenWidth: 0.45,
  route: new THREE.Color(0x1f6fff),
  routeLength: 60,
  routeWidth: 0.8,
  free: { colour: 0xffffff, size: 0.35, opacity: 0.35 },
  wall: { colour: 0xff2d2d, size: 0.9, opacity: 0.8 },
  path: new THREE.Color(0x1f6fff),
  pathWidth: 0.7,
  goalSize: 2.4,
  cairn: new THREE.Color(0xd946ef),
  pull: new THREE.Color(0x1f6fff),
  push: new THREE.Color(0xff4b2b),
  ring: 3.2,
  labelHeight: 3.2,
  labelGap: 0.1,
  carBox: [1, 0.8, 2.4],
  lift: 0.25,
  step: 2,
  opacity: 0.85,
  maxSquares: 9000,
};

/** Strips and squares over the ground showing what the autopilot weighs (see AiDebug). */
export class AiDebugView {
  private readonly strips = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: LOOK.opacity, depthWrite: false, side: THREE.DoubleSide }),
  );
  /** The planner's squares: open, and blocked by a trunk. */
  private readonly free: THREE.InstancedMesh;
  private readonly wall: THREE.InstancedMesh;
  private plans = -1;
  private readonly label: THREE.Sprite;
  private readonly labelCanvas = document.createElement('canvas');
  private labelText = '';
  private readonly corner = new THREE.Vector3();
  private readonly positions: number[] = [];
  private readonly colours: number[] = [];

  constructor(
    scene: THREE.Scene,
    private readonly heightAt: (x: number, z: number) => number,
  ) {
    this.strips.frustumCulled = false;
    this.strips.renderOrder = 11;
    const squares = ({ colour, size, opacity }: { colour: number; size: number; opacity: number }) => {
      const mesh = new THREE.InstancedMesh(
        new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity, depthWrite: false }),
        LOOK.maxSquares,
      );
      mesh.frustumCulled = false;
      mesh.renderOrder = 10;
      mesh.count = 0;
      return mesh;
    };
    this.free = squares(LOOK.free);
    this.wall = squares(LOOK.wall);
    this.labelCanvas.width = 512;
    this.labelCanvas.height = 64;
    this.label = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(this.labelCanvas), depthTest: false, sizeAttenuation: false, transparent: true }),
    );
    this.label.scale.set(0.48, 0.06, 1);
    this.label.renderOrder = 12;
    this.strips.visible = this.free.visible = this.wall.visible = this.label.visible = false;
    scene.add(this.free, this.wall, this.strips, this.label);
  }

  /**
   * Draws `debug` round the car (`car`, its model's root), with the woods path it follows (if any),
   * the label under the car when `fromAbove` (the map view); null hides it all.
   */
  update(debug: AiDebug | null, path: readonly PathPoint[] | null, car: THREE.Object3D, fromAbove: boolean): void {
    this.strips.visible = this.free.visible = this.wall.visible = this.label.visible = debug !== null;
    if (!debug) return;
    const at = car.position;
    const L = LOOK;
    this.positions.length = 0;
    this.colours.length = 0;
    const ray = (yaw: number, length: number, width: number, colour: THREE.Color) => {
      const points: PathPoint[] = [];
      for (let d = 0; ; d += L.step) {
        const along = Math.min(d, length);
        points.push({ x: at.x - Math.sin(yaw) * along, z: at.z - Math.cos(yaw) * along });
        if (along >= length) break;
      }
      this.strip(points, width, colour);
    };

    if (path) {
      this.strip(path, L.pathWidth, L.path);
      const end = path[path.length - 1];
      const r = L.goalSize / 2;
      this.strip([{ x: end.x - r, z: end.z }, { x: end.x + r, z: end.z }], L.goalSize, L.path);
    } else {
      ray(debug.route, L.routeLength, L.routeWidth, L.route);
      for (const { yaw, clear } of debug.fan) ray(yaw, clear, L.fanWidth, clear < debug.look ? L.blocked : L.clear);
    }
    ray(debug.chosen, Math.min(debug.look, 12), L.chosenWidth, L.chosen);
    if (debug.cairn) this.ring(debug.cairn.x, debug.cairn.z, L.ring, 0.5, L.cairn);
    for (const c of debug.company) this.ring(c.x, c.z, L.ring, 0.1 + 0.4 * Math.abs(c.pull), c.pull > 0 ? L.pull : L.push);
    this.placeLabel(car, fromAbove);
    this.setLabel(debug.reason);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colours, 3));
    this.strips.geometry.dispose();
    this.strips.geometry = geometry;

    // The planner's squares only change with a new plan, and only show in the woods.
    if (!path) this.free.count = this.wall.count = 0;
    else if (debug.plans !== this.plans) {
      this.plans = debug.plans;
      const m = new THREE.Matrix4();
      this.free.count = this.wall.count = 0;
      for (const s of debug.squares) {
        const mesh = s.blocked ? this.wall : this.free;
        if (mesh.count >= L.maxSquares) continue;
        m.makeTranslation(s.x, this.heightAt(s.x, s.z) + L.lift * 0.6, s.z);
        mesh.setMatrixAt(mesh.count++, m);
      }
      this.free.instanceMatrix.needsUpdate = this.wall.instanceMatrix.needsUpdate = true;
    }
  }

  /** Adds a ring `radius` m round (x, z), its band `width` m wide. */
  private ring(x: number, z: number, radius: number, width: number, colour: THREE.Color): void {
    const points: PathPoint[] = [];
    for (let k = 0; k <= 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      points.push({ x: x + Math.cos(a) * radius, z: z + Math.sin(a) * radius });
    }
    this.strip(points, width, colour);
  }

  /**
   * Puts the label over the car, or, seen from straight above (−z up the screen), with its top just
   * below the box corner furthest toward +z: the car's lowest point on screen.
   */
  private placeLabel(car: THREE.Object3D, fromAbove: boolean): void {
    const label = this.label;
    if (!fromAbove) {
      label.center.set(0.5, 0.5);
      label.position.set(car.position.x, car.position.y + LOOK.labelHeight, car.position.z);
      return;
    }
    const [hx, hy, hz] = LOOK.carBox;
    car.updateMatrixWorld();
    label.position.set(car.position.x, car.position.y, -Infinity);
    for (let k = 0; k < 8; k++) {
      this.corner.set(k & 1 ? hx : -hx, k & 2 ? hy : -hy, k & 4 ? hz : -hz).applyMatrix4(car.matrixWorld);
      if (this.corner.z > label.position.z) label.position.copy(this.corner).setX(car.position.x);
    }
    label.center.set(0.5, 1 + LOOK.labelGap);
  }

  /** Writes `text` on the label over the car, as a dark pill (redrawn only when it changes). */
  private setLabel(text: string): void {
    if (text === this.labelText) return;
    this.labelText = text;
    const c = this.labelCanvas;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    g.font = '600 34px Barlow, sans-serif';
    const w = Math.min(c.width, g.measureText(text).width + 36);
    const x = (c.width - w) / 2;
    g.fillStyle = 'rgba(16, 22, 34, 0.78)';
    g.beginPath();
    g.roundRect(x, 6, w, c.height - 12, (c.height - 12) / 2);
    g.fill();
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, c.width / 2, c.height / 2 + 1);
    (this.label.material.map as THREE.Texture).needsUpdate = true;
  }

  /** Adds a flat strip `width` m wide along `points`, draped over the ground. */
  private strip(points: readonly PathPoint[], width: number, colour: THREE.Color): void {
    const L = LOOK;
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1e-4) continue;
      const nx = (-(b.z - a.z) / len) * width * 0.5;
      const nz = ((b.x - a.x) / len) * width * 0.5;
      const ya = this.heightAt(a.x, a.z) + L.lift;
      const yb = this.heightAt(b.x, b.z) + L.lift;
      const quad = [
        [a.x - nx, ya, a.z - nz],
        [a.x + nx, ya, a.z + nz],
        [b.x + nx, yb, b.z + nz],
        [a.x - nx, ya, a.z - nz],
        [b.x + nx, yb, b.z + nz],
        [b.x - nx, yb, b.z - nz],
      ];
      for (const v of quad) {
        this.positions.push(v[0], v[1], v[2]);
        this.colours.push(colour.r, colour.g, colour.b);
      }
    }
  }
}
