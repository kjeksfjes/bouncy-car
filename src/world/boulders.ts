import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { PHYSICS_STEP } from '../constants';
import type { Debris } from './debris';
import { ROCKS, type BeddedRock } from './details';
import type { BedGround } from './imprints';
import type { Terrain } from './terrain';
import type { TerrainField } from './terrainField';

/** A boulder that broke loose this step, to set moving once the cars have read their contacts. */
interface Breakout {
  bed: BeddedRock;
  hitter: RAPIER.RigidBody;
  /** The impulse the fixed boulder gave the hitter (N·s), and its direction from hitter to rock. */
  impulse: number;
  dir: THREE.Vector3;
}

/** Rocks heard striking each other and the ground. Feel values. */
const SOUND = {
  /** Closing speed (m/s) between a loose rock and what it hits from which it's heard, and at which it's at full strength. */
  from: 0.6,
  full: 5,
  /** Physics steps between two strikes heard from the same rock. */
  gapSteps: 5,
  /** Loose rocks tracked before the ones gone from the world are dropped. */
  prune: 200,
};

/** What Boulders plays: GameAudio. */
export interface RockSounds {
  rockKnock(at: THREE.Vector3, size: number): void;
  rockHit(at: THREE.Vector3, k: number, size: number, stone: boolean): void;
}

/** A loose rock, heard when it strikes something (see SOUND). */
interface LooseRock {
  size: number;
  /** The physics step it was last heard on. */
  heard: number;
}

const _f = new THREE.Vector3();
const _v = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Boulders sit fixed in their beds until a hit is hard enough for their weight (ROCKS.breakout):
 * then they carry on as loose rocks (Debris), leaving their imprint in the ground (Terrain.imprint).
 * A varde's stones lie loose on each other: a knock on any one of them brings the lot down, the rest
 * coming loose where they stand to topple as they will (no imprint: they stood on the ground).
 *
 * A boulder can only tell it was hit after the physics step has already treated it as fixed, so
 * the hitter bounced off as if from the ground. On breaking out, the impulse J is shared as in a
 * collision with a free rock instead: the rock (mass M) takes J × M / (m + M) and moves off at
 * J / (m + M), the hitter (mass m) gets the rest back, and the cars feel the impact scaled by
 * M / (m + M) too (see `contact`): a small stone barely slows the car, a big one nearly stops it.
 * A one-step approximation: restitution and where the hit landed are left out.
 */
export class Boulders {
  private readonly pending = new Map<number, Breakout>();
  /** Loose rocks by collider handle (handles of removed colliders never come back: see SOUND.prune). */
  private readonly loose = new Map<number, LooseRock>();
  private steps = 0;

  /**
   * @param onLoose called with the bed's middle, the rock's velocity and its radius as it breaks
   *   out, and what it lay bedded in
   */
  constructor(
    private readonly world: RAPIER.World,
    private readonly scene: THREE.Scene,
    private readonly field: TerrainField,
    private readonly terrain: Terrain,
    private readonly debris: Debris,
    private readonly onLoose: (at: THREE.Vector3, velocity: THREE.Vector3, radius: number, ground: BedGround) => void,
    private readonly sounds: RockSounds,
  ) {}

  /**
   * Reads a contact-force event: if it's a hit on a bedded boulder hard enough to break it out,
   * queues that (see afterStep). Returns the force the hitter should take as its impact: all of
   * it from a boulder that holds, its share in a collision with a free rock from one that doesn't.
   */
  contact(event: RAPIER.TempContactForceEvent): number {
    const force = event.totalForceMagnitude();
    const h1 = event.collider1();
    const h2 = event.collider2();
    this.listen(h1, h2);
    const details = this.terrain.details;
    const bed = details.beddedRock(h1) ?? details.beddedRock(h2);
    if (!bed) return force;
    const hitter = this.world.getCollider(bed.collider.handle === h1 ? h2 : h1)?.parent();
    if (!hitter || !hitter.isDynamic()) return force;
    const impulse = force * PHYSICS_STEP;
    if (impulse < bed.mass * bed.breakout) return force;

    // Push direction: the force between them, turned to point from the hitter at the rock.
    const t = event.totalForce();
    const at = hitter.translation();
    const rock = bed.rock;
    _f.set(t.x, t.y, t.z);
    _v.set(rock.x - at.x, rock.y + rock.sy * 0.5 - at.y, rock.z - at.z);
    if (_f.lengthSq() < 1e-9) _f.copy(_v);
    if (_f.dot(_v) < 0) _f.negate();
    const prev = this.pending.get(bed.collider.handle);
    if (!prev || prev.impulse < impulse) this.pending.set(bed.collider.handle, { bed, hitter, impulse, dir: _f.clone().normalize() });
    const m = hitter.mass();
    return (force * bed.mass) / (m + bed.mass);
  }

