/**
 * A 27-slot chest.
 *
 * Almost all of the behaviour is `Container`; the entity's job is to own one, to
 * hand its contents over when the block breaks, and to persist. Keeping it this
 * thin is the point — the slot mechanics that could duplicate or lose items exist
 * once, in `Container`, and are shared with the furnace.
 */

import { Container } from '../../containers/Container.js';
import { Block } from '../BlockTypes.js';
import { BlockEntity, registerBlockEntity } from './BlockEntity.js';

/** Slots in a chest. Three rows of nine, matching the inventory grid. */
export const CHEST_SIZE = 27;

export class ChestBlockEntity extends BlockEntity {
  static get type() {
    return 'chest';
  }

  constructor(options) {
    super(options);
    this.container = new Container({ size: CHEST_SIZE, title: 'Chest' });
  }

  /** Chests have no timers. */
  get needsTick() {
    return false;
  }

  /**
   * Everything inside, so breaking a chest never destroys its contents.
   * @returns {import('../../items/ItemStack.js').ItemStack[]}
   */
  collectDrops() {
    return this.container.drainAll();
  }

  toJSON() {
    return { items: this.container.toJSON() };
  }

  fromJSON(data) {
    this.container.fromJSON(data?.items ?? null);
  }
}

registerBlockEntity(ChestBlockEntity, [Block.CHEST]);

export default ChestBlockEntity;
