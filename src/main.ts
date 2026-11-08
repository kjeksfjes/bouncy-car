import RAPIER from '@dimforge/rapier3d-compat';
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
  const game = new Game(document.getElementById('app')!, seed, start, terrain);
  if (import.meta.env.DEV) {
    window.__bouncy = game;
    document.querySelector('.hint')!.insertAdjacentHTML('beforeend', ' · <kbd>I</kbd> inspect terrain (dev)');
  }
  document.getElementById('loading')!.remove();
  game.start();
}

main();
