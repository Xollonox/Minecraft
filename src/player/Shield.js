/**
 * Shield-facing and durability rules.
 *
 * Kept free of Three.js and DOM dependencies so the protection cone can be
 * regression-tested without constructing a Player or browser. `look` points
 * away from the player; `source` is the attacker's world position.
 */

/** A shield protects the frontal 180 degrees, matching the familiar rule. */
export const SHIELD_BLOCK_DOT = 0;

/**
 * True when an attack source lies inside the shield's frontal protection cone.
 *
 * @param {{x:number,z:number}} player
 * @param {{x:number,z:number}} look Normalised horizontal look direction.
 * @param {{x:number,z:number}|null} source Attacker/projectile source position.
 */
export function isInsideShieldArc(player, look, source) {
  if (!source) return false;
  const dx = Number(source.x) - Number(player.x);
  const dz = Number(source.z) - Number(player.z);
  const distance = Math.hypot(dx, dz);
  if (!(distance > 1e-6)) return true;

  const lookLength = Math.hypot(Number(look.x), Number(look.z));
  if (!(lookLength > 1e-6)) return false;
  const dot = (dx / distance) * (look.x / lookLength) + (dz / distance) * (look.z / lookLength);
  return dot >= SHIELD_BLOCK_DOT;
}

/**
 * Durability consumed by a successful block.
 *
 * One base point plus the integer incoming damage makes stronger attacks wear a
 * shield faster while ensuring every successful block has a cost.
 */
export function shieldDurabilityLoss(incomingDamage) {
  return 1 + Math.max(0, Math.floor(Number(incomingDamage) || 0));
}

export default Object.freeze({
  SHIELD_BLOCK_DOT,
  isInsideShieldArc,
  shieldDurabilityLoss,
});
