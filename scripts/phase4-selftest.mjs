import assert from 'node:assert/strict';
import { Block, BLOCK_DEFINITIONS, TILE_NAMES } from '../src/world/BlockTypes.js';
import { ITEM_IDS, getItem } from '../src/items/ItemRegistry.js';
import { ToolTier, TIER_ORDER, TIER_DATA } from '../src/items/ItemTypes.js';
import { smithUpgrade } from '../src/progression/EnchantingSystem.js';
import { brewPotion } from '../src/progression/BrewingSystem.js';
import RECIPE_DEFINITIONS from '../src/crafting/Recipes.js';
import { MOB_DEFINITIONS, getMob } from '../src/entities/MobTypes.js';
import { mobsForDimension } from '../src/entities/MobSpawner.js';
import { NetherGenerator } from '../src/world/NetherGenerator.js';
import {
  validateFortressPieces, buildFortress, fortressOriginForRegion, fortressForRegion,
  clearFortressCache, FORTRESS_REGION_CHUNKS,
} from '../src/world/NetherFortress.js';
import { detectWitherSummon, trySummonWither, WITHER_PHASES, WitherFight } from '../src/progression/WitherBoss.js';
import { Phase4Runtime } from '../src/progression/Phase4Runtime.js';
import { BARTER_TABLE, rollBarter, barterWithPiglin, piglinIsPacified, StriderControl, striderSpeedOn } from '../src/entities/NetherBehaviour.js';
import { createSoundCatalogue } from '../src/audio/SoundRegistry.js';
import { mulberry32 } from '../src/utils/MathUtils.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  \x1b[32m\u2713\x1b[0m ${name}`); };
console.log('\n\x1b[1mPhase 4 \u2014 the Nether\x1b[0m');

test('netherite sits above diamond in the tool tier order', () => {
  assert.equal(TIER_ORDER[TIER_ORDER.length - 1], ToolTier.NETHERITE);
  assert.ok(TIER_DATA[ToolTier.NETHERITE].level > TIER_DATA[ToolTier.DIAMOND].level);
  assert.ok(TIER_DATA[ToolTier.NETHERITE].durability > TIER_DATA[ToolTier.DIAMOND].durability);
});

test('every netherite tool and armour piece is a real item with an icon', () => {
  for (const id of ['netherite_scrap', 'netherite_ingot', 'netherite_pickaxe', 'netherite_axe',
    'netherite_shovel', 'netherite_hoe', 'netherite_sword', 'netherite_helmet',
    'netherite_chestplate', 'netherite_leggings', 'netherite_boots']) {
    const item = getItem(id);
    assert.ok(item, `${id} is missing`);
    assert.ok(Number.isInteger(item.icon) && item.icon >= 0, `${id} has no icon`);
  }
});

test('the smithing table upgrades diamond gear to netherite', () => {
  assert.equal(smithUpgrade({ itemId: 'diamond_pickaxe' }, 'netherite_ingot').itemId, 'netherite_pickaxe');
});

test('ancient debris smelts into scrap and scrap plus gold makes an ingot', () => {
  assert.ok(RECIPE_DEFINITIONS.some((r) => r.id === 'smelt_netherite_scrap'));
  assert.ok(RECIPE_DEFINITIONS.some((r) => r.id === 'netherite_ingot'));
});

test('the Nether item catalogue is registered with icons', () => {
  for (const id of ['blaze_rod', 'blaze_powder', 'nether_wart', 'ghast_tear', 'magma_cream',
    'gold_nugget', 'glowstone_dust', 'gunpowder', 'nether_star', 'wither_skeleton_skull',
    'warped_fungus_on_a_stick']) {
    const item = getItem(id);
    assert.ok(item, `${id} is missing`);
    assert.ok(Number.isInteger(item.icon) && item.icon >= 0, `${id} has no icon`);
  }
});

test('the wither skull is placeable and nether wart plants a crop', () => {
  assert.equal(getItem('wither_skeleton_skull').placeableBlockId, Block.WITHER_SKELETON_SKULL);
  assert.equal(getItem('nether_wart').metadata.plantsCrop, 'nether_wart');
});

test('every atlas tile name is unique', () => {
  assert.equal(new Set(TILE_NAMES).size, TILE_NAMES.length);
});

test('every mob drop refers to an item that actually exists', () => {
  const ids = new Set(ITEM_IDS);
  const broken = [];
  for (const mob of MOB_DEFINITIONS) {
    for (const drop of mob.drops) if (!ids.has(drop.item)) broken.push(`${mob.id}:${drop.item}`);
  }
  assert.deepEqual(broken, []);
});

