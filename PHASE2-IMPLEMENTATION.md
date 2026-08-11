# Phase 2 implementation notes (FinalV5)

Phase 2 of the five-phase clone roadmap: **Overworld Completion — systems layer.**
Built on top of the Phase 1 FinalV4 package. Version `4.0.0` → `5.0.0`.

## Gate results

All three gates that can run without network access are green:

| Gate | V4 | V5 |
|---|---|---|
| `node scripts/audit-imports.mjs` | 126 modules / 433 imports | **131 modules / 437 imports**, no problems |
| `node scripts/selftest.mjs` | 1126/1126 | **1218/1218** (+92) |
| Parse sweep over all `.js`/`.mjs` | ALL_PARSED | **ALL_PARSED** |

**Not run, and cannot be run in the packaging sandbox:** `npm install`,
`npm run build` (Vite), and `npm run smoketest:browser` (Playwright). The sandbox
has no network access, so `three` and `vite` cannot be installed. Run
`npm install && npm run check` locally to close those gates. This is an
environment limitation, not a known defect.

## What was added
Five modules, 1,465 lines. Every one is renderer-free and world-free, so all of
it is exercised by `npm run selftest` rather than only by eye.

| File | Lines | Purpose |
|---|---|---|
| `src/rendering/MobPoseBuffer.js` | 207 | Packs bone matrices into a GPU-ready float texture |
| `src/entities/MobAnimator.js` | 212 | Drives one creature's clip selection, gait and flinch |
| `src/entities/ai/MobGoals.js` | 389 | Priority goal selector with control-channel arbitration |
| `src/world/BlockFamily.js` | 299 | Generates 127 block variants and their recipes from 13 family definitions |
| `src/world/StructureTemplate.js` | 358 | Deterministic connector/jigsaw structure assembly |

### `MobPoseBuffer` — bone matrices as a texture

Each bone is stored as three RGBA texels (12 floats: the three meaningful rows of
a 4×4 matrix; the fourth row is always `0,0,0,1` and is not worth the bandwidth).
Texture width is `boneCount × 3`, height is `maxInstances`, so one texture serves
an entire mob type and the shader reads row `aInstanceRow`.

UV helpers return **half-texel centres** (`(x + 0.5) / width`). Sampling at texel
edges is the classic way to get bones bleeding into each other on some GPUs.

`writeSkeleton` returns `false` rather than throwing on a bone-count mismatch or
out-of-range row, because this runs in the render loop where a thrown error costs
the whole frame.

### `MobAnimator` — one creature's animation state

Clip priority is `death → cast → attack → flap (airborne) → run → walk → idle`.

Hurt is an **additive layer**, not a clip swap, so a flinch reads on top of
whatever the creature is already doing. It re-arms on the **rising edge** of the
damage flag only — re-arming every frame while a mob stands in fire would pin the
clip to frame zero and look frozen.

Head tracking is merged into the pose **after** sampling, so steering composes
with whatever the clip is doing to the head instead of fighting it. It is only
applied when the rig actually has a `head` bone (the lurker does not).

### `MobGoals` — composable behaviour

`MobBrain.js` hand-writes each creature as one state machine. That works for
seven creatures and collapses at thirty. Here behaviour is a list of goals with
priorities, so a new creature is data rather than new control flow.

The important design point is that goals are **not** mutually exclusive. Each
goal declares the control channels it occupies (`MOVE`, `LOOK`, `JUMP`,
`TARGET`), and two goals run together exactly when their channels are disjoint.
Without this you get either mobs that cannot walk and look at once, or two goals
steering one creature and jittering it in place.

A goal is evicted only by a **strictly higher-priority** goal that needs one of
its channels.

### `BlockFamily` — the catalogue gap is mostly repetition

A full clone needs roughly 250–300 blocks; this project has 73. Most of that gap
is not novel blocks, it is the same 13 variants repeated per wood type and the
same 6 per stone type. Describing a family once yields all of them plus the
recipes that connect them: **7 woods × 13 + 6 stones × 6 = 127 blocks**.

