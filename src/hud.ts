import type { Car } from './vehicle/car';

const AIR_POPUP_SECONDS = 1.6;

/** Minimal DOM overlay: speed, integrity, airtime popups. */
export class Hud {
  private readonly speed = document.getElementById('speed')!;
  private readonly integrity = document.getElementById('integrity')!;
  private readonly status = document.getElementById('status')!;
  private readonly air = document.getElementById('air')!;
  private seenJumps = 0;
  private airTimer = 0;

  update(dt: number, car: Car): void {
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
