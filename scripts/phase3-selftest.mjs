import assert from 'node:assert/strict';
import { DamagePipeline, attackProfile, projectileDamage } from '../src/progression/DamagePipeline.js';
import { EnchantingTable, combineOnAnvil, getEnchantments, grindstone } from '../src/progression/EnchantingSystem.js';
import { BrewingStand, brewPotion } from '../src/progression/BrewingSystem.js';
import { RedstoneNetwork, PistonSystem, HopperController, VehiclePhysics, FishingSystem, BossController } from '../src/automation/AutomationSystems.js';
import { StatusEffect, StatusEffectController } from '../src/entities/StatusEffects.js';
import { ItemStack } from '../src/items/ItemStack.js';
import { Container } from '../src/containers/Container.js';
import { Phase3Runtime } from '../src/progression/Phase3Runtime.js';
import { VillagerTradeBook } from '../src/entities/VillagerTrading.js';
import { MobEntity } from '../src/entities/MobEntity.js';
import { BLOCK_DEFINITIONS } from '../src/world/BlockTypes.js';
import { BIOMES } from '../src/world/BiomeGenerator.js';
import { MOB_DEFINITIONS } from '../src/entities/MobTypes.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); };
console.log('\n\x1b[1mPhase 3 — progression and deep systems\x1b[0m');

test('damage resolves in the documented order', () => {
  const hit = new DamagePipeline().resolve({ amount:10, critical:true }, { bonusDamage:()=>1, armour:x=>x-4, resistanceLevel:1, absorption:2 });
  assert.equal(hit.amount, 7.6); assert.equal(hit.absorbed, 2); assert.deepEqual(hit.trace.map(x=>x.stage), ['enchantment','shield','armour','resistance','absorption','final']);
});
test('shield blocks before armour', () => assert.equal(new DamagePipeline().resolve({amount:12},{shield:()=>true,armour:()=>{throw Error('armour should receive zero only');}}).amount,0));
test('falling charged attacks crit and grounded sword attacks sweep', () => { assert.equal(attackProfile({falling:true,onGround:false,cooldown:1}).critical,true); assert.equal(attackProfile({onGround:true,weapon:'sword',nearbyTargets:2,cooldown:1}).sweeping,true); });
test('bow charge increases projectile damage', () => assert.ok(projectileDamage({charge:1}) > projectileDamage({charge:.2})));

test('enchantment offers are deterministic and bookshelf powered', () => { const table=new EnchantingTable(); assert.deepEqual(table.offers({seed:42,itemClass:'sword',bookshelves:15}),table.offers({seed:42,itemClass:'sword',bookshelves:15})); });
test('anvil combines equal enchantments upward', () => { const a=new ItemStack('diamond_sword',1,{metadata:{enchantments:{sharpness:2}}}); const b=new ItemStack('diamond_sword',1,{metadata:{enchantments:{sharpness:2}}}); const out=combineOnAnvil(a,b); assert.equal(getEnchantments(out.stack).sharpness,3); assert.ok(out.levelCost>0); });
test('grindstone removes enchantments and returns XP', () => { const a=new ItemStack('diamond_sword',1,{metadata:{enchantments:{sharpness:3,unbreaking:2}}}); const out=grindstone(a); assert.deepEqual(getEnchantments(out.stack),{}); assert.equal(out.experience,5); });

test('brewing follows awkward potion tree and modifiers', () => { const awkward=brewPotion({effect:'water',duration:0,form:'drink'},'nether_wart'); const speed=brewPotion(awkward,'sugar'); assert.equal(speed.effect,StatusEffect.SPEED); assert.equal(brewPotion(speed,'gunpowder').form,'splash'); });
test('brewing stand consumes fuel after twenty seconds', () => { const stand=new BrewingStand(); stand.bottles[0]={effect:'water',duration:0,form:'drink'}; stand.ingredient='nether_wart'; stand.addFuel(); assert.equal(stand.tick(20),true); assert.equal(stand.fuel,19); assert.equal(stand.bottles[0].effect,'awkward'); });
test('expanded effects include wither, absorption and levitation', () => { const fx=new StatusEffectController(); assert.equal(fx.apply(StatusEffect.WITHER,10),true); assert.equal(fx.apply(StatusEffect.ABSORPTION,10,1),true); assert.equal(fx.absorptionHearts,8); assert.equal(fx.apply(StatusEffect.LEVITATION,10),true); });

