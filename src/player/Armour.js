/**
 * Java-style armour mitigation maths.
 *
 * Kept independent from Inventory and PlayerStats so protection curves can be
 * verified headlessly and reused by mobs later. Damage and health use the same
 * point scale as the rest of the game (20 health = ten hearts).
 */

import { clamp } from '../utils/MathUtils.js';

/** Maximum visible/effective armour points. */
export const MAX_ARMOUR_POINTS = 20;

/**
 * Resolves incoming damage after armour and toughness.
 *
 * The effective protection term weakens under large hits unless toughness is
 * present, preventing a cheap full set from flattening every damage source by a
 * constant percentage while letting diamond remain meaningfully better.
 */
export function damageAfterArmour(damage, armourPoints, toughness = 0) {
  const incoming = Math.max(0, Number(damage) || 0);
  if (incoming <= 0) return 0;

  const armour = clamp(Number(armourPoints) || 0, 0, MAX_ARMOUR_POINTS);
  if (armour <= 0) return incoming;
  const tough = Math.max(0, Number(toughness) || 0);
  const effective = Math.min(
    MAX_ARMOUR_POINTS,
    Math.max(armour / 5, armour - incoming / (2 + tough / 4))
  );
  return incoming * (1 - effective / 25);
}

/** Durability lost by every equipped piece that participated in a hit. */
export function armourDurabilityLoss(damage) {
  const incoming = Math.max(0, Number(damage) || 0);
  return incoming <= 0 ? 0 : Math.max(1, Math.floor(incoming / 4));
}

export default damageAfterArmour;
