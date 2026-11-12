import * as THREE from 'three';

/**
 * Feel values for the ground's cross-section. Feel-tuned by hand: change freely.
 */
const SECTION = {
  /**
   * How far behind the cut the view is drawn from per metre the camera is under the ground: far
   * enough that the surface's edge stays in view (at 4 and a 60° view looking level, about a fifth
   * of the way down from the top of the screen).
   */
  distancePerDepth: 4,
  /** The view is never drawn from further back than this (m). */
  farthest: 40,
  /** Grid of the cut's mesh (columns × rows): the ground's edge across it is straight between points. */
  columns: 48,
  rows: 28,
  /** The cut reaches this far above the ground's height (m), so no sliver of sky shows at its edge. */
  overlap: 0.01,
  /**
   * It's kept up while the camera is less than this far above the ground (m): the near plane
   * reaches below the camera, so it cuts into the ground just before the camera goes under.
   */
  above: 0.5,
};

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _centre = new THREE.Vector3();
const _point = new THREE.Vector3();
const _back = new THREE.Vector3();

/**
 * When the camera goes under the ground, shows the ground cut open across the view just in front
 * of it, where its near plane is. Where the cut is under the ground it's filled with soil (a strip
 * of turf on top, layers of earth by depth, and stones cut through). The deeper the camera is, the
 * further back the view is drawn from, behind the cut (which stays where it is: everything between
 * is clipped away by moving the near plane out to it), so the ground's edge stays in view: going
 * down reads as backing away and down from the cut.
 */
export class GroundSection {
  private readonly mesh: THREE.Mesh;
  private readonly positions: THREE.BufferAttribute;
  private readonly depths: THREE.BufferAttribute;
  private readonly across: THREE.BufferAttribute;
  private readonly rise: THREE.BufferAttribute;
  /** How far the camera was moved back for this frame's drawing (see update and restore). */
  private readonly moved = new THREE.Vector3();
  /** The camera's own near plane, put back once it's above the ground again. */
  private normalNear: number | null = null;
  /** Whether the camera was under the ground at the last update. */
  underground = false;

