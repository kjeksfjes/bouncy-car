# Changelog

Releases are named plainly after what they bring (the first three after
game-development milestones).

## v0.7.0 – "Muscle Rumble and Torn Turf" (2026-11-13)

A darker muscle-car V8 with a lumpy idle, tyres that grip by the ground
under them, and grass that tears up under slides and hard hits.

- **Engine sound:** the V8 fires each cylinder bank into its own
  exhaust pipe, so it burbles unevenly like a cross-plane muscle car,
  and a big cam makes the idle surge and stumble. Darker overall, and
  a little louder in the mix.
- **Grip by ground:** grass grips more than snow and rock most, blended
  where grounds meet.
- **Torn turf:** tyres sliding hard or skidding with the handbrake
  locked cut ruts in grass, and hard hits gouge small holes where the
  body touches. Each hole throws out its sod, which lands flat,
  sometimes grass down. Only grass and dirt tear, never snow or rock.
- **Tougher on landings:** landings cost an engine a third of what a
  crash does and can't push it into the red on their own, and wheels
  no longer come off on ordinary landings.
- **Fixes:** icy, snow-covered slopes no longer spark and squeal like
  bare rock.

## v0.6.0 – "Photo Mode and Engine Bay" (2026-11-12)

Pause and frame the wreck with a full photo mode, open the hood to a
filled engine bay, and watch slides grind the paint where the body
rests on the ground.

- **Photo mode:** from the pause, a right-drag, Shift+drag or
  Option+drag hands over the camera. Drag orbits the point under the
  cursor, right-drag turns the camera, Shift+drag pans, scroll moves
  towards the point under the cursor and Shift+scroll zooms the lens;
  the arrow keys pan and move. Every move eases in, and the camera
  stays above the ground, sliding along it when orbiting low. In slow
  motion, Esc plays the action on as seen from the photo camera.
- **Controls card:** a small card lists photo mode's controls while
  paused (H hides it), in the new Barlow typeface, with the keys named
  for a Mac or a PC.
- **Engine bay:** inner fender aprons with spring towers, a radiator
  support, a painted firewall, power steering pump, brake lines,
  battery cables and hoses. Panel insides are shaded in the bay and
  trunk and trimmed dark round the cabin.
- **Grind marks:** sliding scratches cover every panel resting on what
  the car slides along: straight streaks, ragged gouges down to primer
  and metal, and rock dust ground in.
- **Smoother crashes:** crumpling does about 5× less work per crash,
  and breaking glass no longer stalls a frame.
- **Fixes:** the rear bench and the engine bay no longer flicker in or
  show through the wheel wells and front fenders.

## v0.5.0 – "Old Oak, Smooth Crashes" (2026-11-12)

The great oak is rebuilt to look its age, and big crashes no longer
freeze the game.

- **Great oak:** a twisting trunk with roots that grow smoothly out of
  it and run down into the ground, following the slope it stands on;
  crooked limbs carry the crown as separate rounded masses of chunky,
  faceted leaves in fresh yellow-greens.
- **No hit-stop:** big crashes used to freeze the simulation for
  50–120 ms; it read as a hitch, so the game now runs straight through.
  The camera shake on impact stays.

## v0.4.0 – "Sights and Sounds" (2026-11-11)

The car wears its crashes and sounds like what it touches: paint that
chips, flakes and scratches, sparks off grinding metal, and new sounds
for scraping, tyres and the engine.

- **Paint wear:** hits chip the paint down to primer and bare metal,
  concentrated where the hit landed and flaking off in big ragged flakes
  on hard and head-on hits; glancing hits mostly scratch. Dragging along
  rock scratches hard, bark and other cars far less, snow never chips.
  Folds crack the paint too, and only faces turned toward the contact wear.
- **Sparks:** streaks that cool from white-hot to dull red, fall and
  bounce off the ground, thrown along the slide wherever metal grinds on
  rock or another car, and fanned out by hard hits.
- **Scraping sounds by surface:** a heavy, damped metal grind on rock, a
  smoother rub against other cars, a duller grind on bark, and soft drags
  over grass, snow and dirt.
- **Tyres by ground:** rolling and sliding sound like snow, grass, dirt
  or stone; on stone the rubber squeals. The load on the tyres sets their
  loudness and the squeal's pitch, and wild slides turn rougher.
- **Engine:** deeper, with a cross-plane V8 burble and a loping idle;
  overrun pops only just after lifting off; a dying engine sputters,
  backfires and knocks to a stop.
- **Testing:** F tips the car onto its side.

## v0.3.0 – "World Building" (2026-11-10)

The mountain becomes a landscape: real landforms, ground and growth that
follow them, a kilometre of view, and a sturdier, more detailed car.

