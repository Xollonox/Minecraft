/**
 * Block Selection Palette UI component.
 *
 * Provides a dedicated, interactive material selection panel for switching
 * between voxel block types (Wood, Stone, Glass, Bricks, Ores, Nature, etc.).
 *
 * Features:
 * - Material Category Tabs (Wood, Stone, Glass, Ores, Earth, Utility, Vegetation)
 * - Live Search Bar with instant filtering and clear action
 * - Hotbar Target Slot Selector (1-9) with live hotbar contents preview
 * - Detailed Block Inspector (Hardness, Tool requirements, Sound, Light rating)
 * - Keyboard navigation (1-9 slot selection, Esc/E to close)
 */

import { BLOCK_DEFINITIONS, Block } from '../world/BlockTypes.js';
import { getBlock, getBlockName } from '../world/BlockRegistry.js';
import { el, setVisible, button } from './dom.js';

/**
 * Categorized material types.
 */
export const MATERIAL_CATEGORIES = Object.freeze([
  { id: 'all', label: 'All', icon: '🧱' },
  {
    id: 'wood',
    label: 'Wood & Timber',
    icon: '🪵',
    ids: [
      Block.OAK_LOG,
      Block.PLANKS,
      Block.SPRUCE_LOG,
      Block.BIRCH_LOG,
      Block.OAK_LEAVES,
      Block.SPRUCE_LEAVES,
      Block.BIRCH_LEAVES,
      Block.OAK_SAPLING,
    ],
  },
  {
    id: 'stone',
    label: 'Stone & Masonry',
    icon: '🪨',
    ids: [
      Block.STONE,
      Block.COBBLESTONE,
      Block.MOSSY_COBBLESTONE,
      Block.SANDSTONE,
      Block.BRICKS,
    ],
  },
  {
    id: 'glass',
    label: 'Glass & Crystals',
    icon: '🪟',
    ids: [Block.GLASS, Block.ICE, Block.GLOWSTONE],
  },
  {
    id: 'ores',
    label: 'Ores & Minerals',
    icon: '⛏️',
    ids: [
      Block.COAL_ORE,
      Block.IRON_ORE,
      Block.GOLD_ORE,
      Block.DIAMOND_ORE,
    ],
  },
  {
    id: 'earth',
    label: 'Earth & Nature',
    icon: '🌿',
    ids: [
      Block.GRASS,
      Block.DIRT,
      Block.SAND,
      Block.RED_SAND,
      Block.GRAVEL,
      Block.CLAY,
      Block.SNOW_BLOCK,
      Block.SNOWY_GRASS,
      Block.BEDROCK,
    ],
  },
  {
    id: 'utility',
    label: 'Built & Workstations',
    icon: '🛠️',
    ids: [
      Block.CRAFTING_TABLE,
      Block.FURNACE,
      Block.CHEST,
      Block.TORCH,
      Block.FARMLAND,
      Block.WHITE_WOOL,
    ],
  },
  {
    id: 'vegetation',
    label: 'Vegetation',
    icon: '🌻',
    ids: [
      Block.TALL_GRASS,
      Block.FERN,
      Block.FLOWER_RED,
      Block.FLOWER_YELLOW,
      Block.DEAD_BUSH,
      Block.CACTUS,
    ],
  },
]);

/** Tool icon indicators */
const TOOL_ICONS = {
  pickaxe: '⛏️ Pickaxe',
  axe: '🪓 Axe',
  shovel: '🧹 Shovel',
  hand: '✋ Hand',
  none: '✋ Hand',
};

export class BlockSelectionPalette {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.root
   * @param {import('../rendering/TextureAtlas.js').TextureAtlas} options.atlas
   * @param {(blockId: number, targetSlot?: number) => void} options.onPick
   * @param {() => void} options.onClose
   */
  constructor({ root, atlas, onPick, onClose }) {
    this._atlas = atlas;
    this._onPick = onPick;
    this._onClose = onClose;

    this._activeCategory = 'all';
    this._searchQuery = '';
    this._targetSlot = 0; // 0..8
    this._focusedBlockId = Block.STONE;
    this._hotbarContents = new Array(9).fill(null);

    this._visible = false;

    // Filter valid placeable blocks
    this._allBlocks = BLOCK_DEFINITIONS.filter(
      (b) => b.id !== Block.AIR && b.stackSize > 0 && b.id !== Block.WATER
    );

    this._buildUI(root);
  }

