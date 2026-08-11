/**
 * Phase 5 self-test: the End, strongholds, and the Ender Dragon.
 *
 * Same harness as `phase4-selftest.mjs`: pure Node, no renderer, no DOM. Every
 * check asserts a rule the player can feel, not an implementation detail.
 */

import { Block } from '../src/world/BlockTypes.js';
import { getItem, isValidItemId } from '../src/items/ItemRegistry.js';
import RECIPE_DEFINITIONS from '../src/crafting/Recipes.js';
import { brewPotion } from '../src/progression/BrewingSystem.js';
import { getMob } from '../src/entities/MobTypes.js';
import { mobsForDimension } from '../src/entities/MobSpawner.js';
import { MOB_IDS } from '../src/entities/MobTypes.js';
import { isDimensionImplemented } from '../src/world/DimensionGenerators.js';
import { EndGenerator, endPillars, endCrystalPositions, END_ARRIVAL_PLATFORM, END_BIOME_ID } from '../src/world/EndGenerator.js';
import {
  validateStrongholdPieces,
  buildStronghold,
  strongholdOriginForRegion,
  paintStrongholdChunk,
  nearestPortalRoom,
  PORTAL_FRAME_OFFSETS,
  StrongholdMarker,
} from '../src/world/Stronghold.js';
import { TerrainGenerator } from '../src/world/TerrainGenerator.js';
import { EnderDragonFight, CRYSTAL_HEAL_PER_SECOND } from '../src/progression/EnderDragon.js';
import { Phase5Runtime, PORTAL_FRAME_COUNT } from '../src/progression/Phase5Runtime.js';
import { BeaconRegistry, beaconState, BEACON_BASE_BLOCKS } from '../src/progression/Beacon.js';

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const section = (name) => console.log(`\n${name}`);

/** Map-backed world stub exposing only what Phase5Runtime touches. */
function fakeWorld() {
  const cells = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  return {
    cells,
    getBlock: (x, y, z) => cells.get(key(x, y, z)) ?? Block.AIR,
    setBlock: (x, y, z, id) => { cells.set(key(x, y, z), id); return true; },
  };
}

/** Lays a complete twelve-frame ring, as the generator would. */
function buildRing(world, cx, cy, cz) {
  for (const [dx, dz] of PORTAL_FRAME_OFFSETS) {
    world.setBlock(cx + dx, cy, cz + dz, Block.END_PORTAL_FRAME);
  }
}

section('End blocks and items');

test('the ten End blocks are registered with distinct ids', () => {
  const ids = ['END_STONE', 'END_STONE_BRICKS', 'PURPUR_BLOCK', 'PURPUR_PILLAR',
    'END_PORTAL_FRAME', 'END_PORTAL', 'DRAGON_EGG', 'CHORUS_PLANT', 'CHORUS_FLOWER', 'END_ROD']
    .map((name) => {
      assert(Block[name] !== undefined, `Block.${name} is missing`);
      return Block[name];
    });
  assert(new Set(ids).size === ids.length, 'End block ids collide');
});

test('ender pearls and eyes of ender are obtainable items', () => {
  assert(isValidItemId('ender_pearl'), 'ender_pearl missing');
  assert(isValidItemId('eye_of_ender'), 'eye_of_ender missing');
  assert(getItem('ender_pearl').maxStack === 16, 'pearls should stack to 16');
  assert(getItem('eye_of_ender').metadata.activatesPortalFrame === 'end_portal_frame',
    'the eye must declare what it activates');
});

test('an eye of ender is crafted from a pearl and blaze powder', () => {
  const recipe = RECIPE_DEFINITIONS.find((r) => r.id === 'eye_of_ender');
  assert(recipe, 'no eye_of_ender recipe');
  assert(recipe.ingredients.includes('ender_pearl'), 'recipe needs a pearl');
  assert(recipe.ingredients.includes('blaze_powder'), 'recipe needs blaze powder');
});

