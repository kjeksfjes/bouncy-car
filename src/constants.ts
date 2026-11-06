/** Fixed physics step. Suspension springs are tuned for this rate. */
export const PHYSICS_STEP = 1 / 60;

/**
 * Gravity in m/s². A bit above Earth's 9.81 so jumps read snappier and
 * landings feel weighty; tune together with suspension stiffness.
 */
export const GRAVITY = 11;
