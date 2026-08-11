/**
 * Finds how far a third-person camera can travel from `start` toward `end`
 * before entering blocked space.
 *
 * The function is deliberately dependency-free so the collision behaviour can
 * be regression-tested in Node without Three.js or a browser.
 *
 * @param {{x:number,y:number,z:number}} start
 * @param {{x:number,y:number,z:number}} end
 * @param {(x:number,y:number,z:number) => boolean} isBlockedPoint
 * @param {{spacing?:number, clearance?:number}} [options]
 * @returns {number} Safe interpolation fraction in the range 0..1.
 */
export function cameraClipFraction(
  start,
  end,
  isBlockedPoint,
  { spacing = 0.1, clearance = 0.16 } = {}
) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const distance = Math.hypot(dx, dy, dz);
  if (!(distance > 1e-6)) return 1;

  const stepSize = Math.max(0.04, Number.isFinite(spacing) ? spacing : 0.1);
  const steps = Math.max(1, Math.ceil(distance / stepSize));
  const clearanceFraction = Math.max(0, clearance) / distance;

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = start.x + dx * t;
    const y = start.y + dy * t;
    const z = start.z + dz * t;
    if (!isBlockedPoint(x, y, z)) continue;

    // The previous sample is known-clear. Pull back a little farther so the
    // near plane does not visibly cut through the face we just stopped at.
    return Math.max(0, Math.min(1, (i - 1) / steps - clearanceFraction));
  }

  return 1;
}

export default cameraClipFraction;
