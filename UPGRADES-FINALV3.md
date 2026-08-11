# FinalV3 upgrade pass

Changes made on top of FinalV2, verified headlessly (Node harness driving the real
`World`/`Player`/`Inventory`/`RecipeRegistry` code) since this environment has no
GPU or npm network access. Every number below is *measured*, not estimated.

## 1. Movement calibrated to Java Edition

`src/config/GameConfig.js`

| Metric | Before | After (measured) | Java |
|---|---|---|---|
| Walk speed | 4.46 b/s | 4.28 b/s | 4.317 |
| Sprint speed | 7.12 b/s (+27%) | 5.54 b/s | 5.612 |
| Jump apex | 1.400 blocks | 1.256 blocks | 1.2522 |
| Sneak multiplier | 0.32 | 0.30 | 0.30 |

- `walkSpeed` 4.5 -> 4.32, `sprintMultiplier` 1.62 -> 1.3, `crouchMultiplier` 0.32 -> 0.3.
- `jumpVelocity` 9.2 -> 8.7. The fixed-step integrator overshoots the analytic apex
  by ~5.9%, so the impulse is chosen to land the measured apex on 1.25 blocks:
  one-block steps jumpable, 1.5-block ledges not.

## 2. Mining speed calibrated to Java Edition

`src/interaction/MiningCalculator.js`, `src/items/ItemTypes.js`

- `HARDNESS_TO_SECONDS` 0.62 -> 1.02. The old value made every block ~2x faster to
  break than vanilla, which flattened the whole tool progression.
- Tool tier speeds snapped to Java's exact multipliers: wood 2.2 -> 2, iron 6.5 -> 6,
  diamond 9 -> 8 (stone already 4).

| Breaking stone | Before | After | Java |
|---|---|---|---|
| bare hand | 4.54s | 7.5s | 7.5s |
| wooden pickaxe | 0.62s | 1.12s | 1.15s |
| stone pickaxe | 0.34s | 0.56s | 0.6s |
| iron pickaxe | 0.21s | 0.37s | 0.4s |
| diamond pickaxe | 0.15s | 0.28s | 0.3s |

## 3. Mob animation overhaul

`src/entities/MobRenderer.js` — still one InstancedMesh per species, all animation on
the GPU; a second instanced vec4 channel (`aMobAnim2`) plus a `uTime` uniform drive:

- **Idle life**: standing mobs breathe (torso rise), drift their limbs, and look
  around slowly; a golden-ratio per-instance seed de-synchronises a herd so cows
  never turn their heads in unison.
- **Walk polish**: heads nod subtly with the gait; tails/ears/horns (`Limb.DETAIL`,
  previously static) wag with movement and flick lazily at rest.
- **Attack telegraphs**: a strike snaps the swinging limbs forward and eases them
  back over the cooldown; hostiles pitch their torso into the lunge. Biped arms
  share the swing channels, so zombies get the classic raised-arm lunge for free.
- **Rim light**: a sky-tinted Fresnel rim in the mob fragment shader separates
  silhouettes from fog and dark backdrops.

## 4. Terrain shader graphics

`src/rendering/shaders/voxel.frag.glsl`

- Tight sun specular (gated by sky light, N.L and the shadow map) so ice, leaves
  and wet-looking surfaces catch the sun.
- Sky-tinted Fresnel rim at grazing angles.
- Screen-space dither (±0.75/255) to remove 8-bit banding in dusk skies and fog
  gradients. All using existing uniforms — no pipeline changes, no new GPU state.

## 5. Bugs investigated and cleared

- Armour maths (`damageAfterArmour`) — verified it already implements Java's exact
  formula `min(20, max(a/5, a - d/(2+t/4)))/25`; 10 dmg at 20 points -> 4. Correct.
- Redstone lamp — verified it swaps to a real `REDSTONE_LAMP_LIT` block on power
  (with the vanilla 4-tick off delay). Correct.
- Water surface — already animated with three crossing waves and analytic normals.

## Verification

- `node scripts/selftest.mjs` — **965/965 checks pass** after all changes.
- Headless gameplay harness — **22/22 pass**: streaming, meshing (1.12M triangles),
  determinism, landing, walking/sprinting/jumping at the calibrated speeds,
  frame-rate independence (0.072 blocks divergence 30Hz vs 144Hz over 4s),
  break/place, falling sand, water spread, torch light, save/reload.
- Renderer paths (GLSL compile, worker pool, vite build) still need a browser run:
  `npm install && npm run dev`, then `npm run smoketest:browser`.

## Honest gap to "perfect Minecraft"

Content: 73 blocks / 134 items / 81 recipes / 7 mobs / 9 effects vs vanilla's
~1100 / ~1400 / ~1100 / ~85 / 34. Missing systems, roughly in build order:
XP + enchanting + anvil, brewing, villages + trading, structures (mineshafts,
strongholds), pistons + hoppers + comparators + observers, rails/minecarts + boats,
the Nether, the End, multiplayer. The engine core (streaming, lighting, physics,
save, redstone base) is solid and now vanilla-calibrated.