  _buildUI(root) {
    // Search input element
    this._searchInput = el('input', {
      className: 'block-palette-search-input',
      attrs: {
        type: 'text',
        placeholder: 'Search materials (e.g. wood, stone, glass)...',
        'aria-label': 'Search blocks',
      },
      on: {
        input: (e) => {
          this._searchQuery = e.target.value.trim().toLowerCase();
          clearTimeout(this._searchDebounce);
          this._searchDebounce = setTimeout(() => this._updateGrid(), 120);
        },
        keydown: (e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            this._onClose();
          }
        },
      },
    });

    this._clearSearchBtn = el('button', {
      className: 'block-palette-search-clear',
      text: '✕',
      attrs: { type: 'button', 'aria-label': 'Clear search', title: 'Clear search' },
      on: {
        click: () => {
          this._searchInput.value = '';
          this._searchQuery = '';
          this._updateGrid();
          this._searchInput.focus();
        },
      },
    });

    this._countBadge = el('span', { className: 'block-palette-count-badge', text: '' });

    const searchBar = el('div', { className: 'block-palette-search-bar' }, [
      el('span', { className: 'block-palette-search-icon', text: '🔍' }),
      this._searchInput,
      this._clearSearchBtn,
      this._countBadge,
    ]);

    // Category Tabs
    this._categoryTabsContainer = el('div', { className: 'block-palette-categories' }, []);

    // Target Hotbar Selector
    this._hotbarSelectorContainer = el('div', { className: 'block-palette-target-bar' }, []);

    // Main Grid & Inspector Container
    this._gridElement = el('div', { className: 'block-palette-grid' });
    this._inspectorElement = el('div', { className: 'block-palette-inspector' });

    const contentLayout = el('div', { className: 'block-palette-content-layout' }, [
      el('div', { className: 'block-palette-grid-wrapper' }, [this._gridElement]),
      this._inspectorElement,
    ]);

    // Dialog structure
    this.element = el(
      'div',
      {
        className: 'screen screen--dim block-palette-screen',
        hidden: true,
        attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Block Selection Palette' },
      },
      [
        el('div', { className: 'panel dialog dialog--wide block-palette-panel' }, [
          el('div', { className: 'block-palette-header' }, [
            el('div', { className: 'block-palette-title-group' }, [
              el('h2', { className: 'dialog-title', text: 'Block Selection Palette' }),
              el('p', {
                className: 'block-palette-subtitle',
                text: 'Select a voxel material to switch your held building block.',
              }),
            ]),
            button('✕', () => this._onClose(), {
              className: 'block-palette-close-btn',
              attrs: { 'aria-label': 'Close palette' },
            }),
          ]),
          searchBar,
          this._categoryTabsContainer,
          this._hotbarSelectorContainer,
          contentLayout,
          el('div', { className: 'dialog-actions block-palette-actions' }, [
            el('div', {
              className: 'inventory-hint',
              text: 'Click a block to pick it. Use 1–9 keys to change hotbar target slot. Press Esc or E to exit.',
            }),
            button('Done', () => this._onClose(), { className: 'ui-button--primary' }),
          ]),
        ]),
      ]
    );

    root.appendChild(this.element);

