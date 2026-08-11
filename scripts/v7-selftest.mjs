/** Version 7 completion gates: outer End, resummoning, progression and migration. */
import { Block, TILE_INDEX } from '../src/world/BlockTypes.js';
import { getItem } from '../src/items/ItemRegistry.js';
import RECIPES from '../src/crafting/Recipes.js';
import { buildEndCity, nearestEndCity } from '../src/world/EndCity.js';
import { buildStronghold, StrongholdMarker } from '../src/world/Stronghold.js';
import { EnderDragonFight, DragonFlightState, cubicBezier } from '../src/progression/EnderDragon.js';
import { Phase5Runtime } from '../src/progression/Phase5Runtime.js';
import { AdvancementSystem, ADVANCEMENTS } from '../src/progression/AdvancementSystem.js';
import { SaveManager, createEmptyWorldRecord } from '../src/core/SaveManager.js';
import { SAVE } from '../src/config/GameConfig.js';
import { getMobSkeleton } from '../src/entities/MobSkeletons.js';
import { hasBlockEntity } from '../src/world/blockentity/BlockEntity.js';
import '../src/world/blockentity/ShulkerBoxBlockEntity.js';
import { createSoundCatalogue } from '../src/audio/SoundRegistry.js';
import { GoalSelector, wanderGoal } from '../src/entities/ai/MobGoals.js';

let passed = 0;
const check = (name, condition) => {
  if (!condition) throw new Error(name);
  passed++;
  console.log(`  ok  ${name}`);
};
const section = (name) => console.log(`\n${name}`);

function fakeWorld(dimensionId = 'end') {
  const cells = new Map();
  const key = (x,y,z) => `${x|0},${y|0},${z|0}`;
  return {
    cells, dimensionId,
    getBlock:(x,y,z) => cells.get(key(x,y,z)) ?? Block.AIR,
    setBlock:(x,y,z,id) => { cells.set(key(x,y,z), id); return true; },
  };
}

section('Append-only content');
check('v6 beacon id remains 364', Block.BEACON === 364);
check('v7 blocks append after the beacon', Block.INFESTED_STONE === 365 && Block.END_GATEWAY > Block.INFESTED_STONE);
check('every v7 visual has an atlas tile', ['infested_stone','silverfish_spawner','shulker_box','elytra','end_crystal','mob_ender_dragon'].every((id) => Number.isInteger(TILE_INDEX[id])));
check('elytra is a durable chest wearable', getItem('elytra')?.durability === 432 && getItem('elytra').metadata.equipmentSlot === 'chestplate');
check('crystal and shulker recipes are reachable', ['end_crystal','shulker_box'].every((id) => RECIPES.some((recipe) => recipe.id === id)));
check('shulker boxes own persistent storage', hasBlockEntity(Block.SHULKER_BOX));

section('Strongholds and outer End');
const stronghold = buildStronghold({ seed:90210, origin:[0,20,0] });
check('portal room carries a silverfish spawner', stronghold.cells.some((cell) => cell.block === Block.SILVERFISH_SPAWNER));
check('stronghold walls carry infested blocks', stronghold.cells.some((cell) => cell.block === Block.INFESTED_STONE || cell.block === Block.INFESTED_MOSSY_COBBLESTONE));
check('stronghold keeps exactly one portal-room marker', stronghold.markers.filter((marker) => marker.type === StrongholdMarker.PORTAL_ROOM).length === 1);
const city = nearestEndCity(0, 0, 90210, 12);
const cityAgain = nearestEndCity(0, 0, 90210, 12);
check('a deterministic outer End city is findable', city && JSON.stringify(city) === JSON.stringify(cityAgain));
const cityCells = buildEndCity(city);
check('the city includes a traversable ship-sized build', cityCells.length > 1000);
check('the ship guarantees an elytra display', cityCells.filter((cell) => cell.block === Block.ELYTRA_DISPLAY).length === 1);
check('the city includes shulker-box loot', cityCells.filter((cell) => cell.block === Block.SHULKER_BOX).length >= 2);

