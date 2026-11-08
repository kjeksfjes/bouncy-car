import type { CarBlueprint } from './blueprint';
import type { CrushTuning } from './crush';
import type { LightTuning } from './lights';

/**
 * Data-driven car definition. All values are gameplay tuning, not real-world
 * specs: the goal is a floaty, forgiving, Driver-style ride.
 * Units: metres, kilograms, newtons, seconds, radians. Car-local frame:
 * +X right, +Y up, −Z forward.
 */
export interface CarConfig {
  name: string;
  mass: number;
  /** Centre of mass in car-local space. Lower = more stable, less roll-over. */
  centerOfMass: [number, number, number];
  /** Principal angular inertia about X (pitch), Y (yaw), Z (roll). */
  inertia: [number, number, number];

  /** Body shape and part layout; colliders are derived from it. */
  blueprint: CarBlueprint;
  look: { paint: string };

  wheels: {
    radius: number;
    width: number;
    /** Half-track: wheel centre distance from the car's centre line. */
    halfTrack: number;
    frontZ: number;
    rearZ: number;
    /** Height of the suspension top mount. */
    mountY: number;
    drive: 'rear' | 'front' | 'all';
  };

  suspension: {
    restLength: number;
    stiffness: number;
    dampCompression: number;
    dampRebound: number;
    /** Fraction of rest length where the bump stop starts. */
    bumpStopAt: number;
    bumpStopStiffness: number;
  };

  tire: {
    /** Fraction of lateral slip velocity removed per step (before the friction limit). */
    gripFront: number;
    gripRear: number;
    /** Friction coefficient: max tyre force = mu × load. */
    mu: number;
    handbrakeRearGrip: number;
    rollingResistance: number;
    /** 0 = tyre forces act at the CoM height (no roll), 1 = at the contact patch (full roll). */
    rollInfluence: number;
  };

  engine: {
    force: number;
    maxSpeed: number;
    reverseForce: number;
    reverseMaxSpeed: number;
    brakeForce: number;
    handbrakeForce: number;
  };

  steering: {
    maxAngle: number;
    /** Steering angle left at `fullSpeed`. */
    minAngle: number;
    fullSpeed: number;
    rate: number;
  };

  air: {
    /**
     * 'auto': levelling is always on and S lifts the nose.
     * 'hold': free physics in the air; holding S engages the levelling.
     */
    leveling: 'auto' | 'hold';
    /** Nose-up torque from S (only in 'auto' mode). */
    pitchTorque: number;
    rollTorque: number;
    angularDamping: number;
    /** Auto-levelling in the air: spring (1/s²) and damping (1/s) toward the flight path. */
    levelPitch: number;
    levelPitchDamping: number;
    levelRoll: number;
    levelRollDamping: number;
  };
  aeroDrag: number;

