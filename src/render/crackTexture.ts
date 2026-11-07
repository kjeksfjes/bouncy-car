import * as THREE from 'three';

const SIZE = 256;

/**
 * A cracked-glass texture: tinted glass with a spiderweb of light cracks
 * radiating from `center` (UV space, 0..1). Alpha carries the tint, so the
 * pane stays see-through between cracks.
 */
export function crackTexture(center: THREE.Vector2, tint: string, tintAlpha: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const color = new THREE.Color(tint);
  ctx.fillStyle = `rgba(${color.r * 255}, ${color.g * 255}, ${color.b * 255}, ${tintAlpha})`;
  ctx.fillRect(0, 0, SIZE, SIZE);

  const cx = center.x * SIZE;
  const cy = (1 - center.y) * SIZE;
  ctx.strokeStyle = 'rgba(232, 240, 248, 0.9)';
  ctx.lineCap = 'round';

  // Radial cracks: jagged polylines running out past the pane's edge.
  const rays = 7 + Math.floor(Math.random() * 5);
  const rayPoints: [number, number][][] = [];
  for (let i = 0; i < rays; i++) {
    const angle = (i / rays) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
    const points: [number, number][] = [[cx, cy]];
    let r = 0;
    let a = angle;
    while (r < SIZE * 1.2) {
      r += 12 + Math.random() * 22;
      a += (Math.random() - 0.5) * 0.35;
      points.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    rayPoints.push(points);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    points.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.stroke();
  }

  // Concentric rings linking neighbouring rays: the "web".
  ctx.lineWidth = 1.1;
  for (const ring of [2, 4, 7]) {
    ctx.beginPath();
    for (let i = 0; i <= rays; i++) {
      const ray = rayPoints[i % rays];
      const [x, y] = ray[Math.min(ring, ray.length - 1)];
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Crushed, frosted spot where it was hit.
  const spot = ctx.createRadialGradient(cx, cy, 0, cx, cy, 18);
  spot.addColorStop(0, 'rgba(235, 242, 250, 0.95)');
  spot.addColorStop(1, 'rgba(235, 242, 250, 0)');
  ctx.fillStyle = spot;
  ctx.fillRect(cx - 18, cy - 18, 36, 36);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
