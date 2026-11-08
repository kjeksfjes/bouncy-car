// Renders the player's car orthographically at each reference drawing's own scale and lays the
// drawing's lines over it, so mismatches between model and drawing can be seen and measured.
//
// Usage (with `npm run dev` running): node scripts/overlay.mjs ref/1970s-muscle-car/views.json
// Writes test-results/overlay/<view>.png (overlay) and <view>-model.png (render only).
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const specPath = process.argv[2];
if (!specPath) throw new Error('Usage: node scripts/overlay.mjs <views.json>');
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const outDir = 'test-results/overlay';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('pageerror:', e.message));
await page.goto('http://localhost:5291/');
await page.waitForFunction(() => window.__bouncy !== undefined);
await page.waitForTimeout(1000);

// Hold the car level and still, high above the terrain.
await page.evaluate(() => {
  const b = window.__bouncy.car.body;
  const t = b.translation();
  b.setGravityScale(0, true);
  b.setTranslation({ x: t.x, y: window.__bouncy.field.height(t.x, t.z) + 8, z: t.z }, true);
  b.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  b.setLinvel({ x: 0, y: 0, z: 0 }, true);
  b.setAngvel({ x: 0, y: 0, z: 0 }, true);
});
await page.waitForTimeout(500);

for (const view of spec.views) {
  const url = '/' + relative(process.cwd(), join(dirname(specPath), view.image));
  const [overlay, model] = await page.evaluate(async ({ view, url }) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const g = window.__bouncy;
    const { renderer, scene } = g.stage;
    const root = g.car.model.root;
    const groundY = g.car.cfg.blueprint.groundY;
    for (const child of scene.children) child.visible = child === root || child.isLight;
    scene.fog = null;
    scene.background = null;
    renderer.setClearColor(0x000000, 1);

    // Piecewise-linear interpolation through [in, out] pairs, extrapolating the end segments.
    const interp = (pairs, x) => {
      const p = [...pairs].sort((a, b) => a[0] - b[0]);
      let i = 1;
      while (i < p.length - 1 && x > p[i][0]) i++;
      const [x0, y0] = p[i - 1];
      const [x1, y1] = p[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    };
    const swap = (pairs) => pairs.map(([a, b]) => [b, a]);

    // The view's extent in metres; the output keeps the rect's width at a uniform metric scale.
    const [rx, ry, rw, rh] = view.rect;
    const uL = interp(view.u, rx);
    const uR = interp(view.u, rx + rw);
    const vT = interp(view.v, ry);
    const vB = interp(view.v, ry + rh);
    const S = rw / (uR - uL);
    const W = rw;
    const H = Math.round((vT - vB) * S);
    const [r, u] = [view.right, view.up];
    const uc = (uL + uR) / 2;
    const vc = (vT + vB) / 2;
    const local = [0, 1, 2].map((i) => r[i] * uc + u[i] * vc + (i === 1 ? groundY : 0));
    const target = root.localToWorld(root.position.clone().set(...local));
    // forward = up × right; a far camera with a narrow lens is orthographic to within 0.1 %.
    const f = [u[1] * r[2] - u[2] * r[1], u[2] * r[0] - u[0] * r[2], u[0] * r[1] - u[1] * r[0]];
    const D = 1000;
    const camera = g.heli.camera;
    camera.position.set(target.x - f[0] * D, target.y - f[1] * D, target.z - f[2] * D);
    camera.up.set(...u);
    camera.lookAt(target);
    camera.fov = (2 * Math.atan((vT - vB) / 2 / D) * 180) / Math.PI;
    camera.aspect = W / H;
    camera.near = D - 10;
    camera.far = D + 10;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    renderer.render(scene, camera);

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(renderer.domElement, 0, 0);
    const model = canvas.toDataURL('image/png');
    // The drawing's white lines, warped into the same metric frame and recoloured cyan, on top.
    const src = document.createElement('canvas');
    src.width = img.width;
    src.height = img.height;
    const sctx = src.getContext('2d');
    sctx.drawImage(img, 0, 0);
    const pixels = sctx.getImageData(0, 0, img.width, img.height).data;
    const lines = document.createElement('canvas');
    lines.width = W;
    lines.height = H;
    const lctx = lines.getContext('2d');
    const data = lctx.createImageData(W, H);
    const toPxU = swap(view.u);
    const toPxV = swap(view.v);
    const sxs = Array.from({ length: W }, (_, x) => Math.round(interp(toPxU, uL + (x + 0.5) / S)));
    for (let y = 0; y < H; y++) {
      const sy = Math.round(interp(toPxV, vT - (y + 0.5) / S));
      if (sy < 0 || sy >= img.height) continue;
      for (let x = 0; x < W; x++) {
        const sx = sxs[x];
        if (sx < 0 || sx >= img.width) continue;
        const k = (sy * img.width + sx) * 4;
        const l = Math.max(pixels[k], pixels[k + 1], pixels[k + 2]);
        data.data.set([0, 230, 255, l], (y * W + x) * 4);
      }
    }
    lctx.putImageData(data, 0, 0);
    ctx.drawImage(lines, 0, 0);
    return [canvas.toDataURL('image/png'), model];
  }, { view, url });
  const save = (name, dataUrl) => writeFileSync(join(outDir, name), Buffer.from(dataUrl.split(',')[1], 'base64'));
  save(`${view.name}.png`, overlay);
  save(`${view.name}-model.png`, model);
  console.log(`${outDir}/${view.name}.png`);
}
await browser.close();
