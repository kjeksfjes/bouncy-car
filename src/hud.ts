import { DEV_FROM_URL } from './constants';
import type { Car } from './vehicle/car';

/** How long photo mode shows the slow-motion badge after a change (ms). */
const SLOW_FLASH_MS = 1500;
/**
 * Where H's hiding each card is remembered, for the next time the game is played (this browser
 * only): the driving card, the dev card (so it shows on entering dev mode until hidden there) and
 * photo mode's.
 */
const HIDDEN_KEY = { play: 'bouncy-car:controls-hidden', dev: 'bouncy-car:dev-controls-hidden', photo: 'bouncy-car:photo-controls-hidden' };
type Card = keyof typeof HIDDEN_KEY;

/**
 * Whether the keyboard is a Mac's: the legend's keys go by their Mac symbols there, by name
 * elsewhere. Dev only: ?keys=pc or ?keys=mac shows the other one.
 */
const KEYS = import.meta.env.DEV ? new URLSearchParams(location.search).get('keys') : null;
const MAC = KEYS ? KEYS === 'mac' : /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const SHIFT = MAC ? '⇧' : 'Shift';

/** Minimal DOM overlay: speed, integrity, status, and the controls cards. */
export class Hud {
  private readonly speed = document.getElementById('speed')!;
  private readonly integrity = document.getElementById('integrity')!;
  private readonly status = document.getElementById('status')!;
  private readonly autopilot = document.getElementById('autopilot')!;
  private readonly paused = document.getElementById('paused')!;
  private readonly slow = document.getElementById('slow')!;
  private readonly toastBox = document.getElementById('toast')!;
  private readonly inspect = document.getElementById('inspect')!;
  private readonly where = document.getElementById('where')!;
  private readonly legend = document.getElementById('legend')!;
  private readonly legendEsc = document.getElementById('legend-esc')!;
  private readonly devLegend = document.getElementById('dev-legend')!;
  private readonly playLegend = document.getElementById('play-legend')!;
  private readonly goto = document.getElementById('goto') as HTMLFormElement;
  private devMode = DEV_FROM_URL;
  private photo = false;
  private slowMotion = false;
  /** H hides the card in front of you until pressed again, each on its own (see toggleLegend). */
  private readonly hidden: Record<Card, boolean> = {
    play: readHidden(HIDDEN_KEY.play),
    dev: readHidden(HIDDEN_KEY.dev),
    photo: readHidden(HIDDEN_KEY.photo),
  };
  private toastTimer: number | undefined;
  private slowFlashTimer: number | undefined;

  constructor() {
    for (const key of document.querySelectorAll('.legend kbd[data-key="shift"]')) key.textContent = SHIFT;
    this.showLegend();
  }