test('blazes drop the rods that gate brewing, and withers drop the star', () => {
  assert.ok(getMob('blaze').drops.some((d) => d.item === 'blaze_rod'));
  assert.ok(getMob('ghast').drops.some((d) => d.item === 'ghast_tear'));
  assert.ok(getMob('magma_cube').drops.some((d) => d.item === 'magma_cream'));
  assert.ok(getMob('wither_skeleton').drops.some((d) => d.item === 'wither_skeleton_skull'));
  assert.ok(getMob('wither').drops.some((d) => d.item === 'nether_star'));
});

test('the brewing chain is reachable from Nether drops alone', () => {
  const awkward = brewPotion({ form: 'drink', effect: null, potion: 'water' }, 'nether_wart');
  assert.equal(awkward.effect, 'awkward');
  assert.equal(brewPotion(awkward, 'blaze_powder').effect, 'strength');
  assert.equal(brewPotion(awkward, 'magma_cream').effect, 'fire_resistance');
  assert.equal(brewPotion(brewPotion(awkward, 'blaze_powder'), 'gunpowder').form, 'splash');
  assert.equal(brewPotion(brewPotion(awkward, 'blaze_powder'), 'glowstone_dust').strong, true);
});

test('Nether mobs only spawn in the Nether, and Overworld mobs stay home', () => {
  const all = MOB_DEFINITIONS.map((m) => m.id);
  const nether = mobsForDimension(all, 'nether');
  const overworld = mobsForDimension(all, 'overworld');
  assert.ok(nether.includes('blaze') && nether.includes('strider'));
  assert.ok(!nether.includes('cow') && !overworld.includes('blaze'));
  for (const id of nether) assert.equal(getMob(id).dimension, 'nether');
});

test('bosses are never chosen by the wandering spawner', () => {
  const all = MOB_DEFINITIONS.map((m) => m.id);
  assert.equal(getMob('wither').boss, true);
  for (const dimension of ['overworld', 'nether', 'the_end']) {
    assert.ok(!mobsForDimension(all, dimension).includes('wither'));
  }
});

test('every fortress piece passes structure validation', () => {
  assert.deepEqual(validateFortressPieces(), []);
});

test('a fortress assembles without overlapping itself', () => {
  const built = buildFortress({ seed: 4242, origin: [0, 40, 0] });
  assert.ok(built.placements.length >= 8, `only ${built.placements.length} pieces`);
});

test('fortresses are deterministic for a seed and vary between seeds', () => {
  clearFortressCache();
  const a = buildFortress({ seed: 99, origin: [0, 40, 0] });
  clearFortressCache();
  const b = buildFortress({ seed: 99, origin: [0, 40, 0] });
  const c = buildFortress({ seed: 100, origin: [0, 40, 0] });
  assert.equal(a.cells.length, b.cells.length);
  assert.notEqual(a.cells.length, c.cells.length);
});

test('fortresses are spaced out rather than in every region', () => {
  let sited = 0;
  for (let rx = 0; rx < 8; rx++) for (let rz = 0; rz < 8; rz++) {
    if (fortressOriginForRegion(rx, rz, 7)) sited++;
  }
  assert.ok(sited > 8 && sited < 60, `${sited} of 64 regions carry a fortress`);
  assert.ok(FORTRESS_REGION_CHUNKS >= 16);
});

test('a fortress carries loot chests and blaze spawner markers', () => {
  const built = fortressForRegion(0, 0, 12345) ?? buildFortress({ seed: 12345, origin: [0, 40, 0] });
  assert.ok(built.markers.length > 0);
  assert.ok(new Set(built.markers.map((m) => m.type)).has('loot_chest'));
});

test('generated Nether chunks actually contain fortress brickwork', () => {
  const seed = 12345;
  const generator = new NetherGenerator(seed);
  let site = null;
  for (let rx = 0; rx < 6 && !site; rx++) for (let rz = 0; rz < 6 && !site; rz++) {
    const origin = fortressOriginForRegion(rx, rz, seed);
    if (origin) site = origin;
  }
  assert.ok(site, 'no fortress sited in 36 regions');
  const chunkX = Math.floor(site.x / 16);
  const chunkZ = Math.floor(site.z / 16);
  let bricks = 0;
  for (let dx = 0; dx < 4; dx++) for (let dz = 0; dz < 4; dz++) {
    const chunk = generator.generateChunk(chunkX + dx, chunkZ + dz);
    for (const block of chunk.blocks) {
      if (block === Block.NETHER_BRICKS || block === Block.NETHER_BRICK_FENCE) bricks++;
    }
  }
  assert.ok(bricks > 200, `only ${bricks} fortress blocks reached the world`);
});