  /** Crumple zones: see CrushTuning; light fixtures: see LightTuning. */
  damage: CrushTuning & LightTuning & {
    /** Impact Δv (m/s, per physics step) the car shrugs off without a scratch. */
    toughness: number;
    /** The same for hits from above on the cabin (landing on the roof), which is much weaker. */
    roofToughness: number;
    /** Dent depth per m/s of Δv over toughness. */
    dentPerDv: number;
    maxDent: number;
    dentRadius: number;
    /** Hit points removed from a nearby part per m/s of Δv over toughness. */
    partDamagePerDv: number;
    partHp: number;
    /** Trim (grille, mirrors) knocked clean off: hit points. */
    trimHp: number;
    wheelHp: number;
    /** Wheel damage (hits near the wheel, bottoming out) that pops its hubcap off. */
    hubcapHp: number;
    /** Wheel damage from slamming into the bump stop faster than this (m/s). */
    bottomOutSpeed: number;
    /** Wheel hit points removed per m/s of bump-stop speed over `bottomOutSpeed`. */
    bottomOutDamagePerDv: number;
    /** Integrity lost per m/s of Δv over toughness. */
    integrityPerDv: number;
    /** Below this integrity the engine dies. */
    engineDeathAt: number;
    /** Glass panes: hit points, and the fraction of them left when a pane cracks. */
    glassHp: number;
    crackAt: number;
    /**
     * How far hits reach the glass grows with severity: reach × (1 + growth × severity),
     * severity capped at `glassReachCap`. Lets hard frontal crashes (bumper ≈1.8 m from the
     * windshield) crack or shatter it through the body, while light knocks don't.
     */
    glassReachGrowth: number;
    glassReachCap: number;
    /** Roof crush (m) at which the windows, which can't bend with it, all shatter. */
    roofGlassBreak: number;
    /** Below this integrity the engine steams. */
    steamBelow: number;
    /**
     * Leaks, each from its own damage and with its own tank: coolant from the radiator (hits
     * near the nose, front crush), oil from the sump (hits from below, bottoming out, a wreck).
     * Hit points as for parts; a leak runs at full rate once its damage reaches them.
     */
    radiatorHp: number;
    sumpHp: number;
    /** Share (0..1) of a leak's damage the car shrugs off before it starts leaking at all. */
    leakTolerance: number;
    /** Share of a hit from below (and of a bottomed-out wheel's damage) that reaches the sump. */
    sumpHitShare: number;
    sumpBottomOutShare: number;
    /** Front crush (m) at which the radiator leaks at full rate. */
    coolantCrushFull: number;
    /** Below this integrity the engine weeps oil anyway, more the lower it goes. */
    oilWreckBelow: number;
    /** Tank sizes (litres) and how much a drop of average size (0.15 m) takes. */
    coolantCapacity: number;
    oilCapacity: number;
    dropVolume: number;
    /** Metres driven between drops, from a slow weep to a full leak. */
    leakSpacingMax: number;
    leakSpacingMin: number;
    /** Dripping while standing still, as if driving this fast (m/s). */
    leakIdle: number;
    /** A dead, stopped car's oil puddle grows to this size (m) at this rate (m/s), draining this much oil (l/s). */
    puddleMax: number;
    puddleGrowth: number;
    puddleDrain: number;
    /** Hinged panels: see PanelTuning. */
    tearHp: number;
    tearSwingSpeed: number;
    panelAeroDrag: number;
  };
}

/**
 * 70s two-door coupe, traced from the user's orthographic reference drawing
 * (side/top/front views, ≈287 px per metre in the side view). Heights are
 * metres above the drawing's ground line.
 */
