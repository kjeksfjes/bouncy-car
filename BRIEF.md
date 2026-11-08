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
| World | Endless chunk-streamed terrain from seeded noise. Downhill along −Z. **Snowy mountain** biome: snow everywhere you drive, shading to an icy blue on steep faces like drop walls; rock only on near-vertical faces. A treeline: bare snow at the top, then small sparse pines that grow taller and denser further down (up to a cap), broken up by large open meadows. Every ~450 m there's a chance of a set piece: a steep drop, half of them with a ski-jump-style launch lip. |
| Car | One car: **70s two-door coupe** (soft, floaty, lots of body roll; all-wheel drive for arcade traction), built from a *blueprint*: profile curves and a side cross-section (tucked in at the bottom, widest at the hips, a shoulder crease and rounded top edge) a forward-leaning shark nose that forms a shallow V from above, with a recessed full-width surround under its beak holding the quad headlights and a barred grille, and a tail panel that leans in at the top, with two rounded taillights, each lens in two sections, a fuel filler cap between them license plates in recesses below both bumpers, and wrap-around chrome bumpers with two guards each (the rear one rising over the plate), traced from orthographic reference drawings (`ref/1970s-muscle-car/`, checked against the model with `scripts/overlay.mjs`), lofted into a body and split along the drawing's cut lines into hood, trunk, doors (with glass and mirrors), roof, glass and bumpers. Panels have real wall thickness (solidified, with edges along every cut line), and under them sit an engine bay (V8, radiator, battery), a cabin (bucket seats, rear bench, dashboard, steering wheel) and a spare wheel in the trunk. Under the floor runs a twin exhaust, traced from underside and rear drawings (`ref/1970s-muscle-car/`): a pipe from each manifold, through a muffler ahead of the rear axle, out to a chrome tip under each side of the rear bumper, kicking up over the rear axle. The rest of the underbody follows the underside drawing too (stretched to the car's proportions): frame rails and crossmembers under a ribbed floor, the oil pan, gearbox and driveshaft, a ribbed fuel tank on straps, and a live rear axle and front A-arms that follow the wheels' travel. The engine steams when the car is badly hurt and smokes when it dies. Colliders are derived from the blueprint. Cars are data-driven configs, so more can be added. |
| Physics | Custom raycast suspension (spring + damper per wheel, bump stops), arcade tire model (lateral grip, friction circle, handbrake slides), air levelling toward the flight path while S is held (an always-on mode exists in the car config). |
| Damage | Mesh **deformation** at impact points, plus **crumple zones** front and rear: hits squarely on the nose or tail push that end in (up to ~0.65 m at the front, ~0.45 m at the rear) – the hood or trunk lid tents up at a crease, fenders bow out, the bumper bends, and the collision box shrinks with it. Trees punch a narrow, deep notch; walls, ground and cars push in wide. Landing on the roof caves it in toward the beltline (up to ~0.25 m; the roof is the body's weak spot, so it gives way at lower impact than the chassis), leaning it over on a corner hit, bowing the pillars and shattering all the windows; the cabin's collision box comes down with it. Crush doesn't change handling. Panels break loose onto **physics hinges** first – doors swing out, hood and trunk lid open up, bumpers dangle from one end; airflow shuts doors and flips hoods up at speed – then tear off from more damage or violent flapping. Glass panes (windshield, rear, quarter and door windows) are see-through, crack in a spiderweb around the hit point (hard crashes carry through the body, so a big frontal hit can take out the windshield), then shatter into glinting shards that are thrown out from the pane, trail back on the air at speed and lie sparkling on the snow; a door window goes with its door. Head-, tail- and marker lights are rigid fixtures that ride on the crushed or dented body, following it at both ends (so a wide taillight tilts with a crumpled tail): hits smash the lens (it goes dark and sheds coloured shards), harder hits or deep crush pop the light out of its socket (headlights leave their place in the nose's recessed surround, taillights a real opening with a dark recess in the tail panel): some snap clean off, the rest dangle on their wire, kept outside the body and bumpers, until a hard yank (a heavy landing) or more hits snap the wire. Small trim gets knocked clean off as tumbling debris: mirrors (they ride on the doors), the grille (baring the hole into the engine bay at the back of the surround), hubcaps, which pop off on hard knocks or landings and roll away, baring the steel wheel and its lug nuts, and the chrome exhaust tips, baring the pipe's open end, the license plates (leaving their dark recesses) and the fuel filler cap. Wheels break off. Losing a wheel changes handling. Coolant and oil leak independently, each until its tank runs dry: a damaged radiator (hits on the nose, front crush) leaves a green trail, a holed sump (hits from below, hard landings, a wrecked engine) a dark one; drops get denser and bigger the worse the leak and stretch into splashes at speed, and a dead car that has stopped bleeds its remaining oil into a spreading puddle. Low integrity kills the engine; press N for a new car. |
| Camera | C cycles cameras. The default orbit camera trails the car (following its direction of travel, stays above the snow, widens its field of view with speed); drag the mouse to swing it freely around the car, from down at the snow (well below the car when it's in the air) to almost overhead, and scroll to zoom; where the snow is in the way it climbs its orbit, keeping its distance from the car. It holds the view where it's left; while the car is moving it eases back behind it after a few seconds. The cinematic helicopter cam hovers off to the side, slowly orbits and drifts in distance and elevation, lags with a telephoto lens and cuts to a new angle when the car gets away; drag to swing it around and tilt it (from down at the snow, looking up at the car, to steeply overhead), scroll to zoom (past ≈160 m, where the fog would swallow the car, zooming out widens the lens instead); its automatic drift pauses while you steer. Both cameras move by angle and distance around the car, so swinging round follows the circle, and both keep the car in sight: when a crest or bump would block the view, they rise quickly and sink back slowly. |
| Juice | Snow spray from the tyres (more when sliding), snow puffs on landings and impacts, snow shaken off trees, orange sparks from metal on rock or metal, screen shake and a camera dip on hard hits and landings, and a brief hit-stop on big crashes. |
| AI traffic | Up to 4 AI cars come and go around the player, each with its own cruise speed. They spawn and despawn only out of the camera's sight (never in front of you). P hands the player's car to the same AI (autopilot). |
| Controls | Keyboard: W/S or ↑/↓ for throttle and brake/reverse, A/D or ←/→ to steer, Space for handbrake, R to reset upright (keeps damage), N for a new car, Esc to pause (everything freezes, but the cameras can still be orbited and zoomed, and they hold the view where it's left). In the air: hold S to level the car toward its flight path (otherwise free physics), A/D roll (W does nothing, since it's usually held). |
| HUD | Speed, car integrity, airtime, controls hint. |
| Audio | Synthesised live with the Web Audio API, positional: V8 engine (pitch from RPM through simulated gears), tyre crunch and sliding, body scrape, wind, plus one-shots for impacts, glass cracking/shattering, panels clanking loose and landings. M mutes. |

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
