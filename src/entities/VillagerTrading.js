/** Deterministic professions, offers, reputation discounts and trade execution. */
import { ItemStack } from '../items/ItemStack.js';

export const VillagerProfession = Object.freeze({
  FARMER:'farmer', ARMOURER:'armourer', TOOLSMITH:'toolsmith', CLERIC:'cleric', FLETCHER:'fletcher', LIBRARIAN:'librarian',
});

const TRADES = Object.freeze({
  farmer:[['wheat',20,'bread',6],['carrot',18,'apple',3]],
  armourer:[['iron_ingot',6,'iron_helmet',1],['diamond',7,'diamond_boots',1]],
  toolsmith:[['iron_ingot',5,'iron_pickaxe',1],['diamond',6,'diamond_sword',1]],
  cleric:[['bone',12,'glowstone',2],['gold_ingot',4,'redstone_dust',8]],
  fletcher:[['stick',24,'arrow',12],['string',8,'bow',1]],
  librarian:[['iron_ingot',4,'grindstone',1],['diamond',5,'enchanting_table',1]],
});

function hash(seed, value) {
  let h=(seed>>>0)^0x9e3779b9;
  for(const ch of String(value)) h=Math.imul(h^ch.charCodeAt(0),0x45d9f3b)>>>0;
  return h>>>0;
}

export class VillagerTradeBook {
  constructor({seed=0,villagerId='villager',profession=null}={}) {
    const professions=Object.values(VillagerProfession);
    this.seed=seed>>>0; this.villagerId=String(villagerId);
    this.profession=profession&&TRADES[profession]?profession:professions[hash(this.seed,this.villagerId)%professions.length];
    this.reputation=0; this.uses=new Map();
  }
  offers() {
    return TRADES[this.profession].map(([buy,buyCount,sell,sellCount],index)=>Object.freeze({
      id:`${this.profession}:${index}`, buy, buyCount:Math.max(1,buyCount-Math.floor(this.reputation/20)), sell, sellCount,
      uses:this.uses.get(index)??0, maxUses:12,
    }));
  }
  trade(index,inventory) {
    const offer=this.offers()[index];
    if(!offer||offer.uses>=offer.maxUses||!inventory?.removeItem||!inventory?.addItem)return false;
    const removed=inventory.removeItem(offer.buy,offer.buyCount);
    if(removed!==offer.buyCount){if(removed>0)inventory.addItem(new ItemStack(offer.buy,removed));return false;}
    const output=new ItemStack(offer.sell,offer.sellCount);
    const leftover=inventory.addItem(output);
    if(leftover>0){inventory.addItem(new ItemStack(offer.buy,offer.buyCount));return false;}
    this.uses.set(index,(this.uses.get(index)??0)+1); this.reputation=Math.min(100,this.reputation+1); return true;
  }
  adjustReputation(delta){this.reputation=Math.max(-100,Math.min(100,this.reputation+(Number(delta)||0)));return this.reputation;}
  toJSON(){return{profession:this.profession,reputation:this.reputation,uses:[...this.uses]};}
  fromJSON(data){if(!data||typeof data!=='object')return this;if(TRADES[data.profession])this.profession=data.profession;this.reputation=Math.max(-100,Math.min(100,Number(data.reputation)||0));this.uses=new Map((Array.isArray(data.uses)?data.uses:[]).filter(e=>Array.isArray(e)&&Number.isInteger(e[0])&&Number.isInteger(e[1])));return this;}
}

export default VillagerTradeBook;
