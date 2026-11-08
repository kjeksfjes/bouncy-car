import * as THREE from 'three';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';

type Kind = 'burst' | 'glow' | 'halo' | 'streak' | 'ghost' | 'disc' | 'ring';

/**
 * Lens flare elements: texture kind, size (CSS px, scaled by the pixel ratio), position along the
 * line from the sun through the screen centre (0 = at the sun, 1 = mirrored to the other side),
 * and colour ('sun' for sunlight; the halo carries its own rainbow). At the sun: a starburst of
 * fine rays, a hot core, a faint rainbow halo and a thin horizontal (anamorphic) streak. Across
 * the screen: aperture-shaped ghosts with coloured fringes, in a spread of sizes, and a few
 * soft discs and rings.
 */
const ELEMENTS: [kind: Kind, size: number, distance: number, color: string][] = [
  ['burst', 340, 0, 'sun'],
  ['glow', 110, 0, '#ffffff'],
  ['halo', 620, 0, '#ffffff'],
  ['streak', 760, 0, '#a9c8ff'],
  ['ghost', 40, 0.18, '#d8ecff'],
  ['disc', 18, 0.26, '#ffe2b0'],
  ['ghost', 70, 0.38, '#c7f2d8'],
  ['disc', 110, 0.5, '#9ab8ff'],
  ['ghost', 28, 0.58, '#ffd2f0'],
  ['ring', 180, 0.7, '#b8d4ff'],
  ['ghost', 95, 0.82, '#ffeccc'],
  ['disc', 14, 0.9, '#ffffff'],
  ['ghost', 150, 1, '#cfe3ff'],
];

/** A regular hexagon path (an aperture shape) centred at (c, c). */
function hexagon(g: CanvasRenderingContext2D, c: number, radius: number): void {
  g.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const x = c + Math.cos(a) * radius;
    const y = c + Math.sin(a) * radius;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
}

/** Draws a flare texture on a canvas (white or coloured shapes on transparent; tinted per element). */
function flareTexture(kind: Kind): THREE.Texture {
  const size = kind === 'burst' || kind === 'streak' ? 512 : 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const c = size / 2;
  const radial = (stops: [number, string][]) => {
    const gradient = g.createRadialGradient(c, c, 0, c, c, c);
    for (const [at, color] of stops) gradient.addColorStop(at, color);
    g.fillStyle = gradient;
    g.fillRect(0, 0, size, size);
  };
  if (kind === 'burst') {
    // Fine rays of random length and brightness from a soft core.
    radial([[0, 'rgba(255,255,255,0.7)'], [0.06, 'rgba(255,255,255,0.3)'], [0.25, 'rgba(255,255,255,0.05)'], [1, 'rgba(255,255,255,0)']]);
    g.globalCompositeOperation = 'lighter';
    const rays = 28;
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2 + (Math.random() - 0.5) * 0.08;
      const length = c * (0.25 + Math.random() * 0.55);
      const gradient = g.createLinearGradient(c, c, c + Math.cos(a) * length, c + Math.sin(a) * length);
      gradient.addColorStop(0, `rgba(255,255,255,${0.1 + Math.random() * 0.15})`);
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      g.strokeStyle = gradient;
      g.lineWidth = 0.6 + Math.random() * 1.0;
      g.beginPath();
      g.moveTo(c, c);
      g.lineTo(c + Math.cos(a) * length, c + Math.sin(a) * length);
      g.stroke();
    }
  } else if (kind === 'glow') {
    radial([[0, 'rgba(255,255,255,1)'], [0.2, 'rgba(255,255,255,0.5)'], [0.5, 'rgba(255,255,255,0.1)'], [1, 'rgba(255,255,255,0)']]);
  } else if (kind === 'halo') {
    // A thin rainbow ring: blue inside to red outside, very faint.
    const bands = ['rgba(120,140,255,0.03)', 'rgba(110,220,255,0.04)', 'rgba(140,255,160,0.04)', 'rgba(255,240,120,0.04)', 'rgba(255,150,90,0.035)', 'rgba(255,90,90,0.025)'];
    const gradient = g.createRadialGradient(c, c, 0, c, c, c);
    gradient.addColorStop(0.7, 'rgba(0,0,0,0)');
    bands.forEach((color, i) => gradient.addColorStop(0.74 + i * 0.035, color));
    gradient.addColorStop(0.98, 'rgba(0,0,0,0)');
    g.fillStyle = gradient;
    g.fillRect(0, 0, size, size);
  } else if (kind === 'streak') {
    // A thin horizontal line, brightest in the middle, soft above and below.
    const along = g.createLinearGradient(0, c, size, c);
    along.addColorStop(0, 'rgba(255,255,255,0)');
    along.addColorStop(0.5, 'rgba(255,255,255,0.28)');
    along.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = along;
    for (let i = 0; i < 4; i++) {
      g.globalAlpha = 0.5 / (i + 1);
      g.fillRect(0, c - 1 - i * 2, size, 2 + i * 4);
    }
  } else if (kind === 'ghost') {
    // A faint aperture with a coloured fringe: reddish outside, bluish inside.
    g.filter = 'blur(1.5px)';
    g.fillStyle = 'rgba(255,255,255,0.08)';
    hexagon(g, c, c * 0.82);
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(255,140,120,0.22)';
    hexagon(g, c, c * 0.86);
    g.stroke();
    g.strokeStyle = 'rgba(130,170,255,0.2)';
    hexagon(g, c, c * 0.78);
    g.stroke();
  } else if (kind === 'disc') {
    radial([[0, 'rgba(255,255,255,0.2)'], [0.7, 'rgba(255,255,255,0.12)'], [1, 'rgba(255,255,255,0)']]);
  } else {
    radial([[0.72, 'rgba(255,255,255,0)'], [0.86, 'rgba(255,255,255,0.13)'], [1, 'rgba(255,255,255,0)']]);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * The sun's lens flare. Three's Lensflare hides it behind anything drawn in front (terrain, trees,
 * the car) by sampling the frame where the sun is. Keep the returned object at the sun's
 * direction from the camera each frame (see Stage.follow).
 */
export function createSunFlare(pixelRatio: number, sunColor: THREE.Color): THREE.Object3D {
  const textures = new Map<Kind, THREE.Texture>();
  const flare = new Lensflare();
  for (const [kind, size, distance, color] of ELEMENTS) {
    let texture = textures.get(kind);
    if (!texture) textures.set(kind, (texture = flareTexture(kind)));
    flare.addElement(new LensflareElement(texture, size * pixelRatio, distance, color === 'sun' ? sunColor : new THREE.Color(color)));
  }
  return flare;
}
