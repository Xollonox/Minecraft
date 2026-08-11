/**
 * Damage sources and their behaviour.
 *
 * A table rather than a set of `if (cause === 'fall')` branches scattered across
 * the player, the mob code and the fluid code. Each source declares how it
 * interacts with the invulnerability window, whether armour would reduce it and
 * what the death screen should say — so adding a source is one entry here, and
 * nothing downstream needs to learn about it.
 *
 * ## Why `bypassesCooldown` exists
 *
 * After taking a hit the player is briefly invulnerable, which is what stops a
 * mob standing in a doorway from killing them in a third of a second. That window
 * must *not* apply to continuous environmental damage: suffocating inside a block
 * or drowning would otherwise be survivable indefinitely, because each tick would
 * be swallowed by the cooldown from the previous one.
 *
 * Worker-safe: no DOM, no Three.js.
 */

/** Canonical damage source names. */
export const DamageType = Object.freeze({
  FALL: 'fall',
  DROWNING: 'drowning',
  MOB: 'mob',
  PROJECTILE: 'projectile',
  SUFFOCATION: 'suffocation',
  STARVATION: 'starvation',
  POISON: 'poison',
  VOID: 'void',
  FIRE: 'fire',
  LAVA: 'lava',
  GENERIC: 'generic',
});

/**
 * @typedef {Object} DamageSource
 * @property {string} id
 * @property {string} deathMessage Shown on the death screen.
 * @property {boolean} bypassesCooldown Ignores invulnerability frames.
 * @property {boolean} reducedByArmour Whether equipped armour mitigates it.
 * @property {boolean} appliesKnockback
 * @property {boolean} blockable Whether a raised shield may stop it.
 * @property {boolean} flashScreen Whether the HUD should flash red.
 */

/** @type {Readonly<Record<string, DamageSource>>} */
export const DAMAGE_SOURCES = Object.freeze({
  [DamageType.FALL]: Object.freeze({
    id: DamageType.FALL,
    deathMessage: 'You hit the ground too hard',
    bypassesCooldown: false,
    // Ordinary armour does not cushion impact; fall-specific enchantments can
    // hook into the resolver later without making every chestplate a parachute.
    reducedByArmour: false,
    appliesKnockback: false,
    blockable: false,
    flashScreen: true,
  }),
  [DamageType.DROWNING]: Object.freeze({
    id: DamageType.DROWNING,
    deathMessage: 'You drowned',
    // Continuous: see the module note on why this must ignore the cooldown.
    bypassesCooldown: true,
    reducedByArmour: false,
    appliesKnockback: false,
    blockable: false,
    flashScreen: true,
  }),
  [DamageType.MOB]: Object.freeze({
    id: DamageType.MOB,
    deathMessage: 'You were slain',
    bypassesCooldown: false,
    reducedByArmour: true,
    appliesKnockback: true,
    blockable: true,
    flashScreen: true,
  }),
  [DamageType.PROJECTILE]: Object.freeze({
    id: DamageType.PROJECTILE,
    deathMessage: 'You were shot',
    bypassesCooldown: false,
    reducedByArmour: true,
    appliesKnockback: true,
    blockable: true,
    flashScreen: true,
  }),
  [DamageType.SUFFOCATION]: Object.freeze({
    id: DamageType.SUFFOCATION,
    deathMessage: 'You suffocated in a wall',
    bypassesCooldown: true,
    reducedByArmour: false,
    appliesKnockback: false,
    blockable: false,
    flashScreen: true,
  }),
  [DamageType.STARVATION]: Object.freeze({
    id: DamageType.STARVATION,
    deathMessage: 'You starved to death',
    bypassesCooldown: true,
    reducedByArmour: false,
    appliesKnockback: false,
    blockable: false,
    // Starvation ticks slowly and constantly; flashing the screen each time
    // would be a strobe rather than a warning.
    flashScreen: false,
  }),
  [DamageType.POISON]: Object.freeze({
    id: DamageType.POISON,
    deathMessage: 'You succumbed to poison',
    bypassesCooldown: true,
    reducedByArmour: false,
    appliesKnockback: false,
    blockable: false,
    flashScreen: true,
  }),
  [DamageType.VOID]: Object.freeze({
    id: DamageType.VOID,
    deathMessage: 'You fell out of the world',
    bypassesCooldown: true,
    reducedByArmour: false,
    appliesKnockback: false,
    blockable: false,
    flashScreen: false,
  }),
  [DamageType.FIRE]: Object.freeze({
    id: DamageType.FIRE,
    deathMessage: 'You burned to death',
    bypassesCooldown: true,
    reducedByArmour: true,
    appliesKnockback: false,
    blockable: false,
    flashScreen: true,
  }),
  [DamageType.LAVA]: Object.freeze({
    id: DamageType.LAVA,
    deathMessage: 'You tried to swim in lava',
    bypassesCooldown: true,
    reducedByArmour: true,
    appliesKnockback: false,
    blockable: false,
    flashScreen: true,
  }),
  [DamageType.GENERIC]: Object.freeze({
    id: DamageType.GENERIC,
    deathMessage: 'You died',
    bypassesCooldown: false,
    reducedByArmour: true,
    appliesKnockback: false,
    blockable: true,
    flashScreen: true,
  }),
});

/**
 * Looks up a damage source, falling back to generic.
 * @param {string} type
 * @returns {DamageSource}
 */
export function getDamageSource(type) {
  return DAMAGE_SOURCES[type] ?? DAMAGE_SOURCES[DamageType.GENERIC];
}

export default DAMAGE_SOURCES;
