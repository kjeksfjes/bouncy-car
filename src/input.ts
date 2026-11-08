import type { CarInput } from './vehicle/car';

const BLOCKED = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

/** Keyboard state with edge-triggered actions. */
export class Input {
  private readonly held = new Set<string>();
  private readonly pressed = new Set<string>();

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (BLOCKED.has(e.code)) e.preventDefault();
      if (!e.repeat) {
        this.pressed.add(e.code);
        // Also by the character typed, for keys that sit in different places on different
        // layouts (the apostrophe isn't on the same physical key on US and Norwegian keyboards).
        this.pressed.add(`char:${e.key}`);
      }
      this.held.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.held.delete(e.code));
    window.addEventListener('blur', () => this.held.clear());
  }

  private any(...codes: string[]): boolean {
    return codes.some((c) => this.held.has(c));
  }

  car(): CarInput {
    return {
      throttle: this.any('KeyW', 'ArrowUp') ? 1 : 0,
      brake: this.any('KeyS', 'ArrowDown') ? 1 : 0,
      steer: (this.any('KeyA', 'ArrowLeft') ? 1 : 0) - (this.any('KeyD', 'ArrowRight') ? 1 : 0),
      handbrake: this.any('Space'),
    };
  }

  get shift(): boolean {
    return this.any('ShiftLeft', 'ShiftRight');
  }

  /** True once per key press: a key code (`KeyT`), or a typed character as `char:'`. */
  consume(code: string): boolean {
    return this.pressed.delete(code);
  }

  endFrame(): void {
    this.pressed.clear();
  }
}
