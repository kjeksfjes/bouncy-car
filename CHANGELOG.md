# Changelog

Releases are named plainly after what they bring (the first three after
game-development milestones).

## v0.12.1 – "Smoother Running" (2026-11-17)

A performance pass, from an audit of what each frame costs.

- **Snow effects:** powder, ice glints, sparks and glass shards find the
  ground from a cached height grid, halving the effects' cost per frame
  in the snow.
- **No more freeze on a new car:** a car arriving (traffic, or N) no
  longer stalls the game for about a tenth of a second.
- **Steadier streaming:** the terrain builds one chunk a frame instead
  of two, so driving fast doesn't spike frames.

## v0.12.0 – "Settling Snow, Smoother Slow Motion" (2026-11-17)

Falling snow now settles on the cars, and a round of fixes makes crashes
look right, in slow motion especially.

- **Snow on the roof:** while it snows, snow builds up on whatever faces
  the open sky (roof, bonnet, boot lid, the screens), much faster in
  heavy snow. It melts from the thaw down, blows off at speed and stays
  out of the engine bay and cabin.
- **Snow and smoke:** flakes pass in front of a burning car's smoke and
  sink into it, instead of showing through it from behind.
- **Slow motion:** a crash no longer makes the car jump forward, and the
  wheels and steering move smoothly instead of in steps.
- **Loose panels:** a bent bumper or crumpled bonnet keeps its whole
  shape solid, so it no longer sinks into the ground or passes through
  things.
- **Leaks** drip steadily from one spot, and **empty lamp sockets**
  don't fill with snow.
- **Dev:** Shift+F drops the car on its nose from 15 m.

## v0.11.0 – "Into the Snowstorm" (2026-11-16)

The top of the mountain gets real weather: a gusting snowstorm under a
grey sky that clears on the way down, snow that settles on the car and
glitters in the air, and trees that drop their leaves when hit. The game
is also playable online.

- **Snowfall:** heavy snow at the top in big clumps falling fast, easing
  toward the thaw into small crystals that flutter and flicker. Flakes
  streak as you drive into them and glow toward the sun.
- **Storm and sky:** a gusting wind blows the snow sideways at the top,
  with a roaring, faintly howling sound, easing to a light breeze by
  1.5 km. While it snows the sky turns grey-white, the sun hides and
  then shows as a pale disc, light goes flat, shadows soft, and the
  view closes in to a couple of hundred metres.
- **Hush:** heavy snow muffles the world: distant sounds fade and dull
  faster, the whole mix dips a little.
- **Snow on the car:** the tyres' spray builds up textured snow on the
  sides, arches, front and rear (glass, bumpers and trim too), creeping
  a little over the edges, never on the roof, underside or inside. It
  melts from the thaw down and blows off at speed.
- **Snow spray:** the powder thrown up is bigger and floats; ice
  crystals in it glint in the sun and settle out, fluttering, onto the
  ground.
- **Snowy trees:** spruces wear snow mantles with wavy hems, heavier where
  the land holds snow, the first ones nearly buried.
- **Falling leaves:** hitting a tree shakes loose leaves that flutter
  down like real ones, and twigs, cones and snow lumps that tumble.
  They stay where they land.
- **Buried boulders** throw their snow when hit or scraped, with the
  sparks.
- **Online:** a README with a screenshot, and the game deploys to GitHub
  Pages on every push.

## v0.10.0 – "Lights, Glass and the Woods" (2026-11-15)

Headlights, brake lights and a parking handbrake, glass that sounds and
breaks like car glass, leaks you can see dripping, and an autopilot that
finds its way through the woods.

- **Lights and handbrake:** tap Space to park on all four wheels, hold
  it to lock the rear and slide. Brake lights glow while braking (not
  while levelling in the air). Headlights look like lamps, glow as
  running lights, and L switches them. A brake press from rolling only
  brakes; reverse takes a new press.
- **Breaking glass:** sounds like toughened car glass: a sharp, weighty
  pop and a rush of small cubes. Each shard comes with three small
  crumbs that hang back as the shards fly on and glitter in the sun.
- **Leaks:** slow or standing still, drops form under the radiator or
  sump, let go and fall, staining where they land. They move with the
  crushed body. A dead car's puddle gets drops falling into it.
