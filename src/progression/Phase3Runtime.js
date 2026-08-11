import { EnchantingTable } from './EnchantingSystem.js';
import { BrewingStand } from './BrewingSystem.js';
import { RedstoneNetwork, PistonSystem, HopperController, VehiclePhysics, FishingSystem, BossController } from '../automation/AutomationSystems.js';
import { VillagerTradeBook } from '../entities/VillagerTrading.js';

/** Live, world-scoped owner for every Phase 3 service. */
export class Phase3Runtime {
  constructor({ world = null, player = null, seed = 0 } = {}) {
    this.world=world; this.player=player; this.seed=Number(seed)>>>0;
    this.enchanting=new EnchantingTable(); this.redstone=new RedstoneNetwork(); this.pistons=new PistonSystem();
    this.hoppers=new Map(); this.brewingStands=new Map(); this.vehicles=new Set();
    this.fishing=new FishingSystem(this.seed^0x51f15e); this.bosses=new Set(); this.unlockedRecipes=new Set();
    this.villagerTrades=new Map();
  }
  fixedUpdate(step){this.redstone.tick();for(const e of this.hoppers.values())e.controller.tick(step,e.source,e.destination);for(const stand of this.brewingStands.values())stand.tick(step);}
  createVehicle(type,position=null){const v=new VehiclePhysics(type);if(position)v.position={...v.position,...position};this.vehicles.add(v);return v;}
  createBoss(config){const boss=new BossController(config);this.bosses.add(boss);return boss;}
  registerHopper(id,source,destination){const e={controller:new HopperController(),source,destination};this.hoppers.set(String(id),e);return e.controller;}
  registerBrewingStand(id,stand=new BrewingStand()){this.brewingStands.set(String(id),stand);return stand;}
  getVillagerTrades(id,profession=null){const key=String(id);if(!this.villagerTrades.has(key))this.villagerTrades.set(key,new VillagerTradeBook({seed:this.seed,villagerId:key,profession}));return this.villagerTrades.get(key);}
  unlockRecipe(id){if(typeof id!=='string'||!id)return false;const n=this.unlockedRecipes.size;this.unlockedRecipes.add(id);return this.unlockedRecipes.size!==n;}
  toJSON(){return{unlockedRecipes:[...this.unlockedRecipes].sort(),brewingStands:[...this.brewingStands].map(([id,s])=>[id,s.toJSON()]),villagerTrades:[...this.villagerTrades].map(([id,t])=>[id,t.toJSON()])};}
  fromJSON(data){if(!data||typeof data!=='object')return this;this.unlockedRecipes=new Set(Array.isArray(data.unlockedRecipes)?data.unlockedRecipes.filter(x=>typeof x==='string').slice(0,4096):[]);this.brewingStands.clear();for(const e of Array.isArray(data.brewingStands)?data.brewingStands.slice(0,1024):[]){if(Array.isArray(e)&&typeof e[0]==='string')this.brewingStands.set(e[0],new BrewingStand().fromJSON(e[1]));}this.villagerTrades.clear();for(const e of Array.isArray(data.villagerTrades)?data.villagerTrades.slice(0,2048):[]){if(Array.isArray(e)&&typeof e[0]==='string')this.villagerTrades.set(e[0],new VillagerTradeBook({seed:this.seed,villagerId:e[0]}).fromJSON(e[1]));}return this;}
  destroy(){this.hoppers.clear();this.brewingStands.clear();this.villagerTrades.clear();this.vehicles.clear();this.bosses.clear();this.world=null;this.player=null;}
}
export default Phase3Runtime;
