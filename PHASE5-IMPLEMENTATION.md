# Phase 5 — The End, the Ender Dragon, and the end of the roadmap

Version 6.6.0. This phase adds the third dimension, the way in, the fight at the
end of it, and the way home. It also closes the last three items Phase 4 had left
open, so the five-phase roadmap now has no deferred work in it.

## What a player can now actually do

1. Kill an Enderman in the Overworld and take its pearl.
2. Craft that pearl with blaze powder from the Nether into an **eye of ender**.
3. Throw the eye to find a **stronghold**, buried between y 14 and y 30.
4. Fill the twelve **end portal frames** in the stronghold's portal room.
5. Step through, arrive on the obsidian platform, and meet the **Ender Dragon**.
6. Shoot out ten **end crystals** so the dragon stops healing, then bring it down.
7. Take the **dragon egg**, bottle the **dragon breath**, brew a lingering potion,
   and walk home through the exit portal.

## The End (`src/world/EndGenerator.js`)

- A central island of end stone about 66 blocks across, ringed by genuine void.
  The self-test asserts the void is empty: `nonAir === 0` across sixteen chunks.
- Ten obsidian pillars carrying ten end crystals, the whole geometry derived from
  the seed and exposed as `endPillars()` / `endCrystalPositions()` so the fight
  and the generator cannot disagree about where a crystal is.
- Outer islands and chorus growth beyond the void ring. Both thresholds were tuned
  against a measured noise histogram rather than guessed: the outer-island field
  runs `-0.506 .. 0.599` with a p90 of `0.199`, so the island gate sits at `0.24`.
- An arrival platform at `{ x: 100, y: 49, z: 0 }`, because a portal that dropped
  you into the void would be a crash, not a dimension.

## Strongholds (`src/world/Stronghold.js`)

Seven room types assembled by the existing `StructureTemplate` walker, sited one
per 48-chunk region with a 40% rejection rate, and painted into Overworld chunks
from `TerrainGenerator`.

- Exactly one portal room per stronghold, with exactly twelve frames and **no lit
  portal** — lighting it is the player's job and costs twelve eyes.
- The palette is mossy cobblestone and cobblestone. This build has no stone-brick
  family at all; the substitution is documented in the file header rather than
  hidden, and was found by probing the block table instead of guessing an id.
- `nearestPortalRoom(x, z, seed)` is what makes a thrown eye of ender point
  somewhere real.
- Stronghold painting runs *after* cave carving so a ravine cannot clip the portal
  room and make a world unfinishable.

## Lighting the portal (`src/progression/Phase5Runtime.js`)

- `placeEyeOfEnder` refuses a filled frame and refuses a non-frame block, then
  lights a 3x3 `END_PORTAL` when the twelfth eye goes in.
- `_ringCentreFor` treats each of the twelve offsets as a hypothesis and confirms
  all twelve cells, which means a **player-built** frame ring works exactly like a
  generated one.
- Filled frames, lit portals and an in-progress dragon fight persist. Health,
  crystals, flight state and death timing resume from the save record.

## The Ender Dragon (`src/progression/EnderDragon.js`)

- 200 hp on the shared `BossController`, with per-part multipliers: head 1.5,
  body 1, wing 0.6, tail 0.4.
- Melee against a flying dragon deals **zero**. Only a perched dragon can be hit
  with a sword, and then the head takes 1.5x.
- Ten crystals heal 2 hp/s each. Twenty hp per second beats any bow in the game,
  so the crystals are not optional — they are the puzzle.
- Three phases (`circling`, `perching`, `desperate`) with escalating breath damage.
- `fireBreath()` returns a lingering cloud that can be bottled into a glass bottle,
  which is the only route to a lingering potion.
- Death opens a 3x3 exit portal and lays one dragon egg. There is no respawn ritual:
  one dragon per world.

### A real bug this found

`BossController.phase` is only assigned inside `damage()`, so a fresh boss reported
`phase: null` and the boss bar would have rendered blank until the first hit. The
dragon's constructor now ends with `this.controller.damage(0)` to prime it. The
same latent bug exists in `WitherFight` and is called out in the code.

## Portal travel rework (`src/Game.js`)

`linkedDimension()` is hard-coded to two dimensions and can never return `end`, so
End travel could not be expressed as "where does this dimension link to".
Destination is now decided by **the portal block you are standing in**:

- `NETHER_PORTAL` → `linkedDimension(from)`, unchanged, including the eightfold
  coordinate scaling and obsidian frame building.
- `END_PORTAL` → the End, or the Overworld if you are already there. This path
  bypasses `linkedPosition`/`resolveDestination` entirely, because both are
  Nether-shaped and would try to build an obsidian frame in the void.

### Entities through portals (the last Phase 4 item)

Mobs standing within three blocks of the player are recorded as an id plus an
**offset**, killed, and re-spawned at the same relative position on the far side.
Offsets rather than absolute coordinates are what make this survive the Nether's
eightfold coordinate scale. Capped at eight passengers so a mob farm built on a
portal cannot stall a crossing, and if the dimension switch fails the passengers
are put back where they were.

## Beacons (`src/progression/Beacon.js`, `src/world/UtilityBlocks.js`)

Before this, a **nether star** — the reward for the hardest fight in the Nether —
had nothing to be crafted into. Now it makes a beacon.

- Four pyramid tiers with 20/30/40/50 block ranges, each tier a solid `(2n+1)`
  square of mineral blocks. A hollow base gives nothing.
- Sky access is required, but transparent blocks are allowed, so a glass-roofed
  beacon still works.
- Base materials are netherite, quartz and obsidian: the ones this build has.
  Vanilla's iron and gold blocks do not exist here, and obsidian is included
  deliberately so the beacon is a goal rather than a decoration.
- `BeaconRegistry` is keyed by position and populated from block placement, so the
  pyramid scan only ever runs for blocks the player actually built.

The beacon is declared in a new **neutral** block family. `NetherBlocks.js` and
`EndBlocks.js` both force a dimension tag onto everything they declare, and block
ids are assigned by declaration order — inserting a beacon into the Phase 3 list
would have shifted every Nether and End id by one and silently rewritten the
contents of existing saves. Appending a new family after the End keeps all 364
existing ids exactly where they are. Beacon is block 364.

## Also in this phase

- **Ruined portals** in the Overworld, so the Nether is discoverable without a
  recipe book.
- **Bastion remnants** in the Nether, with piglin barter and a treasure room.
- Blue wither skulls.
- Three new items: `glass_bottle`, `dragon_breath`, `chorus_fruit`.
- Fixed: `end_portal_frame` declared a diamond harvest tier without requiring the
  correct tool, which `BlockRegistry` correctly rejected at import time.

## Numbers

| | 6.5.0 | 6.6.0 |
|---|---|---|
| Blocks | 364 | **365** |
| Atlas tiles | 428 | **433** |
| Items | 450 | **451** |
| Recipes | 200 | **201** |
| Mobs | 43 | 43 |
| Dimensions | 2 implemented | **3 implemented** |

## Verification

```
npm run audit              155 modules, 520 relative imports, no problems
npm run selftest           1566/1566
npm run selftest:phase3    20/20
npm run selftest:phase4    35/35
npm run selftest:phase5    41/41
```

`npm run build` and `npm run smoketest` cannot run in this sandbox: there is no
network, so `vite` and `three/addons/*` were never installed. That is an
environment limit, not a regression — every check above runs on plain Node.
