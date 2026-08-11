/**
 * Data-driven deterministic loot tables.
 *
 * The engine deliberately returns plain `{item,count}` records. World blocks can
 * wrap them in ItemStack, entities can scatter them, and a future server can
 * serialise them without pulling rendering or inventory code into this module.
 */

const MAX_POOLS = 64;
const MAX_ROLLS = 128;
const MAX_COUNT = 65535;

function clampInteger(value, minimum, maximum) {
  const number = Math.floor(Number(value) || 0);
  return Math.max(minimum, Math.min(maximum, number));
}

function sampleRange(value, random, minimum = 0, maximum = MAX_COUNT) {
  if (typeof value === 'number') return clampInteger(value, minimum, maximum);
  const low = clampInteger(value?.min ?? minimum, minimum, maximum);
  const high = clampInteger(value?.max ?? low, low, maximum);
  return low + Math.floor(random() * (high - low + 1));
}

function conditionPasses(condition, context, random) {
  if (!condition) return true;
  if (typeof condition === 'function') return Boolean(condition(context, random));
  if (condition.type === 'chance') {
    return random() < Math.max(0, Math.min(1, Number(condition.chance) || 0));
  }
  if (condition.type === 'context') {
    return context?.[condition.key] === condition.value;
  }
  if (condition.type === 'context_min') {
    return Number(context?.[condition.key]) >= Number(condition.value);
  }
  if (condition.type === 'context_max') {
    return Number(context?.[condition.key]) <= Number(condition.value);
  }
  return false;
}

function conditionsPass(conditions, context, random) {
  if (!conditions) return true;
  for (const condition of conditions) {
    if (!conditionPasses(condition, context, random)) return false;
  }
  return true;
}

function appendEntry(output, entry, context, random) {
  if (!entry || entry.type === 'empty') return;
  if (!conditionsPass(entry.conditions, context, random)) return;
  const chance = entry.chance === undefined
    ? 1
    : Math.max(0, Math.min(1, Number(entry.chance) || 0));
  if (chance < 1 && random() >= chance) return;
  if (typeof entry.item !== 'string' || entry.item.length === 0) return;
  const count = sampleRange(entry.count ?? 1, random, 0, MAX_COUNT);
  if (count <= 0) return;
  output.push({ item: entry.item, count });
}

function rollAllPool(output, pool, context, random, rolls) {
  for (let roll = 0; roll < rolls; roll++) {
    for (const entry of pool.entries ?? []) appendEntry(output, entry, context, random);
  }
}

function rollWeightedPool(output, pool, context, random, rolls) {
  const candidates = (pool.entries ?? []).filter(
    (entry) => entry && conditionsPass(entry.conditions, context, random)
  );
  if (candidates.length === 0) return;

  for (let roll = 0; roll < rolls; roll++) {
    let total = 0;
    for (const entry of candidates) total += Math.max(0, Number(entry.weight) || 0);
    if (!(total > 0)) return;
    let cursor = random() * total;
    let selected = candidates[candidates.length - 1];
    for (const entry of candidates) {
      cursor -= Math.max(0, Number(entry.weight) || 0);
      if (cursor < 0) {
        selected = entry;
        break;
      }
    }
    appendEntry(output, { ...selected, chance: 1 }, context, random);
  }
}

/**
 * Rolls one table.
 *
 * Pool mode `all` evaluates every entry. Pool mode `weighted` chooses one entry
 * per roll. Conditions and counts are declarative and worker-safe.
 */
export function rollLootTable(table, { random = Math.random, context = {} } = {}) {
  if (!table || !Array.isArray(table.pools)) return [];
  const output = [];
  for (const pool of table.pools.slice(0, MAX_POOLS)) {
    if (!pool || !conditionsPass(pool.conditions, context, random)) continue;
    const rolls = sampleRange(pool.rolls ?? 1, random, 0, MAX_ROLLS);
    if (rolls <= 0) continue;
    if (pool.mode === 'weighted') rollWeightedPool(output, pool, context, random, rolls);
    else rollAllPool(output, pool, context, random, rolls);
  }
  return mergeLoot(output);
}

/** Merges equal stackable item records without depending on ItemRegistry. */
export function mergeLoot(records) {
  const counts = new Map();
  const order = [];
  for (const record of records ?? []) {
    if (!record || typeof record.item !== 'string') continue;
    const count = clampInteger(record.count, 0, MAX_COUNT);
    if (count <= 0) continue;
    if (!counts.has(record.item)) order.push(record.item);
    counts.set(record.item, Math.min(MAX_COUNT, (counts.get(record.item) ?? 0) + count));
  }
  return order.map((item) => ({ item, count: counts.get(item) }));
}

/** Xorshift32 stream for deterministic world loot. */
export function createLootRandom(seed) {
  let state = Number(seed) >>> 0;
  if (state === 0) state = 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

/** Converts legacy independent drop entries into a table. */
export function independentDropTable(entries) {
  return Object.freeze({
    pools: Object.freeze([
      Object.freeze({
        mode: 'all',
        rolls: 1,
        entries: Object.freeze(
          (entries ?? []).map((entry) => Object.freeze({
            item: entry.item,
            count: Object.freeze({ min: entry.min ?? 1, max: entry.max ?? entry.min ?? 1 }),
            chance: entry.chance ?? 1,
          }))
        ),
      }),
    ]),
  });
}

export default rollLootTable;