const COUPE_BLUEPRINT: CarBlueprint = {
  groundY: -0.75,
  front: -2.46,
  rear: 2.44,
  station: 0.1,
  // 2.05 m wide at the hips, as the top, front and rear views agree.
  halfWidth: [[-2.46, 0.9], [-2.36, 0.98], [-2.1, 1.02], [-1.6, 1.025], [2.1, 1.025], [2.36, 1.0], [2.44, 0.94]],
  // From the front and rear views: tucked in at the bottom (flush with the tyres' outer faces),
  // widest at the hips around headlight/taillight height, in again to the shoulder crease
  // (side view: ≈0.89 of the way up) and a rounded top edge.
  side: [[0, 0.91], [0.15, 0.94], [0.35, 0.98], [0.62, 1], [0.78, 0.99], [0.89, 0.97], [0.97, 0.955], [1, 0.92]],
  deck: [
    [-2.46, 0.845], [-2.4, 0.875], [-2.33, 0.91], [-1.6, 0.98], [-0.77, 1.04], [0, 1.03], [0.9, 1.04],
    [1.53, 1.07], [2.0, 1.05], [2.32, 1.03], [2.44, 0.985],
  ],
  // The valances come down below the bumpers to carry the plates (front and rear views): to
  // 0.31 at the nose and 0.36 at the tail, just above the exhaust tips.
  rocker: [[-2.46, 0.31], [-2.25, 0.32], [-2.0, 0.33], [2.0, 0.33], [2.3, 0.345], [2.44, 0.36]],
  crown: 0.03,
  wellHalf: 0.62,
  arches: [
    { z: -1.505, h: 0.31, radius: 0.42 },
    { z: 1.335, h: 0.31, radius: 0.42 },
  ],
  hood: [-2.33, -0.8],
  trunk: [1.56, 2.36],
  door: [-0.76, 0.64],
  greenhouse: {
    roof: [[-0.77, 1.04], [-0.3, 1.39], [-0.18, 1.44], [0.7, 1.44], [0.9, 1.4], [1.2, 1.25], [1.53, 1.07]],
    // Top view: window line at ±0.875 (outside), roof at ±0.73.
    sillHalf: 0.86,
    roofHalf: 0.72,
    windshieldTo: -0.27,
    rearGlassFrom: 0.92,
    doorGlass: [-0.7, 0.46],
    quarterGlass: [0.52, 0.86],
  },
  mirror: { z: -0.62, size: [0.1, 0.08, 0.16] },
  // Front view: the quad headlights and the barred grille sit together in one recessed surround
  // under the hood's beak; the grille's bars only span the middle, between the inner headlights.
  // The surround's corners sit ≈2 cm inside the nose panel's outline (checked at build).
  openings: {
    head: { x: [0.57, 0.765], h: 0.7, radius: 0.066 },
    surround: { h: 0.7, width: 1.72, height: 0.2, radius: 0.05 },
    // Rear view: two separate rounded taillights in the outer thirds of the tail panel, with the
    // filler cap between them and the plate below the bumper; heights placed by their share of
    // the tail panel, since that view is drawn out of proportion vertically.
    tail: { x: 0.628, h: 0.795, width: 0.565, height: 0.13, radius: 0.035 },
    // Wider than the drawing's plates, by choice.
    plates: { front: { h: 0.385, width: 0.38, height: 0.13 }, rear: { h: 0.4375, width: 0.38, height: 0.135 } },
    grille: { h: 0.7, width: 0.94, height: 0.15 },
    depth: 0.06,
  },
  hoodBulge: { from: -2.1, to: -0.95, halfWidth: 0.45, height: 0.05 },
  // Side view: the hood's leading edge is the tip (≈0.87 high, deck plus crown); under it the
  // face sweeps back ≈5.5 cm to the grille and headlights, and the valance under the bumper
  // recedes to ≈12 cm at its bottom edge. Top view: the corners sit ≈10 cm behind the centre.
  // Steepest fade (2 / blend × the largest set-back, ≈0.22 at the bottom corners) ≈0.73 < 1.
  nose: {
    profile: [[0.43, 0.12], [0.5, 0.075], [0.56, 0.055], [0.7, 0.055], [0.78, 0.045], [0.83, 0.02], [0.845, 0]],
    vee: 0.1,
    cornerX: 0.8,
    blend: 0.6,
  },
  // Side view: the tail panel leans in at the top (its top corner ≈9.5 cm ahead of the tail at
  // the bumper) and the valance under the bumper recedes a little. Straight across in plan.
  // Steepest fade ≈2 / 0.5 × 0.095 ≈ 0.38.
  tail: {
    profile: [[0.36, 0.08], [0.45, 0.04], [0.55, 0.01], [0.62, 0], [0.7, 0.015], [0.77, 0.036], [0.9, 0.07], [0.985, 0.095]],
    vee: 0,
    cornerX: 1,
    blend: 0.5,
  },
  fillerCap: { h: 0.78, radius: 0.03 },
  // Front and rear views: bumpers wrap round the corners and back along the sides, each with two
  // vertical guards reaching ≈10 cm below it; the rear one rises over the plate. Heights from
  // those views (the side view draws both ≈10 cm higher). The returns end just outside the sides.
  // A bumper follows the end shape only at its centre height, so its gap clears the panel at its
  // top edge (the nose panel leans ≈2 cm further out there).
  bumpers: {
    front: {
      h: 0.5, gap: 0.075, height: 0.12, depth: 0.1, halfStraight: 0.9, wrapRadius: 0.12, wrapReturn: 0.12,
      guards: { x: 0.445, bottom: 0.36, top: 0.58 },
    },
    rear: {
      h: 0.56, gap: 0.065, height: 0.12, depth: 0.1, halfStraight: 0.9, wrapRadius: 0.12, wrapReturn: 0.12,
      guards: { x: 0.59, bottom: 0.42, top: 0.64 },
      notch: { halfWidth: 0.22, rise: 0.035 },
    },
  },
  // Traced from the underside and rear views (ref/1970s-muscle-car/back-underside.png, ≈234 px/m measured
  // between the axles). The underside drawing's rear overhang is shorter than the side view's,
  // so the run past the rear axle is stretched to reach the tail. Out of the manifold, down
  // through the floor beside the gearbox, in toward the driveshaft to a muffler ahead of the rear
  // axle, then out again past the fuel tank, kicking up over the axle tube (≈0.29 at rest). The
  // rear view puts the tips at ±0.42 m, about 0.25 m below the bumper's centre.
  exhaust: {
    route: [
      [0.33, 0.54, -1.3], [0.37, 0.42, -1.16], [0.38, 0.27, -1.0], [0.38, 0.265, -0.8], [0.22, 0.265, -0.52],
      [0.22, 0.265, 0.95], [0.27, 0.265, 1.05], [0.42, 0.27, 1.2], [0.42, 0.31, 1.335], [0.42, 0.29, 1.55], [0.42, 0.29, 2.38],
    ],
    pipeRadius: 0.028,
    // The muffler's top sits just under the floor (rocker 0.33).
    muffler: { z: [0.38, 0.92], x: 0.22, h: 0.255, width: 0.21, height: 0.12 },
    tip: { radius: 0.05, length: 0.16 },
  },
};

