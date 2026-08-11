# Phase 1 — Foundation Hardening & Visual Rebirth

Delivered in **Final V4**. This document records exactly what changed, what is
verified, and what is explicitly *not* done yet.

---

## Verification status

| Gate | Command | Result |
| --- | --- | --- |
| Import/export graph | `node scripts/audit-imports.mjs` | 126 modules, 433 imports, clean |
| Logic regression suite | `node scripts/selftest.mjs` | **1126 / 1126 passed** |
| Syntax | `node --check` on every `.js` / `.mjs` | clean |
| Production build | `npm run build` | **NOT RUN HERE — see below** |
| Browser smoke test | `npm run smoketest:browser` | **NOT RUN HERE — see below** |

The packaging sandbox has no network access, so `npm ci` could not fetch `three`
or `vite` and the two runtime gates could not execute. Every module added in
this phase was therefore written to be **renderer-free and dependency-free** so
that its behaviour is testable in plain Node — which is why the suite grew from
965 to 1126 checks. Please run `npm install && npm run check` locally to close
the remaining two gates.

The self-test count rose by **161 checks**, all covering this phase's work.

---

## 1. Weather is now a real simulation

**Before:** `_updateWeather` rolled `Math.random()` every 95 seconds. Weather
was not seeded, not saved, identical in every biome, and reset to clear on
reload. Snow and thunder did not exist.

**After:** `src/world/WeatherSystem.js` — a deterministic, seeded state machine.

- Weather is a pure function of `(seed, cycle)`. The same world always produces
  the same sky, on every machine, forever.
- Four states: `clear`, `rain`, `thunder`, `snow`, weighted 66 / 26 / 8 with snow
  derived from biome temperature.
- Cycle lengths are sampled from the seed: clear spells run 4–12 minutes,
  precipitation 1.5–5 minutes.
- **Biome-aware.** The base state is resolved against the temperature of the
  column the player is standing in: below `-0.45` rain becomes snow, above `0.7`
  (desert, savanna) storms are suppressed entirely.
- Intensity ramps in and out across a cycle instead of snapping on.
- Lightning strikes on a seeded Poisson-ish interval during thunder only, and
  never in a storm that is locally reading as snow.
- `serialize()` / `deserialize()` persist as three numbers; a storm survives a
  save/reload round trip. Corrupt records are rejected rather than thrown on.

The biome sample is only taken when the player crosses a block boundary, so this
adds no measurable per-frame cost.

**Persistence wiring:** `SaveManager.createEmptyWorldRecord` gained a `weather`
field and `Game.js` writes it alongside `timeOfDay`. Worlds saved before this
change load as `null`, which cleanly means "start at cycle zero".

**Honest limitation:** `WeatherRenderer` now *receives* the true precipitation
kind and reports it in `this.precipitation` and in the notification copy
("Snow begins to fall", "A thunderstorm rolls in"), but it still draws the
existing rain droplet field for all three. Distinct snow particles, lightning
flashes and storm darkening are Phase 2 rendering work. The simulation is ready
for them; the visuals are not there yet.

---

## 2. Mob animation rebuilt on a real skeleton

**Before:** mobs were flat lists of boxes and `MobRenderer` applied a hard-coded
sine wave to leg boxes. Rotating a body did not move the head. Every creature
shared one walk cycle. There was no way to author a new animation.

**After:** three new renderer-free modules.

- **`src/rendering/SkeletalModel.js`** — a proper parented bone hierarchy with
  pivots, matrix composition and world-space resolution. Validation rejects
  cycles, missing parents, duplicate names and rootless skeletons at load time
  rather than producing silent garbage.
- **`src/rendering/AnimationController.js`** — keyframed clips with loop, clamp
  and ping-pong modes, linear interpolation, cross-fading between clips, and
  additive layers (so a hurt flinch can play *on top of* a walk cycle). Long
  frame deltas are clamped so a backgrounded tab cannot fast-forward a death
  animation.
- **`src/entities/MobSkeletons.js`** — authored skeletons and clips for all
  seven creatures, built from four body archetypes (quadruped, biped, bird,
  floater).

Every creature now has `idle`, `walk`, `run`, `hurt` and `death`, plus
creature-specific `attack`, `cast` and `flap`. Gaits differ per creature — the
suite asserts at least four distinct walk-cycle durations, so the chicken no
longer walks like a cow.

