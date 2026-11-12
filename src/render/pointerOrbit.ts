/**
 * Mouse input for the cameras: drag (left button) and scroll on the canvas accumulate until the
 * active camera takes them each frame. With Shift held they're kept apart, as a pan and a Shift
 * scroll (photo mode's pan and lens zoom; the orbiting cameras ignore them).
 */
export class PointerOrbit {
  private dx = 0;
  private dy = 0;
  private panX = 0;
  private panY = 0;
  private scroll = 0;
  private shiftScroll = 0;
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
      if (e.shiftKey) {
        this.panX += e.movementX;
        this.panY += e.movementY;
      } else {
        this.dx += e.movementX;
        this.dy += e.movementY;
      }
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
        // Browsers on macOS turn a Shift+scroll wheel into a sideways scroll (deltaX).
        if (e.shiftKey) this.shiftScroll += e.deltaY !== 0 ? e.deltaY : e.deltaX;
        else this.scroll += e.deltaY;
      },
      { passive: false },
    );
  }

  /** Whether a Shift+drag has moved since the last take (photo mode starts on one). */
  get panning(): boolean {
    return this.panX !== 0 || this.panY !== 0;
  }

  /**
   * The drag and pan (px) and the scroll and Shift scroll since the last call, and how long the
   * mouse has been left alone (s).
   */
  take(dt: number): { dx: number; dy: number; panX: number; panY: number; scroll: number; shiftScroll: number; idle: number } {
    const touched = this.dragging || this.dx !== 0 || this.dy !== 0 || this.panX !== 0 || this.panY !== 0 || this.scroll !== 0 || this.shiftScroll !== 0;
    this.idle = touched ? 0 : this.idle + dt;
    const out = { dx: this.dx, dy: this.dy, panX: this.panX, panY: this.panY, scroll: this.scroll, shiftScroll: this.shiftScroll, idle: this.idle };
    this.dx = this.dy = this.panX = this.panY = this.scroll = this.shiftScroll = 0;
    return out;
  }
}