section('Dragon fight and resummoning');
const curve = cubicBezier({x:0,y:0,z:0},{x:1,y:2,z:0},{x:2,y:2,z:0},{x:3,y:0,z:0},.5);
check('Bezier flight sampling is finite', Object.values(curve).every(Number.isFinite) && curve.y > 1);
const fight = new EnderDragonFight();
fight.tick(7.1);
check('dragon leaves its initial circling state', fight.flightState !== DragonFlightState.CIRCLING);
check('dragon uses a dedicated articulated rig', getMobSkeleton('ender_dragon')?.skeleton.bones.length >= 10);
const world = fakeWorld();
const runtime = new Phase5Runtime({ world, seed:17 });
runtime.dragonsDefeated = 1;
const results = [[4,0],[-4,0],[0,4],[0,-4]].map(([x,z]) => runtime.placeRespawnCrystal(x, 72, z, 'end'));
check('four distinct crystals complete the ritual', results.slice(0,3).every((result) => result?.ready === false) && results[3]?.ready === true);
check('the ritual restores all ten crystals', runtime.activeFight?.crystalsAlive === 10);
check('the resummoned fight survives reload', new Phase5Runtime({ world, seed:17 }).fromJSON(runtime.toJSON()).activeFight?.crystalsAlive === 10);
runtime.activeFight.crystals.forEach((_, index) => runtime.activeFight.destroyCrystal(index));
runtime.activeFight.damage(999, { part:'head', source:'projectile' });
for (let index = 0; index < 82; index++) runtime.fixedUpdate(.05);
check('later dragon victories do not duplicate the unique egg', [...world.cells.values()].every((block) => block !== Block.DRAGON_EGG));
const delayedWorld = fakeWorld();
delayedWorld.ready = false;
const delayedSet = delayedWorld.setBlock;
delayedWorld.setBlock = (...args) => delayedWorld.ready ? delayedSet(...args) : false;
const delayed = new Phase5Runtime({ world:delayedWorld, seed:9 });
const delayedFight = delayed.beginDragonFight('end');
delayedFight.crystals.forEach((_, index) => delayedFight.destroyCrystal(index));
delayedFight.damage(999, { part:'head', source:'projectile' });
for (let index = 0; index < 82; index++) delayed.fixedUpdate(.05);
delayedWorld.ready = true;
const restoredDelayed = new Phase5Runtime({ world:delayedWorld, seed:9 }).fromJSON(delayed.toJSON());
restoredDelayed.fixedUpdate(.05);
check('pending exit structures survive a save while their chunk streams', delayedWorld.getBlock(12, 71, 0) === Block.END_GATEWAY);

section('Story, statistics and migration');
const progress = new AdvancementSystem();
for (const trigger of ['mine:oak_log','obtain:cobblestone','obtain:iron_ingot','obtain:diamond','dimension:nether','obtain:blaze_rod','locate:stronghold','dimension:end','kill:ender_dragon','locate:end_city','obtain:elytra']) progress.trigger(trigger);
progress.move(12, { dimension:'end', medium:'fly' });
progress.recordDeath({x:1,y:2,z:3}, 'end', 'void', 44);
const restoredProgress = new AdvancementSystem().fromJSON(progress.toJSON());
check('the complete ordered advancement path unlocks', restoredProgress.unlocked.size === ADVANCEMENTS.length - 1);
check('statistics and death markers survive reload', restoredProgress.counters.distanceFlown === 12 && restoredProgress.deathMarkers[0].cause === 'void');
const manager = new SaveManager({ emit(){} });
const legacy = createEmptyWorldRecord('Legacy', 4);
legacy.formatVersion = 6;
delete legacy.advancements;
const migrated = manager._migrateWorldRecord(legacy);
check('v6 saves migrate to the current format without losing identity', migrated.formatVersion === SAVE.worldFormatVersion && migrated.id === legacy.id && migrated.advancements === null);
check('the End has a dedicated original ambience loop', createSoundCatalogue()['ambient.end']?.loop === true);
const selector = new GoalSelector([wanderGoal({ chance:1 })]);
selector.update({ mob:{ isDead:false }, random:() => 0, pickWanderTarget(){}, moveToDestination(){}, clearDestination(){} }, .05);
selector.reset();
check('pooled mobs can reset active goals without a stale context', selector.running.size === 0);

console.log(`\nVersion 7 compatibility self-test: ${passed}/${passed} checks passed`);