export const COUPE_70S: CarConfig = {
  name: '70s Coupe',
  mass: 1600,
  centerOfMass: [0, -0.45, -0.1],
  inertia: [3200, 3600, 850],

  blueprint: COUPE_BLUEPRINT,
  look: { paint: '#d39b2a' },

  wheels: {
    radius: 0.34,
    width: 0.24,
    // Tyres sit inside the arches, like the drawing.
    halfTrack: 0.8,
    frontZ: -1.505,
    rearZ: 1.335,
    // Puts the resting wheel centre (mount − rest length + static sag ≈ 0.15) at y ≈ −0.5,
    // slightly below the arch centre for a lifted, bouncy stance.
    mountY: -0.227,
    // AWD is an arcade liberty: rear-only traction (≈ rear load × mu) can't climb out of dips.
    drive: 'all',
  },

  suspension: {
    restLength: 0.42,
    stiffness: 30000,
    dampCompression: 2600,
    dampRebound: 3200,
    bumpStopAt: 0.85,
    bumpStopStiffness: 120000,
  },

  tire: {
    gripFront: 0.55,
    gripRear: 0.5,
    mu: 1.2,
    handbrakeRearGrip: 0.12,
    rollingResistance: 0.015,
    rollInfluence: 0.45,
  },

  engine: {
    force: 16000,
    maxSpeed: 55,
    // Must beat gravity on the slope (mass × g × sin 18° ≈ 5.4 kN) to back out of trees.
    reverseForce: 10000,
    reverseMaxSpeed: 14,
    brakeForce: 14000,
    handbrakeForce: 6000,
  },

  steering: { maxAngle: 0.55, minAngle: 0.13, fullSpeed: 40, rate: 2.6 },

  air: {
    leveling: 'hold',
    pitchTorque: 5000,
    rollTorque: 1400,
    angularDamping: 0.3,
    levelPitch: 6,
    levelPitchDamping: 3,
    levelRoll: 4,
    levelRollDamping: 2.5,
  },
  aeroDrag: 1.4,

  damage: {
    toughness: 4.5,
    // A 12 m/s drop onto the roof peaks at ≈5 m/s Δv per step, spread over several steps.
    roofToughness: 1.5,
    dentPerDv: 0.035,
    maxDent: 0.24,
    dentRadius: 0.8,
    partDamagePerDv: 14,
    partHp: 100,
    trimHp: 50,
    wheelHp: 100,
    hubcapHp: 30,
    bottomOutSpeed: 12,
    bottomOutDamagePerDv: 6,
    integrityPerDv: 0.025,
    engineDeathAt: 0.12,
    glassHp: 45,
    crackAt: 0.6,
    // Tuned against probed bumper hits: severity ≈12.6 shatters the windshield, ≈9 cracks it, ≈6 leaves it.
    glassReachGrowth: 0.08,
    glassReachCap: 15,
    steamBelow: 0.5,
    // Tougher than a real car: one big landing (floor hit ≈70 + bottom-outs ≈55) doesn't leak,
    // two at most weep, three or four leave a proper oil trail.
    radiatorHp: 100,
    sumpHp: 200,
    leakTolerance: 0.5,
    sumpHitShare: 0.4,
    sumpBottomOutShare: 0.125,
    coolantCrushFull: 0.25,
    oilWreckBelow: 0.35,
    // A full leak loses ≈7 drop volumes per metre (2.9 drops/m at ≈2.5× average size): the sump
    // runs dry in ≈350 m of driving, the radiator in ≈600 m; a slow weep lasts kilometres.
    coolantCapacity: 9,
    oilCapacity: 5,
    dropVolume: 0.002,
    leakSpacingMax: 3,
    leakSpacingMin: 0.35,
    leakIdle: 0.4,
    puddleMax: 1.3,
    puddleGrowth: 0.04,
    puddleDrain: 0.08,
    tearHp: 70,
    tearSwingSpeed: 16,
    panelAeroDrag: 0.3,
    // A hard hit (severity ≈12) pushes a wall-wide front in ≈0.36 m; a tree ≈0.54 m in a notch.
    crushPerDv: 0.03,
    crushMaxFront: 0.65,
    // The rear zone (tail to rear-seat wall) is only ≈0.9 m long.
    crushMaxRear: 0.45,
    // No sharper than the crush columns (≈0.24 m apart) and the body's strips across the deck.
    crushSpreadTree: 0.3,
    crushSpreadWide: 0.9,
    crushTreeFactor: 1.5,
    crushFold: 0.45,
    crushBuckle: 0.2,
    crushWrinkle: 0.06,
    crushWrinkleSize: 0.2,
    // The cabin stands ≈0.4 m above the beltline; the roof can come most of the way down.
    roofCrushMax: 0.25,
    roofLean: 0.6,
    roofBuckle: 0.15,
    roofGlassBreak: 0.06,
    // Damage is severity × partDamagePerDv, fading with distance: a severity-6 hit right on
    // a light smashes it, ≈10 drops it out, and a dangling one snaps off on the next big hit.
    lightReach: 0.6,
    lightLensHp: 25,
    lightMountHp: 100,
    // Counted from when the light starts dangling (it has its own budget).
    lightWireHp: 120,
    lightDropAtCrush: 0.15,
    lightSnapChance: 0.4,
    wireLength: 0.25,
    // Linear air drag on a dangling light: ≈3 m/s² at 15 m/s, well under gravity, so it hangs and swings.
    wireDrag: 0.25,
    // Measured while driving: ≈10 hanging still, 100–180 on bumps (95th pct), 400–800 on jump landings.
    wireTearAccel: 300,
  },
};