  /** Sets this step's broken-out boulders moving. Call after the cars' afterStep (they read the fixed colliders' contacts). */
  afterStep(): void {
    this.steps++;
    const left: { bed: BeddedRock; ground: BedGround }[] = [];
    const details = this.terrain.details;
    for (const { bed, hitter, impulse, dir } of this.pending.values()) {
      // Already loose: another stone of its varde came loose this step and took it along.
      if (details.beddedRock(bed.collider.handle) !== bed) continue;
      const rock = bed.rock;
      const m = hitter.mass();
      const M = bed.mass;
      const velocity = dir.clone().multiplyScalar(impulse / (m + M));
      const spin = new THREE.Vector3().crossVectors(UP, dir).multiplyScalar(velocity.length() / Math.max(0.3, rock.sy));
      this.loosen(bed, velocity, spin);
      this.sounds.rockKnock(new THREE.Vector3(rock.x, rock.y + rock.sy, rock.z), rock.radius);
      // The hitter bounced off as if from a fixed rock: give back what a free one wouldn't have taken.
      hitter.applyImpulse(_v.copy(dir).multiplyScalar((impulse * m) / (m + M)), true);

      if (bed.varde) {
        // The rest of the varde comes loose where it stands, to topple as the stones will. Stacked
        // on the ground rather than bedded in it, it leaves no hollow.
        for (const stone of bed.varde.stones) if (details.beddedRock(stone.collider.handle) === stone) this.loosen(stone, new THREE.Vector3(), new THREE.Vector3());
        this.onLoose(new THREE.Vector3(rock.x, rock.y, rock.z), velocity, rock.radius, 'rock');
        continue;
      }

      // In the snow the hollow goes down to the earth under it; bare ground is rock or grass.
      // The environment its placement read (see RockLayout), so the ground kind matches.
      const env = this.field.environment.atNode(rock.x, rock.z);
      const bedGround: BedGround = rock.snowy ? 'soil' : this.field.biome.isRock(rock.x, rock.z, env) ? 'rock' : 'grass';
      left.push({ bed, ground: bedGround });
      this.onLoose(new THREE.Vector3(rock.x, this.field.height(rock.x, rock.z), rock.z), velocity, rock.radius, bedGround);
    }
    this.pending.clear();
    // Only now, with every boulder of this step out of its chunk: the imprint rebuilds the chunks
    // there, which takes the colliders of the boulders still bedded in them.
    for (const { bed, ground } of left) this.terrain.imprint(bed.rock, bed.shape, ground);
  }

  /** Takes a bedded rock out of its chunk and sets it going as loose debris, from exactly where it lay. */
  private loosen(bed: BeddedRock, velocity: THREE.Vector3, spin: THREE.Vector3): void {
    const rock = bed.rock;
    this.terrain.details.release(bed);
    // A hair up, off the imprint's sampled faces: the ground gets its imprint before the next step
    // (see afterStep), so a boulder starts in its own hollow.
    const mesh = new THREE.Mesh((rock.snowy ? bed.shape.snowy : bed.shape.geometry).clone(), this.terrain.details.rockMaterial);
    mesh.position.set(rock.x, rock.y + 0.03, rock.z);
    mesh.quaternion.setFromAxisAngle(UP, rock.yaw);
    mesh.scale.set(rock.sx, rock.sy, rock.sz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.updateMatrix();
    this.scene.add(mesh);
    // Debris bodies take their pose from the object; the hull is scaled into its own frame.
    const points = new Float32Array(bed.shape.hull.length);
    for (let i = 0; i < points.length; i += 3) {
      points[i] = bed.shape.hull[i] * rock.sx;
      points[i + 1] = bed.shape.hull[i + 1] * rock.sy;
      points[i + 2] = bed.shape.hull[i + 2] * rock.sz;
    }
    const desc = RAPIER.ColliderDesc.convexHull(points);
    if (!desc) throw new Error(`Loose rock at (${rock.x.toFixed(1)}, ${rock.z.toFixed(1)}) has no convex hull`);
    // Mesh scale stays on the object (Debris draws it); the collider already carries it. It reports
    // its strikes (see listen) from a force a little under its own weight's worth of a hit.
    desc.setDensity(ROCKS.density).setFriction(0.8).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold((bed.mass * SOUND.from) / PHYSICS_STEP);
    const body = this.debris.spawn(mesh, [desc], velocity, spin);
    this.loose.set(body.collider(0).handle, { size: rock.radius, heard: -Infinity });
    if (this.loose.size > SOUND.prune) for (const h of this.loose.keys()) if (!this.world.getCollider(h)) this.loose.delete(h);
  }

  /**
   * Plays a loose rock's strike on another rock (a clack) or on the ground (a thud). Only real
   * strikes, bodies closing on each other: a heap resting on itself presses hard but makes no sound.
   * Cars and car parts make their own.
   */
  private listen(h1: number, h2: number): void {
    const a = this.loose.get(h1);
    const b = this.loose.get(h2);
    if (!a && !b) return;
    const c1 = this.world.getCollider(h1);
    const c2 = this.world.getCollider(h2);
    const b1 = c1?.parent();
    const b2 = c2?.parent();
    if (!b1 || !b2) return;
    const rocks = [a, b].filter((r): r is LooseRock => r !== undefined);
    if (rocks.some((r) => this.steps - r.heard < SOUND.gapSteps)) return;
    // What a loose rock struck: another rock (loose or bedded), the ground, or a car (silent here).
    const otherIsRock = (a && b) || this.terrain.details.beddedRock(a ? h2 : h1) !== undefined;
    const other = a ? b2 : b1;
    if (!otherIsRock && other.isDynamic()) return;
    const v1 = b1.linvel();
    const v2 = b2.linvel();
    const closing = Math.hypot(v1.x - v2.x, v1.y - v2.y, v1.z - v2.z);
    if (closing < SOUND.from) return;
    for (const r of rocks) r.heard = this.steps;
    const at = (a ? b1 : b2).translation();
    const k = THREE.MathUtils.clamp((closing - SOUND.from) / (SOUND.full - SOUND.from), 0, 1);
    this.sounds.rockHit(new THREE.Vector3(at.x, at.y, at.z), k, Math.min(...rocks.map((r) => r.size)), !!otherIsRock);
  }
}