The suite verifies, for every one of the seven mobs, that the skeleton is valid,
that every authored clip resolves against its own bones, that loops are seamless,
that the walk gait actually moves something, and that mid-blend poses are finite.
The key behavioural test — **rotating a parent bone moves its child** — is the
thing the old flat box list could not express at all.

**Honest limitation:** `MobRenderer` has **not** yet been switched over to
consume `MOB_SKELETONS`. The skeleton, clip and blending layer is complete and
tested, but the Three.js renderer still drives the old boxes. Wiring the
renderer to the new pose output is the first task of Phase 2, and it is a
renderer-only change because the maths is already proven.

---

## 3. Mob navigation actually navigates

**Before:** cardinal-only A* with a 384-node budget and a 28-block radius. Mobs
staircased around obstacles, treated closed doors as solid walls, could not use
ladders, and gave up on any detour longer than a few blocks.

**After:** `src/entities/ai/VoxelNavigator.js`

- **Diagonal movement** with a corner guard — a mob will not squeeze through a
  diagonal gap between two blocks, which is the classic voxel clipping bug.
- **Octile heuristic.** Adding diagonals made the old Manhattan heuristic
  *inadmissible* (it overestimated true cost, degrading A* into greedy
  best-first and still producing staircase paths). This was caught by the new
  test asserting a diagonal route is shorter than a cardinal one, and fixed with
  the exact octile distance. Diagonal routes are now provably optimal.
- **Doors and ladders** are traversable, gated by `canUseDoors` / `canClimb` so
  that zombies can open a door and a chicken cannot.
- **Budget raised** from 384 to 2000 nodes and 28 to 40 blocks, which is what
  makes a genuine 18-step detour around a walled enclosure possible.
- **Dimension-aware height bound**, ready for the Nether's low ceiling.
- Vertical cost is asymmetric — climbing is penalised more than dropping.

---

## 4. Sound: from 2 events to 37

**Before:** the synthesiser generated 31 distinct sounds but gameplay only ever
triggered two of them. Jumping, landing, splashing and swimming were silent or
hard-coded.

**After:** `src/audio/SoundEvents.js` is a declarative table binding 37 gameplay
events to catalogue buffers, with per-event volume, pitch and cooldown.
`AudioManager.playEvent(event, context)` resolves and throttles them.

The payoff is a test that asserts **every synthesised sound is reachable from
some gameplay event** — which immediately caught a real bug: the item-pickup
buffer is called `pickup`, but the binding pointed at `ui.click`, so the
dedicated pickup sound could never have played. Fixed.

Movement audio in `Game.js` now routes through the event system, including a
proper water-entry splash on the transition edge (not every frame) and landing
volume scaled by impact speed.

---

## 5. Dimension groundwork

`src/world/DimensionConfig.js` defines the Overworld, Nether and End as data:
height, sea level, ceiling, ambient light, skylight, weather, respawn rules and
per-dimension generator seed salts. The 8:1 Nether coordinate ratio is
implemented and round-trip tested.

Nothing generates a Nether yet — this is Phase 4. What this phase delivers is
that the Overworld entry is an exact mirror of the current hard-coded constants,
so the rest of the engine can start reading dimension data without any
behaviour change.

---

## 6. Correctness fixes

- **`PlayerPhysics`** read `player.inLiquid ?? player.inWater`, which silently
  fell back to a second, differently-maintained flag. Now reads the single
  `LiquidContact` source.
- **`MobTypes`** claimed a `NEUTRAL` family for villagers and wolves that do not
  exist. Comment corrected to point at the phases that will add them.
- **`EntityManager.livingEntities()`** was documented as returning an empty pool.
  It does not — the doc was wrong, not the code.

---

## Phase 1 exit state

Project completion moves from roughly **40% to ~52%**.

What is proven in Node: weather simulation, dimension maths, sound-event
bindings, skeleton and animation maths, all seven creature rigs, and navigation
rules.

What still needs your machine: `npm run build` and the browser smoke test, plus
visual confirmation that the weather and audio changes feel right in motion.

First three tasks of Phase 2, in order:

1. Point `MobRenderer` at `MOB_SKELETONS` / `AnimationController`.
2. Give `WeatherRenderer` real snow particles and lightning flashes.
3. Start reading `DimensionConfig` in `World` / `ChunkManager` instead of the
   hard-coded `WORLD_HEIGHT` / `SEA_LEVEL` constants.
