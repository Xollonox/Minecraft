/**
 * Block placement.
 *
 * ## Validation
 *
 * A placement is refused when it would:
 *
 *  - be outside the world's vertical bounds;
 *  - land in a chunk that has not streamed in (which would create an edit that
 *    generation later overwrites);
 *  - intersect the player's own collision box — the single most important check,
 *    because without it a player can seal themselves inside a block and be stuck
 *    until they break out from the inside;
 *  - replace something that is not replaceable (only air, liquids and plants are);
 *  - place a support-requiring block with nothing beneath it.
 *
 * ## Repeat behaviour
 *
 * Holding place repeats on a timer rather than every frame. At 144 FPS a
 * per-frame placement would lay 144 blocks a second, which is unusable; the delay
 * also gives touch players a fighting chance, since a tap is several frames long.
 */

import { INTERACTION, WORLD_HEIGHT } from '../config/GameConfig.js';
import { Events } from '../core/EventBus.js';
import { Block } from '../world/BlockTypes.js';
import { DEFAULT_STATE, getBlock, isValidBlockId } from '../world/BlockRegistry.js';
import { itemIdForBlock } from '../items/ItemRegistry.js';
import {
  bedState,
  buttonState,
  doorState,
  gateState,
  horizontalFacingFromVector,
  horizontalFacingVector,
  oppositeHorizontalFacing,
  repeaterState,
  slabIsDouble,
  slabIsUpper,
  slabState,
  stairState,
  trapdoorState,
} from '../world/BlockState.js';

export class BlockPlacer {
  /**
   * @param {Object} options
   * @param {import('../world/World.js').World} options.world
   * @param {import('../player/Player.js').Player} options.player
   * @param {import('../core/EventBus.js').EventBus} options.bus
   * @param {import('../player/CameraController.js').CameraController|null} [options.camera]
   */
  constructor({ world, player, bus, camera = null }) {
    this._world = world;
    this._player = player;
    this._bus = bus;
    this._camera = camera;

    this._repeatTimer = 0;
    /** Set while the action is held, so the first press is immediate. */
    this._wasHeld = false;
    this._probePosition = { x: 0, y: 0, z: 0 };
  }

  /**
   * Advances placement.
   *
   * @param {number} dt
   * @param {import('./BlockRaycaster.js').RaycastHit|null} target
   * @param {boolean} held
   * @returns {number|null} The block id placed this frame, or `null`.
   */
  update(dt, target, held) {
    this._repeatTimer = Math.max(0, this._repeatTimer - dt);

    if (!held) {
      this._wasHeld = false;
      return null;
    }

    // First press acts immediately; subsequent placements wait for the timer.
    const firstPress = !this._wasHeld;
    this._wasHeld = true;
    if (!firstPress && this._repeatTimer > 0) return null;

    if (!target || !target.hit) return null;

    const blockId = this._player.inventory.selectedBlockId;
    if (!isValidBlockId(blockId) || blockId === Block.AIR) return null;

    const placed = this.tryPlace(target.placeX, target.placeY, target.placeZ, blockId, target);
    if (placed) this._repeatTimer = INTERACTION.placeRepeatSeconds;
    return placed ? blockId : null;
  }

  /**
   * Attempts a placement at explicit coordinates.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} blockId
   * @param {import('./BlockRaycaster.js').RaycastHit|null} [target]
   * @returns {boolean}
   */
  tryPlace(x, y, z, blockId, target = null) {
    const slabMerge = this._tryMergeSlab(blockId, target);
    if (slabMerge !== null) return slabMerge;

    const state = this._placementState(blockId, target, x, y, z);
    if (blockId === Block.OAK_DOOR) return this._tryPlaceDoor(x, y, z, state, target);
    if (blockId === Block.WHITE_BED) return this._tryPlaceBed(x, y, z, state, target);

    const reason = this.validate(x, y, z, blockId, state, target);
    if (reason !== null) {
      // Only surface the reasons the player can act on; "not loaded" is transient.
      if (reason === 'inside-player' || reason === 'no-support') {
        this._bus.emit(Events.NOTIFY, {
          level: 'info',
          message:
            reason === 'inside-player'
              ? 'Not enough room to place that there'
              : 'That block needs something to sit on',
          id: `place-${reason}`,
          duration: 1200,
        });
      }
      return false;
    }

    // Remember what to refund *before* consuming, because consuming can empty
    // the slot and lose the identity of what was there.
    const refundItemId = itemIdForBlock(blockId);
    if (!this._player.inventory.consumeSelected()) return false;

    const success = this._world.placeBlock(x, y, z, blockId, { state });
    if (!success) {
      // The world refused after all; hand the item back so nothing is lost.
      if (!this._player.isCreative && refundItemId) {
        this._player.inventory.addItem(refundItemId, 1);
      }
      return false;
    }

    this._emitPlaced(x, y, z, blockId);
    return true;
  }

