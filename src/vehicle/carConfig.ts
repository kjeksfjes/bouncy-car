import type { CarBlueprint } from './blueprint';

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

  damage: {
    /** Impact Δv (m/s, per physics step) the car shrugs off without a scratch. */
    toughness: number;
    /** Dent depth per m/s of Δv over toughness. */
    dentPerDv: number;
    maxDent: number;
    dentRadius: number;
    /** Hit points removed from a nearby part per m/s of Δv over toughness. */
    partDamagePerDv: number;
    partHp: number;
    wheelHp: number;
    /** Wheel damage from slamming into the bump stop faster than this (m/s). */
    bottomOutSpeed: number;
    /** Wheel hit points removed per m/s of bump-stop speed over `bottomOutSpeed`. */
    bottomOutDamagePerDv: number;
    /** Integrity lost per m/s of Δv over toughness. */
    integrityPerDv: number;
    /** Below this integrity the engine dies. */
    engineDeathAt: number;
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
  front: -2.44,
  rear: 2.44,
  station: 0.1,
  halfWidth: [[-2.44, 0.84], [-2.36, 0.92], [-2.1, 0.955], [-1.6, 0.96], [2.1, 0.96], [2.36, 0.94], [2.44, 0.88]],
  deck: [
    [-2.44, 0.78], [-2.4, 0.86], [-2.33, 0.91], [-1.6, 0.98], [-0.77, 1.04], [0, 1.03], [0.9, 1.04],
    [1.53, 1.07], [2.0, 1.05], [2.32, 1.03], [2.4, 0.98], [2.44, 0.78],
  ],
  rocker: [[-2.44, 0.46], [-2.25, 0.37], [-2.0, 0.33], [2.0, 0.33], [2.3, 0.38], [2.44, 0.44]],
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
    sillHalf: 0.8,
    roofHalf: 0.7,
    windshieldTo: -0.27,
    rearGlassFrom: 0.92,
    doorGlass: [-0.7, 0.46],
    quarterGlass: [0.52, 0.86],
  },
  mirror: { z: -0.62, size: [0.1, 0.08, 0.16] },
  hoodBulge: { from: -2.1, to: -0.95, halfWidth: 0.45, height: 0.05 },
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
    dentPerDv: 0.035,
    maxDent: 0.24,
    dentRadius: 0.8,
    partDamagePerDv: 14,
    partHp: 100,
    wheelHp: 100,
    bottomOutSpeed: 12,
    bottomOutDamagePerDv: 6,
    integrityPerDv: 0.025,
    engineDeathAt: 0.12,
    tearHp: 70,
    tearSwingSpeed: 16,
    panelAeroDrag: 0.3,
  },
};
