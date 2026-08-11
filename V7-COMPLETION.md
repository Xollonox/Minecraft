# Archived Version 7 completion claim (superseded)

> A later strict audit found that the former “every exit criterion” wording was too broad for the
> supplied 122-item roadmap. This file is retained as historical release documentation and must not
> be read as the current completion status. Version 8 uses a scoped, test-backed improvement claim.

Version 7 shipped a playable campaign in which a fresh survival player
can advance from the Overworld through the Nether and a generated stronghold, enter the End, defeat
the Ender Dragon, use the exit portal, see the original poem and credits, and return home. Outer End
islands, cities, ships, shulkers, shulker boxes, elytra and the four-crystal respawn ritual remain
available after that first completion.

## Shipped scope

- Phase 1–2: deterministic infinite world, survival loop, crafting, stateful blocks, biomes, structures,
  original procedural art/audio, mobs, equipment, vehicles, projectiles and accessible input modes.
- Phase 3: unified damage, enchanting, anvils, brewing, status effects, automation, trading, fishing,
  statistics foundations and persistent world services.
- Phase 4: generated Nether, fortresses, portals and coordinate travel, Nether progression, the Wither,
  beacons and dimension-aware saves.
- Phase 5A–B: full Enderman special behaviour, throwable Eyes of Ender, generated strongholds with
  libraries, portal rooms, lava, partial eyes, silverfish spawners, silverfish and infested blocks.
- Phase 5C: End sky/ambience, central and outer islands, void damage, cities, ships, shulkers, persistent
  shulker boxes and durable elytra gliding.
- Phase 5D: dedicated articulated dragon rig, Bezier flight states, ten crystals and healing beams,
  attacks, boss bar, death sequence, 12,000 XP, unique egg, exit fountain, gateway and respawning.
- Phase 5E: original poem and credits, return-home flow, ordered advancements, statistics, death markers,
  v6-to-v7 save migration and responsive phone/mid/desktop graphics profiles.

## Verification record

- Import graph audit and every deterministic Phase 1–5/v7 self-test pass.
- Production Vite build passes.
- Production browser campaign passes 185/185 Chromium/WebGL checks with no console errors.
- Browser coverage includes worker streaming, long-running water shader stability, play/inventory/
  crafting/furnace/chest/combat/save/reload, live End switching, dragon rig/crystals/boss bar, stronghold
  location, outer city content, shulker storage, victory structures, resummoning, credits, return home
  and a 390 px phone viewport with no horizontal overflow.
- The release archive is integrity-tested after packaging.

The current status and boundaries are documented in `V8-IMPROVEMENTS.md`. Textures, sounds, poem and
interface art are original, and the project is unofficial.