test('dragon breath and glass bottles exist, so lingering potions are reachable', () => {
  assert(isValidItemId('glass_bottle'), 'glass_bottle missing');
  assert(isValidItemId('dragon_breath'), 'dragon_breath missing');
  const splash = brewPotion(brewPotion(brewPotion({}, 'nether_wart'), 'blaze_powder'), 'gunpowder');
  const lingering = brewPotion(splash, 'dragon_breath');
  assert(lingering?.form === 'lingering', 'dragon breath must make a potion lingering');
});

test('chorus fruit is food', () => {
  const fruit = getItem('chorus_fruit');
  assert(fruit.foodValue > 0, 'chorus fruit should feed the player');
});

section('Endermen');

test('the enderman is a tall, hard-hitting hostile that drops pearls', () => {
  const mob = getMob('enderman');
  assert(mob.height > 2.5, 'endermen are tall');
  assert(mob.attackDamage >= 7, 'endermen hit hard');
  assert(mob.drops.some((drop) => drop.item === 'ender_pearl'), 'endermen must drop pearls');
});

test('endermen spawn in both the Overworld and the End', () => {
  const overworld = mobsForDimension(MOB_IDS, 'overworld');
  const end = mobsForDimension(MOB_IDS, 'end');
  const nether = mobsForDimension(MOB_IDS, 'nether');
  assert(overworld.includes('enderman'), 'pearls must be farmable before the End');
  assert(end.includes('enderman'), 'the End needs its native mob');
  assert(!nether.includes('enderman'), 'endermen do not belong to the Nether pool here');
});

section('The End dimension');

test('the End is a real, generated dimension', () => {
  assert(isDimensionImplemented('end'), 'the End must have a generator');
});

test('the central island is solid end stone around the fountain', () => {
  const generator = new EndGenerator(4242);
  const chunk = generator.generateChunk(0, 0);
  let endStone = 0;
  let bedrock = 0;
  for (const id of chunk.blocks) {
    if (id === Block.END_STONE) endStone++;
    else if (id === Block.BEDROCK) bedrock++;
  }
  assert(endStone > 4000, `central island too thin (${endStone})`);
  assert(bedrock > 0, 'the fountain should be bedrock');
  assert(chunk.biomeMap.every((b) => b === END_BIOME_ID), 'every End column is the End biome');
});

test('the void ring between the islands is genuinely empty', () => {
  const generator = new EndGenerator(4242);
  let nonAir = 0;
  for (let cx = 8; cx < 12; cx++) {
    for (let cz = 8; cz < 12; cz++) nonAir += generator.generateChunk(cx, cz).nonAirCount;
  }
  assert(nonAir === 0, `the void should be void, found ${nonAir} blocks`);
});

test('ten obsidian pillars carry ten end crystals', () => {
  const pillars = endPillars();
  const crystals = endCrystalPositions();
  assert(pillars.length === 10, `expected 10 pillars, got ${pillars.length}`);
  assert(crystals.length === 10, `expected 10 crystals, got ${crystals.length}`);
  assert(crystals.every((c) => c.y > 64), 'crystals sit on top of their pillars');
});

test('arrival never drops the player into the void', () => {
  const generator = new EndGenerator(4242);
  const spawn = generator.findSpawn(0, 0);
  assert(Number.isFinite(spawn.x) && Number.isFinite(spawn.y), 'spawn must be a real position');
  assert(spawn.y > 40, 'spawn must be above the void');
  assert(END_ARRIVAL_PLATFORM.x > 0, 'the arrival platform sits off the island edge');
});

test('End generation is deterministic for one seed', () => {
  const a = new EndGenerator(99).generateChunk(1, 1);
  const b = new EndGenerator(99).generateChunk(1, 1);
  assert(a.nonAirCount === b.nonAirCount, 'same seed must give the same chunk');
});

section('Strongholds');

test('every stronghold piece is structurally valid', () => {
  const problems = validateStrongholdPieces();
  assert(problems.length === 0, problems.join(' | '));
});

test('a stronghold contains exactly one portal room', () => {
  const hold = buildStronghold({ seed: 777, origin: [0, 20, 0] });
  const rooms = hold.markers.filter((m) => m.type === StrongholdMarker.PORTAL_ROOM);
  assert(rooms.length === 1, `expected 1 portal room, got ${rooms.length}`);
});

