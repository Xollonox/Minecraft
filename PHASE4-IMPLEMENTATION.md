# Phase 4 — The Nether

Phase 4 takes the project from a one-dimension sandbox to a two-dimension game.
The dimension framework, portals, terrain and the eight ambient Nether mobs
landed earlier; this document covers the work that closed the phase.

## What shipped

### Netherite (4C)
A fifth tool tier and armour set above diamond: `ancient_debris` smelts to
`netherite_scrap`, four scrap plus four gold ingots make an ingot, and the
smithing table upgrades diamond gear in place while preserving enchantments.
Tier level 5, durability 2031, and every piece is fireproof.

### Nether Fortress (4D)
The first real consumer of the Phase 2 template engine. Eight piece types
(crossings, corridors, bridges, blaze rooms, wart gardens, treasure caps,
stairs) assemble through the jigsaw connector system. Fortresses are sited one
per 384-block region, in roughly 45% of regions, deterministically per seed, and
are painted into chunks during generation rather than as a post-pass. Marker
blocks record where blaze spawners, loot chests and wart farms belong.

### The Wither (4D)
Three wither skeleton skulls on a soul sand or soul soil frame summon the boss.
The ritual is detected along both horizontal axes from any of the three skull
positions, the blocks are consumed, and the fight runs on the Phase 3
`BossController`: a ten-second invulnerable rise, three phases, explosion
immunity while armoured, and side heads that take half damage. Death yields one
Nether Star.

The Wither is excluded from natural spawning, so it can only ever be summoned.

### Piglin bartering and strider riding (4C)
A fourteen-entry weighted barter table pays out for gold ingots. Each piglin has
its own seeded trade stream derived from the world seed and its trade count, so
rolls are reproducible across a save and reload rather than being re-randomised.
Gold armour pacifies piglins until the player loots a Nether chest or attacks
one. Striders are steered with a warped fungus on a stick that loses durability
per boost, and move fast on lava but crawl on land.

### Nether ambience (4A)
A looping Nether bed — low rumble, a distant resonant groan, and sparse ember
crackle — with a dimension-aware mixer that mutes wind, rain and underwater beds
while the player is in the Nether.

### Brewing became reachable
Brewing existed in Phase 3 but no ingredient did. Blaze rods, blaze powder,
nether wart, magma cream, ghast tears, glowstone dust and gunpowder are now real
items dropped by real mobs, so the potion tree is playable end to end:
water to awkward to strength or fire resistance, then splash or amplified.

## Integration

`Phase4Runtime` mirrors `Phase3Runtime`: the systems themselves are pure and
independently tested, and the runtime is the single place that owns their live
state, binds them to a world, and decides what persists. It is constructed per
world, ticked from the fixed update, saved into the world record, and torn down
with the world.

Wither fights are deliberately not persisted. A boss frozen mid-fight and
restored on load would return at partial health with no body in the world, so a
reload ends the fight instead of corrupting it.

The summon hangs off the canonical `BLOCK_PLACED` event, which means it works
from any placement path without the placer knowing the boss exists.

## Tests

`npm run selftest:phase4` — 35 checks covering the tier ordering and smithing
upgrade, item and icon integrity, drop-to-item resolution, the brewing chain,
dimension-gated spawning, boss exclusion from spawn pools, fortress piece
validation and determinism, fortress brickwork reaching generated chunks, the
summon ritual on both axes including rejections, phase transitions and loot, the
barter table and its reproducibility, strider wear, the ambience loop rendering
audible samples, and the runtime's own behaviour.

Full gate: 1557 core checks, 20 Phase 3, 35 Phase 4, 147 modules audited clean.

## Deferred

- Bastion Remnants and their treasure rooms
- Ruined portals in the Overworld
- Entities and minecarts travelling through portals
- The Wither's blue skulls and the beacon block
- `redstone` and `sugar` items, which would unlock the last two potion modifiers