  /**
   * @param heightAt the drawn ground's height at (x, z) (see Terrain.surfaceHeight)
   */
  constructor(
    scene: THREE.Scene,
    private readonly heightAt: (x: number, z: number) => number,
  ) {
    const { columns, rows } = SECTION;
    const count = (columns + 1) * (rows + 1);
    const geometry = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    this.depths = new THREE.BufferAttribute(new Float32Array(count), 1);
    this.across = new THREE.BufferAttribute(new Float32Array(count), 1);
    this.rise = new THREE.BufferAttribute(new Float32Array(count), 1);
    this.positions.setUsage(THREE.DynamicDrawUsage);
    this.depths.setUsage(THREE.DynamicDrawUsage);
    this.across.setUsage(THREE.DynamicDrawUsage);
    this.rise.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.positions);
    geometry.setAttribute('depth', this.depths);
    geometry.setAttribute('across', this.across);
    geometry.setAttribute('rise', this.rise);
    const index: number[] = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < columns; i++) {
        const a = j * (columns + 1) + i;
        const b = a + columns + 1;
        // Counter-clockwise as the camera sees it (right along i, up along j), so it faces the camera.
        index.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    geometry.setIndex(index);
    this.mesh = new THREE.Mesh(geometry, sectionMaterial());
    this.mesh.frustumCulled = false;
    // Not something to grab: photo mode's pan, orbit and scroll look past it, at what's beyond.
    this.mesh.raycast = () => {};
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /**
   * Call after the camera is placed for the frame, before drawing; and `restore` after drawing,
   * which puts the camera back where it was placed.
   */
  update(camera: THREE.PerspectiveCamera): void {
    this.moved.set(0, 0, 0);
    const under = this.heightAt(camera.position.x, camera.position.z) - camera.position.y;
    this.underground = under > 0;
    if (under <= -SECTION.above) {
      if (this.normalNear !== null) {
        camera.near = this.normalNear;
        camera.updateProjectionMatrix();
        this.normalNear = null;
      }
      this.mesh.visible = false;
      return;
    }
    this.normalNear ??= camera.near;
    const distance = THREE.MathUtils.clamp(under * SECTION.distancePerDepth, this.normalNear, SECTION.farthest);
    // The mesh sits at the camera, its points relative to it: the GPU works in single precision,
    // too coarse far from the world's origin to keep a cut millimetres past the near plane from
    // slipping in front of it (and being clipped away in patches). Placed this way, the camera's
    // offset cancels on the CPU instead.
    camera.near = distance;
    camera.updateProjectionMatrix();
    // Back along the view, so the cut stays at the camera's own near plane.
    camera.getWorldDirection(_back);
    this.moved.copy(_back).multiplyScalar(-(distance - this.normalNear));
    camera.position.add(this.moved);

    // The cut lies just past the near plane, a little wider than the view.
    camera.updateMatrixWorld();
    _right.setFromMatrixColumn(camera.matrixWorld, 0);
    _up.setFromMatrixColumn(camera.matrixWorld, 1);
    camera.getWorldDirection(_forward);
    const at = distance * 1.002;
    _centre.copy(_forward).multiplyScalar(at);
    this.mesh.position.copy(camera.position);
    const halfHeight = at * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * 1.05;
    const halfWidth = halfHeight * camera.aspect;
    // The stones and patches are drawn flat on the cut, by position across it (along the camera's
    // level right) and up it (along the camera's up, so they keep their shape looking down, where
    // height changes slowly up the cut): moving toward or away from them looking level leaves them
    // as they are. (Stones cut through in 3D grow and shrink as the cut moves.)
    const flat = Math.hypot(_right.x, _right.z) || 1;
    const acrossX = _right.x / flat;
    const acrossZ = _right.z / flat;
    const { columns, rows } = SECTION;
    for (let j = 0; j <= rows; j++) {
      const v = (j / rows) * 2 - 1;
      for (let i = 0; i <= columns; i++) {
        const u = (i / columns) * 2 - 1;
        _point.copy(_centre).addScaledVector(_right, u * halfWidth).addScaledVector(_up, v * halfHeight);
        const k = j * (columns + 1) + i;
        this.positions.setXYZ(k, _point.x, _point.y, _point.z);
        _point.add(camera.position);
        this.depths.setX(k, this.heightAt(_point.x, _point.z) - _point.y + SECTION.overlap);
        this.across.setX(k, _point.x * acrossX + _point.z * acrossZ);
        this.rise.setX(k, _point.dot(_up));
      }
    }
    this.positions.needsUpdate = true;
    this.depths.needsUpdate = true;
    this.across.needsUpdate = true;
    this.rise.needsUpdate = true;
    (this.mesh.material as THREE.ShaderMaterial).uniforms.depthIn.value = _point.copy(_centre).add(camera.position).dot(_forward);
    this.mesh.visible = true;
  }

  /** After drawing: puts the camera back where it was placed, before update moved it back. */
  restore(camera: THREE.PerspectiveCamera): void {
    if (this.moved.lengthSq() === 0) return;
    camera.position.sub(this.moved);
    camera.updateMatrixWorld();
  }
}

/**
 * The cut's look, by how deep each point lies (`depth`, m) and where it is on the cut (`across`
 * and up it: `rise`, m): turf, then topsoil, subsoil and deeper clay, each in faceted patches,
 * with faceted stones lit from above.
 */
function sectionMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      depthIn: { value: 0 },
      turf: { value: new THREE.Color('#5f9e3a') },
      turfUnder: { value: new THREE.Color('#477a2c') },
      topsoil: { value: new THREE.Color('#6e4428') },
      subsoil: { value: new THREE.Color('#94552c') },
      clay: { value: new THREE.Color('#7a3f24') },
      stone: { value: new THREE.Color('#8f8580') },
    },
    vertexShader: /* glsl */ `
      attribute float depth;
      attribute float across;
      attribute float rise;
      varying float vDepth;
      varying vec3 vWorld;
      varying vec2 vFlat;
      void main() {
        vDepth = depth;
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        vFlat = vec2(across, rise);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 turf;
      uniform vec3 turfUnder;
      uniform vec3 topsoil;
      uniform vec3 subsoil;
      uniform vec3 clay;
      uniform vec3 stone;
      /** How far into the ground the cut stands, along the view (m): see GroundSection.update. */
      uniform float depthIn;
      varying float vDepth;
      varying vec3 vWorld;
      varying vec2 vFlat;

      float hash(vec3 p) {
        p = fract(p * vec3(0.1031, 0.1030, 0.0973));
        p += dot(p, p.yxz + 33.33);
        return fract((p.x + p.y) * p.z);
      }
      vec3 hash3(vec3 p) {
        return vec3(hash(p), hash(p + 17.1), hash(p + 41.7));
      }

      void main() {
        if (vDepth < 0.0) discard;
        // Patches: a grid of triangles across the cut, each a shade lighter or darker.
        vec2 tri = vec2(vFlat.x + vFlat.y * 0.5, vFlat.y) / 0.8;
        vec2 triCell = floor(tri);
        float shade = hash(vec3(triCell, step(fract(tri.x), fract(tri.y)))) - 0.5;
        // Layer boundaries wander a little along the ground.
        float wander = (hash(floor(vWorld.xzx / vec3(1.6, 1.6, 1.6))) - 0.5) * 0.25;
        float d = vDepth + wander * step(0.2, vDepth);
        vec3 colour;
        if (vDepth < 0.12) {
          colour = mix(turf, turfUnder, vDepth / 0.12);
        } else {
          colour = d < 0.9 ? topsoil : d < 2.6 ? subsoil : clay;
          colour *= 1.0 + shade * 0.16;
          // Stones: at most one per cell of a 1.4 m grid across, up and into the cut (along the
          // view), each a five-sided polygon turned at random, its faces shaded by how much they
          // face up. A stone shows while the cut lies within its thickness, popping in and out at
          // its edges: moving forward and back passes through them, as through the dirt.
          vec3 cell = floor(vec3(vFlat, depthIn) / 1.4);
          for (int z = -1; z <= 1; z++)
          for (int y = -1; y <= 1; y++)
          for (int x = -1; x <= 1; x++) {
            vec3 c = cell + vec3(x, y, z);
            vec3 r = hash3(c + 7.0);
            if (r.x > 0.8) continue;
            float radius = 0.1 + 0.32 * r.y * r.y;
            float into = abs(depthIn - (c.z + 0.2 + 0.6 * hash(c + 3.7)) * 1.4);
            float shown = clamp((radius - into) / (0.25 * radius), 0.0, 1.0);
            if (shown <= 0.0) continue;
            vec2 centre = (c.xy + 0.2 + 0.6 * r.yz) * 1.4;
            vec2 off = (vFlat - centre) * vec2(1.0, 1.25);
            float reach = -1.0;
            float lit = 0.0;
            for (int k = 0; k < 5; k++) {
              float a = r.z * 6.2832 + float(k) * 1.2566 + (hash(c + float(k)) - 0.5) * 0.5;
              vec2 n = vec2(cos(a), sin(a));
              float along = dot(off, n);
              if (along > reach) { reach = along; lit = n.y; }
            }
            if (reach < radius * shown) colour = stone * (0.78 + 0.22 * (lit * 0.5 + 0.5) + (hash(c + 3.0) - 0.5) * 0.08);
          }
        }
        // Darker the deeper it goes.
        colour *= 1.0 - 0.25 * smoothstep(0.0, 6.0, vDepth);
        gl_FragColor = vec4(colour, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}