test('the portal room has twelve frames and no lit portal', () => {
  const hold = buildStronghold({ seed: 777, origin: [0, 20, 0] });
  const frames = hold.cells.filter((c) => c.block === Block.END_PORTAL_FRAME).length;
  const portals = hold.cells.filter((c) => c.block === Block.END_PORTAL).length;
  assert(frames === 12, `expected 12 frames, got ${frames}`);
  assert(portals === 0, 'the portal must be lit by the player, not by the generator');
});

test('stronghold layout is deterministic', () => {
  const a = buildStronghold({ seed: 5, origin: [0, 20, 0] });
  const b = buildStronghold({ seed: 5, origin: [0, 20, 0] });
  assert(a.cells.length === b.cells.length, 'same seed must give the same stronghold');
});

test('strongholds are sited underground and are findable', () => {
  let sited = null;
  for (let r = 0; r < 8 && !sited; r++) sited = strongholdOriginForRegion(r, 0, 777);
  assert(sited, 'no stronghold sited in eight regions');
  assert(sited.y >= 10 && sited.y <= 40, `stronghold y ${sited.y} should be buried`);
  const room = nearestPortalRoom(sited.x, sited.z, 777);
  assert(room, 'a sited stronghold must be locatable by an eye of ender');
});

test('a stronghold paints into real Overworld chunks', () => {
  let sited = null;
  for (let r = 0; r < 8 && !sited; r++) sited = strongholdOriginForRegion(r, 0, 777);
  const cx = Math.floor(sited.x / 16);
  const cz = Math.floor(sited.z / 16);
  let written = 0;
  for (let dx = -1; dx <= 2; dx++) {
    for (let dz = -1; dz <= 2; dz++) {
      written += paintStrongholdChunk(new Uint16Array(16 * 16 * 128), cx + dx, cz + dz, 777);
    }
  }
  assert(written > 200, `stronghold painted only ${written} blocks`);
});

test('the live Overworld generator produces portal frames', () => {
  const generator = new TerrainGenerator(777);
  let sited = null;
  for (let r = 0; r < 8 && !sited; r++) sited = strongholdOriginForRegion(r, 0, 777);
  const cx = Math.floor(sited.x / 16);
  const cz = Math.floor(sited.z / 16);
  let frames = 0;
  for (let dx = -1; dx <= 3; dx++) {
    for (let dz = -1; dz <= 3; dz++) {
      for (const id of generator.generateChunk(cx + dx, cz + dz).blocks) {
        if (id === Block.END_PORTAL_FRAME) frames++;
      }
    }
  }
  assert(frames === 12, `expected 12 frames in the live world, got ${frames}`);
});

section('Lighting the End portal');

test('an eye only goes into an empty frame', () => {
  const world = fakeWorld();
  const runtime = new Phase5Runtime({ world, seed: 1 });
  buildRing(world, 0, 20, 0);
  assert(runtime.placeEyeOfEnder(1, 20, 2)?.placed === true, 'first eye should go in');
  assert(runtime.placeEyeOfEnder(1, 20, 2) === null, 'a filled frame must refuse a second eye');
  assert(runtime.placeEyeOfEnder(0, 20, 0) === null, 'the portal interior is not a frame');
});

test('the twelfth eye lights a 3x3 portal', () => {
  const world = fakeWorld();
  const runtime = new Phase5Runtime({ world, seed: 1 });
  buildRing(world, 40, 20, 40);
  let lit = false;
  let filled = 0;
  for (const [dx, dz] of PORTAL_FRAME_OFFSETS) {
    const result = runtime.placeEyeOfEnder(40 + dx, 20, 40 + dz);
    filled = result.filled;
    lit = result.lit;
  }
  assert(filled === PORTAL_FRAME_COUNT, `expected ${PORTAL_FRAME_COUNT} filled, got ${filled}`);
  assert(lit === true, 'the twelfth eye must open the portal');
  let portalBlocks = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (world.getBlock(40 + dx, 20, 40 + dz) === Block.END_PORTAL) portalBlocks++;
    }
  }
  assert(portalBlocks === 9, `expected a 3x3 portal, got ${portalBlocks} blocks`);
});

