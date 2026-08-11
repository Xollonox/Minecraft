/** Deterministic Phase-3 automation primitives. */
const key = p => `${p.x|0},${p.y|0},${p.z|0}`;
const SIDES = Object.freeze([[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]);

export class RedstoneNetwork {
  constructor() { this.nodes = new Map(); this.queue = []; this.tickNumber = 0; }
  set(position, { kind='wire', source=0, facing=null, delay=1 }={}) { this.nodes.set(key(position), { position:{...position}, kind, source:Math.max(0,Math.min(15,source|0)), power:0, facing, delay:Math.max(1,delay|0) }); this.schedule(position); }
  remove(position) { return this.nodes.delete(key(position)); }
  schedule(position, delay=1) { const id=key(position); if(this.nodes.has(id)) this.queue.push({id,due:this.tickNumber+Math.max(1,delay|0),order:this.queue.length}); }
  _incoming(node) { let best=node.source; for(const [dx,dy,dz] of SIDES){ const other=this.nodes.get(key({x:node.position.x+dx,y:node.position.y+dy,z:node.position.z+dz})); if(!other)continue; const value=other.kind==='wire'?Math.max(0,other.power-1):other.power; best=Math.max(best,value); } return best; }
  tick() { this.tickNumber++; this.queue.sort((a,b)=>a.due-b.due||a.order-b.order); const due=this.queue.filter(x=>x.due<=this.tickNumber); this.queue=this.queue.filter(x=>x.due>this.tickNumber); const changed=[]; for(const entry of due){ const node=this.nodes.get(entry.id); if(!node)continue; const next=this._incoming(node); if(next===node.power)continue; node.power=next; changed.push(entry.id); for(const [dx,dy,dz] of SIDES)this.schedule({x:node.position.x+dx,y:node.position.y+dy,z:node.position.z+dz},node.delay); } return changed; }
  powerAt(position){ return this.nodes.get(key(position))?.power??0; }
}

export class PistonSystem {
  constructor({pushLimit=12}={}) { this.pushLimit=pushLimit; }
  plan(world, origin, direction, sticky=false) { const blocks=[]; let cursor={x:origin.x+direction.x,y:origin.y+direction.y,z:origin.z+direction.z}; while(world.getBlock(cursor.x,cursor.y,cursor.z)!==0){ if(blocks.length>=this.pushLimit||world.isImmovable?.(cursor.x,cursor.y,cursor.z))return null; blocks.push({...cursor}); cursor={x:cursor.x+direction.x,y:cursor.y+direction.y,z:cursor.z+direction.z}; } return {origin:{...origin},direction:{...direction},blocks,sticky}; }
  execute(world, plan){ if(!plan)return false; for(let i=plan.blocks.length-1;i>=0;i--){ const p=plan.blocks[i], id=world.getBlock(p.x,p.y,p.z), state=world.getBlockState?.(p.x,p.y,p.z)??0; world.setBlock(p.x+plan.direction.x,p.y+plan.direction.y,p.z+plan.direction.z,id,{state,cause:'piston',cascade:false}); world.setBlock(p.x,p.y,p.z,0,{cause:'piston',cascade:false}); } return true; }
}

export class HopperController {
  constructor({cooldown=0.4}={}){this.cooldown=cooldown;this.elapsed=0;}
  tick(dt,source,destination){this.elapsed+=Math.max(0,Number(dt)||0);if(this.elapsed<this.cooldown)return 0;this.elapsed=0;if(!source||!destination)return 0;for(let i=0;i<source.size;i++){const stack=source.extract(i,1);if(!stack)continue;const moved=destination.insert(stack);if(!stack.isEmpty)source.insert(stack,[i]);return moved;}return 0;}
}

export class VehiclePhysics {
  constructor(type='boat'){this.type=type;this.position={x:0,y:0,z:0};this.velocity={x:0,y:0,z:0};this.passengers=[];}
  mount(entity){if(!entity||this.passengers.includes(entity))return false;this.passengers.push(entity);return true;}
  dismount(entity){const i=this.passengers.indexOf(entity);if(i<0)return false;this.passengers.splice(i,1);return true;}
  tick(dt,{input={x:0,z:0},inWater=false,onRail=false,powered=false,slope=0}={}){const step=Math.min(.1,Math.max(0,Number(dt)||0));const drive=this.type==='boat'?(inWater?5:1):(onRail?(powered?8:4):0.5);this.velocity.x+=input.x*drive*step;this.velocity.z+=input.z*drive*step;this.velocity.y+=(this.type==='boat'&&inWater ? .9 : -9.8)*step;if(this.type==='minecart'&&onRail)this.velocity.y=slope*2;const drag=this.type==='boat'&&inWater ? .92 : onRail ? .985 : .78;this.velocity.x*=drag;this.velocity.z*=drag;for(const axis of ['x','y','z'])this.position[axis]+=this.velocity[axis]*step;return this.position;}
}

export class FishingSystem {
  constructor(seed=1){this.seed=seed|0;this.castTime=0;this.hooked=false;}
  cast(){this.castTime=0;this.hooked=false;}
  tick(dt,{water=false,raining=false,openSky=true}={}){if(!water)return 'invalid';this.castTime+=Math.max(0,Number(dt)||0)*(raining&&openSky?1.25:1);const wait=5+Math.abs(this.seed%26);if(this.castTime>=wait)this.hooked=true;return this.hooked?'bite':'waiting';}
  reel(){if(!this.hooked)return null;const roll=Math.abs((Math.imul(this.seed,1103515245)+12345)|0)%100;this.seed=(this.seed+1)|0;this.cast();return roll<10?'treasure':roll<20?'junk':'fish';}
}

export class BossController {
  constructor({maxHealth=200,phases=[]}={}){this.maxHealth=maxHealth;this.health=maxHealth;this.phases=[...phases].sort((a,b)=>a.threshold-b.threshold);this.phase=null;this.parts=new Map();}
  addPart(id,multiplier=1){this.parts.set(id,Math.max(0,Number(multiplier)||0));}
  damage(amount,part='body'){const dealt=Math.max(0,Number(amount)||0)*(this.parts.get(part)??1);this.health=Math.max(0,this.health-dealt);const ratio=this.health/this.maxHealth;this.phase=this.phases.find(p=>ratio<=p.threshold)?.id??this.phases[0]?.id??null;return dealt;}
  get bar(){return {health:this.health,maxHealth:this.maxHealth,fraction:this.health/this.maxHealth,phase:this.phase,dead:this.health<=0};}
}

export default Object.freeze({RedstoneNetwork,PistonSystem,HopperController,VehiclePhysics,FishingSystem,BossController});
