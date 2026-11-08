/**
 * Mouse input for orbiting cameras: drag (left button) and scroll on the canvas accumulate
 * until the active camera takes them each frame.
 */
export class PointerOrbit {
  private dx = 0;
  private dy = 0;
  private scroll = 0;
  private dragging = false;
  /** Seconds since the last drag or scroll. */
  private idle = Infinity;

  attach(element: HTMLElement): void {
    element.style.cursor = 'grab';
    element.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.dragging = true;
      element.setPointerCapture(e.pointerId);
      element.style.cursor = 'grabbing';
    });
    element.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    });
    const release = () => {
      this.dragging = false;
      element.style.cursor = 'grab';
    };
    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', release);
    element.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.scroll += e.deltaY;
      },
      { passive: false },
    );
  }

  /** The drag (px) and scroll since the last call, and how long the mouse has been left alone (s). */
  take(dt: number): { dx: number; dy: number; scroll: number; idle: number } {
    const touched = this.dragging || this.dx !== 0 || this.dy !== 0 || this.scroll !== 0;
    this.idle = touched ? 0 : this.idle + dt;
    const out = { dx: this.dx, dy: this.dy, scroll: this.scroll, idle: this.idle };
    this.dx = this.dy = this.scroll = 0;
    return out;
  }
}
