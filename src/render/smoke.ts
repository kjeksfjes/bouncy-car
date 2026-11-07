import * as THREE from 'three';

const POOL_SIZE = 40;
const LIFETIME = 2.2;

interface Puff {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  velocity: THREE.Vector3;
  age: number;
  size: number;
}

let softDot: THREE.Texture | null = null;

/** Shared round, soft-edged sprite texture. */
function softDotTexture(): THREE.Texture {
  if (softDot) return softDot;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  softDot = new THREE.CanvasTexture(canvas);
  return softDot;
}

/** A small pool of rising, growing, fading puffs: engine steam and smoke. */
export class Smoke {
  private readonly puffs: Puff[] = [];
  private next = 0;
  private carry = 0;

  constructor(private readonly scene: THREE.Scene) {
    for (let i = 0; i < POOL_SIZE; i++) {
      const material = new THREE.SpriteMaterial({ map: softDotTexture(), transparent: true, depthWrite: false, opacity: 0 });
      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      scene.add(sprite);
      this.puffs.push({ sprite, material, velocity: new THREE.Vector3(), age: LIFETIME, size: 1 });
    }
  }

  /**
   * Emits `rate` puffs per second at `at` (world space).
   * @param drift velocity the puffs start with (e.g. a share of the car's)
   */
  emit(dt: number, rate: number, at: THREE.Vector3, drift: THREE.Vector3, color: THREE.ColorRepresentation, size: number): void {
    this.carry += rate * dt;
    while (this.carry >= 1) {
      this.carry -= 1;
      const p = this.puffs[this.next];
      this.next = (this.next + 1) % POOL_SIZE;
      p.age = 0;
      p.size = size * (0.8 + Math.random() * 0.4);
      p.sprite.position.copy(at);
      p.velocity.copy(drift).add(new THREE.Vector3((Math.random() - 0.5) * 0.6, 1.2 + Math.random() * 0.6, (Math.random() - 0.5) * 0.6));
      p.material.color.set(color);
      p.sprite.visible = true;
    }
  }

  update(dt: number): void {
    for (const p of this.puffs) {
      if (p.age >= LIFETIME) continue;
      p.age += dt;
      const t = p.age / LIFETIME;
      p.velocity.multiplyScalar(1 - 1.5 * dt); // air slows the puff
      p.sprite.position.addScaledVector(p.velocity, dt);
      p.sprite.scale.setScalar(p.size * (0.4 + t * 1.6));
      p.material.opacity = 0.55 * (1 - t) * Math.min(1, t * 8);
      p.sprite.visible = p.age < LIFETIME;
    }
  }

  dispose(): void {
    for (const p of this.puffs) {
      this.scene.remove(p.sprite);
      p.material.dispose();
    }
  }
}