test('an incomplete ring never lights', () => {
  const world = fakeWorld();
  const runtime = new Phase5Runtime({ world, seed: 1 });
  buildRing(world, 0, 30, 0);
  world.setBlock(1, 30, 2, Block.AIR);
  for (const [dx, dz] of PORTAL_FRAME_OFFSETS) runtime.placeEyeOfEnder(dx, 30, dz);
  assert(runtime.litPortalCount === 0, 'a broken ring must stay dark');
});

test('filled frames and lit portals survive a save', () => {
  const world = fakeWorld();
  const runtime = new Phase5Runtime({ world, seed: 1 });
  buildRing(world, 0, 20, 0);
  for (const [dx, dz] of PORTAL_FRAME_OFFSETS) runtime.placeEyeOfEnder(dx, 20, dz);
  const restored = new Phase5Runtime({ world, seed: 1 }).fromJSON(JSON.parse(JSON.stringify(runtime.toJSON())));
  assert(restored.litPortalCount === 1, 'a lit portal must persist');
  assert(restored.frameIsFilled(1, 20, 2), 'filled frames must persist');
});

section('The Ender Dragon');

test('the boss bar reads a phase from the first frame', () => {
  const fight = new EnderDragonFight();
  assert(fight.bar.phase === 'circling', `expected circling, got ${fight.bar.phase}`);
  assert(fight.bar.fraction === 1, 'the dragon starts at full health');
});

test('crystals out-heal the player until they are destroyed', () => {
  const fight = new EnderDragonFight();
  fight.damage(30, { part: 'body', source: 'arrow' });
  const healed = fight.tick(1).healing;
  assert(healed === 10 * CRYSTAL_HEAL_PER_SECOND, `expected 20 hp/s, got ${healed}`);
  // 30 damage taken, 20 healed back in one second: the bow is losing the race.
  assert(fight.bar.health === fight.controller.maxHealth - 10,
    `expected 190 hp after a 30 damage hit and a second of healing, got ${fight.bar.health}`);
  fight.crystals.forEach((_, i) => fight.destroyCrystal(i));
  assert(fight.tick(1).healing === 0, 'no crystals, no healing');
});

test('a flying dragon cannot be hit with a sword', () => {
  const fight = new EnderDragonFight();
  assert(fight.damage(50, { part: 'head', source: 'melee' }) === 0, 'melee must miss a flying dragon');
  assert(fight.damage(10, { part: 'head', source: 'arrow' }) === 15, 'arrows hit the head for 1.5x');
});

test('the dragon only perches once every crystal is gone', () => {
  const fight = new EnderDragonFight();
  for (let i = 0; i < 40; i++) fight.tick(1);
  assert(fight.perched === false, 'a healing dragon must not land');
  fight.crystals.forEach((_, i) => fight.destroyCrystal(i));
  let perched = false;
  for (let i = 0; i < 30 && !perched; i++) perched = fight.tick(1).perched;
  assert(perched, 'the dragon must eventually perch');
  assert(fight.damage(20, { part: 'head', source: 'melee' }) === 30, 'a perched head takes melee');
});

test('phases escalate as the dragon is worn down', () => {
  const fight = new EnderDragonFight();
  fight.crystals.forEach((_, i) => fight.destroyCrystal(i));
  fight.damage(100, { part: 'body', source: 'arrow' });
  assert(fight.bar.phase === 'perching', `expected perching, got ${fight.bar.phase}`);
  fight.damage(60, { part: 'body', source: 'arrow' });
  assert(fight.bar.phase === 'desperate', `expected desperate, got ${fight.bar.phase}`);
});

