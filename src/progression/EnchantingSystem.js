/** Enchanting, anvils, grindstones and smithing without DOM/render dependencies. */
export const Enchantment = Object.freeze({
  PROTECTION: 'protection', FIRE_PROTECTION: 'fire_protection', FEATHER_FALLING: 'feather_falling',
  SHARPNESS: 'sharpness', SMITE: 'smite', BANE: 'bane_of_arthropods', EFFICIENCY: 'efficiency',
  FORTUNE: 'fortune', SILK_TOUCH: 'silk_touch', UNBREAKING: 'unbreaking', MENDING: 'mending',
  LOOTING: 'looting', POWER: 'power', PUNCH: 'punch', FLAME: 'flame', INFINITY: 'infinity',
  DEPTH_STRIDER: 'depth_strider', THORNS: 'thorns',
});

export const ENCHANTMENTS = Object.freeze({
  protection:{max:4,weight:10,slots:['armour']}, fire_protection:{max:4,weight:5,slots:['armour']},
  feather_falling:{max:4,weight:5,slots:['boots']}, sharpness:{max:5,weight:10,slots:['sword','axe']},
  smite:{max:5,weight:5,slots:['sword','axe']}, bane_of_arthropods:{max:5,weight:5,slots:['sword','axe']},
  efficiency:{max:5,weight:10,slots:['tool']}, fortune:{max:3,weight:2,slots:['tool']},
  silk_touch:{max:1,weight:1,slots:['tool']}, unbreaking:{max:3,weight:5,slots:['all']},
  mending:{max:1,weight:1,slots:['all'],treasure:true}, looting:{max:3,weight:2,slots:['sword']},
  power:{max:5,weight:10,slots:['bow']}, punch:{max:2,weight:2,slots:['bow']},
  flame:{max:1,weight:2,slots:['bow']}, infinity:{max:1,weight:1,slots:['bow']},
  depth_strider:{max:3,weight:2,slots:['boots']}, thorns:{max:3,weight:1,slots:['armour']},
});

const conflicts = new Set(['fortune|silk_touch','bane_of_arthropods|sharpness','sharpness|smite','bane_of_arthropods|smite','infinity|mending']);
const pair = (a,b) => [a,b].sort().join('|');
export const compatibleEnchantments = (a,b) => a === b || !conflicts.has(pair(a,b));

function hash(seed) {
  let x = (Number(seed) || 0) | 0;
  return () => { x |= 0; x = x + 0x6d2b79f5 | 0; let t = Math.imul(x ^ x >>> 15, 1 | x); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

export function getEnchantments(stack) { return { ...(stack?.metadata?.enchantments ?? {}) }; }
export function setEnchantments(stack, enchantments) {
  stack.metadata = { ...(stack.metadata ?? {}), enchantments: { ...enchantments } };
  return stack;
}

export class EnchantingTable {
  offers({ seed = 0, itemClass = 'all', bookshelves = 0 } = {}) {
    const random = hash(seed);
    const shelfPower = Math.max(0, Math.min(15, Math.floor(bookshelves)));
    return [1,2,3].map(slot => {
      const cost = Math.max(slot, Math.floor((shelfPower + 1) * slot / 2 + random() * 4));
      const pool = Object.entries(ENCHANTMENTS).filter(([,d]) => !d.treasure && (d.slots.includes('all') || d.slots.includes(itemClass)));
      const [id, definition] = pool[Math.floor(random() * pool.length)] ?? ['unbreaking', ENCHANTMENTS.unbreaking];
      return Object.freeze({ slot, cost, lapis: slot, enchantments: Object.freeze({ [id]: Math.max(1, Math.min(definition.max, Math.ceil(cost / 10))) }) });
    });
  }

  apply(stack, offer, { levels = 0, lapis = 0 } = {}) {
    if (!offer || levels < offer.cost || lapis < offer.lapis) return null;
    const current = getEnchantments(stack);
    for (const [id, level] of Object.entries(offer.enchantments)) {
      if (Object.keys(current).every(existing => compatibleEnchantments(existing, id))) current[id] = level;
    }
    setEnchantments(stack, current);
    return { stack, levelsSpent: offer.cost, lapisSpent: offer.lapis };
  }
}

export function combineOnAnvil(left, right, { rename = null } = {}) {
  if (!left || !right) return null;
  const merged = left.clone();
  const enchantments = getEnchantments(merged);
  let cost = rename && rename !== merged.metadata?.customName ? 1 : 0;
  for (const [id, incoming] of Object.entries(getEnchantments(right))) {
    if (!Object.keys(enchantments).every(existing => compatibleEnchantments(existing,id))) continue;
    const current = enchantments[id] ?? 0;
    const max = ENCHANTMENTS[id]?.max ?? incoming;
    enchantments[id] = Math.min(max, current === incoming ? incoming + 1 : Math.max(current, incoming));
    cost += enchantments[id];
  }
  if (left.itemId === right.itemId && merged.isDamageable) {
    merged.repair(right.remainingDurability + Math.floor(merged.maxDurability * 0.12));
    cost += 2;
  }
  merged.metadata = { ...(merged.metadata ?? {}), enchantments };
  if (rename) merged.metadata.customName = String(rename).slice(0, 50);
  return Object.freeze({ stack: merged, levelCost: Math.max(1, cost) });
}

export function grindstone(stack) {
  const result = stack.clone();
  const enchanted = getEnchantments(result);
  const xp = Object.values(enchanted).reduce((sum, level) => sum + level, 0);
  if (result.metadata) delete result.metadata.enchantments;
  return Object.freeze({ stack: result, experience: xp });
}

export function smithUpgrade(stack, materialId) {
  if (!stack || materialId !== 'netherite_ingot') return null;
  const match = /^(diamond)_(.+)$/.exec(stack.itemId);
  if (!match) return null;
  return Object.freeze({ itemId: `netherite_${match[2]}`, metadata: { ...(stack.metadata ?? {}) }, damage: stack.damage });
}

export default EnchantingTable;
