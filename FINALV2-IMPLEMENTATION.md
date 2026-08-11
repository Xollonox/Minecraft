# Minecraft-W FinalV2 — implementation report

FinalV2 is a source-code package built from the earlier `Final.zip`. It is not a renamed archive:
the engine, simulation and test suite were materially expanded.

## What FinalV2 implements

### Scalable world data

- Runtime block ids widened from 8-bit to 16-bit (`0..65535`).
- Current save edit format stores a 16-bit block id plus persistent state and migrates older saves.
- Palette-compressed `16×16×16` section snapshots with bit-packed palette indices.
- Validation and exact round-trip decoding for block ids and state bytes.
- Expanded procedural atlas capacity from 256 to 1,024 cells.
- Hardened import normalisation rejects malformed, truncated and reserved-bit edit payloads.

The active streamer still loads full 128-block columns. The section codec is the migration
foundation, not a false claim that vertical section streaming is already complete.

### Shared block model and collision system

Rendering, collision, selection and ray targeting now consume the same state-aware voxel shapes.
Implemented structural blocks include:

- Oak and cobblestone slabs.
- Oak and cobblestone stairs.
- Trapdoors and climbable ladders.
- Fences, walls and fence gates with neighbour connections.
- Double-block doors.
- Glass panes.
- Double-block beds with spawn assignment and night skipping.
- Buttons and wooden/stone pressure plates.

This removes the former full-cube-only limitation and creates the base for pistons, hoppers, rails
and other complex models.

### Lighting

- Propagated 0–15 block light.
- Cross-chunk propagation from a 3×3 chunk neighbourhood.
- Torches, lava, fire and powered redstone lamps act as real voxel light sources.
- Opaque blocks stop light; transparent blocks attenuate according to their registry data.
- Light-relevant edits invalidate every potentially affected neighbouring mesh.

### World simulation

- Stable 20 Hz block simulation clock.
- Deduplicated scheduled ticks and deterministic random ticks.
- Persistent block-state bytes across chunk workers, edits and saves.
- Stateful flowing water and lava.
- Water source formation and falling liquid columns.
- Water/lava reactions producing cobblestone or obsidian.
- Farmland moisture and drying.
- Wheat, carrot and potato growth/drop rules.
- Bone meal and oak sapling growth with full-volume validation.
- Deterministic fire ignition, spread, water extinguishing and burnout.
- Flint-and-steel item, recipe, durability, procedural icon and sound.
- Fire contact damage for players and living mobs, respecting fire resistance.

### Survival, inventory and equipment

- Health, hunger, saturation, exhaustion, air, damage, death, respawn and XP foundations.
- Armour slots, offhand and four complete armour tiers.
- Armour reduction/toughness and durability loss.
- Directional shields with durability and blocking movement penalty.
- Charged bows, ammunition, projectile entities, swept collision and mob/player arrows.
- Shared persistent status-effect controller with speed, slowness, strength, weakness,
  regeneration, poison, fire resistance, water breathing and night vision foundations.
- Safe centralised container transfers with item-conservation regression tests.
- Enhanced-mode inventory sorting: merges compatible stacks and deterministically sorts the
  27-slot storage grid while preserving the hotbar, equipment, offhand and cursor.

### Living world

- Data-driven mob definitions and pooled living entities.
- Passive and hostile spawn categories/caps using daylight and propagated block light.
- Persistent mob and dropped-item records with stable ids, health, velocity and metadata.
- Local bounded A* voxel navigation with safe steps/drops, hazards and route replanning.
- Line of sight, wander, flee, chase, melee and ranged behaviours.
- Animal breeding foods, love mode, babies, growth, feeding acceleration and cooldown persistence.
- Data-driven deterministic loot tables used by mobs, gravel and crops.

### Redstone foundation

- Power levels `0..15`.
- Redstone wire attenuation and depowering.
- Levers and redstone torches.
- Lit/unlit redstone lamps.
- Directional repeaters with delays.
- Buttons and wooden/stone pressure plates.
- Persistent states and scheduled transitions.

This is not presented as complete Java redstone. Pistons, comparators, observers, hoppers,
dispensers, rails, exact update ordering and quasi-connectivity remain future work.

### Engineering and diagnostics

- F3 overlay includes player/world state, target block id/state/shape/light, status effects,
  chunk/worker queues, entity/baby/projectile counts, renderer statistics and memory information.
- GitHub Actions workflow runs import audit, syntax checks, deterministic tests, production build,
  Playwright Chromium WebGL smoke testing and uploads screenshots/diagnostics.
- Original procedural textures and audio only; no Mojang assets or source code.

## Validation commands

```bash
npm ci
npm run audit
npm run selftest
npm run build
npx playwright install chromium
npm run smoketest:browser
```

The archive itself does not include `node_modules`; install dependencies before running the Vite
build or browser smoke test.

## Major remaining work

The following are not silently represented as complete:

1. Full vertical section streaming and configurable world height.
2. Exact compatibility movement/mining/hunger/fluid constants and edge cases.
3. Waterlogging, fire edge cases and broader environmental ticks.
4. Full inventory drag/double-click/recipe-unlock parity.
5. Hierarchical/specialised navigation and the full mob catalogue.
6. Villages, villagers, professions, trading and major deterministic structures.
7. Enchanting, anvils, grindstones, smithing and brewing UI/content.
8. Pistons, comparators, observers, hoppers, dispensers, droppers, TNT and complete redstone order.
9. Rails, minecarts, boats and shared vehicle physics.
10. Thousands of compatibility and long-session browser/device tests.

See `ROADMAP-REMAINING.md` for the recommended dependency order.