test('breath is rate limited and stops at death', () => {
  const fight = new EnderDragonFight();
  fight.breathCooldown = 0;
  const breath = fight.fireBreath(() => 0);
  assert(breath?.type === 'dragon_breath', 'the dragon should breathe');
  assert(breath.lingering === true, 'dragon breath lingers');
  assert(fight.fireBreath(() => 0) === null, 'breath must respect its cooldown');
  fight.crystals.forEach((_, i) => fight.destroyCrystal(i));
  fight.damage(999, { part: 'head', source: 'arrow' });
  fight.breathCooldown = 0;
  assert(fight.fireBreath(() => 0) === null, 'a dead dragon does not breathe');
});

test('killing the dragon opens the exit portal and drops the egg', () => {
  const world = fakeWorld();
  const runtime = new Phase5Runtime({ world, seed: 3 });
  const fight = runtime.beginDragonFight('end');
  assert(fight, 'arriving in the End starts the fight');
  fight.crystals.forEach((_, i) => fight.destroyCrystal(i));
  fight.damage(999, { part: 'head', source: 'arrow' });
  for (let index = 0; index < 82; index++) runtime.fixedUpdate(1 / 20);
  assert(runtime.dragonsDefeated === 1, 'the kill should be recorded');
  assert(runtime.exitPortalOpen === true, 'the exit portal must open');
  const rewards = runtime.claimRewards();
  assert(rewards.some((r) => r.experience === 12000), 'the dragon pays the full experience reward');
  let portal = 0;
  let egg = 0;
  for (const id of world.cells.values()) {
    if (id === Block.END_PORTAL) portal++;
    else if (id === Block.DRAGON_EGG) egg++;
  }
  assert(portal === 9, `expected a 3x3 exit portal, got ${portal}`);
  assert(egg === 1, 'exactly one dragon egg');
});

test('a live fight resumes exactly, and a defeated dragon needs the four-crystal ritual', () => {
  const runtime = new Phase5Runtime({ world: fakeWorld(), seed: 3 });
  const fight = runtime.beginDragonFight('end');
  fight.crystals.forEach((_, i) => fight.destroyCrystal(i));
  fight.damage(999, { part: 'head', source: 'arrow' });
  for (let index = 0; index < 82; index++) runtime.fixedUpdate(1 / 20);
  assert(runtime.beginDragonFight('end') === null, 'a defeated dragon cannot respawn for free');
  const mid = new Phase5Runtime({ world: fakeWorld(), seed: 3 });
  mid.beginDragonFight('end');
  mid.fight.damage(50, { part: 'body', source: 'arrow' });
  const restored = new Phase5Runtime({ world: fakeWorld(), seed: 3 }).fromJSON(mid.toJSON());
  assert(restored.activeFight?.bar.health === mid.activeFight.bar.health, 'a half-finished fight must restore at the same health');
  assert(restored.activeFight?.crystalsAlive === mid.activeFight.crystalsAlive, 'crystal state must survive a reload');
  assert(restored.dragonsDefeated === 0, 'and it must not count as a win');
});

test('the dragon fight only starts in the End', () => {
  const runtime = new Phase5Runtime({ world: fakeWorld(), seed: 3 });
  assert(runtime.beginDragonFight('overworld') === null, 'no dragon in the Overworld');
  assert(runtime.beginDragonFight('nether') === null, 'no dragon in the Nether');
});

section('Beacons (the nether star finally pays out)');

test('a beacon exists, glows, and is crafted from a nether star', () => {
  assert(Block.BEACON !== undefined, 'no beacon block');
  const recipe = RECIPE_DEFINITIONS.find((r) => r.id === 'beacon');
  assert(recipe, 'no beacon recipe');
  assert(recipe.ingredients.includes('nether_star'), 'a beacon must cost a nether star');
  assert(isValidItemId('beacon'), 'the beacon must be an item you can hold');
});

test('a bare beacon does nothing', () => {
  const world = fakeWorld();
  const state = beaconState(world, 0, 40, 0);
  assert(state.active === false, 'a beacon with no pyramid must stay dark');
  assert(state.range === 0 && state.choices.length === 0, 'and offer nothing');
});