- **Landforms:** ridges and valleys meander down the fall line, with level
  floors and flanks up to 60 m high; gullies fork and join down the valley
  flanks; ledges where a flank levels off; rocky knolls with a gentle ramp
  up and a short rock face to fly off; about one in five kicker ridges comes
  up bigger.
- **Shared environment:** slope, curvature, moisture, sun exposure and
  elevation are worked out from the landforms, and ground cover, trees and
  details all read them instead of separate noise.
- **Ground cover across the biomes:** some country is rocky, rock on its
  upper flanks and ridge tops; drop walls are grassy banks with rock
  outcrops instead of a bare stone band; rock shifts slowly between greys;
  grass leans lush in moist ground and drier on sunny slopes; snow lingers in
  hollows and scours off crests.
- **Trees:** woods grow where the ground suits them, old and big in their
  cores and young at the fringe, with each species on its own ground (spruce
  in moist, shaded hollows, pine on dry, sunny ridges, broadleaf low and
  sheltered). Open and wooded stretches alternate down the slope in the snow
  forest and the grassland, valley floors stay open meadow, now and then a
  great forest closes in, and winding lanes keep a way through every wood.
- **Details:** boulders lie about on rock and convex grass, snow-topped in
  the snow; a hard enough hit knocks one loose to tumble off, leaving its
  hollow and thrown clods. Shrubs gather along wood edges, grass clumps on
  moist ground.
- **Landmarks:** vardes of loose stones on cliff tops and knoll crowns
  topple when knocked; rare great oaks stand alone on rises in the grassland.
- **Far view and haze:** low-detail terrain and trees carry the view out to
  1 km; the haze builds gently by distance, glows warmer toward the sun and
  melts into the sky's own colour at the edge.
- **Sound:** modal-synthesis stone sounds: the knock of a toppling varde,
  stones clacking and thudding as they tumble.
- **The car:** a low-poly V8 engine bay that the crush shoves back whole; a
  tree-hit nose stays wrapped round the trunk instead of shrinking away from
  it; end panels that crumple; dangling lights that settle and tear off in
  crashes; closed wheel housings; overlapping fluid stains blend instead of
  flickering; no freeze on the first broken window.
- **Camera:** in slow motion the orbit camera stays where you leave it.
- **AI:** the autopilot and traffic steer clear of boulders as well as trees.
- **Faster:** chunk builds are about a third cheaper (6.0 → 4.3 ms).
- **Dev tools:** I cycles terrain inspection views (landforms, gullies,
  steepness, moisture, curvature, exposure); `scripts/terrain-map.mjs` draws
  relief and tree maps; a HUD line shows where the car is, and `?x=` spawns
  there.

## v0.2.0 – "Biome Blending" (2026-11-08)

The mountain thaws into summer: three biomes along the descent.

- **Biomes:** below the snowy mountain and forest, a thaw where the snow
  breaks up into patches on flat and shaded ground, then grassland with
  stone on the steepest faces.
- **Trees:** spruces keep their snow only where the ground is snowy;
  broadleaf trees and Scots pines join through the thaw, and the grassland's
  trees stand in woods and small groups of mostly one kind, with open
  meadow between.
- **Ground effects:** tyre spray, landing and impact puffs and scrapes throw
  whatever the ground is made of (snow powder, torn turf, stone dust and
  chips); metal sparks on stone; trees shed snow, leaves or needles.
- **Sky:** the wintry sky shifts to a deeper summer blue, and distance fades
  the landscape instead of whitening it.
- **Biome jumps:** B makes the next biome start just beyond the fog ahead;
  Shift+B puts you straight at its start.
- **Terrain:** the classic mountain (drops and launch humps) is back as the
  default; the varied set pieces (kickers, valleys, hills) are kept as a
  preset for later.

## v0.1.0 – "First Playable" (2026-11-08)

The sandbox: a floaty, destructible 70s coupe on an endless snowy mountain.

- **Driving:** custom raycast suspension with soft, bouncy body roll, an arcade
  tyre model with handbrake slides, air levelling on S, reset and new car.
- **The car:** a 70s coupe built from a blueprint traced from reference
  drawings (hips, shark nose, leaning tail, wrap-around bumpers, a full
  underbody with a moving axle), with an engine bay and cabin.
- **Damage:** dents, front/rear crumple zones and a caving roof; panels that
  hang on hinges and tear off; cracking and shattering glass; lights that smash,
  dangle on wires and fall off; knock-off trim; wheels that break off; coolant
  and oil leaks.
- **World:** endless streamed terrain with a treeline, meadows, and set pieces
  (drops, ski-jump lips, kickers, valleys, hills).
- **Cameras and time:** an orbitable chase camera, a cinematic helicopter
  camera, pause, and slow motion.
- **Juice and sound:** snow spray, sparks, screen shake, a sun lens flare and
  glass shards that flash in the sun; synthesised positional engine, tyre and
  impact sound.
- **AI:** traffic that comes and goes out of sight, and an autopilot.
