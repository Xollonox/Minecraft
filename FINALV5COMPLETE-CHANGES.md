# FinalV5complete — what actually changed

Version `5.1.0`. This build closes the **block catalogue** half of the Phase 2 gap that the
previous V5 package overclaimed. It does not finish Phases 1–2. Read the scoreboard before the
detail.

## Scoreboard

| Thing | V5 (5.0.0) | This build (5.1.0) | Roadmap target |
| --- | --- | --- | --- |
| Blocks | 73 | **189** | 250–300 |
| Atlas tiles | 192 | **227** | — (1024 ceiling) |
| Items | 178 | **250** | — |
| Recipes | 81 | **181** | — |
| Mobs | 7 | **7** | ~30 |
| Biomes | 12 | **12** | ~45 |
| Selftest checks | 1218 | **1240** | — |
| Modules / imports | 131 / 437 | **131 / 438** | — |
| Unwired Phase 2 modules | 6 | **5** | 0 |

## What was done

### `BlockFamily` is no longer an orphan

It was fully implemented, fully tested, and imported by nothing. It is now the generator behind
the live catalogue.

- `BlockTypes.js` imports `ALL_FAMILIES`, `buildFamilies` and `allocateIds`.
- The hand-written enum became `BASE_BLOCK_IDS` (ids 0–72, unchanged). The exported `Block` is now
  that base merged with the generated ids.
- 116 variants across **7 wood families** (oak, spruce, birch, jungle, acacia, dark oak, mangrove)
  and **6 stone families** (granite, diorite, andesite, deepslate, tuff, calcite) were appended as
  **ids 73–188**.

### Save compatibility was the constraint, and it held

Block ids are written into every saved chunk. Renumbering an existing block silently corrupts
every existing world. `allocateIds` was given the base ids as "taken" and allocated upward from
the first free slot, so the injection is a **pure append**: ids 0–72 mean exactly what they meant
before. **No save migration is needed and existing worlds still load.** A selftest asserts this.

Eleven variants (`oak_log`, `oak_planks`, `oak_slab`, `oak_stairs`, `oak_fence`, `oak_fence_gate`,
`oak_door`, `oak_trapdoor`, `oak_pressure_plate`, `spruce_log`, `birch_log`) already existed by
hand and are skipped, so no duplicate name or second id was minted. A selftest asserts the skip
list still matches reality, because a stale skip list is how a duplicate sneaks in.

### Textures: 35 new tiles, all painted

A declared tile with no painter makes `TextureAtlas.build()` **throw at boot**; a block with no
tile renders magenta. Both were checked by executing the module, not by reading it:

- 35 tiles appended (6 plank types, 4 log sides, 7 stripped logs, 6 stone bases, 6 polished, 6
  brick variants) — the atlas holds 227 of a possible 1024.
- Procedural painters added for every one (`paintFamilyPlanks`, `paintFamilyLog`,
  `paintStrippedLog`, `paintFamilyStone`, `paintPolishedStone`, `paintFamilyBricks`), reusing the
  existing `barkColumns` helper. Registration guards skip tiles that already existed.
- **Verified: 227 tiles declared, 227 painters registered, zero missing, zero orphaned.**

### The blocks are reachable and craftable

A block nobody can obtain is the same as a block that does not exist.

- Two generated creative palette groups ("Wood Families", "Stone Families") expose all 116.
- 100 generated recipes: per wood family — wood block, planks, slab, stairs, fence, fence gate,
  door, trapdoor, button, pressure plate, sign; per stone family — polished, bricks, slab, stairs,
  wall. All 181 recipes validate against `RecipeRegistry` with unique ids and real item ids.
- Items are generated from `BLOCK_DEFINITIONS`, so all 116 got items automatically (178 → 250).
- Stone families set `requiresCorrectTool`, so they drop nothing when punched; wood does not.

**One deliberate quirk:** the legacy recipes turn oak, spruce *and* birch logs into *oak* planks.
Changing that would have altered existing behaviour a test pins, so spruce and birch planks are
crafted via their `_wood` block instead, and the legacy recipes were left alone.

## What was NOT done — do not misread this build

- **Mobs are still 7.** Roadmap wants ~30. Untouched.
- **Biomes are still 12.** Roadmap wants ~45. Untouched.
- **`MobRenderer` still uses the old flat-box path.** The whole skeletal stack remains unwired.
- **Five modules are still imported by nothing:** `MobAnimator`, `MobPoseBuffer`, `MobGoals`,
  `StructureTemplate`, `DimensionConfig`. Their tests pass and change nothing you can play.
- **No village generation, no Nether, no End, no Ender Dragon.** Phases 3–5 are untouched.
- **Nothing was rendered.** The sandbox has no network, so `three` and `vite` could not be
  installed; `npm run build` and the browser smoke test did not run. Logic gates only.

## Verify it yourself

```bash
npm install
npm run check      # audit + selftest + build
npm run dev
```

In game: open the creative inventory and look for the **Wood Families** and **Stone Families**
groups, place a few, and craft `granite` → `polished_granite` → `granite_bricks`. Load an existing
save and confirm the terrain is unchanged.
