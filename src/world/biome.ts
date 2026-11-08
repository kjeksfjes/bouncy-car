import * as THREE from 'three';
import type { NoiseFunction2D } from 'simplex-noise';
import { makeNoise, smoothstep } from './noise';

/**
 * Biomes along the descent (distance downhill from the spawn, −Z): snowy mountain and snowy
 * forest, then a thaw where the snow breaks up into patches, then grassland. Feel values.
 */
const BIOME = {
  /** The thaw: snow starts breaking up here (m downhill) and is all gone by `thawEnd`. */
  thawStart: 3500,
  thawEnd: 5000,
  /** Snow patches: noise scales (m) and how much they shift where the snow lingers. */
  patchScale: 46,
  patchDetailScale: 13,
  patchDetail: 0.35,
  patchWeight: 0.7,
  /** Half width of a patch's edge in that noise: small, so each face is snow or bare. */
  patchEdge: 0.025,
  /** Snow lingers longest on flatter ground and on faces turned away from the sun. */
  flatBonus: 0.25,
  shadeBonus: 0.3,
  /** Bare ground is dry and brown just after the snow, lush green from `greenAt` m further down. */
  greenAt: 900,
  /** Dirt patches: noise scale (m) and the noise range over which they fade in. */
  dirtScale: 28,
  dirtFrom: 0.35,
  dirtTo: 0.65,
  /**
   * Stone by steepness (normal.y, cos of the slope angle): from ≈37° to full at ≈50°. Steeper than
   * the drop walls' snow-to-ice range, since bare ground holds steeper than packed snow looks.
   */
  stoneFrom: 0.8,
  stoneTo: 0.64,
};

/** Ground colours. */
export const GROUND = {
  snow: new THREE.Color('#eef3f9'),
  snowShade: new THREE.Color('#dde6f0'),
  /** Wind-packed snow on steep faces (drop walls): a cooler blue hint, still light. */
  ice: new THREE.Color('#c4d7ea'),
  rock: new THREE.Color('#646872'),
  grass: new THREE.Color('#6b9a48'),
  grassDry: new THREE.Color('#a49a63'),
  dirt: new THREE.Color('#7b5b3f'),
  stone: new THREE.Color('#7f7b74'),
};

/**
 * Snow by face steepness (normal.y). Drop walls peak around 47° (base slope 0.32 + max drop
 * gradient 0.75), so they stay snow with an icy tint; rock only shows on near-vertical faces.
 */
const SNOW_SURFACE = {
  /** snowShade → snow from ≈32° to ≈14°. */
  shadeFrom: 0.85,
  shadeTo: 0.97,
  /** Icy tint fades in from ≈30° and is full at ≈50°. */
  iceFrom: 0.86,
  iceTo: 0.64,
  /** Rock fades in from ≈55° and is full at ≈63°, under snow and bare ground alike. */
  rockFrom: 0.57,
  rockTo: 0.45,
};

/** What the ground is made of at a spot: shares of snow and of bare grass, dirt and stone (summing to 1). */
export interface GroundMix {
  snow: number;
  grass: number;
  dirt: number;
  stone: number;
}

const _bare = new THREE.Color();

/** Ground cover across the biomes. Pure functions of position (and the surface's normal). */
export class Biome {
  private readonly patch: NoiseFunction2D;
  private readonly dirt: NoiseFunction2D;

  constructor(
    seed: number,
    private readonly sun: THREE.Vector3,
  ) {
    this.patch = makeNoise(seed + 20);
    this.dirt = makeNoise(seed + 21);
  }

  /** 1 where it's all snow, 0 where the snow is gone, patchy through the thaw. */
  snowCover(x: number, z: number, normal: THREE.Vector3): number {
    const B = BIOME;
    const d = -z;
    if (d <= B.thawStart) return 1;
    if (d >= B.thawEnd + 200) return 0;
    // Where the thaw has got to (+1.2 before it, −1.2 after), shifted by patches, flat ground and shade.
    const thaw = (1 - smoothstep(B.thawStart, B.thawEnd, d)) * 2.4 - 1.2;
    const patch = this.patch(x / B.patchScale, z / B.patchScale) + B.patchDetail * this.patch(x / B.patchDetailScale + 40, z / B.patchDetailScale);
    const flat = smoothstep(0.9, 1, normal.y);
    const shade = smoothstep(0.3, -0.1, normal.dot(this.sun));
    // A narrow edge: low-poly faces read best as snow or bare, a half-blend looks washed out.
    return smoothstep(-B.patchEdge, B.patchEdge, thaw + B.patchWeight * patch + B.flatBonus * flat + B.shadeBonus * shade);
  }

  /** What the ground is made of here (see GroundMix). */
  mix(x: number, z: number, normal: THREE.Vector3, out: GroundMix = { snow: 0, grass: 0, dirt: 0, stone: 0 }): GroundMix {
    const B = BIOME;
    const snow = this.snowCover(x, z, normal);
    const stone = smoothstep(B.stoneFrom, B.stoneTo, normal.y);
    const dirt = (1 - stone) * smoothstep(B.dirtFrom, B.dirtTo, this.dirt(x / B.dirtScale, z / B.dirtScale));
    const bare = 1 - snow;
    out.snow = snow;
    out.stone = bare * stone;
    out.dirt = bare * dirt;
    out.grass = bare * (1 - stone - dirt);
    return out;
  }

  /** The ground's colour for a terrain face at (x, z) with this normal. */
  colour(x: number, z: number, normal: THREE.Vector3, out: THREE.Color): THREE.Color {
    const B = BIOME;
    const S = SNOW_SURFACE;
    const m = this.mix(x, z, normal, _mix);
    if (m.snow > 0) {
      out.copy(GROUND.snowShade).lerp(GROUND.snow, smoothstep(S.shadeFrom, S.shadeTo, normal.y));
      out.lerp(GROUND.ice, smoothstep(S.iceFrom, S.iceTo, normal.y));
    }
    if (m.snow < 1) {
      const green = smoothstep(B.thawStart, B.thawEnd + B.greenAt, -z);
      _bare.copy(GROUND.grassDry).lerp(GROUND.grass, green).multiplyScalar(m.grass);
      _bare.add(_c.copy(GROUND.dirt).multiplyScalar(m.dirt)).add(_c.copy(GROUND.stone).multiplyScalar(m.stone));
      _bare.multiplyScalar(1 / (1 - m.snow));
      if (m.snow > 0) out.lerp(_bare, 1 - m.snow);
      else out.copy(_bare);
    }
    return out.lerp(GROUND.rock, smoothstep(S.rockFrom, S.rockTo, normal.y));
  }
}

const _mix: GroundMix = { snow: 0, grass: 0, dirt: 0, stone: 0 };
const _c = new THREE.Color();
