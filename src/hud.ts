import type { Car } from './vehicle/car';

const AIR_POPUP_SECONDS = 1.6;
/** How long photo mode shows the slow-motion badge after a change (ms). */
const SLOW_FLASH_MS = 1500;

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
  private toastTimer: number | undefined;
  private slowFlashTimer: number | undefined;
  private seenJumps = 0;
  private airTimer = 0;

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
    if (label !== null && this.slow.textContent !== `SLOW ${label}`) this.slow.textContent = `SLOW ${label}`;
  }

  /** Shows the inspection view's legend, or hides it with null. */
  setInspect(legend: { title: string; entries: { colour: string; label: string }[] } | null): void {
    this.inspect.classList.toggle('visible', legend !== null);
    if (!legend) return;
    this.inspect.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = `Inspect: ${legend.title} (I for next)`;
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

  /** Dev: where the car is (see Game.describeWhere). */
  setWhere(text: string): void {
    this.where.hidden = false;
    if (this.where.textContent !== text) this.where.textContent = text;
  }

  setPaused(paused: boolean): void {
    this.paused.classList.toggle('visible', paused);
  }

  /** Photo mode hides all the UI (but not an error report). */
  setPhotoMode(on: boolean): void {
    document.getElementById('hud')!.classList.toggle('photo', on);
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