  /** Emits the canonical placement event once a transaction has completed. */
  _emitPlaced(x, y, z, blockId) {
    this._bus.emit(Events.BLOCK_PLACED, {
      x,
      y,
      z,
      blockId,
      soundGroup: getBlock(blockId).soundGroup,
    });
  }

  /**
   * Merges two matching slabs without asking the world to replace an occupied
   * voxel. `null` means the click was not a merge attempt.
   */
  _tryMergeSlab(blockId, target) {
    if (
      (blockId !== Block.OAK_SLAB && blockId !== Block.COBBLESTONE_SLAB) ||
      !target?.hit ||
      target.blockId !== blockId
    ) return null;

    const state = target.blockState ?? this._world.getBlockState(
      target.blockX,
      target.blockY,
      target.blockZ
    );
    if (slabIsDouble(state)) return null;
    const localY = target.pointY - Math.floor(target.pointY);
    const canMerge = slabIsUpper(state)
      ? target.normalY < 0 || (target.normalY === 0 && localY < 0.5)
      : target.normalY > 0 || (target.normalY === 0 && localY > 0.5);
    if (!canMerge) return null;

    if (!this._player.inventory.consumeSelected()) return false;
    const next = slabState(false, true);
    const success = this._world.setBlockState(
      target.blockX,
      target.blockY,
      target.blockZ,
      next,
      { cause: 'slab-merge', cascade: false }
    );
    if (!success) {
      const itemId = itemIdForBlock(blockId);
      if (!this._player.isCreative && itemId) this._player.inventory.addItem(itemId, 1);
      return false;
    }
    this._emitPlaced(target.blockX, target.blockY, target.blockZ, blockId);
    return true;
  }

  /** Places both halves of a door atomically, rolling back on any failure. */
  _tryPlaceDoor(x, y, z, state, target) {
    if (y + 1 >= WORLD_HEIGHT || !this._world.isSupportive(x, y - 1, z)) return false;
    const lower = doorState(state & 0x03, {
      open: false,
      upper: false,
      hingeRight: (state & 0x20) !== 0,
    });
    const upper = doorState(state & 0x03, {
      open: false,
      upper: true,
      hingeRight: (state & 0x20) !== 0,
    });
    if (this.validate(x, y, z, Block.OAK_DOOR, lower, target) !== null) return false;
    if (this.validate(x, y + 1, z, Block.OAK_DOOR, upper, null) !== null) return false;
    if (!this._player.inventory.consumeSelected()) return false;

    const lowerPlaced = this._world.placeBlock(x, y, z, Block.OAK_DOOR, { state: lower });
    const upperPlaced = lowerPlaced && this._world.placeBlock(x, y + 1, z, Block.OAK_DOOR, {
      state: upper,
    });
    if (!upperPlaced) {
      if (lowerPlaced) this._world.setBlock(x, y, z, Block.AIR, {
        cause: 'door-rollback',
        cascade: false,
      });
      const itemId = itemIdForBlock(Block.OAK_DOOR);
      if (!this._player.isCreative && itemId) this._player.inventory.addItem(itemId, 1);
      return false;
    }
    this._emitPlaced(x, y, z, Block.OAK_DOOR);
    return true;
  }

  /** Places a two-block bed atomically in the player's look direction. */
  _tryPlaceBed(x, y, z, state, target) {
    const facing = state & 0x03;
    const direction = horizontalFacingVector(facing);
    const headX = x + direction.x;
    const headZ = z + direction.z;
    const footState = bedState(facing, { head: false, occupied: false });
    const headState = bedState(facing, { head: true, occupied: false });
    if (this.validate(x, y, z, Block.WHITE_BED, footState, target) !== null) return false;
    if (this.validate(headX, y, headZ, Block.WHITE_BED, headState, null) !== null) return false;
    if (!this._player.inventory.consumeSelected()) return false;

    const footPlaced = this._world.placeBlock(x, y, z, Block.WHITE_BED, { state: footState });
    const headPlaced = footPlaced && this._world.placeBlock(headX, y, headZ, Block.WHITE_BED, {
      state: headState,
    });
    if (!headPlaced) {
      if (footPlaced) this._world.setBlock(x, y, z, Block.AIR, {
        cause: 'bed-rollback',
        cascade: false,
      });
      const itemId = itemIdForBlock(Block.WHITE_BED);
      if (!this._player.isCreative && itemId) this._player.inventory.addItem(itemId, 1);
      return false;
    }
    this._emitPlaced(x, y, z, Block.WHITE_BED);
    return true;
  }