  /** Shows a short message mid-screen for a couple of seconds. */
  toast(text: string): void {
    this.toastBox.textContent = text;
    this.toastBox.classList.add('visible');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastBox.classList.remove('visible'), 2200);
  }

  /** In photo mode, where the UI is hidden, shows the slow-motion badge for a moment (on toggling it on or changing speed). */
  flashSlowMotion(): void {
    this.slow.classList.add('flash');
    clearTimeout(this.slowFlashTimer);
    this.slowFlashTimer = window.setTimeout(() => this.slow.classList.remove('flash'), SLOW_FLASH_MS);
  }

  /** Shows the slow-motion speed (e.g. '¼×'), or hides the badge with null. */
  setSlowMotion(label: string | null): void {
    this.slow.classList.toggle('visible', label !== null);
    if (this.slowMotion !== (label !== null)) {
      this.slowMotion = label !== null;
      this.showLegend();
    }
    if (label !== null && this.slow.textContent !== `SLOW ${label}`) this.slow.textContent = `SLOW ${label}`;
  }

  /** Shows the inspection view's legend, or hides it with null. */
  setInspect(legend: { title: string; entries: { colour: string; label: string }[] } | null): void {
    this.inspect.classList.toggle('visible', legend !== null);
    if (!legend) return;
    this.inspect.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = `Inspect: ${legend.title} (I next, ${MAC ? '⇧I' : 'Shift+I'} back)`;
    this.inspect.append(title);
    for (const { colour, label } of legend.entries) {
      const row = document.createElement('div');
      row.className = 'row';
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = colour;
      row.append(swatch, label);
      this.inspect.append(row);
    }
  }

  /** Dev mode on or off: its shortcuts' legend, and where the car is. */
  setDevMode(on: boolean): void {
    this.devMode = on;
    if (!on) this.where.hidden = true;
    this.showLegend();
  }

  /**
   * Dev: asks where to go, starting from `start` m downhill and `x` m across (where the car is), and
   * hands the answer to `go`. Enter goes; Esc, J again or clicking away cancels.
   */
  askWhere(start: number, x: number, go: (start: number, x: number) => void): void {
    const form = this.goto;
    const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
    field('start').value = String(start);
    field('x').value = String(x);
    form.hidden = false;
    field('start').select();
    const close = () => {
      form.hidden = true;
      form.onsubmit = form.onkeydown = form.onfocusout = null;
      (document.activeElement as HTMLElement | null)?.blur();
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      const s = Number(field('start').value);
      const across = Number(field('x').value);
      close();
      if (Number.isFinite(s) && Number.isFinite(across)) go(s, across);
    };
    form.onfocusout = (e: FocusEvent) => {
      if (!form.contains(e.relatedTarget as Node | null)) close();
    };
    form.onkeydown = (e) => {
      // A form with two fields and no button doesn't submit on Enter by itself.
      if (e.key === 'Enter') {
        e.preventDefault();
        form.requestSubmit();
      } else if (e.key === 'Escape' || e.code === 'KeyJ') {
        e.preventDefault();
        close();
      }
    };
  }

  /** Dev: where the car is (see Game.describeWhere). */
  setWhere(text: string): void {
    this.where.hidden = false;
    if (this.where.textContent !== text) this.where.textContent = text;
  }

  setPaused(paused: boolean): void {
    this.paused.classList.toggle('visible', paused);
  }

  /** Photo mode hides all the UI but its controls (and an error report). */
  setPhotoMode(on: boolean): void {
    document.getElementById('hud')!.classList.toggle('photo', on);
    this.photo = on;
    this.showLegend();
  }

  /**
   * H: hides or shows the card in front of you, and remembers it: photo mode's in photo mode, else
   * the dev card in dev mode or the driving card.
   */
  toggleLegend(): void {
    const card: Card = this.photo ? 'photo' : this.devMode ? 'dev' : 'play';
    this.hidden[card] = !this.hidden[card];
    try {
      localStorage.setItem(HIDDEN_KEY[card], this.hidden[card] ? '1' : '0');
    } catch {
      // Storage can be off (private windows, blocked site data): it's only forgotten on reload.
    }
    this.showLegend();
  }

  /**
   * One card at a time in the bottom left corner: the driving card (which tells how to get into photo
   * mode), or in photo mode only its own controls, with how to get out again (Esc plays on in slow
   * motion, see Game.tick). In dev mode the dev shortcuts show on the right instead of the driving
   * card (but not in photo mode), and the inspection legend has the corner. Each card stays hidden
   * once H hid it.
   */
  private showLegend(): void {
    this.playLegend.classList.toggle('visible', !this.devMode && !this.photo && !this.hidden.play);
    this.legend.classList.toggle('visible', this.photo && !this.hidden.photo);
    this.devLegend.classList.toggle('visible', this.devMode && !this.hidden.dev);
    this.legendEsc.textContent = this.slowMotion ? 'play and pause' : 'back to the pause';
  }

  update(car: Car, autopilot: boolean): void {
    this.autopilot.classList.toggle('visible', autopilot);
    this.speed.textContent = Math.round(Math.abs(car.forwardSpeed) * 3.6).toString();
    const pct = Math.round(car.integrity * 100);
    this.integrity.style.width = `${pct}%`;
    this.integrity.dataset.level = pct > 60 ? 'ok' : pct > 25 ? 'warn' : 'bad';

    const notes: string[] = [];
    if (!car.engineAlive) notes.push('Engine dead – press N for a new car');
    if (car.wheelsLost > 0) notes.push(`${car.wheelsLost} wheel${car.wheelsLost > 1 ? 's' : ''} lost`);
    this.status.textContent = notes.join(' · ');
  }
}

/** Whether the controls cards were hidden last time, under `key` (see HIDDEN_KEY). */
function readHidden(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
