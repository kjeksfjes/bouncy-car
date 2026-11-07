import { expect, test } from '@playwright/test';

test('game boots, car settles on its wheels and drives', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto('/');
  await page.waitForFunction(() => window.__bouncy !== undefined);
  await page.waitForTimeout(2500);

  const settled = await page.evaluate(() => {
    const g = window.__bouncy!;
    const t = g.car.body.translation();
    return { y: t.y, ground: g.field.height(t.x, t.z), wheels: g.car.groundedWheels, z: t.z };
  });
  // Resting on the suspension: above the ground, not sunk into or bouncing off it.
  expect(settled.wheels).toBeGreaterThanOrEqual(3);
  expect(settled.y - settled.ground).toBeGreaterThan(0.3);
  expect(settled.y - settled.ground).toBeLessThan(1.5);
  await page.screenshot({ path: 'test-results/smoke-idle.png' });

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: 'test-results/smoke-driving.png' });
  await page.keyboard.up('KeyW');

  const driven = await page.evaluate(() => window.__bouncy!.car.body.translation().z);
  expect(settled.z - driven).toBeGreaterThan(20); // moved downhill (−Z)
  expect(errors).toEqual([]);
});

test('autopilot takes over and drives downhill', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => window.__bouncy !== undefined);
  await page.waitForTimeout(1000);
  const z0 = await page.evaluate(() => window.__bouncy!.car.body.translation().z);
  await page.keyboard.press('KeyP');
  await page.waitForTimeout(4000);
  const z1 = await page.evaluate(() => window.__bouncy!.car.body.translation().z);
  expect(z0 - z1).toBeGreaterThan(20);
  expect(errors).toEqual([]);
});