  /** State assigned to a player-placed block. */
  _placementState(blockId, target = null, x = 0, y = 0, z = 0) {
    const view = this._camera?.forwardFlat;
    const viewFacing = view
      ? horizontalFacingFromVector(view.x, view.z)
      : horizontalFacingFromVector(this._player.position.x - x, this._player.position.z - z);
    const localHitY = target ? target.pointY - Math.floor(target.pointY) : 0.5;
    const upper = Boolean(target && (target.normalY < 0 || (target.normalY === 0 && localHitY > 0.5)));

    if (blockId === Block.REPEATER) return repeaterState(viewFacing, 1, false);
    if (blockId === Block.OAK_FENCE_GATE) return gateState(viewFacing, { open: false });
    if (blockId === Block.OAK_DOOR) {
      // The panel faces the player. Hinge is chosen deterministically from the
      // clicked half so adjacent doors can still be mirrored manually later.
      return doorState(oppositeHorizontalFacing(viewFacing), {
        open: false,
        upper: false,
        hingeRight: Boolean(target && target.pointX - Math.floor(target.pointX) > 0.5),
      });
    }
    if (blockId === Block.WHITE_BED) return bedState(viewFacing, { head: false });
    if (blockId === Block.OAK_SLAB || blockId === Block.COBBLESTONE_SLAB) {
      return slabState(upper);
    }
    if (blockId === Block.OAK_STAIRS || blockId === Block.COBBLESTONE_STAIRS) {
      return stairState(oppositeHorizontalFacing(viewFacing), upper);
    }
    if (blockId === Block.OAK_TRAPDOOR) {
      const supportFacing = target && (target.normalX !== 0 || target.normalZ !== 0)
        ? horizontalFacingFromVector(-target.normalX, -target.normalZ)
        : oppositeHorizontalFacing(viewFacing);
      return trapdoorState(supportFacing, { upper });
    }
    if (blockId === Block.LADDER || blockId === Block.STONE_BUTTON) {
      const supportFacing = target && (target.normalX !== 0 || target.normalZ !== 0)
        ? horizontalFacingFromVector(-target.normalX, -target.normalZ)
        : oppositeHorizontalFacing(viewFacing);
      return blockId === Block.STONE_BUTTON
        ? buttonState(supportFacing, false)
        : supportFacing;
    }
    return DEFAULT_STATE[blockId] ?? 0;
  }

  /**
   * Checks whether a placement is legal.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} blockId
   * @param {number} [state]
   * @param {import('./BlockRaycaster.js').RaycastHit|null} [target]
   * @returns {string|null} A reason code, or `null` when the placement is legal.
   */
  validate(x, y, z, blockId, state = DEFAULT_STATE[blockId] ?? 0, target = null) {
    if (y < 0 || y >= WORLD_HEIGHT) return 'out-of-bounds';
    if (!this._world.isLoaded(x, z)) return 'not-loaded';

    const definition = getBlock(blockId);
    if (definition.stackSize === 0) return 'not-placeable';

    const existing = this._world.getBlock(x, y, z);
    const replaceable =
      existing === Block.AIR ||
      this._world.isLiquid(x, y, z) ||
      // Plants are trampled by placement rather than blocking it.
      (!getBlock(existing).solid && getBlock(existing).needsSupport);
    if (!replaceable) return 'occupied';

    // Collidable blocks must not be placed inside the player. Non-collidable ones
    // (torches, plants) are allowed, which is what lets you light your own feet.
    if (definition.collidable) {
      const player = this._player;
      this._probePosition.x = player.position.x;
      this._probePosition.y = player.position.y;
      this._probePosition.z = player.position.z;
      if (
        player.collision.intersectsBlock(
          this._probePosition,
          player.width,
          player.height,
          x,
          y,
          z,
          blockId,
          state
        )
      ) {
        return 'inside-player';
      }
    }

    if (blockId === Block.LADDER || blockId === Block.STONE_BUTTON) {
      if (target && target.normalY !== 0) return 'no-support';
      const support = horizontalFacingVector(state);
      if (!this._world.isSupportive(x + support.x, y, z + support.z)) return 'no-support';
    } else if (definition.needsSupport && !this._world.isSupportive(x, y - 1, z)) {
      return 'no-support';
    }

    return null;
  }

  /**
   * Pick-block: copies the targeted block into the hotbar.
   *
   * @param {import('./BlockRaycaster.js').RaycastHit|null} target
   * @returns {boolean}
   */
  pickBlock(target) {
    if (!target || !target.hit) return false;
    return this._player.inventory.pickBlock(target.blockId);
  }

  /** Clears the repeat state, e.g. when input context changes. */
  reset() {
    this._repeatTimer = 0;
    this._wasHeld = false;
  }
}

export default BlockPlacer;
