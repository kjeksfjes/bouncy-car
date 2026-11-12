import * as THREE from 'three';

/** Where a drag grabbed the screen: −1..1 screen coordinates, and the canvas's height (px). */
export interface Grab {
  ndc: THREE.Vector2;
  height: number;
}

/**
 * Mouse input for the cameras: drag (left button) and scroll on the canvas accumulate until the
 * active camera takes them each frame. A right-button drag (or one with Alt/Option held) is
 * kept apart as a look, a drag with Shift held as a pan, and a scroll with Shift as a Shift scroll
 * (photo mode's look, pan and lens zoom; the following cameras ignore them). A drag or pan also
 * reports where it grabbed the screen when it starts, so the camera can hold on to that point.
 */
export class PointerOrbit {
  private dx = 0;
  private dy = 0;
  private panX = 0;
  private panY = 0;
  private scroll = 0;
  private shiftScroll = 0;
  /** Where the mouse was at the last scroll (−1..1 screen coordinates) since the last take. */
  private scrollAt: THREE.Vector2 | null = null;
  private dragging = false;
  private lookX = 0;
  private lookY = 0;
  /** The current drag is on the right button: a look. */
  private rightButton = false;
  /** What the current drag did on its last move. */
  private held: 'drag' | 'pan' | 'look' | null = null;
  /** Where a pan, and a drag, started since the last take. */
  private grab: Grab | null = null;
  private dragGrab: Grab | null = null;
  /** Seconds since the last drag or scroll. */
  private idle = Infinity;

  /** Where the current drag went down (client px). */
  private readonly downAt = new THREE.Vector2();
  /** Marks the point a drag orbits in photo mode, where it went down. */
  private marker: HTMLElement | null = null;

  /** The canvas's height (px), once attached. */
  height = 1;
  /**
   * Whether a drag orbits the point under the cursor (photo mode) rather than the car, so it marks
   * that point.
   */
  orbitsCursor = false;

  attach(element: HTMLElement): void {
    this.height = element.clientHeight;
    new ResizeObserver(() => (this.height = element.clientHeight)).observe(element);
    element.style.cursor = 'grab';
    // The right button looks round, so it doesn't open the browser's menu.
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    element.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 2) return;
      this.dragging = true;
      this.rightButton = e.button === 2;
      this.held = null;
      this.downAt.set(e.clientX, e.clientY);
      element.setPointerCapture(e.pointerId);
      element.style.cursor = 'grabbing';
      // An orbit round the cursor marks where it went down: the point it turns round, which stays
      // put on screen while the cursor moves on.
      if (!e.shiftKey && !e.altKey && !this.rightButton && this.orbitsCursor) this.showMarker(true);
    });
    element.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const mode = e.shiftKey ? 'pan' : e.altKey || this.rightButton ? 'look' : 'drag';
      // A pan or look follows the cursor, so it has no mark.
      if (mode === 'pan' || mode === 'look') this.showMarker(false);
      if (mode !== this.held && mode !== 'look') {
        // A drag or pan starts here: where it grabbed, before this move.
        const box = element.getBoundingClientRect();
        const x = e.clientX - e.movementX - box.left;
        const y = e.clientY - e.movementY - box.top;
        const grab = { ndc: new THREE.Vector2((x / box.width) * 2 - 1, 1 - (y / box.height) * 2), height: box.height };
        if (mode === 'pan') this.grab = grab;
        else this.dragGrab = grab;
      }
      this.held = mode;
      if (mode === 'pan') {
        this.panX += e.movementX;
        this.panY += e.movementY;
      } else if (mode === 'look') {
        this.lookX += e.movementX;
        this.lookY += e.movementY;
      } else {
        this.dx += e.movementX;
        this.dy += e.movementY;
      }
    });
    const release = () => {
      this.dragging = false;
      element.style.cursor = 'grab';
      this.showMarker(false);
    };
    // A right-drag that leaves the window loses its capture in Chromium on macOS, and so never sees
    // the button go up out there: it ends on coming back without the right button held. (A drag
    // that keeps its capture never comes back in, so this can't cut it short.)
    element.addEventListener('pointerenter', (e) => {
      if (this.dragging && this.rightButton && (e.buttons & 2) === 0) release();
    });
    element.addEventListener('pointerup', release);
    element.addEventListener('pointercancel', release);
    element.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        // Browsers on macOS turn a Shift+scroll wheel into a sideways scroll (deltaX).
        if (e.shiftKey) this.shiftScroll += e.deltaY !== 0 ? e.deltaY : e.deltaX;
        else {
          this.scroll += e.deltaY;
          const box = element.getBoundingClientRect();
          this.scrollAt = new THREE.Vector2(((e.clientX - box.left) / box.width) * 2 - 1, 1 - ((e.clientY - box.top) / box.height) * 2);
        }
      },
      { passive: false },
    );
  }

  /** A small ring where the current drag went down. */
  private showMarker(on: boolean): void {
    if (on && !this.marker) {
      const m = document.createElement('div');
      m.style.cssText =
        'position:fixed;width:12px;height:12px;margin:-7px 0 0 -7px;border:1px solid #fff;border-radius:50%;box-shadow:0 0 0 1px rgb(0 0 0 / 0.5);pointer-events:none;z-index:10';
      document.body.append(m);
      this.marker = m;
    }
    if (!this.marker) return;
    this.marker.style.display = on ? 'block' : 'none';
    this.marker.style.left = `${this.downAt.x}px`;
    this.marker.style.top = `${this.downAt.y}px`;
  }

  /**
   * Whether a pan has grabbed, or a pan or look has moved, since the last take (photo mode starts
   * on one). A grab counts before any movement so photo mode is there to take it: a camera that
   * took it instead would leave the pan without its depth.
   */
  get freeLook(): boolean {
    return this.grab !== null || this.panX !== 0 || this.panY !== 0 || this.lookX !== 0 || this.lookY !== 0;
  }

  /**
   * The drag, pan and look (px) and the scroll and Shift scroll since the last call, where a pan and
   * a drag started and where the mouse was at the last scroll since then, and how long
   * the mouse has been left alone (s).
   */
  take(dt: number): {
    dx: number;
    dy: number;
    panX: number;
    panY: number;
    lookX: number;
    lookY: number;
    scroll: number;
    shiftScroll: number;
    scrollAt: THREE.Vector2 | null;
    grab: Grab | null;
    dragGrab: Grab | null;
    idle: number;
  } {
    const touched =
      this.dragging || this.dx !== 0 || this.dy !== 0 || this.panX !== 0 || this.panY !== 0 || this.lookX !== 0 || this.lookY !== 0 || this.scroll !== 0 || this.shiftScroll !== 0;
    this.idle = touched ? 0 : this.idle + dt;
    const out = {
      dx: this.dx,
      dy: this.dy,
      panX: this.panX,
      panY: this.panY,
      lookX: this.lookX,
      lookY: this.lookY,
      scroll: this.scroll,
      shiftScroll: this.shiftScroll,
      scrollAt: this.scrollAt,
      grab: this.grab,
      dragGrab: this.dragGrab,
      idle: this.idle,
    };
    this.dx = this.dy = this.panX = this.panY = this.lookX = this.lookY = this.scroll = this.shiftScroll = 0;
    this.grab = this.dragGrab = null;
    this.scrollAt = null;
    return out;
  }
}