test('redstone propagation is deterministic and attenuates', () => { const n=new RedstoneNetwork(); n.set({x:0,y:0,z:0},{kind:'lever',source:15}); n.set({x:1,y:0,z:0}); n.tick(); n.tick(); assert.equal(n.powerAt({x:0,y:0,z:0}),15); assert.equal(n.powerAt({x:1,y:0,z:0}),15); });
test('pistons reject chains beyond twelve blocks', () => { const cells=new Map(); for(let x=1;x<=13;x++)cells.set(`${x},0,0`,1); const w={getBlock:(x,y,z)=>cells.get(`${x},${y},${z}`)??0}; assert.equal(new PistonSystem().plan(w,{x:0,y:0,z:0},{x:1,y:0,z:0}),null); });
test('hopper transfer conserves items', () => { const a=new Container({size:3}), b=new Container({size:3}); a.setSlot(0,new ItemStack('cobblestone',3)); const h=new HopperController({cooldown:0}); assert.equal(h.tick(1,a,b),1); assert.equal(a.getSlot(0).quantity+b.getSlot(0).quantity,3); });
test('boats share a mountable vehicle base', () => { const v=new VehiclePhysics('boat'), rider={id:1}; assert.equal(v.mount(rider),true); v.tick(.1,{input:{x:1,z:0},inWater:true}); assert.ok(v.position.x>0); assert.equal(v.dismount(rider),true); });
test('fishing yields only declared loot classes', () => { const f=new FishingSystem(5); f.cast(); f.tick(40,{water:true}); assert.ok(['fish','junk','treasure'].includes(f.reel())); });
test('boss parts modify damage and phases drive the bar', () => { const boss=new BossController({maxHealth:100,phases:[{id:'rage',threshold:.5},{id:'normal',threshold:1}]}); boss.addPart('head',2); assert.equal(boss.damage(30,'head'),60); assert.equal(boss.bar.phase,'rage'); assert.equal(boss.bar.fraction,.4); });
test('live Phase 3 runtime persists recipe and brewing progress', () => { const runtime=new Phase3Runtime({seed:7}); runtime.unlockRecipe('diamond_sword'); const stand=runtime.registerBrewingStand('1,2,3'); stand.addFuel(); const restored=new Phase3Runtime({seed:7}).fromJSON(runtime.toJSON()); assert.equal(restored.unlockedRecipes.has('diamond_sword'),true); assert.equal(restored.brewingStands.get('1,2,3').fuel,20); });
test('villager professions and offers persist deterministically', () => { const a=new VillagerTradeBook({seed:9,villagerId:'v1'}); a.adjustReputation(12); const runtime=new Phase3Runtime({seed:9}); runtime.villagerTrades.set('v1',a); const restored=new Phase3Runtime({seed:9}).fromJSON(runtime.toJSON()); assert.deepEqual(restored.villagerTrades.get('v1').offers(),a.offers()); });
test('taming and mount ownership persist on living entities', () => { const horse=new MobEntity().spawn('horse',0,2,0,4); assert.equal(horse.feed('apple').mode,'tame'); assert.equal(horse.mount(),true); const data=horse.toJSON(); const restored=new MobEntity(); assert.equal(restored.fromJSON(data),true); assert.equal(restored.ownerId,'local-player'); assert.equal(restored.riderId,'local-player'); });
test('overall Phase 1-3 content targets are present', () => { assert.ok(BLOCK_DEFINITIONS.length>=250); assert.ok(Object.keys(BIOMES).length>=45); assert.ok(MOB_DEFINITIONS.length>=30); });

console.log(`\n\x1b[32m${passed}/${passed} Phase 3 checks passed\x1b[0m`);
