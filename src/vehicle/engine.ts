import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { sideHalfWidth } from './blueprint';
import type { CarConfig } from './carConfig';

/**
 * The engine bay: a small-block V8 after the user's reference (an AI-generated low-poly render,
 * 09.11.2026), made to fit the coupe's bay. Heights above the drawing's ground line, front at −Z.
 *
 * Fitted around what's already there: the hood's underside is ≈0.97 over the engine and ≈0.90
 * over the radiator, the underbody's oil pan tops out at ≈0.39 under the block and its bellhousing
 * starts at z −1.09, the exhaust pipes start at (±0.33, 0.54, −1.30) where the headers' collectors
 * end, and the front wheel arches (centred at z −1.5) keep everything inside |x| ≈ 0.45 beside
 * the block. The radiator spans the bay just behind the grille, inside the crumple zone, so it's
 * subdivided across (the crush bends a part only at its vertices). Painted inner fender aprons with
 * strut towers box the bay in over the wheel housings, so the bay reads as filled, not as a tub.
 */

export interface EngineMaterials {
  engineBlock: THREE.Material;
  valveCover: THREE.Material;
  aluminium: THREE.Material;
  header: THREE.Material;
  coolantTank: THREE.Material;
  /** Radiator frame, tanks and fins. */
  radiator: THREE.Material;
  /** Bare cast metal: the master cylinder. */
  alloy: THREE.Material;
  /** White plastic: brake fluid reservoir, washer bottle. */
  plate: THREE.Material;
  steel: THREE.Material;
  dark: THREE.Material;
  /** The battery's positive terminal and cable. */
  taillight: THREE.Material;
  /** The bay's painted sheet metal: aprons, strut towers, radiator support. */
  bay: THREE.Material;
}

type Part = [THREE.BufferGeometry, THREE.Material];

/** The block's middle along Z, its length, and its two banks' tilt from upright (radians). */
const BLOCK = { z: -1.45, length: 0.7, bankTilt: 0.55 };
/**
 * The radiator: its middle plane (z), just ahead of the fan, and its size. Its top sits a little
 * below the valve covers, so the fan shows above it from above, and well under the hood (≈0.92 here).
 */
const RADIATOR_Z = -2.03;
const RADIATOR = { width: 0.84, depth: 0.1, top: 0.8, bottom: 0.38, tank: 0.05 };
/** The firewall's face toward the engine (z): the bay's back wall. */
const FIREWALL_Z = -0.78;
const FRONT = BLOCK.z - BLOCK.length / 2;
/** Where the exhaust pipes start (see CarBlueprint.exhaust.route): the headers' collectors end here. */
const EXHAUST_START = { x: 0.33, h: 0.54, z: -1.3 };
/**
 * The inner fender aprons, painted sheet metal boxing the bay in at the sides, from behind the
 * battery (`from`) to the firewall: a deck over the wheel housings' crest (≈0.71–0.73) at `top`,
 * from the fender in to `edge` (just inside the housings' inner walls, |x| 0.62), sloping from
 * there down to the frame rail (`rail`: its middle, half width, and top) beside the headers. A
 * spring tower rises out of each slope over the front wheel (`tower`: centre x, at the arch's z;
 * radius; top), a drum with a rounded shoulder standing half over the deck.
 */
const APRON = {
  top: 0.735,
  edge: 0.61,
  thickness: 0.02,
  rail: { x: 0.45, half: 0.04, top: 0.5 },
  from: -1.9,
  tower: { x: 0.66, z: -1.505, radius: 0.14, top: 0.85 },
};

/**
 * The engine itself (`engine`: a rigid lump the crush moves as a whole, see CarPiece.rigid) and
 * what's in front of it (`front`: radiator, hoses, battery and coolant tank, crumpling with the nose).
 */
