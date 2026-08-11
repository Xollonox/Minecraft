/** Version 8 improvement gates: visible eyes, End cages, dragon combat and High graphics. */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

import { Block, TILE_INDEX, CREATIVE_GROUPS } from '../src/world/BlockTypes.js';
import { voxelIndex } from '../src/utils/CoordinateUtils.js';
import { EndGenerator, END_ISLAND_SURFACE_Y, endPillars } from '../src/world/EndGenerator.js';
import { EyeOfEnderRenderer } from '../src/rendering/EyeOfEnderRenderer.js';
import { EnderDragonRenderer } from '../src/rendering/EnderDragonRenderer.js';
import { DragonFlightState, EnderDragonFight } from '../src/progression/EnderDragon.js';
import { Phase5Runtime } from '../src/progression/Phase5Runtime.js';
import { GRAPHICS_PRESETS } from '../src/config/GraphicsPresets.js';
import { createSoundCatalogue } from '../src/audio/SoundRegistry.js';
import { SAVE } from '../src/config/GameConfig.js';

let passed = 0;
const check = (name, condition) => {
  if (!condition) throw new Error(name);
  passed++;
  console.log(`  ok  ${name}`);
};
const section = (name) => console.log(`\n${name}`);

function fakeWorld() {
  const cells = new Map();
  const key = (x, y, z) => `${x | 0},${y | 0},${z | 0}`;
  return {
    cells,
    dimensionId:'end',
    getBlock:(x, y, z) => cells.get(key(x, y, z)) ?? Block.AIR,
    setBlock:(x, y, z, block) => {
      const cell = key(x, y, z);
      if ((cells.get(cell) ?? Block.AIR) === block) return false;
      cells.set(cell, block);
      return true;
    },
  };
}

section('Append-only v8 content');
check('world format retains version 8 compatibility', SAVE.worldFormatVersion >= 8);
check('iron bars append at block id 371', Block.IRON_BARS === 371);
check('iron bars have an atlas tile', Number.isInteger(TILE_INDEX.iron_bars));
check('the creative End group exposes iron bars', CREATIVE_GROUPS.some((group) => group.label === 'The End' && group.blocks.includes(Block.IRON_BARS)));

const cagedPillar = endPillars().find((pillar) => pillar.caged);
const pillarChunkX = Math.floor(cagedPillar.x / 16);
const pillarChunkZ = Math.floor(cagedPillar.z / 16);
const pillarChunk = new EndGenerator(8080).generateChunk(pillarChunkX, pillarChunkZ);
let generatedBars = 0;
for (let y = 0; y < 128; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
  if (pillarChunk.blocks[voxelIndex(x, y, z)] === Block.IRON_BARS) generatedBars++;
}
check('tall End pillars generate real iron cages', generatedBars >= 20);

section('Visible Eye of Ender');
const eyeScene = new THREE.Scene();
const eyeRenderer = new EyeOfEnderRenderer({ scene:eyeScene });
const eyeFlight = {
  shatters:false,
  samples:Array.from({ length:13 }, (_, index) => ({ x:index, y:64 + Math.sin(index / 12 * Math.PI) * 5, z:index * .5 })),
};
check('a valid eye throw launches a world-space model', eyeRenderer.launch(eyeFlight) && eyeRenderer.group.visible && eyeRenderer.active);
let eyeCompletion = null;
for (let index = 0; index < 64; index++) eyeCompletion = eyeRenderer.update(.05) ?? eyeCompletion;
check('the eye renders a twenty-point additive trail', eyeRenderer.trail.geometry.attributes.position.count === 20);
check('the flight finishes with a deterministic item drop position', eyeCompletion?.shatters === false && eyeCompletion.end.x === 12 && !eyeRenderer.group.visible);
eyeRenderer.destroy();
check('the Eye renderer removes its scene group on teardown', !eyeScene.children.includes(eyeRenderer.group));

section('Expanded dragon encounter');
const fight = new EnderDragonFight();
fight.tick(7.1);
const fireball = fight.consumeAttack();
check('the crystal phase opens with a dedicated fireball state', fight.flightState === DragonFlightState.FIREBALL && fireball?.kind === 'fireball');

