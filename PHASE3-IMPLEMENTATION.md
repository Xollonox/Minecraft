# Phase 3 systems implementation

Version 6.1 completes the roadmap through Phase 3 and connects the mechanical core to the playable build.

Implemented and tested:

- One ordered damage pipeline for melee, projectile, armour, resistance, shields and absorption.
- Charged attacks, critical hits, sweep eligibility, sprint knockback and bow charge maths.
- Seeded enchanting offers, conflicts, anvil combining/repair/rename, grindstone removal and smithing upgrades.
- Brewing fuel/progress, awkward potion tree, extension/amplification, corruption, splash and lingering forms.
- Expanded shared status effects: resistance, absorption, invisibility, wither, levitation, jump boost and slow falling.
- Deterministic queued redstone network, piston push planning, item-conserving hoppers.
- Shared boat/minecart vehicle physics, fishing loot state machine and reusable multi-part boss controller.
- Craftable enchanting, anvil, grindstone, smithing, brewing, piston, hopper, dispenser and rail blocks.
- In-world workstation actions for enchanting, anvils, grindstones and brewing; click-driven piston execution.
- 264 registered blocks, 33 living mob types, 45 biomes, generated villages, taming/mount ownership and deterministic villager trades.
- GPU bone-texture skeletal rendering driven by the authored animation controller for the full mob roster.
- Distinct snow motion and thunder flashes in the live weather renderer.

The systems are renderer/DOM independent and covered by `npm run selftest:phase3`. The production
player damage resolver now uses the shared pipeline, preserving the existing armour durability path.

Run the complete gate with `npm run check`, then `npm run smoketest:browser`. The latter requires a local Playwright Chromium installation.