- **Sparks:** a soft warm glow and round ends; the smallest slow to
  dashes and dots, skidding along the ground.
- **Boulder hollows** take the stone's shape: they open at its outline
  and slope in at about 50°, following the stone, not the grid.
- **Trees hiding the car** thin out as a whole, in a coarse dot
  pattern, instead of a car-sized hole.
- **Birds:** flocks cross more often (every 15–40 s). About one crossing
  in three is a lone bird or a pair, and stragglers wander off on their
  own.
- **Autopilot in the woods:** it slows for trees and plans a path
  through the gaps to open ground, backing round to face it. It backs
  off a trunk it has nosed into and swings its nose round it, and swaps
  a limping car sooner. Shift+P shows what it weighs and why.
- **Photo mode:** 1 frees the camera, 2 watches the car from where the
  camera stands, 3 follows it. Esc pauses and plays, and C goes back to
  your view.
- **Controls:** the cards list the action first, with Shift variants
  indented under it. Shift+' speeds slow motion back up.
- **Dev mode** survives a reload: typing "dev" adds `?dev` to the
  address. E toggles the engine sound (was Shift+M).

## v0.9.0 – "Rooks, Maps and Controls" (2026-11-14)

Rooks that live in the trees and on the meadows and take off when you
come crashing through, a controls card on screen, and a dev mode with
map views of the mountain.

- **Rookeries:** some big broadleaf trees, every great oak, and a few
  pines and spruces hold rooks. Any touch on the tree sends them up and
  away from the car: they climb on fast wingbeats, then flap and glide
  off. An emptied tree stays empty.
- **Rook flocks:** flocks of 8–25 feed on open grass, walking, pecking
  and looking round. A car within 22 m or a crash within 60 m sends
  them up in a ripple. Now and then a loose flock crosses the sky in
  green country.
- **Rook sounds:** whirring wingbeats as a group lifts off, alarm caws
  (their resonances measured from a rook recording), and calls from
  birds in the air. The sounds follow the birds as they fly.
- **Controls card:** the controls move from the line along the top into
  a card in the bottom left corner, with Esc (pause and photo mode) set
  apart. Photo mode shows only its own card. H hides the card in front
  of you, and each card remembers it.
- **Airtime popup:** gone.
- **Dev mode:** `?dev` in the address, or typing "dev" while playing,
  turns on the test tools, listed on a card on the right: terrain
  inspection views (I, Shift+I back, also while paused), a camera
  straight down over the car (V), a 4 km 2D map with trees, boulders
  and the loaded area (Shift+V), a rook flock (G, Shift+G), engine sound
  off (Shift+M), a blast under the car (F) and Go to (J, which also
  updates the address). F was a hidden key anyone could press before.

## v0.8.0 – "Smarter Autopilot, Clearer View" (2026-11-14)

An autopilot that plans its way down the mountain, hunts cairns and
works itself loose when stuck, and a car you can always see: through
the trees that hide it, and as a silhouette against the sun.

- **Autopilot route:** the AI plans far ahead for the open way through
  or round forest, off rock faces and tipping slopes, sets its speed by
  the grip, and goes for a cairn ahead to knock it over.
- **Getting loose:** when stuck, the AI backs out and drives away round
  trunks and steep rock instead of pushing on, avoids the heading that
  got it stuck, and picks its way to open ground in dense forest.
  Resets put a car on the nearest spot clear of trunks, and slippery
  bark keeps cars from hanging on trees.
- **New car when wrecked:** a broken autopilot car that has lain still
  for a few seconds is swapped for a new one, as N would.
- **See through trees:** when trees hide most of the car, they dissolve
  in front of it. A tree covering only a corner or a side stays whole,
  and photo mode always shows trees whole.
- **Backlight:** undersides catch the ground's light, bright on snow
  and darker on grass, and looking into the sun darkens the land and
  the car toward a silhouette against the sky.
- **Photo mode:** a right-drag turns the camera the way the cursor
  goes, and faster.
- **Brakes:** much stronger; on snow they now use all the grip there is.
- **Fixes:** a wheel torn off on landing no longer counts as touching
  the ground (it could break the tyre grip reading).

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
