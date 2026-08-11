/**
 * Classifies which liquid intersects the player's feet, torso and head.
 *
 * Kept independent of Three.js so water/lava survival rules can be tested in
 * Node. Water switches to swimming only once the torso is submerged (or the
 * player is falling through the surface); lava damages on any overlap.
 */

import { Block } from '../world/BlockTypes.js';

function isLiquidBlock(blockId) {
  return blockId === Block.WATER || blockId === Block.LAVA;
}

export function classifyLiquidContact(
  feetBlock,
  midBlock,
  headBlock,
  verticalVelocity = 0
) {
  const feetLiquid = isLiquidBlock(feetBlock);
  const midLiquid = isLiquidBlock(midBlock);
  const movingThroughFeet = feetLiquid && verticalVelocity < -0.5;

  const inWater = midBlock === Block.WATER || (feetBlock === Block.WATER && movingThroughFeet);
  const inLava = feetBlock === Block.LAVA || midBlock === Block.LAVA || headBlock === Block.LAVA;
  return Object.freeze({
    feetLiquid,
    midLiquid,
    inWater,
    inLava,
    inLiquid: inWater || inLava || midLiquid || movingThroughFeet,
    headInWater: headBlock === Block.WATER,
    headInLava: headBlock === Block.LAVA,
  });
}

export default classifyLiquidContact;
