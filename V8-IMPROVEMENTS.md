# Version 8 improvement release

Version 8 is a focused gameplay and presentation upgrade. It is not represented as a 100% clone or
as completion of every line in the supplied 122-item roadmap.

## Player-visible improvements

- Eyes of Ender now fly as visible glowing world-space models with a twenty-point trail, a hover
  finish, and deterministic shatter or dropped-eye outcomes.
- Tall End pillars have generated iron-bar cages. The four-crystal resummon ritual restores complete
  obsidian pillars, bedrock caps, cages and all ten crystals.
- The dragon encounter adds live fireball projectiles, contact damage and knockback, charge-path block
  destruction, procedural roars, an original battle-music loop, and a four-second death spectacle with
  an XP-style burst and eight light beams.
- In-progress dragon fights persist across saves, including health, crystals, flight state and death
  timing.
- The High graphics preset adds screen-space ambient occlusion. Animated water gains procedural
  caustics and crest foam while preserving the existing atlas-safety guard.
- Iron bars are append-only block id 371, have original procedural atlas art, and appear in the
  creative End category.

## Compatibility and boundaries

- Existing block ids remain unchanged. World format 8 needs no destructive record reshaping.
- Medium and lower presets keep SSAO disabled; High and Ultra enable it only on WebGL 2-capable
  devices.
- Exact commercial-edition parity is not claimed. The known-limitations section of `README.md`
  records major remaining engine and ruleset differences.

## Verification

Run `npm run check` for import, deterministic compatibility, v8 and production-build gates. Run
`npm run smoketest:browser` for production startup plus the instrumented Chromium/WebGL campaign,
including the High preset and the live v8 End encounter.
