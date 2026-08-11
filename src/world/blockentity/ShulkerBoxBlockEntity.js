/** Persistent 27-slot storage for the portable End-game shulker box block. */
import { Container } from '../../containers/Container.js';
import { Block } from '../BlockTypes.js';
import { BlockEntity, registerBlockEntity } from './BlockEntity.js';

export class ShulkerBoxBlockEntity extends BlockEntity {
  static get type() { return 'shulker_box'; }

  constructor(options) {
    super(options);
    this.container = new Container({ size:27, title:'Shulker Box' });
  }

  collectDrops() { return this.container.drainAll(); }
  toJSON() { return { items:this.container.toJSON() }; }
  fromJSON(data) { this.container.fromJSON(data?.items ?? null); }
}

registerBlockEntity(ShulkerBoxBlockEntity, [Block.SHULKER_BOX]);
export default ShulkerBoxBlockEntity;
