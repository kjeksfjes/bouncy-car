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

  body: { width: number; length: number; height: number };
  cabin: { width: number; length: number; height: number; z: number };
  look: { paint: string; roof: string };

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
  };
}

export const SEDAN_70S: CarConfig = {
  name: '70s Sedan',
  mass: 1600,
  centerOfMass: [0, -0.3, 0.05],
  inertia: [3200, 3600, 850],

  body: { width: 1.94, length: 5.1, height: 0.56 },
  cabin: { width: 1.7, length: 2.3, height: 0.52, z: 0.2 },
  look: { paint: '#d39b2a', roof: '#4a3426' },

  wheels: {
    radius: 0.37,
    width: 0.28,
    halfTrack: 0.92,
    frontZ: -1.58,
    rearZ: 1.52,
    mountY: -0.05,
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
    reverseForce: 4500,
    reverseMaxSpeed: 12,
    brakeForce: 14000,
    handbrakeForce: 6000,
  },

  steering: { maxAngle: 0.55, minAngle: 0.13, fullSpeed: 40, rate: 2.6 },

  air: {
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
  },
};
