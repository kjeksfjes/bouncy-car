# Bouncy Car – Brief

_Work name. Drafted 2026-11-06._

## Pitch

Drive a big, floaty, indestructible-ish car down an endless procedurally generated snowy
mountain. Hit bumps, catch air, land hard, lose a bumper, keep going. The fun is in the
**feel**: soft suspension, body roll, big jumps and satisfying crunches.

## Pillars

1. **Feel first.** Driver-style (1999) handling: soft, bouncy suspension, visible body roll and
   pitch, forgiving arcade grip, controllable slides. If it isn't fun to drive on flat ground,
   nothing else matters.
2. **Terrain made for jumping.** Mostly downhill, bumpy, with rolling hills, moguls and natural
   kicker ridges running across the slope.
3. **Crunchy, but robust.** Cars dent and shed parts, but they're tougher than real cars, so a
   session lasts.
4. **Low-poly, nicely lit.** Flat-shaded geometry, soft sun shadows, fog for depth, a coherent
   palette. Polish comes from lighting and atmosphere, not polygon count.

## Scope – first playable (v0.1)

| Area | Decision |
|---|---|
| Stack | TypeScript + Vite + Three.js (rendering) + Rapier (`@dimforge/rapier3d-compat`, physics). Runs in the browser. |
| Mode | **Sandbox**: free roam, no fail state, respawn anytime. Goals/scoring come later. |
| World | Endless chunk-streamed terrain from seeded noise. Downhill along −Z. **Snowy mountain** biome: snow on gentle slopes, rock on steep ones. A treeline: bare snow at the top, then small sparse pines that grow taller and denser further down (up to a cap), broken up by large open meadows. Every ~450 m there's a chance of a set piece: a steep drop, half of them with a ski-jump-style launch lip. |
| Car | One car: **70s two-door coupe** (soft, floaty, lots of body roll; all-wheel drive for arcade traction), built from a *blueprint*: profile curves traced from an orthographic reference drawing, lofted into a body and split along the drawing's cut lines into hood, trunk, doors (with glass and mirrors), roof, glass and bumpers. Colliders are derived from the blueprint. Cars are data-driven configs, so more can be added. |
| Physics | Custom raycast suspension (spring + damper per wheel, bump stops), arcade tire model (lateral grip, friction circle, handbrake slides), air levelling toward the flight path while S is held (an always-on mode exists in the car config). |
| Damage | Mesh **deformation** at impact points. Panels break loose onto **physics hinges** first – doors swing out, hood and trunk lid open up, bumpers dangle from one end; airflow shuts doors and flips hoods up at speed – then tear off from more damage or violent flapping. Wheels break off. Losing a wheel changes handling. Low integrity kills the engine; press N for a new car. |
| Camera | Smoothed chase cam that stays above the terrain. |
| AI traffic | Up to 4 AI cars come and go around the player, each with its own cruise speed. They spawn and despawn only out of the camera's sight (never in front of you). P hands the player's car to the same AI (autopilot). |
| Controls | Keyboard: W/S or ↑/↓ for throttle and brake/reverse, A/D or ←/→ to steer, Space for handbrake, R to reset upright (keeps damage), N for a new car. In the air: hold S to level the car toward its flight path (otherwise free physics), A/D roll (W does nothing, since it's usually held). |
| HUD | Speed, car integrity, airtime, controls hint. |

## Later (not v0.1)

- More cars: pickup truck, dune buggy, compact hatchback (weight, suspension, grip and
  toughness differ per car).
- More biomes, including biomes that change along the descent (snow → forest → grassland).
- Gamepad support (analog steering and throttle).
- Goals: trick/airtime scoring, runs with a finish line.
- Juice: snow spray, sparks, smoke and fire, screen shake, audio (engine, crunch, landing).
- Post-processing (ambient occlusion, bloom), additional camera modes.
- Smashable props (trees that snap, fences).

## Technical notes

- Fixed 60 Hz physics step with render interpolation.
- Terrain height is an analytic function `h(x, z)`, so props, camera clamping and spawning can
  all query it without raycasts.
- Terrain colliders are trimeshes built from the same vertices as the render mesh.
- Impact detection uses Rapier contact-force events on the chassis. Damage scales with the
  impact's Δv above a per-car toughness threshold.
