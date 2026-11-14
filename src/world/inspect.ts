import * as THREE from 'three';
import type { EnvSample } from './environment';
import { KICKER_HEIGHT, type TerrainField } from './terrainField';

/**
 * Dev inspection view: the terrain coloured by what shapes it instead of by its ground cover.
 * - landforms: valley lines, floors, flanks and ridge tops, with 5 m contour lines;
 * - layers: what is laid over the landform (moguls, kicker ridges, drops, launch humps);
 * - steepness: the slope of each face, in bands;
 * - moisture, curvature, exposure: the ground's environment (see Environment), as colour scales.
 */
export type InspectMode = 'landforms' | 'layers' | 'steepness' | 'moisture' | 'curvature' | 'exposure';

export const INSPECT_MODES: readonly InspectMode[] = ['landforms', 'layers', 'steepness', 'moisture', 'exposure', 'curvature'];

interface LegendEntry {
  colour: string;
  label: string;
}

const C = {
  valleyLine: '#1f4fa8',
  valleyFloor: '#6c9be0',
  lowerFlank: '#6fc1b0',
  upperFlank: '#d2d36c',
  ridgeTop: '#e0893a',
  gully: '#3d6f6a',
  ledge: '#a58fd6',
  openSlope: '#d6d0bf',
  base: '#cfcfc8',
  moguls: '#8f8f88',
  kicker: '#e8c547',
  dropFace: '#8a4fd0',
  hump: '#d8443a',
  setValley: '#3fb6c9',
  setHill: '#a8743f',
  steep0: '#9fd4a0',
  steep15: '#d9e27a',
  steep25: '#f0c04a',
  steep30: '#ec8a3a',
  steep35: '#d8443a',
  dry: '#c9a66b',
  middling: '#d8d8cc',
  wet: '#2f6fb3',
  convex: '#d8643a',
  flat: '#d8d8cc',
  concave: '#3a74c9',
  sunny: '#f0b43c',
  shaded: '#4a5a9a',
};

/** Legends for the HUD, per mode. */
export const INSPECT_LEGENDS: Record<InspectMode, { title: string; entries: LegendEntry[] }> = {
  landforms: {
    title: 'Landforms',
    entries: [
      { colour: C.valleyLine, label: 'valley line' },
      { colour: C.valleyFloor, label: 'valley floor' },
      { colour: C.lowerFlank, label: 'flank, low' },
      { colour: C.upperFlank, label: 'flank, high' },
      { colour: C.ridgeTop, label: 'ridge top' },
      { colour: C.ledge, label: 'ledge' },
      { colour: C.gully, label: 'gully (darker = deeper)' },
      { colour: C.openSlope, label: 'open slope (no valley)' },
      { colour: '#555', label: 'contour every 5 m' },
    ],
  },
  layers: {
    title: 'Layers',
    entries: [
      { colour: C.base, label: 'mogul top' },
      { colour: C.moguls, label: 'mogul hollow' },
      { colour: C.kicker, label: 'kicker ridge' },
      { colour: C.dropFace, label: 'drop' },
      { colour: C.hump, label: 'launch hump / ramp' },
      { colour: C.setValley, label: 'set-piece valley (varied)' },
      { colour: C.setHill, label: 'set-piece hill (varied)' },
    ],
  },
  steepness: {
    title: 'Steepness',
    entries: [
      { colour: C.steep0, label: 'under 15°' },
      { colour: C.steep15, label: '15–25°' },
      { colour: C.steep25, label: '25–30°' },
      { colour: C.steep30, label: '30–35°' },
      { colour: C.steep35, label: 'over 35°' },
    ],
  },
  moisture: {
    title: 'Moisture',
    entries: [
      { colour: C.dry, label: 'dry (ridges, convex edges)' },
      { colour: C.middling, label: 'middling' },
      { colour: C.wet, label: 'wet (floors, gullies, hollows)' },
    ],
  },
  curvature: {
    title: 'Curvature',
    entries: [
      { colour: C.convex, label: 'convex (crests, edges, ribs)' },
      { colour: C.flat, label: 'even' },
      { colour: C.concave, label: 'concave (hollows, grooves)' },
    ],
  },
  exposure: {
    title: 'Sun exposure',
    entries: [
      { colour: C.sunny, label: 'turned toward the sun' },
      { colour: C.middling, label: 'like the plain slope' },
      { colour: C.shaded, label: 'turned away' },
    ],
  },
};