export function engineParts(cfg: CarConfig, mat: EngineMaterials): { engine: Part[]; front: Part[] } {
  const gy = cfg.blueprint.groundY;
  const engine: Part[] = [];
  const front: Part[] = [];
  let parts = engine;
  const v = (x: number, h: number, z: number) => new THREE.Vector3(x, h + gy, z);
  /** A primitive placed at (x, h, z), turned about Z (a bank's lean), then X. */
  const put = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, h: number, z: number, rotZ = 0, rotX = 0) => {
    parts.push([geo.rotateZ(rotZ).rotateX(rotX).translate(x, h + gy, z), m]);
  };
  /** A disc or drum facing forward (its axis along Z). */
  const drum = (radius: number, depth: number, segments: number, m: THREE.Material, x: number, h: number, z: number) =>
    put(new THREE.CylinderGeometry(radius, radius, depth, segments), m, x, h, z, 0, Math.PI / 2);
  /** A bent pipe or hose through car-local points (x, h, z). */
  const tube = (points: [number, number, number][], radius: number, m: THREE.Material, closed = false) => {
    const curve = new THREE.CatmullRomCurve3(points.map(([x, h, z]) => v(x, h, z)), closed, 'centripetal');
    parts.push([new THREE.TubeGeometry(curve, Math.max(6, Math.ceil(curve.getLength() / 0.04)), radius, 6, closed), m]);
  };

  // Block: the crankcase on the oil pan, and the two cylinder banks leaning out in a V.
  put(new THREE.BoxGeometry(0.38, 0.24, BLOCK.length), mat.engineBlock, 0, 0.52, BLOCK.z);
  const tilt = BLOCK.bankTilt;
  for (const side of [-1, 1]) {
    // Leaning outward: the bank's up turns toward its own side.
    const lean = -side * tilt;
    const up = new THREE.Vector2(side * Math.sin(tilt), Math.cos(tilt));
    const bank = new THREE.Vector2(side * 0.14, 0.7);
    put(new THREE.BoxGeometry(0.19, 0.16, BLOCK.length - 0.04), mat.engineBlock, bank.x, bank.y, BLOCK.z, lean);
    // Valve cover on the head, its rails a shade darker, and a breather cap.
    const cover = bank.clone().addScaledVector(up, 0.11);
    put(new THREE.BoxGeometry(0.14, 0.07, BLOCK.length - 0.1), mat.valveCover, cover.x, cover.y, BLOCK.z, lean);
    const rail = bank.clone().addScaledVector(up, 0.08);
    put(new THREE.BoxGeometry(0.16, 0.015, BLOCK.length - 0.08), mat.engineBlock, rail.x, rail.y, BLOCK.z, lean);
    const breather = cover.clone().addScaledVector(up, 0.045);
    put(new THREE.CylinderGeometry(0.022, 0.022, 0.03, 8), mat.dark, breather.x, breather.y, BLOCK.z + 0.18, lean);

    // Headers: a pipe from each of the bank's four ports curling down the side into a collector
    // running back to where the exhaust pipe starts.
    const x = side;
    for (let i = 0; i < 4; i++) {
      const zp = FRONT + 0.1 + i * 0.13;
      tube([[x * 0.235, 0.645, zp], [x * 0.31, 0.64, zp], [x * 0.37, 0.58, zp + 0.005], [x * 0.375, 0.52, zp + 0.01], [x * 0.36, 0.49, zp + 0.03]], 0.019, mat.header);
    }
    tube([[x * 0.36, 0.49, FRONT + 0.08], [x * 0.36, 0.49, FRONT + 0.3], [x * 0.355, 0.5, EXHAUST_START.z - 0.08], [x * EXHAUST_START.x, EXHAUST_START.h, EXHAUST_START.z]], 0.03, mat.header);
  }

  // Intake manifold in the V, the carburettor on it, and the round air cleaner on top with its
  // wing nut. The cleaner's top stays under the hood (≈0.97 here).
  put(new THREE.BoxGeometry(0.2, 0.09, 0.5), mat.aluminium, 0, 0.77, BLOCK.z);
  put(new THREE.BoxGeometry(0.15, 0.06, 0.16), mat.aluminium, 0, 0.835, BLOCK.z - 0.02);
  put(new THREE.CylinderGeometry(0.19, 0.19, 0.06, 14), mat.aluminium, 0, 0.895, BLOCK.z - 0.02);
  put(new THREE.CylinderGeometry(0.15, 0.17, 0.012, 14), mat.aluminium, 0, 0.931, BLOCK.z - 0.02);
  put(new THREE.CylinderGeometry(0.038, 0.038, 0.02, 8), mat.steel, 0, 0.94, BLOCK.z - 0.02);
  // Water outlet at the front of the intake, with the neck the upper hose slips onto.
  put(new THREE.BoxGeometry(0.07, 0.05, 0.07), mat.aluminium, 0, 0.74, FRONT + 0.05);
  drum(0.026, 0.04, 8, mat.aluminium, 0, 0.74, FRONT - 0.005);

  // Distributor at the back of the intake: its body, the cap with a tower per cylinder, and a plug
  // wire from each tower into a loom on top of the valve cover along its outer edge (the four side by
  // side, held by two clips), which each wire leaves at its cylinder to drop over the edge to the
  // boot on its spark plug, in the head's outer face between the header ports. In view, but tidy.
  const dist = { h: 0.78, z: BLOCK.z + 0.31 };
  put(new THREE.CylinderGeometry(0.03, 0.035, 0.12, 8), mat.engineBlock, 0, dist.h, dist.z);
  put(new THREE.CylinderGeometry(0.06, 0.055, 0.05, 10), mat.dark, 0, dist.h + 0.085, dist.z);
  const capTop = dist.h + 0.11;
  for (const side of [-1, 1]) {
    // The head's outward direction (its bank leans out by BLOCK.bankTilt).
    const out = new THREE.Vector2(Math.cos(BLOCK.bankTilt), -Math.sin(BLOCK.bankTilt));
    const outward = new THREE.Vector2(side * out.x, out.y);
    const up = new THREE.Vector2(side * Math.sin(BLOCK.bankTilt), Math.cos(BLOCK.bankTilt));
    // The valve cover's middle (see above), the loom on its top near the outer edge, and the edge.
    const cover = new THREE.Vector2(side * 0.14, 0.7).addScaledVector(up, 0.11);
    const loom = cover.clone().addScaledVector(up, 0.035 + 0.008).addScaledVector(outward, 0.035);
    const edge = cover.clone().addScaledVector(up, 0.03).addScaledVector(outward, 0.082);
    const loomFrom = BLOCK.z + 0.28;
    for (const z of [FRONT + 0.25, FRONT + 0.51]) put(new THREE.BoxGeometry(0.06, 0.016, 0.025), mat.dark, loom.x, loom.y, z, -side * BLOCK.bankTilt);
    for (let i = 0; i < 4; i++) {
      const zPlug = FRONT + 0.165 + i * 0.13;
      // Four towers on the cap's half toward this bank, fanned front to back.
      const spread = (i - 1.5) * 0.4;
      const tower = { x: side * 0.042 * Math.cos(spread), z: dist.z + 0.042 * Math.sin(spread) };
      put(new THREE.CylinderGeometry(0.008, 0.008, 0.02, 6), mat.dark, tower.x, capTop + 0.005, tower.z);
      const boot = new THREE.Vector2(side * 0.23, 0.68);
      const bootEnd = boot.clone().addScaledVector(new THREE.Vector2(side * out.x, out.y), 0.05);
      // The boot, sticking out of the head along its outward direction.
      const mid = boot.clone().lerp(bootEnd, 0.5);
      put(new THREE.CylinderGeometry(0.013, 0.013, 0.05, 6), mat.dark, mid.x, mid.y, zPlug, Math.atan2(-side * out.x, out.y));
      // Its lane in the loom: the four side by side across the cover's top.
      const lane = loom.clone().addScaledVector(outward, (i - 1.5) * 0.012);
      tube([
        [tower.x, capTop + 0.015, tower.z],
        [side * 0.1, capTop + 0.01, dist.z - 0.01],
        [lane.x, lane.y + 0.015, loomFrom + 0.03],
        [lane.x, lane.y, loomFrom - 0.02],
        [lane.x, lane.y, (loomFrom + zPlug) / 2],
        [lane.x, lane.y, zPlug + 0.035],
        [edge.x, edge.y, zPlug + 0.008],
        [bootEnd.x + side * 0.01, bootEnd.y + 0.03, zPlug],
        [bootEnd.x, bootEnd.y, zPlug],
      ], 0.006, mat.dark);
    }
  }

  // Front: the timing cover, and the belt drive on it (crank pulley at the bottom, water pump
  // pulley above, alternator off to the right) with the belt round all three.
  put(new THREE.BoxGeometry(0.3, 0.27, 0.03), mat.engineBlock, 0, 0.55, FRONT - 0.015);
  const pulleyZ = FRONT - 0.05;
  drum(0.075, 0.035, 12, mat.dark, 0, 0.45, pulleyZ);
  drum(0.035, 0.04, 8, mat.steel, 0, 0.45, pulleyZ - 0.01);
  drum(0.055, 0.03, 10, mat.dark, 0, 0.64, pulleyZ);
  drum(0.035, 0.035, 8, mat.steel, 0, 0.64, pulleyZ - 0.01);
  const alternator = { x: 0.2, h: 0.66 };
  drum(0.062, 0.11, 10, mat.aluminium, alternator.x, alternator.h, FRONT + 0.01);
  for (const dz of [-0.035, 0, 0.035]) drum(0.066, 0.01, 10, mat.steel, alternator.x, alternator.h, FRONT + 0.01 + dz);
  drum(0.032, 0.03, 8, mat.dark, alternator.x, alternator.h, pulleyZ);
  tube([
    [0, 0.37, pulleyZ], [0.065, 0.39, pulleyZ], [0.24, 0.62, pulleyZ], [0.23, 0.69, pulleyZ],
    [0.16, 0.69, pulleyZ], [0.03, 0.695, pulleyZ], [-0.05, 0.66, pulleyZ], [-0.075, 0.45, pulleyZ], [-0.06, 0.39, pulleyZ],
  ], 0.009, mat.dark, true);

  // Cooling fan on the water pump's shaft, ahead of the belt: a bare-metal hub, a spacer back to
  // the pulley, and four broad grey blades, pitched (dark ones vanished against the dark bay).
  const fanZ = RADIATOR_Z + RADIATOR.depth / 2 + 0.07;
  drum(0.045, 0.035, 8, mat.aluminium, 0, 0.64, fanZ);
  drum(0.022, pulleyZ - fanZ, 6, mat.steel, 0, 0.64, (fanZ + pulleyZ) / 2);
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    const blade = new THREE.BoxGeometry(0.075, 0.13, 0.008).rotateY(0.35).translate(0, 0.105, 0).rotateZ(a);
    parts.push([blade.translate(0, 0.64 + gy, fanZ), mat.radiator]);
  }

  // Power steering pump on the left front of the block, belted to a second groove on the crank
  // pulley: the pump body, its pulley, the fluid reservoir on top with its cap, and the two hoses
  // tucked down beside the block toward the steering box below.
  const pump = { x: -0.22, h: 0.6, z: FRONT - 0.01 };
  drum(0.055, 0.1, 10, mat.engineBlock, pump.x, pump.h, pump.z);
  drum(0.05, 0.02, 10, mat.dark, pump.x, pump.h, pulleyZ - 0.03);
  drum(0.07, 0.02, 12, mat.dark, 0, 0.45, pulleyZ - 0.03);
  put(new THREE.CylinderGeometry(0.035, 0.035, 0.04, 10), mat.engineBlock, pump.x - 0.01, pump.h + 0.075, pump.z + 0.01);
  put(new THREE.CylinderGeometry(0.02, 0.02, 0.012, 8), mat.dark, pump.x - 0.01, pump.h + 0.1, pump.z + 0.01);
  const beltZ = pulleyZ - 0.03;
  tube([
    [0, 0.378, beltZ], [0.07, 0.43, beltZ], [0.04, 0.51, beltZ], [-0.18, 0.645, beltZ],
    [-0.23, 0.65, beltZ], [-0.27, 0.6, beltZ], [-0.25, 0.555, beltZ], [-0.07, 0.42, beltZ],
  ], 0.008, mat.dark, true);
  for (const dh of [0, -0.04]) {
    tube([[pump.x - 0.03, pump.h - 0.02 + dh, pump.z + 0.04], [-0.29, 0.5 + dh, pump.z + 0.06], [-0.33, 0.42 + dh, pump.z + 0.04]], 0.012, mat.dark);
  }

  parts = front;
  // Radiator just ahead of the fan: a chunky dark-grey frame (top and bottom tanks, side posts)
  // round a dark core with fins across it, and the filler cap on the top tank. Subdivided across
  // to bend with the nose; narrow enough for the battery and coolant tank beside it.
  const R = RADIATOR;
  const rz = RADIATOR_Z;
  const across = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d, 10, 1, 1);
  const coreH = R.top - R.bottom - 2 * R.tank;
  const coreMid = (R.top + R.bottom) / 2;
  put(across(R.width - 0.06, coreH, R.depth - 0.03), mat.dark, 0, coreMid, rz);
  put(across(R.width, R.tank, R.depth), mat.radiator, 0, R.top - R.tank / 2, rz);
  put(across(R.width, R.tank, R.depth), mat.radiator, 0, R.bottom + R.tank / 2, rz);
  for (const side of [-1, 1]) put(new THREE.BoxGeometry(0.035, R.top - R.bottom, R.depth), mat.radiator, side * (R.width / 2 - 0.0175), coreMid, rz);
  const fins = 8;
  for (let i = 1; i < fins; i++) {
    for (const face of [-1, 1]) put(across(R.width - 0.07, 0.01, 0.006), mat.radiator, 0, R.bottom + R.tank + (coreH * i) / fins, rz + face * (R.depth / 2 - 0.012));
  }
  // Filler neck on the top tank, its cap, and the overflow nipple sticking out of the neck's side.
  const neckTop = R.top + 0.03;
  put(new THREE.CylinderGeometry(0.024, 0.024, 0.03, 8), mat.radiator, 0, R.top + 0.015, rz);
  put(new THREE.CylinderGeometry(0.035, 0.04, 0.018, 8), mat.aluminium, 0, neckTop + 0.009, rz);
  const nipple = { x: -0.024, h: R.top + 0.014 };
  put(new THREE.CylinderGeometry(0.0045, 0.0045, 0.03, 6), mat.steel, nipple.x - 0.012, nipple.h, rz, Math.PI / 2);
  // Hoses: the upper one from a neck on the top tank to the water outlet's neck on the intake
  // (a clamp round each end), the lower one from a neck on the bottom tank to the water pump.
  const back = rz + R.depth / 2;
  const upper = { x: -0.22, h: R.top - 0.03 };
  drum(0.026, 0.04, 8, mat.radiator, upper.x, upper.h, back + 0.015);
  drum(0.027, 0.01, 8, mat.steel, upper.x, upper.h, back + 0.05);
  drum(0.027, 0.01, 8, mat.steel, 0, 0.74, FRONT - 0.035);
  tube([[upper.x, upper.h, back + 0.02], [upper.x, upper.h, back + 0.06], [-0.17, R.top - 0.04, back + 0.12], [-0.03, 0.75, FRONT - 0.08], [0, 0.74, FRONT - 0.045], [0, 0.74, FRONT - 0.01]], 0.022, mat.dark);
  drum(0.026, 0.04, 8, mat.radiator, 0.24, R.bottom + 0.03, back + 0.015);
  tube([[0.24, R.bottom + 0.03, back + 0.02], [0.22, R.bottom + 0.01, back + 0.07], [0.09, 0.53, pulleyZ - 0.03], [0.02, 0.6, pulleyZ + 0.01]], 0.022, mat.dark);

  // On the firewall: the two heater pipes the heater hoses run onto (through to the heater core in
  // the cabin), both coming from the back of the intake behind the valve covers; and the brake
  // booster (left, the driver's side), a broad shallow drum with its seam, the master cylinder
  // coming forward out of it and the twin-chamber fluid reservoir on top.
  const wall = FIREWALL_Z;
  // The heater box the pipes come out of, standing just off the firewall.
  put(new THREE.BoxGeometry(0.26, 0.13, 0.04), mat.engineBlock, 0.3, 0.76, wall - 0.025);
  for (const [x, end] of [[0.09, 0.24], [-0.09, 0.36]]) {
    drum(0.02, 0.05, 8, mat.steel, end, 0.75, wall - 0.035);
    tube([[x, 0.79, BLOCK.z + 0.25], [x * 1.4, 0.83, BLOCK.z + 0.36], [end - 0.03, 0.8, wall - 0.16], [end, 0.75, wall - 0.055]], 0.016, mat.dark);
  }
  const booster = { x: -0.4, h: 0.72 };
  drum(0.14, 0.12, 14, mat.engineBlock, booster.x, booster.h, wall - 0.06);
  drum(0.145, 0.012, 14, mat.steel, booster.x, booster.h, wall - 0.06);
  // The master cylinder bolted to the booster's face by its flange, and the reservoir seated on it.
  put(new THREE.BoxGeometry(0.1, 0.1, 0.012), mat.alloy, booster.x, booster.h, wall - 0.126);
  drum(0.042, 0.22, 8, mat.alloy, booster.x, booster.h, wall - 0.24);
  put(new THREE.BoxGeometry(0.075, 0.05, 0.11), mat.plate, booster.x, booster.h + 0.055, wall - 0.25);
  for (const dz of [-0.03, 0.03]) put(new THREE.CylinderGeometry(0.016, 0.016, 0.014, 8), mat.dark, booster.x, booster.h + 0.087, wall - 0.25 + dz);
  // Lines off the brake booster side: the two brake lines from the master cylinder out over the
  // left apron to the proportioning valve on its deck, and the vacuum hose from the back of the
  // intake to the booster.
  const valve = { x: -0.75, h: APRON.top + 0.02, z: wall - 0.17 };
  put(new THREE.BoxGeometry(0.06, 0.04, 0.09), mat.alloy, valve.x, valve.h, valve.z);
  for (const dz of [-0.03, 0.03]) {
    tube([[booster.x - 0.04, booster.h - 0.02, wall - 0.2 + dz], [-0.52, 0.745, wall - 0.19 + dz], [-0.62, 0.76, valve.z + dz], [valve.x + 0.03, valve.h, valve.z + dz]], 0.0045, mat.steel);
  }
  tube([[-0.09, 0.8, BLOCK.z + 0.2], [-0.2, 0.84, -1.05], [-0.33, 0.83, wall - 0.14], [-0.36, 0.8, wall - 0.125]], 0.012, mat.dark);

  // Washer fluid reservoir lying on the right apron in front of the spring tower: a low, wide tank
  // with rounded edges, long along the car, a round cap with its neck near the front end, and two
  // straps across it holding it down.
  const washer = { x: 0.8, base: APRON.top, z: -1.785, width: 0.18, height: 0.085, length: 0.25 };
  // The rounded box comes without an index; the bay's other parts have one, and merging needs all alike.
  const tank = new RoundedBoxGeometry(washer.width, washer.height, washer.length, 2, 0.025);
  tank.setIndex(Array.from({ length: tank.getAttribute('position').count }, (_, i) => i));
  put(tank, mat.plate, washer.x, washer.base + washer.height / 2, washer.z);
  const capAt = { x: washer.x - 0.02, z: washer.z - washer.length / 2 + 0.06 };
  put(new THREE.CylinderGeometry(0.022, 0.026, 0.02, 10), mat.plate, capAt.x, washer.base + washer.height + 0.008, capAt.z);
  put(new THREE.CylinderGeometry(0.03, 0.03, 0.018, 10), mat.dark, capAt.x, washer.base + washer.height + 0.026, capAt.z);
  for (const dz of [0.02, 0.1]) put(new THREE.BoxGeometry(washer.width + 0.008, washer.height + 0.008, 0.02), mat.dark, washer.x, washer.base + washer.height / 2, washer.z + dz);

  // Battery beside the radiator (right): its case, the terminals (red positive), and the cell caps.
  const bx = R.width / 2 + 0.16;
  put(new THREE.BoxGeometry(0.22, 0.2, 0.17), mat.dark, bx, 0.62, rz + 0.02);
  put(new THREE.BoxGeometry(0.035, 0.03, 0.035), mat.taillight, bx + 0.065, 0.735, rz - 0.02);
  put(new THREE.BoxGeometry(0.035, 0.03, 0.035), mat.steel, bx - 0.065, 0.735, rz - 0.02);
  for (let i = 0; i < 3; i++) put(new THREE.BoxGeometry(0.03, 0.012, 0.03), mat.steel, bx - 0.05 + i * 0.05, 0.725, rz + 0.06);
  // Coolant reservoir on the other side, a bottle with rounded edges (indexed for merging, like
  // the washer tank), its cap, and the spout the overflow hose slips onto beside it.
  const bottle = new RoundedBoxGeometry(0.1, 0.15, 0.11, 2, 0.02);
  bottle.setIndex(Array.from({ length: bottle.getAttribute('position').count }, (_, i) => i));
  put(bottle, mat.coolantTank, -bx, 0.63, rz + 0.02);
  put(new THREE.CylinderGeometry(0.025, 0.025, 0.025, 8), mat.dark, -bx, 0.718, rz + 0.04);
  const spout = { x: -bx + 0.025, z: rz - 0.015 };
  put(new THREE.CylinderGeometry(0.0045, 0.0045, 0.025, 6), mat.coolantTank, spout.x, 0.715, spout.z);
  // Its overflow hose from the nipple on the radiator's filler neck, along the top tank, down onto
  // the bottle's spout.
  // It keeps clear of the top tank (and its end post) until past the radiator's end, then drops.
  const tankEnd = R.width / 2;
  tube([
    [nipple.x - 0.022, nipple.h, rz], [nipple.x - 0.06, R.top + 0.01, rz - 0.025], [-0.2, R.top + 0.009, rz - 0.035], [-(tankEnd - 0.03), R.top + 0.009, rz - 0.035],
    [-(tankEnd + 0.025), R.top + 0.004, rz - 0.03], [-(tankEnd + 0.07), 0.77, rz - 0.02], [spout.x, 0.745, spout.z], [spout.x, 0.722, spout.z],
  ], 0.006, mat.dark);
  // Battery cables: the positive (red) down behind the battery and past the block to the starter,
  // the negative to the block's front corner.
  tube([[bx + 0.065, 0.75, rz - 0.02], [bx + 0.065, 0.78, rz + 0.05], [0.56, 0.74, rz + 0.17], [0.48, 0.6, -1.72], [0.38, 0.44, -1.45], [0.31, 0.4, -1.2]], 0.011, mat.taillight);
  tube([[bx - 0.065, 0.75, rz - 0.02], [bx - 0.08, 0.79, rz + 0.06], [0.38, 0.74, rz + 0.17], [0.24, 0.56, -1.8], [0.16, 0.5, FRONT + 0.01]], 0.011, mat.dark);

  // Radiator support: the painted frame the radiator stands in, a top bar across the bay just
  // ahead of it and a post either side. Subdivided across to bend with the nose.
  const supportZ = rz - R.depth / 2 - 0.06;
  const barH = R.top + 0.035;
  const barHalf = sideHalfWidth(cfg.blueprint, supportZ, barH) - 0.05;
  put(across(2 * barHalf, 0.05, 0.07), mat.bay, 0, barH, supportZ);
  for (const side of [-1, 1]) put(new THREE.BoxGeometry(0.05, barH - 0.38, 0.06), mat.bay, side * (R.width / 2 + 0.04), (barH + 0.38) / 2, supportZ);
  // The horn, on a bracket under the bar's left end, facing forward.
  drum(0.045, 0.035, 10, mat.dark, -0.62, 0.76, supportZ - 0.07);
  put(new THREE.BoxGeometry(0.03, 0.05, 0.08), mat.steel, -0.62, 0.8, supportZ - 0.035);

  // Inner fender aprons with their strut towers (see APRON), long parts subdivided along their
  // length to crumple with the nose; a loom along the left one, a row of fender bolts along each
  // outer edge, and the voltage regulator on the right one by the firewall.
  const A = APRON;
  const apronTo = wall - 0.01;
  const apronLength = apronTo - A.from;
  const apronZ = (A.from + apronTo) / 2;
  const along = Math.ceil(apronLength / 0.1);
  let outer = Infinity;
  for (let z = A.from; z <= apronTo; z += 0.05) outer = Math.min(outer, sideHalfWidth(cfg.blueprint, z, A.top) - 0.045);
  const deckWidth = outer - A.edge;
  // The slope from the deck's inner edge down to the rail's outer top corner.
  const slopeFrom = new THREE.Vector2(A.edge, A.top - A.thickness / 2);
  const slopeTo = new THREE.Vector2(A.rail.x + A.rail.half, A.rail.top);
  const slope = slopeFrom.clone().sub(slopeTo);
  const slopeMid = slopeFrom.clone().add(slopeTo).multiplyScalar(0.5);
  for (const side of [-1, 1]) {
    put(new THREE.BoxGeometry(deckWidth, A.thickness, apronLength, 3, 1, along), mat.bay, side * (A.edge + deckWidth / 2), A.top - A.thickness / 2, apronZ);
    put(new THREE.BoxGeometry(slope.length() + A.thickness, A.thickness, apronLength, 2, 1, along), mat.bay, side * slopeMid.x, slopeMid.y, apronZ, side * Math.atan2(slope.y, slope.x));
    put(new THREE.BoxGeometry(2 * A.rail.half, 0.1, apronLength, 1, 1, along), mat.bay, side * A.rail.x, A.rail.top - 0.05, apronZ);
    // The tower: a drum rising out of the slope (its foot hidden in it, at the rail's top), with a
    // rounded shoulder into its flat top, the shock's top mount in the middle and three bolts.
    const T = A.tower;
    const tx = side * T.x;
    const rise = T.top - A.rail.top;
    const profile = [
      [T.radius, 0], [T.radius, rise - 0.05], [T.radius - 0.012, rise - 0.02], [T.radius - 0.03, rise - 0.004], [T.radius - 0.045, rise], [0, rise],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    put(new THREE.LatheGeometry(profile, 16), mat.bay, tx, A.rail.top, T.z);
    put(new THREE.CylinderGeometry(0.045, 0.045, 0.012, 10), mat.dark, tx, T.top + 0.006, T.z);
    put(new THREE.CylinderGeometry(0.016, 0.016, 0.03, 6), mat.steel, tx, T.top + 0.015, T.z);
    for (let i = 0; i < 3; i++) {
      const a = (i * 2 * Math.PI) / 3 + 0.5;
      put(new THREE.CylinderGeometry(0.011, 0.011, 0.01, 6), mat.steel, tx + Math.cos(a) * 0.07, T.top + 0.005, T.z + Math.sin(a) * 0.07);
    }
    for (let z = A.from + 0.08; z < apronTo - 0.05; z += 0.14) {
      put(new THREE.CylinderGeometry(0.011, 0.011, 0.008, 6), mat.steel, side * (outer - 0.02), A.top + 0.004, z);
    }
  }
  // The loom runs along the left deck's outer edge, outside the tower, on to the headlights.
  const loomX = -(outer - 0.09);
  tube([[-0.62, 0.8, wall - 0.03], [loomX, 0.755, wall - 0.12], [loomX, 0.748, -1.3], [loomX, 0.748, -1.7], [loomX, 0.75, A.from + 0.02], [-0.72, 0.76, rz - 0.1], [-0.7, 0.73, rz - 0.2]], 0.011, mat.dark);
  for (const z of [-1.1, -1.75]) put(new THREE.BoxGeometry(0.025, 0.025, 0.03), mat.dark, loomX, A.top + 0.012, z);
  put(new THREE.BoxGeometry(0.09, 0.04, 0.06), mat.dark, 0.72, A.top + 0.02, wall - 0.12);
  put(new THREE.BoxGeometry(0.03, 0.02, 0.03), mat.plate, 0.72, A.top + 0.05, wall - 0.12);
  return { engine, front };
}