Non-solid variants (slabs, stairs, fences, walls, gates, buttons, plates, signs)
get `lightAttenuation: 0`. A fence that blocks skylight like a full cube renders
the garden underneath it pitch black.

### `StructureTemplate` — one assembler for every structure

Villages, desert temples, mineshafts, Nether fortresses and strongholds are the
same problem: place a start piece, then attach further pieces at declared
connectors without overlapping anything already placed. Building it now means
Phase 2 villages, Phase 4 fortresses and Phase 5 strongholds are all data.

Assembly is breadth-first so growth is even rather than one long tendril, and it
takes an **injected** `random` and never touches `Math.random`. Same seed must
always give the same village, or structures shift under already-saved chunks.

After the random draws for a connector fail to fit, it retries every piece in the
pool once. Without that fallback a village silently loses buildings purely
because of draw order.

## Three real bugs caught by running the code

All three were found by executing the modules, not by reading them.

1. **`wander` claimed `MOVE|LOOK`.** `lookAt` could therefore never run while a
   creature was wandering, so a strolling cow could never turn its head to watch
   you. Now `MOVE` only.

2. **`panic` and `meleeAttack` claimed `JUMP`.** Higher-priority `float`
   (priority 5) evicted the *entire* panic goal just to claim the jump channel,
   so a hurt animal in water stopped fleeing and bobbed in place. Both are now
   `MOVE|LOOK`, leaving `JUMP` disjoint so `float` composes instead of
   preempting.

3. **`selectClip` returned optional clips unguarded.** `resolveClip` falls back
   to `idle` for a mob that lacks a clip, so `if (state.attacking) return
   resolveClip(id, 'attack')` dropped a *sprinting passive animal* into `idle`
   the instant it swung — it reads as the mob freezing mid-stride. `cast` and
   `attack` now use the same existence guard the `flap` branch already used.

## Deliberately deferred

### `MobRenderer` skeletal rewrite — the one thing you will notice

`MobRenderer.js` (407 lines) is **unchanged**. Mobs still animate with the old
`Limb` enum and a GLSL sine-wave swing. The entire skeletal pipeline behind them
is implemented and tested end to end, but nothing is driving the renderer yet, so
**Phase 2 is not yet visible in game.**

This was deferred on purpose. It is a shader rewrite that cannot be compiled,
let alone visually verified, in a sandbox with no `three` and no `vite`. Shipping
an unverifiable GLSL rewrite on top of a build I cannot run is the most likely
way to hand back a black screen.

The design is settled, so this is execution rather than research:

- Build geometry from `MOB_SKELETONS[id].skeleton.bones` with a per-vertex
  `aBone` attribute replacing the current `aLimb`/`aPivot` pair.
- Instance with an `aInstanceRow` attribute. **Do not use `gl_InstanceID`** —
  the project targets GLSL1.
- Upload bones as a `DataTexture` with `uBones` / `uBoneTexSize`, sampled with
  `texture2D` (**not** `texelFetch`, same GLSL1 reason).
- Keep a renderer-owned `Map` of `MobAnimator`s **pruned every frame**. Mobs are
  pooled and ids are recycled, so an unpruned map is a slow leak that also
  animates the wrong creature.

### Also deferred

- **Injecting the 127 block variants** into `BlockTypes.js` and the texture
  atlas. Block ids are baked into every saved chunk, so this is a save-format
  migration, not a refactor. `allocateIds` exists precisely to do it
  reproducibly, and it was not done blind.
- **Village piece content** on top of `StructureTemplate`.
- **Migrating `MobBrain.js`** onto `GoalSelector`.
- **Snow, lightning and storm darkening** in `WeatherRenderer` — same
  cannot-verify-without-a-build reason as the mob renderer.

## Completion estimate

Roughly **57%**, up from ~52% at V4.

The increment is deliberately smaller than the line count suggests, because
Phase 2 delivered the load-bearing systems layer rather than visible gameplay.
Four of the five modules are consumed by code that does not exist yet. That is
the right order — each one is independently testable now, and the work that
consumes them cannot be verified in this environment.
