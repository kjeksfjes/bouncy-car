import type { CarInput } from './vehicle/car';

const BLOCKED = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
/** A word counts as typed (see typed) only when all of it comes within this long (ms), first letter to last. */
const TYPING_WINDOW = 700;

/** Keyboard state with edge-triggered actions. */
export class Input {
  private readonly held = new Set<string>();
  private readonly pressed = new Set<string>();
  /** The last few characters typed, and when (ms, event time). */
  private typing: { key: string; at: number }[] = [];

  constructor() {
    window.addEventListener('keydown', (e) => {
      // Typing into a form field (the dev Go to form) isn't playing.
      if (e.target instanceof HTMLInputElement) return;
      if (BLOCKED.has(e.code)) e.preventDefault();
      if (!e.repeat) {
        this.pressed.add(e.code);
        // Also by the character typed, for keys that sit in different places on different
        // layouts (the apostrophe isn't on the same physical key on US and Norwegian keyboards).
        this.pressed.add(`char:${e.key}`);
        // With Shift held at the press itself, so a quick Shift+key isn't lost if Shift is let go
        // before the frame reads it.
        if (e.shiftKey) this.pressed.add(`shift:${e.code}`);
        if (e.key.length === 1) this.typing = [...this.typing, { key: e.key.toLowerCase(), at: e.timeStamp }].slice(-16);
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

  /** Whether `word` was just typed, all of it within TYPING_WINDOW; true once per typing. */
  typed(word: string): boolean {
    const last = this.typing.slice(-word.length);
    if (last.length < word.length || last.map((c) => c.key).join('') !== word) return false;
    if (last[last.length - 1].at - last[0].at > TYPING_WINDOW) return false;
    this.typing = [];
    return true;
  }

  /**
   * Whether the last keys typed are the start of `word` (two letters or more, but not all of it), so
   * the key just pressed may be part of typing it rather than meant on its own.
   */
  startsTyping(word: string): boolean {
    for (let n = Math.min(word.length - 1, this.typing.length); n >= 2; n--) {
      const last = this.typing.slice(-n);
      if (last.map((c) => c.key).join('') === word.slice(0, n) && last[n - 1].at - last[0].at <= TYPING_WINDOW) return true;
    }
    return false;
  }

  /** True once per key press: a key code (`KeyT`), a typed character as `char:'`, or `shift:KeyB` for Shift+B. */
  consume(code: string): boolean {
    return this.pressed.delete(code);
  }

  endFrame(): void {
    this.pressed.clear();
  }
}
