import { DEV_FROM_URL } from './constants';
import type { Car } from './vehicle/car';

const AIR_POPUP_SECONDS = 1.6;
/** How long photo mode shows the slow-motion badge after a change (ms). */
const SLOW_FLASH_MS = 1500;
/** The gap between the inspection legend and photo mode's controls beside it (px). */
const CARD_GAP = 12;

/**
 * Whether the keyboard is a Mac's: the legend's keys go by their Mac symbols there, by name
 * elsewhere. Dev only: ?keys=pc or ?keys=mac shows the other one.
 */
const KEYS = import.meta.env.DEV ? new URLSearchParams(location.search).get('keys') : null;
const MAC = KEYS ? KEYS === 'mac' : /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const SHIFT = MAC ? '⇧' : 'Shift';

/** Minimal DOM overlay: speed, integrity, airtime popups. */
export class Hud {
  private readonly speed = document.getElementById('speed')!;
  private readonly integrity = document.getElementById('integrity')!;
  private readonly status = document.getElementById('status')!;
  private readonly air = document.getElementById('air')!;
  private readonly autopilot = document.getElementById('autopilot')!;
  private readonly paused = document.getElementById('paused')!;
  private readonly slow = document.getElementById('slow')!;
  private readonly toastBox = document.getElementById('toast')!;
  private readonly inspect = document.getElementById('inspect')!;
  private readonly where = document.getElementById('where')!;
  private readonly legend = document.getElementById('legend')!;
  private readonly legendHow = document.getElementById('legend-how')!;
  private readonly legendEsc = document.getElementById('legend-esc')!;
  private readonly devLegend = document.getElementById('dev-legend')!;
  private isPaused = false;
  private devMode = DEV_FROM_URL;
  /** The 2D map is open (over the middle of the screen): photo mode's controls make way for it. */
  private mapOpen = false;
  private photo = false;
  private slowMotion = false;
  /** H hides the controls cards (photo mode's, and the dev shortcuts) until pressed again. */
  private legendHidden = false;
  private toastTimer: number | undefined;
  private slowFlashTimer: number | undefined;
  private seenJumps = 0;
  private airTimer = 0;

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

  /** Dev: the 2D map opened or closed. */
  setMapOpen(open: boolean): void {
    this.mapOpen = open;
    this.showLegend();
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

  /** Dev: where the car is (see Game.describeWhere). */
  setWhere(text: string): void {
    this.where.hidden = false;
    if (this.where.textContent !== text) this.where.textContent = text;
  }

  setPaused(paused: boolean): void {
    this.paused.classList.toggle('visible', paused);
    this.isPaused = paused;
    this.showLegend();
  }

  /** Photo mode hides all the UI but its controls (and an error report). */
  setPhotoMode(on: boolean): void {
    document.getElementById('hud')!.classList.toggle('photo', on);
    this.photo = on;
    this.showLegend();
  }

  /** H: hides or shows the controls cards. */
  toggleLegend(): void {
    this.legendHidden = !this.legendHidden;
    this.showLegend();
  }

  /**
   * Photo mode's controls show while paused: how to get into it from the pause, or out of it again
   * (Esc plays on in slow motion, see Game.tick). The dev shortcuts show throughout in dev mode, but
   * not in photo mode.
   */
  private showLegend(): void {
    this.legend.classList.toggle('visible', (this.isPaused || this.photo) && !this.legendHidden && !this.mapOpen);
    this.devLegend.classList.toggle('visible', this.devMode && !this.legendHidden);
    this.legendHow.textContent = this.photo ? 'The camera is yours' : `Right-drag or ${SHIFT}-drag to start`;
    this.legendEsc.textContent = !this.photo ? 'resume' : this.slowMotion ? 'play and pause' : 'back to the pause';
    // The inspection legend shares the corner: it moves aside while photo mode's controls show.
    const beside = this.legend.classList.contains('visible');
    this.inspect.style.left = beside ? `${this.legend.offsetLeft + this.legend.offsetWidth + CARD_GAP}px` : '';
  }

  update(dt: number, car: Car, autopilot: boolean): void {
    this.autopilot.classList.toggle('visible', autopilot);
    this.speed.textContent = Math.round(Math.abs(car.forwardSpeed) * 3.6).toString();
    const pct = Math.round(car.integrity * 100);
    this.integrity.style.width = `${pct}%`;
    this.integrity.dataset.level = pct > 60 ? 'ok' : pct > 25 ? 'warn' : 'bad';

    const notes: string[] = [];
    if (!car.engineAlive) notes.push('Engine dead – press N for a new car');
    if (car.wheelsLost > 0) notes.push(`${car.wheelsLost} wheel${car.wheelsLost > 1 ? 's' : ''} lost`);
    this.status.textContent = notes.join(' · ');

    if (car.jumpCount !== this.seenJumps) {
      this.seenJumps = car.jumpCount;
      this.airTimer = AIR_POPUP_SECONDS;
      this.air.textContent = `AIR ${car.lastJumpAirTime.toFixed(1)}s`;
    }
    if (car.airTime > 0.6) {
      this.airTimer = AIR_POPUP_SECONDS;
      this.air.textContent = `AIR ${car.airTime.toFixed(1)}s`;
    }
    this.airTimer -= dt;
    this.air.classList.toggle('visible', this.airTimer > 0);
  }

  /** New car: forget the previous car's jump counter. */
  reset(): void {
    this.seenJumps = 0;
    this.airTimer = 0;
  }
}
