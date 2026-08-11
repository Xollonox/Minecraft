/** Full-game advancement tree, statistics and death markers. */

export const ADVANCEMENTS = Object.freeze([
  { id:'first_wood', title:'Getting Wood', parent:null, trigger:'mine:oak_log' },
  { id:'stone_age', title:'Stone Age', parent:'first_wood', trigger:'obtain:cobblestone' },
  { id:'acquire_hardware', title:'Acquire Hardware', parent:'stone_age', trigger:'obtain:iron_ingot' },
  { id:'diamonds', title:'Diamonds!', parent:'acquire_hardware', trigger:'obtain:diamond' },
  { id:'we_need_to_go_deeper', title:'We Need to Go Deeper', parent:'diamonds', trigger:'dimension:nether' },
  { id:'into_fire', title:'Into Fire', parent:'we_need_to_go_deeper', trigger:'obtain:blaze_rod' },
  { id:'eye_spy', title:'Eye Spy', parent:'into_fire', trigger:'locate:stronghold' },
  { id:'the_end', title:'The End?', parent:'eye_spy', trigger:'dimension:end' },
  { id:'free_the_end', title:'Free the End', parent:'the_end', trigger:'kill:ender_dragon' },
  { id:'remote_getaway', title:'Remote Getaway', parent:'free_the_end', trigger:'locate:end_city' },
  { id:'skys_the_limit', title:"Sky's the Limit", parent:'remote_getaway', trigger:'obtain:elytra' },
  { id:'the_end_again', title:'The End… Again…', parent:'free_the_end', trigger:'respawn:ender_dragon' },
]);

const BY_TRIGGER = new Map(ADVANCEMENTS.map((entry) => [entry.trigger, entry]));

function counterRecord() {
  return {
    blocksMined:0, blocksPlaced:0, itemsCrafted:0, itemsPickedUp:0,
    mobsKilled:0, damageDealt:0, damageTaken:0, deaths:0,
    distanceWalked:0, distanceSwum:0, distanceFlown:0,
    timePlayed:0, worldsSaved:0, portalsUsed:0, dragonsDefeated:0,
  };
}

export class AdvancementSystem {
  constructor() {
    this.unlocked = new Map();
    this.counters = counterRecord();
    this.byBlock = Object.create(null);
    this.byItemCrafted = Object.create(null);
    this.byMobKilled = Object.create(null);
    this.distanceByDimension = { overworld:0, nether:0, end:0 };
    this.deathMarkers = [];
    this.lastUnlock = null;
  }

  trigger(trigger, details = {}) {
    const definition = BY_TRIGGER.get(trigger);
    if (!definition || this.unlocked.has(definition.id)) return null;
    const parent = definition.parent;
    if (parent && !this.unlocked.has(parent)) return null;
    const unlock = {
      id:definition.id, title:definition.title, trigger,
      at:Math.max(0, Number(details.playTime) || this.counters.timePlayed),
      dimension:details.dimension ?? null,
    };
    this.unlocked.set(definition.id, unlock);
    this.lastUnlock = unlock;
    return unlock;
  }

  mine(blockName, details = {}) {
    this.counters.blocksMined++;
    this.byBlock[blockName] = (this.byBlock[blockName] || 0) + 1;
    return this.trigger(`mine:${blockName}`, details);
  }

  place(blockName) {
    this.counters.blocksPlaced++;
    this.byBlock[`placed:${blockName}`] = (this.byBlock[`placed:${blockName}`] || 0) + 1;
  }

  obtain(itemId, count = 1, details = {}) {
    this.counters.itemsPickedUp += Math.max(0, Number(count) || 0);
    return this.trigger(`obtain:${itemId}`, details);
  }

  craft(itemId, count = 1, details = {}) {
    const amount = Math.max(1, Number(count) || 1);
    this.counters.itemsCrafted += amount;
    this.byItemCrafted[itemId] = (this.byItemCrafted[itemId] || 0) + amount;
    return this.trigger(`obtain:${itemId}`, details);
  }

