// Top-down relief map and steepness numbers for the terrain generator, straight from the
// TerrainField module (no game running), so landform changes can be judged as a whole.
//
// Usage (with `npm run dev` running):
//   node scripts/terrain-map.mjs [--seed 1977] [--z 0,5000] [--size 1024] [--preset classic] [--tag name] [--landform]
// --landform maps the smooth landform alone (no moguls, kicker ridges or drops), to see its shapes.
// For each downhill distance in --z, maps a size × size m square starting there, centred on x = 0,
// at the 2 m mesh grid. Writes test-results/terrain/<tag>-<z>.png and prints:
//   - steep: share of ground steeper than 25/30/35° with the drops left out (the climbs a car may
//     face anywhere), and the steepest 0.1 %;
//   - µs per height() call (chunk builds and every ground query pay this).
//   - landform (if TerrainField.landform exists): the same for the smooth landform alone.
// Map: hillshade of the height with the base slope and drops taken out, tinted low (green-blue) to high
// (tan), 5 m contours, red where the ground (drops left out) is steeper than 30°.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const seed = Number(args.seed ?? 1977);
const starts = String(args.z ?? '0,5000').split(',').map(Number);
const size = Number(args.size ?? 1024);
const preset = args.preset ?? 'classic';
const tag = args.tag ?? 'map';
const landformOnly = process.argv.includes('--landform');
const outDir = 'test-results/terrain';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('pageerror:', e.message));
// Any non-HTML file gives a page on the dev server's origin without booting the game.
await page.goto('http://localhost:5291/package.json');

for (const start of starts) {
  const result = await page.evaluate(
    async ({ seed, start, size, preset, landformOnly }) => {
      const { TerrainField } = await import('/src/world/terrainField.ts');
      const field = new TerrainField(seed, preset);
      const step = 2;
      const n = size / step + 1;
      const x0 = -size / 2;
      const z0 = -start;
      const h = new Float64Array(n * n);
      const drop = new Float64Array(n * n);
      const t0 = performance.now();
      const sample = landformOnly ? (x, z) => field.landform(x, z) : (x, z) => field.height(x, z);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[j * n + i] = sample(x0 + i * step, z0 - j * step);
      const usPerCall = ((performance.now() - t0) * 1000) / (n * n);
      // The drops (and their humps) are set pieces, not landform: left out of the steepness.
      if (!landformOnly) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) drop[j * n + i] = field.features.height(x0 + i * step, z0 - j * step);

      const SLOPE = 0.32;
      const detrended = (i, j) => h[j * n + i] - drop[j * n + i] - (z0 - j * step) * SLOPE;
      let lo = Infinity, hi = -Infinity;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const d = detrended(i, j); lo = Math.min(lo, d); hi = Math.max(hi, d); }

      const canvas = new OffscreenCanvas(n - 2, n - 2);
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(n - 2, n - 2);
      const grads = [];
      const light = [-0.5, -0.6, 0.62]; // from the upper left of the map
      const ln = Math.hypot(...light);
      for (let j = 1; j < n - 1; j++) {
        for (let i = 1; i < n - 1; i++) {
          const k = j * n + i;
          // Real gradient without drops: what the car climbs.
          const gx = (h[k + 1] - drop[k + 1] - h[k - 1] + drop[k - 1]) / (2 * step);
          const gz = (h[k + n] - drop[k + n] - h[k - n] + drop[k - n]) / (2 * step);
          const g = Math.hypot(gx, gz);
          grads.push(g);
          // Shade the detrended surface (x right, map y downhill).
          const dx = (detrended(i + 1, j) - detrended(i - 1, j)) / (2 * step);
          const dy = (detrended(i, j + 1) - detrended(i, j - 1)) / (2 * step);
          const nl = Math.hypot(dx, dy, 1);
          const shade = Math.max(0, (-dx * light[0] - dy * light[1] + light[2]) / (nl * ln));
          const e = (detrended(i, j) - lo) / Math.max(1e-6, hi - lo);
          let r = 70 + e * 120, gg = 120 + e * 60, b = 120 - e * 40;
          const c = detrended(i, j) / 5;
          const contour = Math.floor(c) !== Math.floor(detrended(i + 1, j) / 5) || Math.floor(c) !== Math.floor(detrended(i, j + 1) / 5);
          const s = 0.35 + 0.85 * shade;
          r *= s; gg *= s; b *= s;
          if (contour) { r *= 0.7; gg *= 0.7; b *= 0.7; }
          if (g > Math.tan((30 * Math.PI) / 180)) { r = 220; gg = 40; b = 40; }
          const o = ((j - 1) * (n - 2) + (i - 1)) * 4;
          img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
      grads.sort((a, b) => a - b);
      // The smooth landform alone (no moguls, kicker ridges or drops): the climbs that last.
      let land = null;
      if (field.landform) {
        const lg = [];
        const e = 1;
        for (let j = 0; j < n; j += 2) for (let i = 0; i < n; i += 2) {
          const x = x0 + i * step, z = z0 - j * step;
          lg.push(Math.hypot(field.landform(x + e, z) - field.landform(x - e, z), field.landform(x, z + e) - field.landform(x, z - e)) / (2 * e));
        }
        lg.sort((a, b) => a - b);
        land = { over25: lg.filter((g) => g > Math.tan(25 * Math.PI / 180)).length / lg.length, p999: (Math.atan(lg[Math.floor(lg.length * 0.999)]) * 180) / Math.PI, max: (Math.atan(lg[lg.length - 1]) * 180) / Math.PI };
      }
      const share = (deg) => grads.filter((g) => g > Math.tan((deg * Math.PI) / 180)).length / grads.length;
      const deg = (g) => (Math.atan(g) * 180) / Math.PI;
      return {
        bytes,
        usPerCall,
        relief: hi - lo,
        land,
        steep: { over25: share(25), over30: share(30), over35: share(35), p999: deg(grads[Math.floor(grads.length * 0.999)]), max: deg(grads[grads.length - 1]) },
      };
    },
    { seed, start, size, preset, landformOnly },
  );
  const file = `${outDir}/${tag}-${start}.png`;
  writeFileSync(file, Buffer.from(result.bytes));
  const pct = (v) => `${(v * 100).toFixed(2)}%`;
  const s = result.steep;
  const l = result.land;
  console.log(
    `${file}: relief ${result.relief.toFixed(1)} m · >25° ${pct(s.over25)} · >30° ${pct(s.over30)} · >35° ${pct(s.over35)} · p99.9 ${s.p999.toFixed(1)}° · max ${s.max.toFixed(1)}° · ${result.usPerCall.toFixed(2)} µs/height` +
      (l ? `\n  landform: >25° ${pct(l.over25)} · p99.9 ${l.p999.toFixed(1)}° · max ${l.max.toFixed(1)}°` : ''),
  );
}
await browser.close();