const fakeWorld = () => ({
  cells: new Map(),
  key: (x, y, z) => `${x},${y},${z}`,
  getBlock(x, y, z) { return this.cells.get(this.key(x, y, z)) ?? Block.AIR; },
  setBlock(x, y, z, id) { this.cells.set(this.key(x, y, z), id); return true; },
});
const buildRitual = (world, axis, mx, my, mz, soul = Block.SOUL_SAND) => {
  const dx = axis === 'x' ? 1 : 0;
  const dz = axis === 'z' ? 1 : 0;
  for (const o of [-1, 0, 1]) world.setBlock(mx + o * dx, my, mz + o * dz, Block.WITHER_SKELETON_SKULL);
  for (const [across, down] of [[0, -1], [-1, -1], [1, -1], [0, -2]]) {
    world.setBlock(mx + across * dx, my + down, mz + across * dz, soul);
  }
};

test('the summon ritual is recognised along both axes', () => {
  const a = fakeWorld(); buildRitual(a, 'x', 10, 50, 20);
  assert.equal(detectWitherSummon(a, 10, 50, 20).axis, 'x');
  assert.equal(detectWitherSummon(a, 9, 50, 20).axis, 'x');
  const b = fakeWorld(); buildRitual(b, 'z', 0, 64, 0);
  assert.equal(detectWitherSummon(b, 0, 64, 1).axis, 'z');
});

test('soul soil substitutes for soul sand', () => {
  const world = fakeWorld(); buildRitual(world, 'x', 5, 40, 5, Block.SOUL_SOIL);
  assert.ok(detectWitherSummon(world, 5, 40, 5));
});

test('an incomplete ritual summons nothing', () => {
  const missingSpine = fakeWorld(); buildRitual(missingSpine, 'x', 5, 40, 5);
  missingSpine.setBlock(5, 38, 5, Block.AIR);
  assert.equal(detectWitherSummon(missingSpine, 5, 40, 5), null);
  const twoSkulls = fakeWorld(); buildRitual(twoSkulls, 'x', 5, 40, 5);
  twoSkulls.setBlock(6, 40, 5, Block.AIR);
  assert.equal(detectWitherSummon(twoSkulls, 5, 40, 5), null);
  const bareSkull = fakeWorld();
  bareSkull.setBlock(1, 20, 1, Block.WITHER_SKELETON_SKULL);
  assert.equal(detectWitherSummon(bareSkull, 1, 20, 1), null);
});

test('summoning consumes the ritual blocks', () => {
  const world = fakeWorld(); buildRitual(world, 'x', 5, 40, 5);
  const fight = trySummonWither(world, 5, 40, 5);
  assert.ok(fight);
  assert.equal(world.getBlock(5, 40, 5), Block.AIR);
  assert.equal(world.getBlock(5, 38, 5), Block.AIR);
  assert.equal(detectWitherSummon(world, 5, 40, 5), null);
});

test('the wither is untouchable during its spawn animation', () => {
  const fight = new WitherFight();
  assert.equal(fight.damage(50), 0);
  fight.tick(10);
  assert.ok(fight.damage(10) > 0);
});

test('the three heads take damage independently', () => {
  const fight = new WitherFight(); fight.tick(10);
  assert.equal(fight.damage(40, { part: 'head_centre' }), 40);
  assert.equal(fight.damage(40, { part: 'head_left' }), 20);
});

test('the armour phase makes explosions useless', () => {
  const fight = new WitherFight(); fight.tick(10);
  fight.damage(160, { part: 'head_centre' });
  assert.equal(fight.bar.phase, 'armoured');
  assert.equal(fight.damage(80, { source: 'explosion' }), 0);
  assert.ok(fight.damage(20, { source: 'melee' }) > 0);
  assert.deepEqual(WITHER_PHASES.map((p) => p.id), ['descent', 'armoured', 'enraged']);
});

test('killing the wither yields exactly one nether star', () => {
  const fight = new WitherFight(); fight.tick(10);
  assert.deepEqual(fight.rewards, []);
  fight.damage(1000, { part: 'head_centre' });
  assert.equal(fight.bar.dead, true);
  assert.deepEqual(fight.rewards, [{ item: 'nether_star', count: 1 }]);
});

test('every barter reward is a real item', () => {
  const ids = new Set(ITEM_IDS);
  assert.deepEqual(BARTER_TABLE.filter((e) => !ids.has(e.item)).map((e) => e.item), []);
});