  kill(mobId, details = {}) {
    this.counters.mobsKilled++;
    this.byMobKilled[mobId] = (this.byMobKilled[mobId] || 0) + 1;
    if (mobId === 'ender_dragon') this.counters.dragonsDefeated++;
    return this.trigger(`kill:${mobId}`, details);
  }

  move(distance, { dimension='overworld', medium='walk' } = {}) {
    const amount = Math.max(0, Number(distance) || 0);
    if (medium === 'swim') this.counters.distanceSwum += amount;
    else if (medium === 'fly') this.counters.distanceFlown += amount;
    else this.counters.distanceWalked += amount;
    if (Object.hasOwn(this.distanceByDimension, dimension)) this.distanceByDimension[dimension] += amount;
  }

  recordDeath(position, dimension, cause, playTime = 0) {
    this.counters.deaths++;
    const marker = {
      id:`death-${this.counters.deaths}`,
      x:Number(position?.x) || 0, y:Number(position?.y) || 0, z:Number(position?.z) || 0,
      dimension:String(dimension || 'overworld'), cause:String(cause || 'unknown'),
      playTime:Math.max(0, Number(playTime) || 0),
    };
    this.deathMarkers.unshift(marker);
    if (this.deathMarkers.length > 20) this.deathMarkers.length = 20;
    return marker;
  }

  tick(seconds) { this.counters.timePlayed += Math.max(0, Number(seconds) || 0); }
  recordSave() { this.counters.worldsSaved++; }
  recordPortal() { this.counters.portalsUsed++; }

  tree() {
    return ADVANCEMENTS.map((definition) => ({
      ...definition,
      unlocked:this.unlocked.has(definition.id),
      data:this.unlocked.get(definition.id) ?? null,
    }));
  }

  snapshot() {
    return {
      counters:{ ...this.counters },
      distanceByDimension:{ ...this.distanceByDimension },
      mostMined:Object.entries(this.byBlock).sort((a,b) => b[1]-a[1]).slice(0,8),
      mostCrafted:Object.entries(this.byItemCrafted).sort((a,b) => b[1]-a[1]).slice(0,8),
      mobKills:Object.entries(this.byMobKilled).sort((a,b) => b[1]-a[1]).slice(0,8),
      advancements:this.tree(),
      deathMarkers:this.deathMarkers.map((marker) => ({ ...marker })),
    };
  }

  toJSON() {
    return {
      unlocked:[...this.unlocked.values()].map((entry) => ({ ...entry })),
      counters:{ ...this.counters }, byBlock:{ ...this.byBlock },
      byItemCrafted:{ ...this.byItemCrafted }, byMobKilled:{ ...this.byMobKilled },
      distanceByDimension:{ ...this.distanceByDimension },
      deathMarkers:this.deathMarkers.map((marker) => ({ ...marker })),
    };
  }

  fromJSON(data) {
    if (!data || typeof data !== 'object') return this;
    this.unlocked.clear();
    for (const entry of Array.isArray(data.unlocked) ? data.unlocked : []) {
      if (entry && ADVANCEMENTS.some((definition) => definition.id === entry.id)) this.unlocked.set(entry.id, { ...entry });
    }
    for (const [key, value] of Object.entries(data.counters ?? {})) {
      if (Object.hasOwn(this.counters, key)) this.counters[key] = Math.max(0, Number(value) || 0);
    }
    this.byBlock = { ...(data.byBlock ?? {}) };
    this.byItemCrafted = { ...(data.byItemCrafted ?? {}) };
    this.byMobKilled = { ...(data.byMobKilled ?? {}) };
    this.distanceByDimension = { ...this.distanceByDimension, ...(data.distanceByDimension ?? {}) };
    this.deathMarkers = (Array.isArray(data.deathMarkers) ? data.deathMarkers : []).slice(0,20).map((entry) => ({ ...entry }));
    return this;
  }
}

export default AdvancementSystem;
