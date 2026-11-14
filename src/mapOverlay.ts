import * as THREE from 'three';
import type { RockLayout } from './world/details';
import { INSPECT_LEGENDS, type InspectMode } from './world/inspect';
import { CHUNK_SIZE } from './world/terrain';
import { MapObjects, TERRAIN_MAP, TerrainMap, type MapObject } from './world/terrainMap';
import type { TerrainField } from './world/terrainField';
import type { TreeLayout } from './world/trees';

/**
 * Time (ms) the map builds for each frame, and while paused, when the game leaves more to spare. A
 * ground tile takes ≈2–3 ms, ≈8 in the landforms view, and a piece of trees or boulders ≈5 (measured),
 * so a frame always builds one.
 */
const BUILD_MS = { playing: 6, paused: 14 };

/**
 * How the trees, boulders and loaded chunks are drawn, on layers `detail` times as fine as the ground
 * (sizes in m: a tree as its crown, a boulder at least `boulderMin` across its radius).
 */
const DRAW = {
  detail: 2,
  tree: { colour: '#1e5a32', radius: 3.5 },
  oak: { colour: '#0f3d1f', radius: 20 },
  boulder: { colour: '#3d4148', min: 4 },
  loaded: { fill: 'rgb(43 125 233 / 0.14)', line: '#2b7de9', width: 12 },
};

const _forward = new THREE.Vector3();

/**
 * Dev: the 2D map (see TerrainMap) over the middle of the screen, filling in as it builds: the ground,
 * then the trees and boulders on it, with the loaded chunks marked live, the car, a scale and a key.
 * The ground builds again when the inspection view changes.
 */
export class MapOverlay {
  private readonly box = document.createElement('div');
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  /** Trees and boulders; the loaded chunks, redrawn when they change. */
  private readonly things: CanvasRenderingContext2D;
  private readonly loaded: CanvasRenderingContext2D;
  private loadedKey = '';
  private readonly car = document.createElement('div');
  private readonly info = document.createElement('div');
  private map: TerrainMap;
  private readonly objects: MapObjects;

