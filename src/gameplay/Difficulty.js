/**
 * Persistent world difficulty profiles.
 *
 * Difficulty is world-owned rather than a global setting: loading an Easy world
 * must not silently weaken a Chug Tuff world. The numbers are deliberately plain
 * data so the player, spawner, UI and deterministic tests share one contract.
 */

export const DifficultyId = Object.freeze({
  EASY:'easy',
  NORMAL:'normal',
  HARDCORE:'hardcore',
  CHUG_TUFF:'chug_tuff',
});

export const DIFFICULTY_PROFILES = Object.freeze({
  [DifficultyId.EASY]:Object.freeze({
    id:DifficultyId.EASY,
    label:'Easy',
    description:'Gentler damage, slower hunger, faster natural healing and fewer hostile spawns.',
    incomingDamage:.65,
    exhaustionMultiplier:.62,
    naturalRegeneration:1.5,
    starvationFloor:10,
    hostileHealth:.82,
    hostileAttackRate:.82,
    hostileSpawnRate:.72,
    hostileCapMultiplier:.72,
    oneLife:false,
  }),
  [DifficultyId.NORMAL]:Object.freeze({
    id:DifficultyId.NORMAL,
    label:'Normal',
    description:'Balanced survival damage, hunger, healing and hostile population.',
    incomingDamage:1,
    exhaustionMultiplier:1,
    naturalRegeneration:1,
    starvationFloor:1,
    hostileHealth:1,
    hostileAttackRate:1,
    hostileSpawnRate:1,
    hostileCapMultiplier:1,
    oneLife:false,
  }),
  [DifficultyId.HARDCORE]:Object.freeze({
    id:DifficultyId.HARDCORE,
    label:'Hardcore',
    description:'One life. Stronger mobs, faster hunger and starvation can kill.',
    incomingDamage:1.35,
    exhaustionMultiplier:1.3,
    naturalRegeneration:.72,
    starvationFloor:0,
    hostileHealth:1.22,
    hostileAttackRate:1.18,
    hostileSpawnRate:1.22,
    hostileCapMultiplier:1.2,
    oneLife:true,
  }),
  [DifficultyId.CHUG_TUFF]:Object.freeze({
    id:DifficultyId.CHUG_TUFF,
    label:'Chug Tuff',
    description:'The special brutal mode: one life, savage damage, scarce healing and relentless mobs.',
    incomingDamage:1.75,
    exhaustionMultiplier:1.7,
    naturalRegeneration:.32,
    starvationFloor:0,
    hostileHealth:1.55,
    hostileAttackRate:1.42,
    hostileSpawnRate:1.58,
    hostileCapMultiplier:1.48,
    oneLife:true,
  }),
});

export const DIFFICULTY_ORDER = Object.freeze([
  DifficultyId.EASY,
  DifficultyId.NORMAL,
  DifficultyId.HARDCORE,
  DifficultyId.CHUG_TUFF,
]);

export function normalizeDifficulty(value) {
  return DIFFICULTY_PROFILES[value] ? value : DifficultyId.NORMAL;
}

export function getDifficulty(value) {
  return DIFFICULTY_PROFILES[normalizeDifficulty(value)];
}

export function isPermadeathDifficulty(value) {
  return getDifficulty(value).oneLife;
}

export default DIFFICULTY_PROFILES;