test('each complete pyramid layer raises the level and the range', () => {
  const world = fakeWorld();
  const base = BEACON_BASE_BLOCKS[0];
  const expected = [20, 30, 40, 50];
  for (let layer = 1; layer <= 4; layer++) {
    for (let dx = -layer; dx <= layer; dx++) {
      for (let dz = -layer; dz <= layer; dz++) world.setBlock(dx, 40 - layer, dz, base);
    }
    const state = beaconState(world, 0, 40, 0);
    assert(state.level === layer, `expected level ${layer}, got ${state.level}`);
    assert(state.range === expected[layer - 1], `expected range ${expected[layer - 1]}, got ${state.range}`);
  }
  assert(beaconState(world, 0, 40, 0).secondaryAllowed === true, 'a full pyramid unlocks a second effect');
});

test('a hollow pyramid is not a pyramid', () => {
  const world = fakeWorld();
  const base = BEACON_BASE_BLOCKS[0];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) world.setBlock(dx, 39, dz, base);
  }
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (Math.abs(dx) === 2 || Math.abs(dz) === 2) world.setBlock(dx, 38, dz, base);
    }
  }
  assert(beaconState(world, 0, 40, 0).level === 1, 'a ring is not a solid layer');
});

test('dirt is not a mineral block', () => {
  const world = fakeWorld();
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) world.setBlock(dx, 39, dz, Block.DIRT);
  }
  assert(beaconState(world, 0, 40, 0).level === 0, 'you cannot power a beacon with dirt');
});

test('a buried beacon cannot see the sky', () => {
  const world = fakeWorld();
  const base = BEACON_BASE_BLOCKS[0];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) world.setBlock(dx, 39, dz, base);
  }
  assert(beaconState(world, 0, 40, 0).active === true, 'an open beacon works');
  world.setBlock(0, 48, 0, Block.STONE);
  assert(beaconState(world, 0, 40, 0).active === false, 'stone above must switch it off');
});

test('a registered beacon pulses its effect at range and not beyond', () => {
  const world = fakeWorld();
  const base = BEACON_BASE_BLOCKS[0];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) world.setBlock(dx, 39, dz, base);
  }
  const registry = new BeaconRegistry({ world });
  registry.add(0, 40, 0);
  assert(registry.configure(0, 40, 0, 'speed'), 'speed is a level 1 effect');
  assert(registry.configure(0, 40, 0, 'regeneration') === false, 'regeneration needs a bigger pyramid');
  assert(registry.effectsAt({ x: 5, y: 40, z: 5 }).length === 1, 'nearby players get the effect');
  assert(registry.effectsAt({ x: 90, y: 40, z: 0 }).length === 0, 'distant players do not');
  const applied = [];
  let pulses = 0;
  for (let i = 0; i < 100; i++) pulses += registry.fixedUpdate(1 / 20, { x: 0, y: 40, z: 0 }, (e) => applied.push(e));
  assert(pulses > 0 && applied.length === pulses, `beacon should pulse, got ${pulses}`);
  assert(applied[0].effect === 'speed' && applied[0].duration > 0, 'the pulse must carry a real effect');
});

test('beacons and their chosen effects survive a save', () => {
  const world = fakeWorld();
  const base = BEACON_BASE_BLOCKS[0];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) world.setBlock(dx, 39, dz, base);
  }
  const registry = new BeaconRegistry({ world });
  registry.add(0, 40, 0);
  registry.configure(0, 40, 0, 'speed');
  const restored = new BeaconRegistry({ world }).fromJSON(JSON.parse(JSON.stringify(registry.toJSON())));
  assert(restored.count === 1, 'the beacon must persist');
  assert(restored.effectsAt({ x: 1, y: 40, z: 1 })[0]?.effect === 'speed', 'and keep its effect');
  assert(restored.remove(0, 40, 0), 'breaking a beacon forgets it');
  assert(restored.effectsAt({ x: 1, y: 40, z: 1 }).length === 0, 'a broken beacon stops pulsing');
});

console.log(`\nPhase 5 self-test: ${passed}/${passed} checks passed`);
