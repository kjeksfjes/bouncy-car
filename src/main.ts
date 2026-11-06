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
  const seedParam = new URLSearchParams(location.search).get('seed');
  const seed = seedParam === null ? DEFAULT_SEED : Number(seedParam);
  const game = new Game(document.getElementById('app')!, seed);
  if (import.meta.env.DEV) window.__bouncy = game;
  document.getElementById('loading')!.remove();
  game.start();
}

main();
