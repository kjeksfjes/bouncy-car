import * as THREE from 'three';
import { hash2 } from './noise';
import type { TerrainField } from './terrainField';

/** Grid cell size for tree candidates; at most one tree per cell, so it sets how close a copse can pack. */
export const TREE_CELL = 6;
/**
 * Tree species and their collider per unit of tree scale: radius (a spruce's covers its lowest
 * branches; pines and broadleaf trees branch high, so only the trunk counts) and half height.
 */
export type Species = 'spruce' | 'pine' | 'broadleaf';
export const SPECIES: Record<Species, { radius: number; halfHeight: number }> = {
  spruce: { radius: 0.45, halfHeight: 2.2 },
  pine: { radius: 0.24, halfHeight: 2.6 },
  broadleaf: { radius: 0.28, halfHeight: 2.0 },
};
/** The widest collider radius per unit of scale, for search reach. */
const MAX_RADIUS = Math.max(...Object.values(SPECIES).map((s) => s.radius));
/** Cache cap; the cache is simply cleared when full (lookups are cheap to redo). */
const CACHE_LIMIT = 20000;

export interface Tree {
  x: number;
  y: number;
  z: number;
  scale: number;
  yaw: number;
  species: Species;
  /** Snow on the branches: a spruce standing where the ground is snowy. */
  snowy: boolean;
  /** Collider radius (m). */
  radius: number;
}

const _n = new THREE.Vector3();

/**
 * Deterministic tree placement. The single source of truth for where trees
 * are: chunks use it to build meshes and colliders, the AI uses it to see
 * trees anywhere without raycasting.
 */
export class TreeLayout {
  private readonly cache = new Map<number, Tree | null>();

  constructor(private readonly field: TerrainField) {}

  /** The tree in grid cell (cellX, cellZ), if there is one. */
  inCell(cellX: number, cellZ: number): Tree | null {
    // Cantor-free key: cells stay well inside ±2^20 for any reachable distance.
    const key = (cellX + 1048576) * 2097152 + (cellZ + 1048576);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const seed = this.field.seed;
    let tree: Tree | null = null;
    const x = (cellX + hash2(cellX, cellZ, seed + 11)) * TREE_CELL;
    const z = (cellZ + hash2(cellX, cellZ, seed + 12)) * TREE_CELL;
    if (
      hash2(cellX, cellZ, seed + 13) < this.field.treeDensity(x, z) &&
      this.field.normal(x, z, _n).y >= 0.82
    ) {
      const species = this.field.biome.treeSpecies(x, z, hash2(cellX, cellZ, seed + 16), hash2(cellX, cellZ, seed + 17));
      const scale = (0.8 + hash2(cellX, cellZ, seed + 14) * 0.8) * this.field.treeScale(z);
      tree = {
        x,
        y: this.field.height(x, z) - 0.2,
        z,
        scale,
        yaw: hash2(cellX, cellZ, seed + 15) * Math.PI * 2,
        species,
        snowy: species === 'spruce' && this.field.biome.snowCover(x, z, _n) > 0.5,
        radius: SPECIES[species].radius * scale,
      };
    }
    if (this.cache.size >= CACHE_LIMIT) this.cache.clear();
    this.cache.set(key, tree);
    return tree;
  }

  /** Forgets every cached tree (after the biomes change, see Biome.shift). */
  invalidate(): void {
    this.cache.clear();
  }

  /** Nearest tree whose trunk comes within `clearance` of (x, z), or null. */
  blocking(x: number, z: number, clearance: number): Tree | null {
    const reach = clearance + MAX_RADIUS * 1.6; // 1.6 = max tree scale
    let best: Tree | null = null;
    let bestGap = Infinity;
    for (let cz = Math.floor((z - reach) / TREE_CELL); cz <= Math.floor((z + reach) / TREE_CELL); cz++) {
      for (let cx = Math.floor((x - reach) / TREE_CELL); cx <= Math.floor((x + reach) / TREE_CELL); cx++) {
        const t = this.inCell(cx, cz);
        if (!t) continue;
        const gap = Math.hypot(t.x - x, t.z - z) - t.radius;
        if (gap < clearance && gap < bestGap) {
          best = t;
          bestGap = gap;
        }
      }
    }
    return best;
  }
}
