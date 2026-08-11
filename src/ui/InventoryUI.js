/**
 * Creative block palette powered by BlockSelectionPalette.
 */

import { BlockSelectionPalette } from './BlockSelectionPalette.js';

export class InventoryUI {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.root
   * @param {import('../rendering/TextureAtlas.js').TextureAtlas} options.atlas
   * @param {(blockId: number, targetSlot?: number) => void} options.onPick
   * @param {() => void} options.onClose
   */
  constructor({ root, atlas, onPick, onClose }) {
    this.palette = new BlockSelectionPalette({
      root,
      atlas,
      onPick,
      onClose,
    });
    this.element = this.palette.element;
  }

  get visible() {
    return this.palette.visible;
  }

  show() {
    this.palette.show();
  }

  hide() {
    this.palette.hide();
  }

  updateHotbar(hotbarArray, selectedSlot) {
    this.palette.updateHotbar(hotbarArray, selectedSlot);
  }

  destroy() {
    this.palette.destroy();
  }
}

export default InventoryUI;
