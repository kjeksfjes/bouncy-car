import RAPIER from '@dimforge/rapier3d-compat';
// The HUD's typeface, served with the game (Latin only).
import '@fontsource/barlow/latin-500.css';
import '@fontsource/barlow/latin-600.css';
import '@fontsource/barlow/latin-700.css';
import { Game } from './game';

declare global {
  interface Window {
    /** Dev-only handle for debugging and smoke tests. */
    __bouncy?: Game;
  }
}

const DEFAULT_SEED = 1977;

async function main(): Promise<void> {
  await RAPIER.init();
  const params = new URLSearchParams(location.search);
  const seedParam = params.get('seed');
  const seed = seedParam === null ? DEFAULT_SEED : Number(seedParam);
  // Dev only: ?start=4000 spawns 4 km downhill, to get to the lower biomes quickly.
  const start = import.meta.env.DEV ? Number(params.get('start') ?? 0) : 0;
  // Dev only: ?terrain=varied switches to the varied set pieces (hills, valleys, kickers).
  const terrain = import.meta.env.DEV && params.get('terrain') === 'varied' ? 'varied' : 'classic';
  // Dev only: ?x=-120 spawns that far across the slope (the HUD shows start= and x= in dev).
  const startX = import.meta.env.DEV ? Number(params.get('x') ?? 0) : 0;
  const game = new Game(document.getElementById('app')!, seed, start, terrain, startX);
  if (import.meta.env.DEV) window.__bouncy = game;
  document.getElementById('loading')!.remove();
  game.start();
}

main();
