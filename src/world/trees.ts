import * as THREE from 'three';
import { hash2 } from './noise';
import type { TerrainField } from './terrainField';

/** Grid cell size for tree candidates; at most one tree per cell. */
export const TREE_CELL = 9;
/** Trunk collider radius per unit of tree scale (wide enough to cover the lowest branches). */
export const TREE_RADIUS = 0.45;
/** Cache cap; the cache is simply cleared when full (lookups are cheap to redo). */
const CACHE_LIMIT = 20000;

export interface Tree {
  x: number;
  y: number;
  z: number;
  scale: number;
  yaw: number;
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
      tree = {
        x,
        y: this.field.height(x, z) - 0.2,
        z,
        scale: (0.8 + hash2(cellX, cellZ, seed + 14) * 0.8) * this.field.treeScale(z),
        yaw: hash2(cellX, cellZ, seed + 15) * Math.PI * 2,
      };
    }
    if (this.cache.size >= CACHE_LIMIT) this.cache.clear();
    this.cache.set(key, tree);
    return tree;
  }

  /** Nearest tree whose trunk comes within `clearance` of (x, z), or null. */
  blocking(x: number, z: number, clearance: number): Tree | null {
    const reach = clearance + TREE_RADIUS * 1.6; // 1.6 = max tree scale
    let best: Tree | null = null;
    let bestGap = Infinity;
    for (let cz = Math.floor((z - reach) / TREE_CELL); cz <= Math.floor((z + reach) / TREE_CELL); cz++) {
      for (let cx = Math.floor((x - reach) / TREE_CELL); cx <= Math.floor((x + reach) / TREE_CELL); cx++) {
        const t = this.inCell(cx, cz);
        if (!t) continue;
        const gap = Math.hypot(t.x - x, t.z - z) - TREE_RADIUS * t.scale;
        if (gap < clearance && gap < bestGap) {
          best = t;
          bestGap = gap;
        }
      }
    }
    return best;
  }
}