test('bartering is weighted, bounded and reproducible across a reload', () => {
  const random = mulberry32(7);
  for (let i = 0; i < 500; i++) {
    const reward = rollBarter(random);
    const entry = BARTER_TABLE.find((e) => e.item === reward.item);
    assert.ok(reward.count >= entry.min && reward.count <= entry.max);
  }
  assert.deepEqual(barterWithPiglin({ seed: 99, trades: 0 }), barterWithPiglin({ seed: 99, trades: 0 }));
  const piglin = { seed: 5, trades: 0 };
  barterWithPiglin(piglin);
  assert.equal(piglin.trades, 1);
  assert.equal(barterWithPiglin(piglin, { count: 0 }), null);
});

test('gold armour pacifies piglins until you loot or swing', () => {
  assert.equal(piglinIsPacified({ worn: ['golden_helmet'] }), true);
  assert.equal(piglinIsPacified({ worn: ['iron_helmet'] }), false);
  assert.equal(piglinIsPacified({ worn: ['golden_boots'], openedNetherChest: true }), false);
  assert.equal(piglinIsPacified({ worn: ['golden_boots'], attackedPiglin: true }), false);
});

test('striders are steered by a fungus that wears out', () => {
  const control = new StriderControl({ durability: 1 });
  assert.equal(control.boost(), true);
  assert.equal(control.speedMultiplier, 2.4);
  control.tick(3);
  assert.equal(control.speedMultiplier, 1);
  assert.equal(control.usable, false);
  assert.equal(control.boost(), false);
  assert.ok(striderSpeedOn(true) > striderSpeedOn(false));
  assert.equal(getMob('strider').rideable, true);
});

test('the Nether has its own ambience loop', () => {
  const loop = createSoundCatalogue()['ambient.nether'];
  assert.ok(loop);
  assert.equal(loop.loop, true);
  const data = new Float32Array(2048);
  let seed = 1;
  loop.render(data, 44100, () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; });
  assert.ok(data.some((sample) => sample !== 0), 'ambience rendered silence');
});

test('Phase 4 content targets are met', () => {
  assert.ok(BLOCK_DEFINITIONS.length >= 350, `${BLOCK_DEFINITIONS.length} blocks`);
  assert.ok(MOB_DEFINITIONS.length >= 42, `${MOB_DEFINITIONS.length} mobs`);
  assert.ok(ITEM_IDS.length >= 90, `${ITEM_IDS.length} items`);
  assert.equal(MOB_DEFINITIONS.filter((m) => m.dimension === 'nether').length, 9);
});

test('the runtime starts a fight only when the ritual is completed', () => {
  const world = fakeWorld();
  const runtime = new Phase4Runtime({ world, seed: 7 });
  assert.equal(runtime.onBlockPlaced(1, 1, 1, Block.DIRT), null);
  buildRitual(world, 'x', 5, 40, 5);
  const fight = runtime.onBlockPlaced(5, 40, 5, Block.WITHER_SKELETON_SKULL);
  assert.ok(fight);
  assert.equal(runtime.fights.size, 1);
  assert.equal(runtime.activeFight, fight);
});

test('a defeated Wither hands over its loot exactly once', () => {
  const world = fakeWorld();
  const runtime = new Phase4Runtime({ world, seed: 7 });
  buildRitual(world, 'x', 5, 40, 5);
  const fight = runtime.onBlockPlaced(5, 40, 5, Block.WITHER_SKELETON_SKULL);
  runtime.fixedUpdate(10);
  fight.damage(1000, { part: 'head_centre' });
  runtime.fixedUpdate(0.05);
  assert.equal(runtime.fights.size, 0);
  assert.equal(runtime.defeatedWithers, 1);
  assert.deepEqual(runtime.claimRewards(), [{ item: 'nether_star', count: 1 }]);
  assert.deepEqual(runtime.claimRewards(), []);
});

test('piglin trades and strider wear survive a save and reload', () => {
  const runtime = new Phase4Runtime({ seed: 7 });
  const first = runtime.barter('piglin-1');
  assert.ok(first);
  runtime.striderControl('strider-9', 5).boost();
  const saved = JSON.parse(JSON.stringify(runtime.toJSON()));
  const reloaded = new Phase4Runtime({ seed: 7 }).fromJSON(saved);
  assert.deepEqual(reloaded.barter('piglin-1'), runtime.barter('piglin-1'));
  assert.equal(reloaded.striderControl('strider-9').durability, 4);
  assert.equal(reloaded.defeatedWithers, 0);
});

console.log(`\n\x1b[32m${passed}/${passed} Phase 4 checks passed\x1b[0m`);
