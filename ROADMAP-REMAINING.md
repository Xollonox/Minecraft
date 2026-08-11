# Archived FinalV2 remaining roadmap

> Historical planning document. The former blanket completion claim was superseded after a strict
> audit. Some entries remain aspirational or partial. See `V8-IMPROVEMENTS.md` and README known
> limitations for the current shipped scope.

## Priority 0 — certify the package

- Install dependencies with `npm ci`.
- Run production build and Playwright smoke suite in CI.
- Capture desktop, mobile, Survival, third-person, fire, mob and redstone screenshots.
- Fix every runtime/browser issue before increasing the content catalogue.

## Phase 1 completion

1. Migrate the live chunk manager and mesher to independently streamed 16³ vertical sections.
2. Replace fixed `WORLD_HEIGHT` assumptions with configurable `minY`, `maxY` and `seaLevel`.
3. Add a general property-compiled block-state registry beyond the current persistent state byte.
4. Complete waterlogging, downhill fluid search, currents, fire edge cases, snow/ice/leaf/grass ticks.
5. Add exact mining, movement, hunger and damage compatibility tables.
6. Finish beds/safe respawn edge cases, inventory drag, double-click collection and recipe unlocking.
7. Expand early survival content, wood families, foods, utility items and browser end-to-end tests.

## Phase 2 completion

1. Persist every long-lived entity by chunk/region with migration and bounded save size.
2. Add hierarchical navigation plus dedicated climbing, swimming and flying navigation.
3. Convert mob behaviour into reusable goal components and expand passive/hostile archetypes.
4. Complete animal products, taming, ownership, mounts and breeding genetics where useful.
5. Build a template/piece/connector structure engine and data-driven chest loot.
6. Implement villages, POIs, schedules, professions, trading, reputation and defenders.

## Phase 3 completion

1. Unify all combat through a damage-event pipeline; add criticals, sweep, sprint knockback and
   weapon timings.
2. Finish status effects, then enchanting/anvils/grindstones/smithing and brewing/potions.
3. Upgrade redstone to directional strong/weak power with explicit update ordering.
4. Implement pistons and moving-block collision as an isolated heavily tested subsystem.
5. Add hoppers, droppers, dispensers and sided inventory automation with conservation tests.
6. Add rails, minecarts and boats using a shared vehicle entity/physics architecture.
7. Generate block families from data instead of hand-writing every slab/stair/door variant.

## Enhanced-mode add-ons

- Optional inventory/container sorting and recipe favourites.
- Editable mobile HUD, gyroscope aiming and controller-first UI navigation.
- Waypoints, death markers, photo mode and world statistics.
- Distant terrain LOD and optional WebGPU renderer while keeping WebGL baseline.
- Data packs/resource packs, structure editor and creator/debug overlays.
