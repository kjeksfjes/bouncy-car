import type { CarInput } from './vehicle/car';

const BLOCKED = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
/** A word counts as typed (see typed) only when all of it comes within this long (ms), first letter to last. */
const TYPING_WINDOW = 700;

/**
 * The pedals, as the player's keys work them (see car):
 * - A press of Space shorter than `tap` ms sets the handbrake as a parking brake on all four
 *   wheels, or releases it if it was set; a longer one locks the rear wheels only while held, and
 *   leaves it released.
 * - A brake press that starts while the car rolls forward faster than `reverseFrom` m/s only brakes,
 *   down to a stop and holding it there: backing up takes a new press.
 */
const PEDALS = { tap: 250, reverseFrom: 1 };

/** Keyboard state with edge-triggered actions. */
export class Input {
  private readonly held = new Set<string>();
  private readonly pressed = new Set<string>();
  /** The last few characters typed, and when (ms, event time). */
  private typing: { key: string; at: number }[] = [];
  /**
   * Which physical keys type which characters unshifted (see consumeShifted): from the browser's
   * layout map where it has one (Chrome, Edge), and from each key as it's pressed.
   */
  private readonly charKeys = new Map<string, Set<string>>();
  /** The handbrake set by a tap (see PEDALS), and the Space press under way: when, and whether it was set then. */
  private handbrakeSet = false;
  private spaceDown = { at: 0, wasSet: false };
  /** The brake key held last time car() looked, and whether this press only brakes (see PEDALS). */
  private brakeHeld = false;
  private brakeOnly = false;

  constructor() {
    const keyboard = (navigator as Navigator & { keyboard?: { getLayoutMap(): Promise<Map<string, string>> } }).keyboard;
    keyboard
      ?.getLayoutMap()
      .then((layout) => layout.forEach((key, code) => this.learn(key, code)))
      // Not allowed in some frames: the keys are learned as they're pressed instead.
      .catch(() => {});
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
        else if (e.key.length === 1) this.learn(e.key, e.code);
        if (e.code === 'Space') this.spaceDown = { at: e.timeStamp, wasSet: this.handbrakeSet };
        if (e.key.length === 1) this.typing = [...this.typing, { key: e.key.toLowerCase(), at: e.timeStamp }].slice(-16);
      }
      this.held.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.held.delete(e.code);
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) {
        this.handbrakeSet = e.timeStamp - this.spaceDown.at < PEDALS.tap ? !this.spaceDown.wasSet : false;
      }
    });
    window.addEventListener('blur', () => this.held.clear());
  }

  private any(...codes: string[]): boolean {
    return codes.some((c) => this.held.has(c));
  }

  /** The car's controls from the keys, the pedals worked as PEDALS says; `forwardSpeed` is the car's (m/s). */
  car(forwardSpeed = 0): CarInput {
    const brake = this.any('KeyS', 'ArrowDown');
    if (brake && !this.brakeHeld) this.brakeOnly = forwardSpeed > PEDALS.reverseFrom;
    this.brakeHeld = brake;
    return {
      throttle: this.any('KeyW', 'ArrowUp') ? 1 : 0,
      brake: brake ? 1 : 0,
      steer: (this.any('KeyA', 'ArrowLeft') ? 1 : 0) - (this.any('KeyD', 'ArrowRight') ? 1 : 0),
      handbrake: this.any('Space'),
      parkingBrake: this.handbrakeSet,
      holdStill: brake && this.brakeOnly,
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

  /**
   * True once per press of Shift with the key that types `char` (which types something else with
   * Shift, and sits in different places on different layouts). Until the browser's layout map has
   * come, or that key has been pressed without Shift, it isn't known and this is false.
   */
  consumeShifted(char: string): boolean {
    for (const code of this.charKeys.get(char) ?? []) if (this.consume(`shift:${code}`)) return true;
    return false;
  }

  private learn(char: string, code: string): void {
    let codes = this.charKeys.get(char);
    if (!codes) this.charKeys.set(char, (codes = new Set()));
    codes.add(code);
  }

  /** True once per key press: a key code (`KeyT`), a typed character as `char:'`, or `shift:KeyB` for Shift+B. */
  consume(code: string): boolean {
    return this.pressed.delete(code);
  }

  endFrame(): void {
    this.pressed.clear();
  }
}
