import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
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
 * subdivided across (the crush bends a part only at its vertices).
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
  /** The battery's positive terminal. */
  taillight: THREE.Material;
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
  // Water outlet at the front of the intake, where the upper hose joins.
  put(new THREE.BoxGeometry(0.07, 0.05, 0.07), mat.aluminium, 0, 0.74, FRONT + 0.05);

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
  put(new THREE.CylinderGeometry(0.035, 0.04, 0.018, 8), mat.aluminium, 0.18, R.top + 0.009, rz);
  // Hoses: the upper one from the top tank to the water outlet on the intake, the lower one from
  // the bottom tank to the water pump.
  const back = rz + R.depth / 2;
  tube([[-0.22, R.top - 0.03, back - 0.01], [-0.18, R.top - 0.05, back + 0.06], [-0.06, 0.77, FRONT - 0.03], [0, 0.745, FRONT + 0.03]], 0.022, mat.dark);
  tube([[0.24, R.bottom + 0.03, back - 0.01], [0.22, R.bottom + 0.01, back + 0.07], [0.09, 0.53, pulleyZ - 0.03], [0.02, 0.6, pulleyZ + 0.01]], 0.022, mat.dark);

  // On the firewall: the two heater pipes the heater hoses run onto (through to the heater core in
  // the cabin), both coming from the back of the intake behind the valve covers; and the brake
  // booster (left, the driver's side), a broad shallow drum with its seam, the master cylinder
  // coming forward out of it and the twin-chamber fluid reservoir on top.
  const wall = FIREWALL_Z;
  put(new THREE.BoxGeometry(0.22, 0.09, 0.01), mat.engineBlock, 0.3, 0.75, wall - 0.005);
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

  // Washer fluid reservoir lying on the right wheel housing's crest (≈0.71–0.73 there): a low,
  // wide tank with rounded edges, long along the car, a round cap with its neck near the front end,
  // and two straps across it holding it down.
  const washer = { x: 0.75, base: 0.715, z: -1.5, width: 0.18, height: 0.085, length: 0.27 };
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
  // Coolant reservoir on the other side, with its cap.
  put(new THREE.BoxGeometry(0.1, 0.15, 0.11), mat.coolantTank, -bx, 0.63, rz + 0.02);
  put(new THREE.CylinderGeometry(0.025, 0.025, 0.025, 8), mat.dark, -bx, 0.718, rz + 0.02);
  return { engine, front };
}