    this._renderCategoryTabs();
    this._renderHotbarSelector();
    this._updateGrid();
    this._updateInspector();
  }

  /** Render Category Filter Pills */
  _renderCategoryTabs() {
    this._categoryTabsContainer.replaceChildren();

    MATERIAL_CATEGORIES.forEach((cat) => {
      const isSelected = cat.id === this._activeCategory;
      const count = this._getBlocksForCategory(cat.id).length;

      const tabBtn = el(
        'button',
        {
          className: `block-palette-tab ${isSelected ? 'is-active' : ''}`,
          attrs: { type: 'button', 'aria-selected': isSelected ? 'true' : 'false' },
          on: {
            click: () => {
              this._activeCategory = cat.id;
              this._renderCategoryTabs();
              this._updateGrid();
            },
          },
        },
        [
          el('span', { className: 'tab-icon', text: cat.icon }),
          el('span', { className: 'tab-label', text: cat.label }),
          el('span', { className: 'tab-count', text: String(count) }),
        ]
      );

      this._categoryTabsContainer.appendChild(tabBtn);
    });
  }

  /** Render Target Hotbar Selector Row */
  _renderHotbarSelector() {
    this._hotbarSelectorContainer.replaceChildren();

    const label = el('span', {
      className: 'target-bar-label',
      text: 'Assign To Slot:',
    });

    const slotButtons = [];
    for (let slot = 0; slot < 9; slot++) {
      const isTarget = slot === this._targetSlot;
      const stack = this._hotbarContents[slot];
      const iconUrl = stack && !stack.isEmpty ? this._atlas.getItemIcon(stack.itemId, 32) : null;

      const iconImg = el('img', {
        className: 'target-slot-icon',
        alt: '',
        src: iconUrl || '',
      });
      iconImg.hidden = !iconUrl;

      const slotBtn = el(
        'button',
        {
          className: `target-slot-btn ${isTarget ? 'is-target' : ''}`,
          attrs: {
            type: 'button',
            'aria-label': `Hotbar Target Slot ${slot + 1}`,
            title: `Hotbar Slot ${slot + 1} ${stack ? `: ${stack.displayName}` : '(empty)'}`,
          },
          on: {
            click: () => {
              this._targetSlot = slot;
              this._renderHotbarSelector();
            },
          },
        },
        [
          el('span', { className: 'target-slot-num', text: String(slot + 1) }),
          iconImg,
        ]
      );

      slotButtons.push(slotBtn);
    }

    const slotGroup = el('div', { className: 'target-slot-group' }, slotButtons);
    this._hotbarSelectorContainer.appendChild(label);
    this._hotbarSelectorContainer.appendChild(slotGroup);
  }

  /** Get blocks belonging to a category */
  _getBlocksForCategory(catId) {
    if (catId === 'all') return this._allBlocks;
    const cat = MATERIAL_CATEGORIES.find((c) => c.id === catId);
    if (!cat || !cat.ids) return [];
    return this._allBlocks.filter((b) => cat.ids.includes(b.id));
  }

  /** Update displayed block grid according to filter & search */
  _updateGrid() {
    this._gridElement.replaceChildren();

    let blocks = this._getBlocksForCategory(this._activeCategory);

    if (this._searchQuery) {
      blocks = blocks.filter((b) => {
        const name = (b.displayName || b.name).toLowerCase();
        const tool = (b.preferredTool || '').toLowerCase();
        const sound = (b.soundGroup || '').toLowerCase();
        return (
          name.includes(this._searchQuery) ||
          tool.includes(this._searchQuery) ||
          sound.includes(this._searchQuery)
        );
      });
    }

    this._countBadge.textContent = `${blocks.length} materials`;

    if (blocks.length === 0) {
      const emptyState = el('div', { className: 'block-palette-empty' }, [
        el('div', { className: 'empty-icon', text: '🔍' }),
        el('div', { className: 'empty-text', text: 'No matching materials found.' }),
        button('Reset Filter', () => {
          this._searchQuery = '';
          this._searchInput.value = '';
          this._activeCategory = 'all';
          this._renderCategoryTabs();
          this._updateGrid();
        }, { className: 'ui-button--small' }),
      ]);
      this._gridElement.appendChild(emptyState);
      return;
    }

    blocks.forEach((blockDef) => {
      const isFocused = blockDef.id === this._focusedBlockId;
      const iconUrl = this._atlas.getBlockIcon(blockDef.id, 64);

      const iconImg = el('img', {
        className: 'block-card-icon',
        src: iconUrl,
        alt: blockDef.displayName,
        attrs: { draggable: 'false' },
      });

      const card = el(
        'button',
        {
          className: `block-card ${isFocused ? 'is-focused' : ''}`,
          attrs: {
            type: 'button',
            'aria-label': blockDef.displayName,
            title: `${blockDef.displayName} (${getCategoryLabel(blockDef.id)})`,
          },
          on: {
            mouseenter: () => {
              this._focusedBlockId = blockDef.id;
              this._updateInspector();
              this._highlightCard(blockDef.id);
            },
            focus: () => {
              this._focusedBlockId = blockDef.id;
              this._updateInspector();
              this._highlightCard(blockDef.id);
            },
            click: (e) => {
              e.preventDefault();
              this._onPick(blockDef.id, this._targetSlot);
            },
          },
        },
        [
          iconImg,
          el('span', { className: 'block-card-name', text: blockDef.displayName }),
          el('span', {
            className: 'block-card-category-tag',
            text: getCategoryLabel(blockDef.id),
          }),
        ]
      );

      this._gridElement.appendChild(card);
    });
  }

  _highlightCard(blockId) {
    const cards = this._gridElement.querySelectorAll('.block-card');
    cards.forEach((card) => {
      card.classList.toggle('is-focused', card.getAttribute('aria-label') === getBlockName(blockId));
    });
  }

  /** Update sidebar inspector for focused block */
  _updateInspector() {
    this._inspectorElement.replaceChildren();

    const blockDef = getBlock(this._focusedBlockId) || getBlock(Block.STONE);
    if (!blockDef) return;

    const iconUrl = this._atlas.getBlockIcon(blockDef.id, 96);
    const categoryName = getCategoryLabel(blockDef.id);
    const toolName = TOOL_ICONS[blockDef.preferredTool] || TOOL_ICONS.none;

    const previewSection = el('div', { className: 'inspector-preview' }, [
      el('img', { className: 'inspector-icon', src: iconUrl, alt: blockDef.displayName }),
      el('h3', { className: 'inspector-title', text: blockDef.displayName }),
      el('span', { className: 'inspector-category-badge', text: categoryName }),
    ]);

    const statsSection = el('div', { className: 'inspector-stats' }, [
      this._buildStatRow('Tool Required', toolName),
      this._buildStatRow('Hardness', `${blockDef.hardness.toFixed(1)}`),
      this._buildStatRow('Sound Material', capitalize(blockDef.soundGroup)),
      blockDef.lightLevel > 0
        ? this._buildStatRow('Light Output', `✨ Level ${blockDef.lightLevel}`)
        : null,
      blockDef.transparent
        ? this._buildStatRow('Transparency', capitalize(blockDef.renderLayer))
        : null,
      blockDef.gravityAffected
        ? this._buildStatRow('Physics', '⚠️ Gravity Affected')
        : null,
    ].filter(Boolean));

    const assignBtn = button(
      `Pick Material (Slot ${this._targetSlot + 1})`,
      () => this._onPick(blockDef.id, this._targetSlot),
      { className: 'ui-button--primary inspector-pick-btn' }
    );

    this._inspectorElement.appendChild(previewSection);
    this._inspectorElement.appendChild(statsSection);
    this._inspectorElement.appendChild(assignBtn);
  }

  _buildStatRow(label, val) {
    return el('div', { className: 'inspector-stat-row' }, [
      el('span', { className: 'stat-label', text: label }),
      el('span', { className: 'stat-value', text: val }),
    ]);
  }

  /** Sync hotbar state to update target slot previews */
  updateHotbar(hotbarArray, currentSelectedSlot) {
    if (Array.isArray(hotbarArray)) {
      this._hotbarContents = hotbarArray;
    }
    if (typeof currentSelectedSlot === 'number') {
      this._targetSlot = currentSelectedSlot;
    }
    this._renderHotbarSelector();
  }

  /** Set current active target slot */
  setTargetSlot(slot) {
    this._targetSlot = Math.max(0, Math.min(8, slot));
    this._renderHotbarSelector();
  }

  get visible() {
    return this._visible;
  }

  show() {
    setVisible(this.element, true);
    this._visible = true;
    this._renderHotbarSelector();
    this._updateGrid();
    this._updateInspector();
    setTimeout(() => {
      this._searchInput.focus();
    }, 50);
  }

  hide() {
    setVisible(this.element, false);
    this._visible = false;
  }

  destroy() {
    this.element.remove();
  }
}

/** Helper: find category label for a block */
function getCategoryLabel(blockId) {
  for (const cat of MATERIAL_CATEGORIES) {
    if (cat.ids && cat.ids.includes(blockId)) {
      return cat.label.split('&')[0].trim();
    }
  }
  return 'Material';
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export default BlockSelectionPalette;