const col = Object.fromEntries(Object.entries(C).map(([k, v]) => [k, new THREE.Color(v)])) as Record<keyof typeof C, THREE.Color>;
/**
 * The plain mountain slope already faces the sun (exposure ≈0.7, measured median), so the exposure
 * view centres on that and shows faces turned toward or away from the sun relative to it.
 */
const PLAIN_EXPOSURE = 0.7;
const EXPOSURE_RANGE = 0.35;
/** Contour interval (m) in the landforms view. */
const CONTOUR = 5;
/** A valley shallower than this (m) is too faint to count: the ground counts as open slope. */
const FAINT_VALLEY = 8;
/** Ledge strength (0..1) from which a flank is marked as ledge. */
const LEDGE_MARK = 0.5;
/** Gully groove depth (m) shown at full colour. */
const GULLY_MARK = 1.5;
/** Ground within this height (m) of the ridge tops counts as ridge top. */
const RIDGE_TOP = 1.5;

/** Colours a terrain face (corners a, b, c, with this normal) for the inspection view. */
export function inspectColour(
  field: TerrainField,
  mode: InspectMode,
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  normal: THREE.Vector3,
  env: EnvSample,
  out: THREE.Color,
): THREE.Color {
  const x = (a.x + b.x + c.x) / 3;
  const z = (a.z + b.z + c.z) / 3;
  if (mode === 'steepness') {
    const deg = (Math.acos(Math.min(1, normal.y)) * 180) / Math.PI;
    return out.copy(deg < 15 ? col.steep0 : deg < 25 ? col.steep15 : deg < 30 ? col.steep25 : deg < 35 ? col.steep30 : col.steep35);
  }

  if (mode === 'moisture') return scale(col.dry, col.middling, col.wet, env.moisture * 2 - 1, out);
  if (mode === 'curvature') return scale(col.concave, col.flat, col.convex, env.curvature, out);
  if (mode === 'exposure') return scale(col.shaded, col.middling, col.sunny, (env.exposure - PLAIN_EXPOSURE) / EXPOSURE_RANGE, out);

  if (mode === 'layers') {
    const s = field.surface(x, z);
    out.copy(col.moguls).lerp(col.base, THREE.MathUtils.clamp(0.5 + s.moguls / 3, 0, 1));
    if (s.kickers > 0.3) out.lerp(col.kicker, Math.min(1, 0.35 + s.kickers / KICKER_HEIGHT));
    const p = field.features.parts(x, z);
    const dropSlope = (field.features.parts(x, z + 1).drop - field.features.parts(x, z - 1).drop) / 2;
    if (p.bell < -0.5) out.copy(col.setValley);
    if (p.bell > 0.5) out.copy(col.setHill);
    if (dropSlope > 0.03) out.copy(col.dropFace);
    if (p.lip > 0.15) out.copy(col.hump);
    return out;
  }

  const spot = field.landforms.inspect(x, z);
  if (spot.depth < FAINT_VALLEY) out.copy(col.openSlope);
  else if (spot.below < RIDGE_TOP) out.copy(col.ridgeTop);
  else if (spot.fromLine < 2.5) out.copy(col.valleyLine);
  else if (spot.flank < 0) out.copy(col.valleyFloor);
  else out.copy(col.lowerFlank).lerp(col.upperFlank, Math.min(1, spot.flank));
  if (spot.ledge > LEDGE_MARK && spot.depth >= FAINT_VALLEY) out.copy(col.ledge);
  // Gully grooves shade in over the landform colour: full colour at GULLY_MARK m deep.
  if (spot.gully < 0) out.lerp(col.gully, Math.min(1, -spot.gully / GULLY_MARK));
  // Contours of the smooth landform (moguls left out), so the lines run clean.
  const ha = field.landform(a.x, a.z);
  const hb = field.landform(b.x, b.z);
  const hc = field.landform(c.x, c.z);
  if (Math.floor(Math.min(ha, hb, hc) / CONTOUR) !== Math.floor(Math.max(ha, hb, hc) / CONTOUR)) out.multiplyScalar(0.55);
  return out;
}

/** A three-colour scale: low at −1, mid at 0, high at 1. */
function scale(low: THREE.Color, mid: THREE.Color, high: THREE.Color, t: number, out: THREE.Color): THREE.Color {
  return t < 0 ? out.copy(mid).lerp(low, Math.min(1, -t)) : out.copy(mid).lerp(high, Math.min(1, t));
}