  constructor(
    private readonly field: TerrainField,
    trees: TreeLayout,
    rocks: RockLayout,
    private readonly centre: { x: number; z: number },
    mode: InspectMode | null,
  ) {
    const M = TERRAIN_MAP;
    this.box.id = 'map2d';
    this.canvas.width = this.canvas.height = M.size;
    this.context = this.canvas.getContext('2d')!;
    this.map = new TerrainMap(field, centre, mode);
    this.objects = new MapObjects(trees, rocks, this.map.x0, this.map.z0);
    // Drawn in world metres: x across, z down the map.
    const layer = () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = M.size * DRAW.detail;
      const context = canvas.getContext('2d')!;
      const k = DRAW.detail / M.step;
      context.setTransform(k, 0, 0, k, -this.map.x0 * k, -this.map.z0 * k);
      this.box.append(canvas);
      return context;
    };
    this.car.className = 'map-car';
    this.info.className = 'map-info';
    const km = 1000 / (M.size * M.step);
    const scale = document.createElement('div');
    scale.className = 'map-scale';
    scale.style.setProperty('--km', String(km));
    scale.innerHTML = '1 km<i></i>';
    this.box.append(this.canvas);
    this.things = layer();
    this.loaded = layer();
    const key = document.createElement('div');
    key.className = 'map-key';
    const swatch = (colour: string, label: string, square = false) =>
      `<span><i style="background:${colour};${square ? `border-radius:2px;border:1.5px solid ${DRAW.loaded.line}` : ''}"></i>${label}</span>`;
    key.innerHTML = swatch(DRAW.tree.colour, 'trees') + swatch(DRAW.boulder.colour, 'boulders') + swatch(DRAW.loaded.fill, 'loaded', true);
    this.box.append(this.car, scale, key, this.info);
    document.getElementById('hud')!.append(this.box);
  }

  /** The map's own inspection view (null: ground cover); a new one builds the ground again. */
  get mode(): InspectMode | null {
    return this.map.mode;
  }

  set mode(mode: InspectMode | null) {
    if (mode !== this.map.mode) this.map = new TerrainMap(this.field, this.centre, mode);
  }

  /** Builds on (the ground, then what's on it), and moves the car's marker and the loaded area. */
  update(car: { position: THREE.Vector3; quaternion: THREE.Quaternion }, paused: boolean, chunks: Iterable<[number, number]>): void {
    const start = performance.now();
    const budget = paused ? BUILD_MS.paused : BUILD_MS.playing;
    while (performance.now() - start < budget) {
      const tile = this.map.build();
      if (tile) {
        this.context.putImageData(this.map.image, 0, 0, tile.x, tile.y, TERRAIN_MAP.tile, TERRAIN_MAP.tile);
        continue;
      }
      const found = this.objects.find();
      if (!found) break;
      this.draw(found);
    }
    this.drawLoaded(chunks);
    const M = TERRAIN_MAP;
    const extent = M.size * M.step;
    const u = (car.position.x - this.map.x0) / extent;
    const v = (car.position.z - this.map.z0) / extent;
    this.car.hidden = u < 0 || u > 1 || v < 0 || v > 1;
    _forward.set(0, 0, -1).applyQuaternion(car.quaternion);
    // Screen right is +x and down is +z: the heading as a clockwise turn from straight up.
    const turn = Math.atan2(_forward.x, -_forward.z);
    this.car.style.left = `${u * 100}%`;
    this.car.style.top = `${v * 100}%`;
    this.car.style.transform = `translate(-50%, -50%) rotate(${turn}rad)`;
    const what = this.mode ? INSPECT_LEGENDS[this.mode].title : 'Ground cover';
    const left =
      this.map.progress < 1
        ? ` · ground ${Math.round(this.map.progress * 100)} %`
        : this.objects.progress < 1
          ? ` · trees and boulders ${Math.round(this.objects.progress * 100)} %`
          : '';
    const text = `${(extent / 1000).toFixed(1)} km across · ${what}${left}`;
    if (this.info.textContent !== text) this.info.textContent = text;
  }

  private draw(found: MapObject[]): void {
    const c = this.things;
    for (const o of found) {
      const look = o.kind === 'boulder' ? DRAW.boulder : o.kind === 'oak' ? DRAW.oak : DRAW.tree;
      c.fillStyle = look.colour;
      c.beginPath();
      c.arc(o.x, o.z, o.kind === 'boulder' ? Math.max(DRAW.boulder.min, o.radius) : (look as { radius: number }).radius, 0, Math.PI * 2);
      c.fill();
    }
  }

  /** The loaded chunks, shaded, with a line round their edge: redrawn when they change. */
  private drawLoaded(chunks: Iterable<[number, number]>): void {
    const list = [...chunks];
    const key = list.map(([x, z]) => `${x},${z}`).sort().join(';');
    if (key === this.loadedKey) return;
    this.loadedKey = key;
    const has = new Set(list.map(([x, z]) => `${x},${z}`));
    const c = this.loaded;
    const S = CHUNK_SIZE;
    c.save();
    c.resetTransform();
    c.clearRect(0, 0, c.canvas.width, c.canvas.height);
    c.restore();
    c.fillStyle = DRAW.loaded.fill;
    for (const [x, z] of list) c.fillRect(x * S, z * S, S, S);
    // The edge: each side of a chunk with no loaded neighbour there.
    c.strokeStyle = DRAW.loaded.line;
    c.lineWidth = DRAW.loaded.width;
    c.beginPath();
    for (const [x, z] of list) {
      if (!has.has(`${x},${z - 1}`)) (c.moveTo(x * S, z * S), c.lineTo((x + 1) * S, z * S));
      if (!has.has(`${x},${z + 1}`)) (c.moveTo(x * S, (z + 1) * S), c.lineTo((x + 1) * S, (z + 1) * S));
      if (!has.has(`${x - 1},${z}`)) (c.moveTo(x * S, z * S), c.lineTo(x * S, (z + 1) * S));
      if (!has.has(`${x + 1},${z}`)) (c.moveTo((x + 1) * S, z * S), c.lineTo((x + 1) * S, (z + 1) * S));
    }
    c.stroke();
  }

  dispose(): void {
    this.box.remove();
  }
}
