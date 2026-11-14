/** Fixed physics step. Suspension springs are tuned for this rate. */
export const PHYSICS_STEP = 1 / 60;

/**
 * Gravity in m/s². A bit above Earth's 9.81 so jumps read snappier and
 * landings feel weighty; tune together with suspension stiffness.
 */
export const GRAVITY = 11;

/**
 * `?dev` in the URL, in any build: the test shortcuts and their legend (see index.html's
 * #dev-legend), and where the car is in the HUD.
 */
export const DEV_MODE = new URLSearchParams(location.search).has('dev');

/**
 * Features that are off unless switched on. In dev, a URL parameter switches one on for a look.
 */
export const FEATURES = {
  /**
   * Photo mode's camera can go under the ground, which then shows cut open (see GroundSection).
   * Off: the camera stays above the ground. Meant as a hidden extra for a settings menu to come;
   * `?section` turns it on in dev.
   */
  groundSection: import.meta.env.DEV && new URLSearchParams(location.search).has('section'),
};