const player = {
  position:{ x:0, y:END_ISLAND_SURFACE_Y + 2, z:0 },
  velocity:{ x:0, y:0, z:0 },
  damageTaken:0,
  hurt(amount) { this.damageTaken += amount; },
};
const combatWorld = fakeWorld();
const combatRuntime = new Phase5Runtime({ world:combatWorld, player, seed:8 });
combatRuntime.beginDragonFight('end');
let spawnedProjectile = null;
combatRuntime._applyLiveAttack({ kind:'fireball', damage:7, speed:15 }, {
  spawnProjectile:(...args) => { spawnedProjectile = args; },
});
check('dragon fireballs become live mob projectiles', spawnedProjectile?.[4]?.visualKind === 'dragon_fireball' && spawnedProjectile[4].gravity === 0);

combatRuntime.fight.position = { ...player.position };
combatRuntime._applyDragonBodyCollision();
check('contact with the dragon causes damage and knockback', player.damageTaken === 5 && player.velocity.y >= 3.5);

combatWorld.setBlock(0, END_ISLAND_SURFACE_Y + 9, 0, Block.DIRT);
combatRuntime.fight.position = { x:0, y:END_ISLAND_SURFACE_Y + 9, z:0 };
combatRuntime.fight.flightState = DragonFlightState.CHARGE;
combatRuntime._bodyDamageCooldown = 1;
combatRuntime._blockBreakCooldown = 0;
combatRuntime._applyDragonBodyCollision();
check('a charging dragon breaks ordinary blocks in its path', combatWorld.getBlock(0, END_ISLAND_SURFACE_Y + 9, 0) === Block.AIR);

const deathScene = new THREE.Scene();
const deathRenderer = new EnderDragonRenderer({ scene:deathScene });
combatRuntime.fight.crystals.forEach((_, index) => combatRuntime.fight.destroyCrystal(index));
combatRuntime.fight.damage(999, { part:'head', source:'projectile' });
combatRuntime.fixedUpdate(.25);
deathRenderer.update(combatRuntime.fight, .25);
check('dragon death has a visible burst and eight light beams', deathRenderer.deathBurst.visible && deathRenderer.deathBeams.every((beam) => beam.visible));
for (let index = 0; index < 16; index++) combatRuntime.fixedUpdate(.25);
check('the four-second death sequence ends in portal and reward payout', !combatRuntime.activeFight && combatRuntime.exitPortalOpen && combatRuntime.pendingRewards[0]?.experience === 12000);
deathRenderer.destroy();

const ritualWorld = fakeWorld();
const ritual = new Phase5Runtime({ world:ritualWorld, player, seed:8 });
ritual.dragonsDefeated = 1;
for (const [x, z] of [[4,0],[-4,0],[0,4],[0,-4]]) ritual.placeRespawnCrystal(x, END_ISLAND_SURFACE_Y + 8, z, 'end');
const regeneratedPillar = endPillars().find((pillar) => pillar.caged);
const regeneratedTop = END_ISLAND_SURFACE_Y + regeneratedPillar.height;
check('resummoning rebuilds the complete arena', ritual.arenaRegeneratedBlocks > 9000 && ritualWorld.getBlock(regeneratedPillar.x + 2, regeneratedTop + 2, regeneratedPillar.z) === Block.IRON_BARS);

section('High graphics and original audio');
check('High enables SSAO while Medium keeps its lower-cost path', GRAPHICS_PRESETS.high.graphics.screenSpaceAmbientOcclusion === true && GRAPHICS_PRESETS.medium.graphics.screenSpaceAmbientOcclusion === false);
const postSource = readFileSync(new URL('../src/rendering/PostProcessing.js', import.meta.url), 'utf8');
check('the post-processing chain installs a real SSAO pass', postSource.includes("SSAOPass") && postSource.includes('wantSsao'));
const waterSource = readFileSync(new URL('../src/rendering/shaders/water.frag.glsl', import.meta.url), 'utf8');
check('High water contains animated caustics and crest foam', waterSource.includes('caustics') && waterSource.includes('foam'));
const sounds = createSoundCatalogue();
check('the dragon has a procedural roar', typeof sounds['mob.ender_dragon.roar']?.render === 'function');
check('the dragon battle has an original looping music layer', sounds['music.dragon']?.loop === true && sounds['music.dragon'].category === 'music');

console.log(`\nVersion 8 self-test: ${passed}/${passed} checks passed`);
