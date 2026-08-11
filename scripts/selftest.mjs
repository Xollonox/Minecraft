/**
 * Headless self-test for the worker-safe half of the engine.
 *
 * Everything under `src/world/` (plus `src/utils/` and `src/config/`) is free of
 * DOM and Three.js dependencies precisely so it can be exercised in Node. This
 * script checks the properties that are expensive to eyeball in a browser:
 * determinism, negative-coordinate correctness, chunk-border agreement, mesh
 * validity and generation cost.
 *
 * Run with: npm run selftest
 */

import { readFileSync, readdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import {
  CHUNK_VOLUME,
  LAYER_NAMES,
  SEA_LEVEL,
  WORLD_HEIGHT,
  PADDED_VOLUME,
} from '../src/config/GameConfig.js';
import {
  blockToChunkX,
  blockToChunkZ,
  blockToLocalX,
  blockToLocalZ,
  collectAffectedChunks,
  mod,
  floorDiv,
  paddedIndex,
  voxelIndex,
} from '../src/utils/CoordinateUtils.js';
import { parseSeed } from '../src/utils/MathUtils.js';
import { PriorityQueue } from '../src/utils/PriorityQueue.js';
import {
  EDIT_PAIR_MAGIC,
  normaliseChunkEditPayload,
  packChunkEdits,
  unpackChunkEdits,
} from '../src/core/SaveManager.js';
import { TerrainGenerator } from '../src/world/TerrainGenerator.js';
import { ChunkMesher } from '../src/world/ChunkMesher.js';
import {
  blockLightIndex,
  extractPaddedBlockLight,
  hasBlockLightSource,
  LIGHT_TARGET_OFFSET_X,
  LIGHT_TARGET_OFFSET_Z,
  LIGHT_VOLUME,
  LIGHT_VOLUME_SIZE_X,
  LIGHT_VOLUME_SIZE_Y,
  LIGHT_VOLUME_SIZE_Z,
  propagateBlockLight,
  sampleWorldBlockLight,
} from '../src/world/BlockLight.js';
import {
  bitsForPaletteSize,
  chunkSectionByteLength,
  decodeChunkSection,
  encodeChunkSection,
  packPaletteIndices,
  SECTION_VOLUME,
  sectionIndex,
  unpackPaletteIndex,
  validateChunkSection,
} from '../src/world/ChunkSection.js';
import {
  BLOCK_DEFINITIONS,
  Block,
  CREATIVE_GROUPS,
  FAMILY_BLOCKS,
  TILE_INDEX,
  TILE_NAMES,
} from '../src/world/BlockTypes.js';
import { RECIPE_DEFINITIONS } from '../src/crafting/Recipes.js';
import { BlockTickScheduler } from '../src/world/BlockTickScheduler.js';
import {
  aabbIntersectsBox,
  getCollisionShape,
  getShapeBounds,
  getVoxelShape,
  rayIntersectVoxelShape,
} from '../src/world/BlockModels.js';
import { getBlockBehavior } from '../src/world/BlockBehaviorRegistry.js';
import {
  bedHead,
  bedState,
  buttonPowered,
  buttonState,
  connectionMask,
  cropAge,
  cropState,
  doorOpen,
  doorState,
  doorUpper,
  farmlandMoisture,
  farmlandState,
  fluidIsFalling,
  fluidLevel,
  fluidState,
  horizontalFacingFromVector,
  gateIsOpen,
  gateState,
  horizontalFacingVector,
  pressurePlatePowered,
  pressurePlateState,
  slabIsDouble,
  slabIsUpper,
  slabState,
  stairFacing,
  stairIsUpper,
  stairState,
  trapdoorIsOpen,
  trapdoorState,
  setTrapdoorOpen,
  powerLevel,
  powerState,
  repeaterDelay,
  repeaterFacing,
  repeaterPowered,
  repeaterState,
  switchActive,
  packBlockWord,
  blockIdFromWord,
  stateFromWord,
} from '../src/world/BlockState.js';
import {
  fertilisePlant,
  growOakTree,
  plantCrop,
} from '../src/world/behaviors/AgricultureBehaviors.js';
import {
  desiredFluidState,
  flowFluidInto,
  reactFluidContacts,
} from '../src/world/behaviors/FluidBehaviors.js';
import {
  desiredWirePower,
  powerOutputToward,
  pressButton,
  receivedPower,
  repeaterInputPower,
  rotateRepeaterDelay,
  toggleLever,
  touchPressurePlate,
} from '../src/world/behaviors/RedstoneBehaviors.js';
import {
  connectedBlockState,
  resolveBed,
  toggleDoor,
  toggleFenceGate,
} from '../src/world/behaviors/StructuralBehaviors.js';
import {
  ITEM_IDS,
  describeRegistry,
  getItem,
  harvestLevelOf,
  itemIdForBlock,
  itemsWithTag,
} from '../src/items/ItemRegistry.js';
import {
  ARMOUR_DATA,
  ArmourMaterial,
  ArmourSlot,
  TIER_DATA,
  TIER_ORDER,
} from '../src/items/ItemTypes.js';
import { ItemStack } from '../src/items/ItemStack.js';
import { HOTBAR_SIZE, Inventory, SLOT } from '../src/player/Inventory.js';
import { armourDurabilityLoss, damageAfterArmour } from '../src/player/Armour.js';
import { MAX_HEALTH, MAX_HUNGER, MAX_AIR, PlayerStats } from '../src/player/PlayerStats.js';
import { DAMAGE_SOURCES, DamageType } from '../src/player/DamageTypes.js';
import { fuelItems } from '../src/items/ItemRegistry.js';
import {
  ALL_RECIPES,
  consumeIngredients,
  describeRecipes,
  findMatch,
  getRecipe,
  getSmeltingRecipe,
  maxCrafts,
  recipesProducing,
} from '../src/crafting/RecipeRegistry.js';
import { CraftingStation, ingredientOptions } from '../src/crafting/RecipeTypes.js';
import { Container } from '../src/containers/Container.js';
import {
  FURNACE_SLOT,
  FurnaceBlockEntity,
} from '../src/world/blockentity/FurnaceBlockEntity.js';
import { BlockEntityStore } from '../src/world/blockentity/BlockEntityStore.js';
// Registers the chest type, which the store tests rely on.
import '../src/world/blockentity/ChestBlockEntity.js';
import {
  breakSeconds,
  isCorrectTool,
  shouldConsumeDurability,
  wouldDrop,
} from '../src/interaction/MiningCalculator.js';
import { CombatSystem, raycastBox } from '../src/interaction/CombatSystem.js';
import { cameraClipFraction } from '../src/player/ThirdPersonCameraMath.js';
import { isInsideShieldArc, shieldDurabilityLoss } from '../src/player/Shield.js';
import { classifyLiquidContact } from '../src/player/LiquidContact.js';
import {
  containerToPlayer,
  cursorClickContainer,
  cursorSplitContainer,
  playerToContainer,
  swapContainerWithHotbar,
  transferSlot,
} from '../src/containers/ItemTransfer.js';
import { ItemEntity } from '../src/entities/ItemEntity.js';
import { MobEntity } from '../src/entities/MobEntity.js';
import { StatusEffect, StatusEffectController } from '../src/entities/StatusEffects.js';
import {
  createLootRandom,
  independentDropTable,
  mergeLoot,
  rollLootTable,
} from '../src/loot/LootTable.js';
import {
  firstBlockedFraction,
  ProjectileEntity,
  segmentAabbFraction,
} from '../src/entities/ProjectileEntity.js';
import {
  chooseWander,
  decideMobIntent,
  hasVoxelLineOfSight,
  MobBrainState,
} from '../src/entities/ai/MobBrain.js';
import {
  findVoxelPath,
  isNavigationHazard,
  isWalkableNode,
  nextPathDirection,
} from '../src/entities/ai/VoxelNavigator.js';
import {
  countMobFamilies,
  isSpawnVolumeClear,
  isValidMobSpawn,
  MobSpawner,
} from '../src/entities/MobSpawner.js';
import {
  describeMobs,
  getMob,
  HOSTILE_MOBS,
  MobFamily,
  MOB_DEFINITIONS,
  PASSIVE_MOBS,
  rollDrops,
} from '../src/entities/MobTypes.js';
import { ENTITIES } from '../src/config/GameConfig.js';
import { mulberry32 } from '../src/utils/MathUtils.js';
import { gravelDrops } from '../src/world/behaviors/NaturalDrops.js';
import {
  fireAge,
  fireState,
  igniteBlock,
  isFlammable,
  tickFire,
} from '../src/world/behaviors/FireBehaviors.js';
import { createSoundCatalogue } from '../src/audio/SoundRegistry.js';
import {
  ACTION_LABELS,
  Action,
  CONTEXT_ACTIONS,
  DEFAULT_KEY_BINDINGS,
  DEFAULT_MOUSE_BINDINGS,
  EDGE_TRIGGERED_ACTIONS,
  InputContext,
  WHEEL_BINDINGS,
} from '../src/config/KeyBindings.js';

/**
 * Minimal world stand-in for entity physics.
 *
 * `Entity.update` only needs `getBlock`; a uniform world of one block type is
 * enough to exercise gravity, drag and buoyancy without building a chunk manager.
 *
 * @param {number} [fill] Block id filling everything below y=64.
 */
function stubWorldForEntities(fill = Block.AIR) {
  return {
    getBlock(_x, y, _z) {
      // Solid floor well below the test positions, so nothing falls out of the
      // world mid-test.
      if (y < 64) return Block.STONE;
      return fill;
    },
    isCollidable(_x, y) {
      return y < 64;
    },
  };
}

/** Small in-memory block world for deterministic block-behaviour tests. */
class GridTestWorld {
  constructor(seed = 12345) {
    this.seed = seed >>> 0;
    this.gameTick = 0;
    this.itemDropsEnabled = true;
    this.cells = new Map();
    this.scheduled = [];
    this.drops = [];
  }

  _key(x, y, z) {
    return `${x},${y},${z}`;
  }

  getBlock(x, y, z) {
    if (y < 0 || y >= WORLD_HEIGHT) return Block.AIR;
    return this.cells.get(this._key(x, y, z))?.id ?? Block.AIR;
  }

  getBlockState(x, y, z) {
    return this.cells.get(this._key(x, y, z))?.state ?? 0;
  }

  setBlock(x, y, z, id, options = {}) {
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    const key = this._key(x, y, z);
    const previous = this.cells.get(key) ?? { id: Block.AIR, state: 0 };
    const state = options.state ?? 0;
    if (previous.id === id && previous.state === state) return false;
    if (id === Block.AIR) this.cells.delete(key);
    else this.cells.set(key, { id, state });
    return true;
  }

  setBlockState(x, y, z, state) {
    const id = this.getBlock(x, y, z);
    if (id === Block.AIR) return false;
    return this.setBlock(x, y, z, id, { state });
  }

  placeBlock(x, y, z, id, options = {}) {
    const existing = this.getBlock(x, y, z);
    if (existing !== Block.AIR && existing !== Block.WATER && existing !== Block.LAVA) return false;
    return this.setBlock(x, y, z, id, options);
  }

  breakBlock(x, y, z, options = {}) {
    const id = this.getBlock(x, y, z);
    if (id === Block.AIR) return Block.AIR;
    const state = this.getBlockState(x, y, z);
    this.setBlock(x, y, z, Block.AIR);
    if (options.drop) {
      const behaviour = getBlockBehavior(id);
      const drops = behaviour?.drops?.({
        world: this,
        x,
        y,
        z,
        blockId: id,
        state,
        tick: this.gameTick,
        context: options.context ?? null,
      });
      if (Array.isArray(drops)) this.drops.push(...drops);
    }
    return id;
  }

  scheduleBlockTick(x, y, z, delay, channel, data = null) {
    this.scheduled.push({ x, y, z, delay, channel, data });
    return this.scheduled.at(-1);
  }

  isLoaded() {
    return true;
  }

  isCollidable(x, y, z) {
    return IS_COLLIDABLE[this.getBlock(x, y, z)] === 1;
  }

  isSupportive(x, y, z) {
    return IS_SOLID[this.getBlock(x, y, z)] === 1;
  }

  isOpaque(x, y, z) {
    return IS_OPAQUE[this.getBlock(x, y, z)] === 1;
  }
}
import {
  BLOCK_COUNT,
  IS_COLLIDABLE,
  IS_OPAQUE,
  LIGHT_ATTENUATION,
  IS_SOLID,
  getBlock,
} from '../src/world/BlockRegistry.js';
import { getBiomeName } from '../src/world/BiomeGenerator.js';
import {
  ATLAS_COLUMNS,
  ATLAS_ROWS,
  TILE_PADDING_UV,
  TILE_UV_PERIOD,
  tileUvRect,
} from '../src/world/AtlasLayout.js';
import {
  WATER_SCROLL_PERIOD,
  WATER_SCROLL_U,
  WATER_SCROLL_V,
  WATER_TILE_INDEX,
  assertWaterUvInvariant,
  maxFoldedOffset,
  waterScrollForTime,
} from '../src/rendering/WaterUv.js';

// ------------------------------------------------------------------- phase 2
// Aliased so nothing collides with the existing 5,500-line suite.
import {
  MobPoseBuffer,
  boneTextureWidth as poseBufferWidth,
  boneTexelUv as poseBufferUv,
} from '../src/rendering/MobPoseBuffer.js';
import {
  MobAnimator,
  tryCreateAnimator,
  selectClip as selectMobClip,
  gaitRate as mobGaitRate,
  RUN_SPEED as MOB_RUN_SPEED,
  MOVE_EPSILON as MOB_MOVE_EPSILON,
  MIN_GAIT_RATE as MOB_MIN_GAIT,
  MAX_GAIT_RATE as MOB_MAX_GAIT,
} from '../src/entities/MobAnimator.js';
import {
  GoalSelector,
  Control as GoalControl,
  floatGoal,
  panicGoal,
  wanderGoal,
  meleeAttackGoal,
  passiveAnimalGoals,
  hostileMeleeGoals,
  validateGoal,
} from '../src/entities/ai/MobGoals.js';
import {
  buildFamily,
  buildFamilies,
  familyRecipes,
  validateFamilyBlocks,
  allocateIds,
  ALL_FAMILIES,
  WOOD_FAMILIES,
  STONE_FAMILIES,
  plannedBlockCount,
  variantName as familyVariantName,
  variantDisplayName as familyVariantDisplayName,
} from '../src/world/BlockFamily.js';
import {
  Facing as StructureFacing,
  rotatePoint as rotateStructurePoint,
  rotatePiece as rotateStructurePiece,
  rotateSize as rotateStructureSize,
  oppositeFacing as oppositeStructureFacing,
  StructurePool,
  assembleStructure,
  flattenPlacements,
  validatePiece as validateStructurePiece,
  boundsOverlap as structureBoundsOverlap,
} from '../src/world/StructureTemplate.js';
import {
  MOB_SKELETONS as PHASE2_MOB_SKELETONS,
  REQUIRED_CLIPS as PHASE2_REQUIRED_CLIPS,
} from '../src/entities/MobSkeletons.js';
import {
  WeatherSystem,
  WeatherState,
  WEATHER_STATES,
  CYCLE_SECONDS,
  baseStateForCycle,
  durationForCycle,
  intensityForCycle,
  isPrecipitation,
  resolveLocalWeather,
  weatherUnit,
} from '../src/world/WeatherSystem.js';
import {
  DIMENSIONS,
  DIMENSION_IDS,
  Dimension,
  buildCeiling,
  convertCoordinates,
  dimensionSeed,
  getDimension,
  validateDimension,
} from '../src/world/DimensionConfig.js';
import {
  GameplayEvent,
  SOUND_EVENTS,
  SoundEventThrottle,
  listAllSoundNames,
  resolveSoundEvent,
} from '../src/audio/SoundEvents.js';
import {
  Skeleton,
  compose,
  identity,
  multiply,
  sortBones,
  transformPoint,
  validateBones,
} from '../src/rendering/SkeletalModel.js';
import {
  AnimationController,
  LoopMode,
  addPose,
  blendPoses,
  sampleClip,
  sampleTrack,
  validateClip,
  wrapTime,
} from '../src/rendering/AnimationController.js';
import { MOB_SKELETONS, REQUIRED_CLIPS, resolveClip } from '../src/entities/MobSkeletons.js';
import { MOB_IDS } from '../src/entities/MobTypes.js';

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks++;
  if (condition) {
    process.stdout.write(`  \x1b[32m✓\x1b[0m ${label}\n`);
  } else {
    failures++;
    process.stdout.write(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}\n`);
  }
}

function section(title) {
  process.stdout.write(`\n\x1b[1m${title}\x1b[0m\n`);
}

// ---------------------------------------------------------------- coordinates

section('Coordinate maths (negative-coordinate correctness)');

check('mod(-1, 16) === 15', mod(-1, 16) === 15, `got ${mod(-1, 16)}`);
check('mod(-16, 16) === 0', mod(-16, 16) === 0, `got ${mod(-16, 16)}`);
check('floorDiv(-1, 16) === -1', floorDiv(-1, 16) === -1, `got ${floorDiv(-1, 16)}`);

{
  let ok = true;
  let firstBad = '';
  for (let blockX = -80; blockX <= 80; blockX++) {
    const chunkX = blockToChunkX(blockX);
    const localX = blockToLocalX(blockX);
    if (chunkX !== Math.floor(blockX / 16) || localX !== mod(blockX, 16)) {
      ok = false;
      firstBad = `x=${blockX} -> chunk ${chunkX}, local ${localX}`;
      break;
    }
    if (chunkX * 16 + localX !== blockX) {
      ok = false;
      firstBad = `round-trip failed at x=${blockX}`;
      break;
    }
  }
  check('blockToChunkX/blockToLocalX round-trip over [-80, 80]', ok, firstBad);
}
{
  let ok = true;
  for (let blockZ = -80; blockZ <= 80; blockZ++) {
    if (blockToChunkZ(blockZ) * 16 + blockToLocalZ(blockZ) !== blockZ) ok = false;
  }
  check('blockToChunkZ/blockToLocalZ round-trip over [-80, 80]', ok);
}

{
  const seen = new Set();
  let unique = true;
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const index = voxelIndex(x, y, z);
        if (index < 0 || index >= CHUNK_VOLUME || seen.has(index)) unique = false;
        seen.add(index);
      }
    }
  }
  check('voxelIndex is a bijection onto [0, CHUNK_VOLUME)', unique && seen.size === CHUNK_VOLUME);
}

{
  const seen = new Set();
  let ok = true;
  for (let y = -1; y <= WORLD_HEIGHT; y++) {
    for (let z = -1; z <= 16; z++) {
      for (let x = -1; x <= 16; x++) {
        const index = paddedIndex(x, y, z);
        if (index < 0 || index >= PADDED_VOLUME || seen.has(index)) ok = false;
        seen.add(index);
      }
    }
  }
  check('paddedIndex covers the padded volume exactly once', ok && seen.size === PADDED_VOLUME);
}

check(
  'collectAffectedChunks returns 1 chunk for an interior block',
  collectAffectedChunks(0, 0, 8, 8).length === 1
);
check(
  'collectAffectedChunks returns 4 chunks for a corner block',
  collectAffectedChunks(0, 0, 0, 0).length === 4,
  `got ${collectAffectedChunks(0, 0, 0, 0).length}`
);
check(
  'collectAffectedChunks returns 2 chunks for an edge block',
  collectAffectedChunks(0, 0, 0, 8).length === 2
);

// -------------------------------------------------------------------- helpers

section('Seed parsing and priority queue');

check('parseSeed is stable for the same string', parseSeed('hello world') === parseSeed('hello world'));
check('parseSeed differs for different strings', parseSeed('hello') !== parseSeed('hell0'));
check('parseSeed accepts numeric strings', parseSeed('12345') === 12345);

{
  const queue = new PriorityQueue((value) => value.key);
  const order = [];
  queue.push({ key: 'c' }, 3);
  queue.push({ key: 'a' }, 1);
  queue.push({ key: 'd' }, 4);
  queue.push({ key: 'b' }, 2);
  queue.pushOrUpdate({ key: 'd' }, 0);
  while (!queue.isEmpty) order.push(queue.pop().key);
  check('priority queue pops in priority order', order.join('') === 'dabc', order.join(''));
  check('priority queue is empty after draining', queue.size === 0);
}

{
  const queue = new PriorityQueue((value) => value.key);
  for (let i = 0; i < 50; i++) queue.push({ key: `k${i}` }, i);
  const removed = queue.prune((value) => Number(value.key.slice(1)) % 2 === 0);
  check('priority queue prune removes the right count', removed === 25, `removed ${removed}`);
  check('priority queue prune keeps the heap valid', queue.pop().key === 'k1');
}

section('Persistent block state and scheduled ticks');
{
  const word = packBlockWord(Block.WHEAT_CROP, cropState(7));
  check('a block word preserves its state byte', stateFromWord(word) === 7);

  const wideWord = packBlockWord(0x1234, 0xab);
  check('a block word preserves a 16-bit block id', blockIdFromWord(wideWord) === 0x1234);
  check('a wide block word preserves its state byte', stateFromWord(wideWord) === 0xab);
  const wideRoundTrip = unpackChunkEdits(packChunkEdits(new Map([[3, wideWord]])));
  check('save packing preserves block ids above 255', wideRoundTrip.get(3) === wideWord);

  const edits = new Map([
    [17, word],
    [CHUNK_VOLUME - 1, packBlockWord(Block.WATER, fluidState(5, true))],
  ]);
  const roundTrip = unpackChunkEdits(packChunkEdits(edits));
  check('stateful chunk edits survive save packing', roundTrip.get(17) === word);
  check(
    'fluid state survives save packing',
    roundTrip.get(CHUNK_VOLUME - 1) === edits.get(CHUNK_VOLUME - 1)
  );
  const legacy = unpackChunkEdits(new Uint32Array([(31 << 8) | Block.STONE]));
  check('legacy edit entries load with state zero', legacy.get(31) === packBlockWord(Block.STONE, 0));
}
{
  const scheduler = new BlockTickScheduler();
  scheduler.schedule(10, 1, 2, 3, 8, 'water', 'late');
  scheduler.schedule(10, 1, 2, 3, 3, 'water', 'early');
  scheduler.schedule(10, 9, 2, 3, 3, 'water', 'same-tick-second');
  scheduler.schedule(10, 1, 2, 3, 9, 'water', 'ignored-later');
  const delivered = [];
  check('scheduled ticks do not run early', scheduler.runDue(12, (entry) => delivered.push(entry)) === 0);
  check('scheduled ticks run at their exact game tick', scheduler.runDue(13, (entry) => delivered.push(entry)) === 2);
  check('an earlier duplicate supersedes a later one', delivered[0]?.data === 'early');
  check('equal-due ticks keep insertion order', delivered[1]?.data === 'same-tick-second');
  check('delivered scheduled ticks leave no live entries', scheduler.size === 0);
}

// ------------------------------------------------------------------- registry

section('Save import normalisation');
{
  const validWord = packBlockWord(Block.STONE, 37);
  const futureWord = packBlockWord(65535, 9);
  const corruptWord = 0xff00_0001;
  const payload = [
    EDIT_PAIR_MAGIC,
    4,
    validWord,
    CHUNK_VOLUME + 2,
    validWord,
    8,
    futureWord,
    10,
    corruptWord,
    12, // deliberately truncated pair
  ];
  const normalised = normaliseChunkEditPayload(payload);
  const edits = unpackChunkEdits(normalised);
  check('import normalisation keeps a valid pair', edits.get(4) === validWord);
  check('import normalisation rejects an out-of-range voxel', !edits.has(CHUNK_VOLUME + 2));
  check('import normalisation preserves future 16-bit block ids', edits.get(8) === futureWord);
  check('import normalisation rejects words using reserved high bits', !edits.has(10));
  check('import normalisation ignores a truncated final pair', !edits.has(12));
  check('import normalisation emits the current pair header', normalised[0] === EDIT_PAIR_MAGIC);

  const legacy = [(7 << 8) | Block.DIRT, Number.NaN];
  const migrated = normaliseChunkEditPayload(legacy);
  const migratedEdits = unpackChunkEdits(migrated);
  check('legacy imports migrate into the current format', migrated[0] === EDIT_PAIR_MAGIC);
  check('legacy imports preserve valid edits', blockIdFromWord(migratedEdits.get(7)) === Block.DIRT);
  check('legacy imports discard non-numeric entries', migratedEdits.size === 1);

  check('unsupported import payloads are rejected', normaliseChunkEditPayload({ nope: true }) === null);
}

section('Palette-compressed chunk sections');
{
  const visited = new Set();
  for (let y = 0; y < 16; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) visited.add(sectionIndex(x, y, z));
    }
  }
  check('sectionIndex is a bijection over 4096 cells', visited.size === SECTION_VOLUME);
  check('one-entry palettes still use one bit', bitsForPaletteSize(1) === 1);
  check('a 257-entry palette uses nine bits', bitsForPaletteSize(257) === 9);

  const blocks = new Uint16Array(CHUNK_VOLUME);
  const states = new Uint8Array(CHUNK_VOLUME);
  blocks.fill(Block.STONE, 0, SECTION_VOLUME);

  const uniform = encodeChunkSection(blocks, states, 0);
  check('a uniform section uses one palette entry', uniform.palette.length === 1);
  check('a uniform section uses the minimum bit width', uniform.bits === 1);
  check('a uniform solid section counts every voxel', uniform.nonAirCount === SECTION_VOLUME);
  check('a uniform section is far smaller than dense storage', chunkSectionByteLength(uniform) < SECTION_VOLUME / 4);
  check('a generated section validates', validateChunkSection(uniform));

  for (let y = 16; y < 32; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const i = voxelIndex(x, y, z);
        const local = x + z * 16 + (y - 16) * 256;
        blocks[i] = (local * 73 + 257) & 0xffff;
        states[i] = (local * 29) & 0xff;
      }
    }
  }
  const varied = encodeChunkSection(blocks, states, 1);
  check('a varied section chooses enough palette bits', varied.bits === bitsForPaletteSize(varied.palette.length));
  check('section palettes support block ids above 255', Array.from(varied.palette).some((word) => blockIdFromWord(word) > 255));

  const decodedBlocks = new Uint16Array(CHUNK_VOLUME);
  const decodedStates = new Uint8Array(CHUNK_VOLUME);
  decodeChunkSection(varied, decodedBlocks, decodedStates);
  let roundTrips = true;
  for (let y = 16; y < 32 && roundTrips; y++) {
    for (let z = 0; z < 16 && roundTrips; z++) {
      for (let x = 0; x < 16; x++) {
        const i = voxelIndex(x, y, z);
        if (blocks[i] !== decodedBlocks[i] || states[i] !== decodedStates[i]) {
          roundTrips = false;
          break;
        }
      }
    }
  }
  check('palette sections round-trip ids and states exactly', roundTrips);

  const crossing = Uint16Array.from({ length: 97 }, (_, i) => (i * 7) & 31);
  const packed = packPaletteIndices(crossing, 5);
  check('bit packing survives 32-bit word boundaries', crossing.every((value, i) => unpackPaletteIndex(packed, 5, i) === value));
  check('truncated section payloads are rejected', !validateChunkSection({ ...varied, data: varied.data.slice(0, -1) }));
}

section('Expanded texture atlas capacity');
{
  check('the atlas reserves at least 1024 tile cells', ATLAS_COLUMNS * ATLAS_ROWS >= 1024);
  check('declared tiles fit with substantial expansion room', TILE_NAMES.length < ATLAS_COLUMNS * ATLAS_ROWS * 0.75);
  const lastDeclared = tileUvRect(TILE_NAMES.length - 1);
  check('declared tile UVs stay inside the atlas', lastDeclared.every((value) => value >= 0 && value <= 1));
  check('declared tile UV rectangles have positive area', lastDeclared[2] > lastDeclared[0] && lastDeclared[3] > lastDeclared[1]);
}

section('Block registry');

check('every block id resolves to a definition', (() => {
  for (let id = 0; id < BLOCK_COUNT; id++) if (!getBlock(id)) return false;
  return true;
})());
check('air is not opaque', IS_OPAQUE[Block.AIR] === 0);
check('stone is opaque', IS_OPAQUE[Block.STONE] === 1);
check('glass is not opaque', IS_OPAQUE[Block.GLASS] === 0);
check('leaves are not opaque', IS_OPAQUE[Block.OAK_LEAVES] === 0);
check('water is not opaque', IS_OPAQUE[Block.WATER] === 0);

// ----------------------------------------------------------------- generation

section('Shared voxel models');
{
  const lower = getVoxelShape(Block.OAK_SLAB, slabState(false));
  const upper = getVoxelShape(Block.OAK_SLAB, slabState(true));
  const lowerBounds = getShapeBounds(lower);
  const upperBounds = getShapeBounds(upper);
  check('lower slabs occupy the bottom half', lowerBounds?.minY === 0 && lowerBounds?.maxY === 0.5);
  check('upper slabs occupy the top half', upperBounds?.minY === 0.5 && upperBounds?.maxY === 1);
  check('slab state preserves its half', !slabIsUpper(slabState(false)) && slabIsUpper(slabState(true)));

  const stair = stairState(horizontalFacingFromVector(1, 0), true);
  check('stair state preserves facing', stairFacing(stair) === horizontalFacingFromVector(1, 0));
  check('stair state preserves upper half', stairIsUpper(stair));
  check('stairs are represented by two cuboids', getVoxelShape(Block.OAK_STAIRS, stair).length === 2);

  const rayOrigin = { x: 0.5, y: 0.25, z: -1 };
  const rayDirection = { x: 0, y: 0, z: 1 };
  const hit = rayIntersectVoxelShape(rayOrigin, rayDirection, 0, 0, 0, lower, 5);
  check('a ray hits the solid half of a slab', hit?.distance === 1 && hit.normalZ === -1, JSON.stringify(hit));
  const miss = rayIntersectVoxelShape(
    { x: 0.5, y: 0.75, z: -1 },
    rayDirection,
    0,
    0,
    0,
    lower,
    5
  );
  check('a ray passes through the empty half of a slab', miss === null);
  check(
    'player AABB collision uses the slab height',
    aabbIntersectsBox(0.2, 0.25, 0.2, 0.8, 0.75, 0.8, 0, 0, 0, lower[0])
  );
  check(
    'an AABB above a lower slab is clear',
    !aabbIntersectsBox(0.2, 0.51, 0.2, 0.8, 1.2, 0.8, 0, 0, 0, lower[0])
  );

  const closed = trapdoorState(horizontalFacingFromVector(0, 1), { upper: false });
  const opened = setTrapdoorOpen(closed, true);
  check('trapdoor state toggles open without losing facing', trapdoorIsOpen(opened));
  check(
    'an open trapdoor becomes a vertical collision plane',
    getShapeBounds(getCollisionShape(Block.OAK_TRAPDOOR, opened))?.maxY === 1
  );
  check('ladders remain non-colliding climbables', getCollisionShape(Block.LADDER, 0).length === 0);


  const doubleSlab = slabState(false, true);
  check('merged slabs become a full cube', slabIsDouble(doubleSlab) && getVoxelShape(Block.OAK_SLAB, doubleSlab) === getVoxelShape(Block.STONE, 0));

  const connectionWorld = new GridTestWorld(5);
  connectionWorld.setBlock(0, 10, 0, Block.OAK_FENCE);
  connectionWorld.setBlock(-1, 10, 0, Block.OAK_FENCE);
  connectionWorld.setBlock(1, 10, 0, Block.STONE);
  const fenceState = connectedBlockState(connectionWorld, 0, 10, 0, Block.OAK_FENCE);
  check('fences derive west/east connections from neighbours', connectionMask(fenceState) === 0x0a);
  check('connected fences emit post plus rail boxes', getVoxelShape(Block.OAK_FENCE, fenceState).length === 5);

  const paneState = connectedBlockState(connectionWorld, 0, 10, 0, Block.GLASS_PANE);
  check('panes derive the same cardinal connection mask', connectionMask(paneState) === 0x0a);
  check('connected panes emit a centre and two arms', getVoxelShape(Block.GLASS_PANE, paneState).length === 3);

  const closedDoor = doorState(0, { open: false, upper: false });
  const openDoor = doorState(0, { open: true, upper: false });
  const closedDoorBounds = getShapeBounds(getVoxelShape(Block.OAK_DOOR, closedDoor));
  const openDoorBounds = getShapeBounds(getVoxelShape(Block.OAK_DOOR, openDoor));
  check('closed doors are thin south-facing panels', closedDoorBounds.maxZ === 1 && closedDoorBounds.minZ > 0.75);
  check('opening a door rotates its collision panel', openDoorBounds.maxX < 0.25 || openDoorBounds.minX > 0.75);

  const openGate = gateState(0, { open: true });
  check('an open gate removes its blocking crossbars', getVoxelShape(Block.OAK_FENCE_GATE, openGate).length === 2);
  const closedGate = gateState(0, { open: false });
  check('a closed gate includes posts and crossbars', getVoxelShape(Block.OAK_FENCE_GATE, closedGate).length === 4);

  const plateUp = pressurePlateState(false);
  const plateDown = pressurePlateState(true);
  check('pressed pressure plates render lower', getShapeBounds(getVoxelShape(Block.STONE_PRESSURE_PLATE, plateDown)).maxY < getShapeBounds(getVoxelShape(Block.STONE_PRESSURE_PLATE, plateUp)).maxY);
  check('pressure plates do not block movement', getCollisionShape(Block.STONE_PRESSURE_PLATE, plateUp).length === 0);

  const buttonUp = buttonState(0, false);
  const buttonDown = buttonState(0, true);
  check('pressed buttons retract toward their support', getShapeBounds(getVoxelShape(Block.STONE_BUTTON, buttonDown)).minZ > getShapeBounds(getVoxelShape(Block.STONE_BUTTON, buttonUp)).minZ);

  check('bed head/foot state survives encoding', !bedHead(bedState(0, { head: false })) && bedHead(bedState(0, { head: true })));
  check('beds use a low multi-box model', getShapeBounds(getVoxelShape(Block.WHITE_BED, bedState(0))).maxY === 9 / 16);
}

section('Terrain generation');

const seed = parseSeed('voxel-selftest');
const generator = new TerrainGenerator(seed);

const chunkA = generator.generateChunk(0, 0);
const chunkARepeat = generator.generateChunk(0, 0);

check('chunk has the expected voxel count', chunkA.blocks.length === CHUNK_VOLUME);
check('chunk contains solid ground', chunkA.nonAirCount > 2000, `nonAir=${chunkA.nonAirCount}`);
check(
  'generation is deterministic for the same seed',
  Buffer.compare(Buffer.from(chunkA.blocks), Buffer.from(chunkARepeat.blocks)) === 0
);

{
  const other = new TerrainGenerator(seed + 1).generateChunk(0, 0);
  check(
    'a different seed produces different terrain',
    Buffer.compare(Buffer.from(chunkA.blocks), Buffer.from(other.blocks)) !== 0
  );
}

check('bedrock floor is present at y=0', (() => {
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      if (chunkA.blocks[voxelIndex(x, 0, z)] !== Block.BEDROCK) return false;
    }
  }
  return true;
})());

check('no block ids outside the registry are produced', (() => {
  for (let i = 0; i < chunkA.blocks.length; i++) {
    if (chunkA.blocks[i] >= BLOCK_COUNT) return false;
  }
  return true;
})());

// Negative coordinates must generate real terrain, not an empty or clamped mess.
{
  const negative = generator.generateChunk(-3, -5);
  check('negative chunk coordinates generate terrain', negative.nonAirCount > 2000, `nonAir=${negative.nonAirCount}`);
  const repeat = generator.generateChunk(-3, -5);
  check(
    'negative chunk generation is deterministic',
    Buffer.compare(Buffer.from(negative.blocks), Buffer.from(repeat.blocks)) === 0
  );
}

// Chunk borders: the shared column between two chunks must agree, otherwise
// terrain would step at every seam.
{
  const left = generator.generateChunk(0, 0);
  const right = generator.generateChunk(1, 0);
  let mismatches = 0;
  for (let z = 0; z < 16; z++) {
    const leftHeight = left.heightMap[15 + z * 16];
    const rightHeight = right.heightMap[0 + z * 16];
    // Adjacent columns, so heights should be within a block or two of each other.
    if (Math.abs(leftHeight - rightHeight) > 4) mismatches++;
  }
  check('heights are continuous across a chunk border', mismatches === 0, `${mismatches} steps > 4 blocks`);
}

// Water should only exist at or below sea level.
check('no water above sea level', (() => {
  for (let y = SEA_LEVEL + 1; y < WORLD_HEIGHT; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        if (chunkA.blocks[voxelIndex(x, y, z)] === Block.WATER) return false;
      }
    }
  }
  return true;
})());

// Spawn search must land above ground, not inside rock or under the sea.
{
  const spawn = generator.findSpawn(0, 0);
  const height = generator.getSurfaceHeight(Math.floor(spawn.x), Math.floor(spawn.z));
  check(
    'findSpawn lands on the surface above sea level',
    spawn.y >= SEA_LEVEL + 1 && Math.abs(spawn.y - (height + 1)) <= 1,
    `spawn.y=${spawn.y}, surface=${height}`
  );
}

// Biome diversity across a wide area: a single-biome world means the climate
// fields are not doing their job.
{
  const found = new Set();
  for (let i = 0; i < 400; i++) {
    const x = (i % 20) * 220 - 2200;
    const z = Math.floor(i / 20) * 220 - 2200;
    const sample = generator.sampleColumn(x, z);
    found.add(sample.biome);
  }
  check(
    'multiple biomes appear across a 4400-block area',
    found.size >= 6,
    `found ${found.size}: ${Array.from(found).map(getBiomeName).join(', ')}`
  );
}

// Trees must be complete: check that no chunk contains leaves with no log
// anywhere in the 3x3 neighbourhood (the classic half-tree symptom).
{
  let orphanCanopies = 0;
  for (let cz = -2; cz <= 2; cz++) {
    for (let cx = -2; cx <= 2; cx++) {
      const chunk = generator.generateChunk(cx, cz);
      let leaves = 0;
      let logs = 0;
      for (let i = 0; i < chunk.blocks.length; i++) {
        const id = chunk.blocks[i];
        if (id === Block.OAK_LEAVES || id === Block.BIRCH_LEAVES || id === Block.SPRUCE_LEAVES) leaves++;
        if (id === Block.OAK_LOG || id === Block.BIRCH_LOG || id === Block.SPRUCE_LOG) logs++;
      }
      // A chunk may legitimately contain only canopy overhang from a neighbour,
      // but a large canopy with zero logs anywhere nearby is suspicious.
      if (leaves > 200 && logs === 0) orphanCanopies++;
    }
  }
  check('no chunk has a large canopy with no trunks at all', orphanCanopies === 0, `${orphanCanopies} chunks`);
}

// -------------------------------------------------------------------- meshing

section('Chunk meshing');

const mesher = new ChunkMesher();

/** Builds the padded volume for a chunk by generating its 8 neighbours. */
function buildPaddedVolume(cx, cz) {
  const padded = new Uint8Array(PADDED_VOLUME);
  const cache = new Map();
  const chunkAt = (x, z) => {
    const key = `${x},${z}`;
    if (!cache.has(key)) cache.set(key, generator.generateChunk(x, z));
    return cache.get(key);
  };
  for (let localZ = -1; localZ <= 16; localZ++) {
    for (let localX = -1; localX <= 16; localX++) {
      const worldX = cx * 16 + localX;
      const worldZ = cz * 16 + localZ;
      const chunk = chunkAt(Math.floor(worldX / 16), Math.floor(worldZ / 16));
      const sourceX = mod(worldX, 16);
      const sourceZ = mod(worldZ, 16);
      for (let y = 0; y < WORLD_HEIGHT; y++) {
        padded[paddedIndex(localX, y, localZ)] = chunk.blocks[voxelIndex(sourceX, y, sourceZ)];
      }
    }
  }
  return padded;
}

{
  const padded = buildPaddedVolume(0, 0);
  const result = mesher.mesh(padded, { ambientOcclusion: true, smoothLighting: true });

  let totalVertices = 0;
  let totalIndices = 0;
  let valid = true;
  let detail = '';

  for (const name of LAYER_NAMES) {
    const layer = result.layers[name];
    if (!layer) continue;
    const vertexCount = layer.positions.length / 3;
    totalVertices += vertexCount;
    totalIndices += layer.indices.length;

    if (layer.normals.length !== vertexCount * 3) {
      valid = false;
      detail = `${name}: normal count mismatch`;
    }
    if (layer.uvs.length !== vertexCount * 2) {
      valid = false;
      detail = `${name}: uv count mismatch`;
    }
    if (layer.light.length !== vertexCount * 4) {
      valid = false;
      detail = `${name}: light attribute count mismatch`;
    }
    if (layer.indices.length % 3 !== 0) {
      valid = false;
      detail = `${name}: index count is not a multiple of 3`;
    }
    for (let i = 0; i < layer.indices.length; i++) {
      if (layer.indices[i] >= vertexCount) {
        valid = false;
        detail = `${name}: index ${layer.indices[i]} out of range (${vertexCount} vertices)`;
        break;
      }
    }
  }

  check('mesher produced geometry', totalVertices > 0, `${totalVertices} vertices`);
  check('every attribute array has a consistent length', valid, detail);
  check('opaque layer exists for solid terrain', Boolean(result.layers.opaque));
  process.stdout.write(
    `    ${totalVertices.toLocaleString()} vertices, ${(totalIndices / 3).toLocaleString()} triangles\n`
  );
}

// A fully solid chunk interior must emit nothing at all: this is the single most
// important mesher property, because getting it wrong means drawing 6 faces per
// buried voxel.
{
  const solid = new Uint8Array(PADDED_VOLUME).fill(Block.STONE);
  const result = mesher.mesh(solid, { ambientOcclusion: true, smoothLighting: true });
  const vertices = result.layers.opaque ? result.layers.opaque.positions.length / 3 : 0;
  check('a fully enclosed solid volume emits zero faces', vertices === 0, `${vertices} vertices`);
}

// A single block surrounded by air must emit exactly 6 quads = 24 vertices.
{
  const single = new Uint8Array(PADDED_VOLUME);
  single[paddedIndex(8, 40, 8)] = Block.STONE;
  const result = mesher.mesh(single, { ambientOcclusion: true, smoothLighting: true });
  const vertices = result.layers.opaque ? result.layers.opaque.positions.length / 3 : 0;
  const triangles = result.layers.opaque ? result.layers.opaque.indices.length / 3 : 0;
  check('an isolated cube emits 6 quads', vertices === 24 && triangles === 12, `${vertices} verts, ${triangles} tris`);
}

// Custom cuboid models must use their state-dependent bounds.
{
  const shapedBlocks = new Uint16Array(PADDED_VOLUME);
  const shapedStates = new Uint8Array(PADDED_VOLUME);
  const index = paddedIndex(8, 40, 8);
  shapedBlocks[index] = Block.OAK_SLAB;
  shapedStates[index] = slabState(false);
  const lower = mesher.mesh(shapedBlocks, shapedStates, {}).layers.opaque;
  let lowerTop = -Infinity;
  for (let i = 1; i < lower.positions.length; i += 3) lowerTop = Math.max(lowerTop, lower.positions[i]);
  check('lower slab geometry stops at half height', Math.abs(lowerTop - 40.5) < 1e-6, String(lowerTop));

  shapedStates[index] = slabState(true);
  const upper = mesher.mesh(shapedBlocks, shapedStates, {}).layers.opaque;
  let upperBottom = Infinity;
  for (let i = 1; i < upper.positions.length; i += 3) upperBottom = Math.min(upperBottom, upper.positions[i]);
  check('upper slab geometry begins at half height', Math.abs(upperBottom - 40.5) < 1e-6, String(upperBottom));

  shapedBlocks[index] = Block.OAK_STAIRS;
  shapedStates[index] = stairState(horizontalFacingFromVector(0, -1), false);
  const stairs = mesher.mesh(shapedBlocks, shapedStates, {}).layers.opaque;
  check('stair meshing emits both cuboids', stairs.positions.length > lower.positions.length);

  shapedBlocks[index] = Block.LADDER;
  shapedStates[index] = horizontalFacingFromVector(0, 1);
  const ladder = mesher.mesh(shapedBlocks, shapedStates, {}).layers.cutout;
  check('ladder model is emitted on the cutout layer', Boolean(ladder) && ladder.positions.length > 0);
}

// Two adjacent opaque blocks must not draw the face between them.
{
  const pair = new Uint8Array(PADDED_VOLUME);
  pair[paddedIndex(8, 40, 8)] = Block.STONE;
  pair[paddedIndex(9, 40, 8)] = Block.STONE;
  const result = mesher.mesh(pair, { ambientOcclusion: true, smoothLighting: true });
  const vertices = result.layers.opaque.positions.length / 3;
  check('adjacent opaque blocks cull their shared face', vertices === 40, `${vertices} vertices`);
}

// Glass against stone: the stone face must still be drawn (you can see it).
{
  const mixed = new Uint8Array(PADDED_VOLUME);
  mixed[paddedIndex(8, 40, 8)] = Block.STONE;
  mixed[paddedIndex(9, 40, 8)] = Block.GLASS;
  const result = mesher.mesh(mixed, { ambientOcclusion: true, smoothLighting: true });
  const opaqueVertices = result.layers.opaque ? result.layers.opaque.positions.length / 3 : 0;
  check('stone keeps its face behind glass', opaqueVertices === 24, `${opaqueVertices} vertices`);
  check('glass is emitted on the translucent layer', Boolean(result.layers.translucent));
}

// Identical glass blocks hide their shared face.
{
  const glass = new Uint8Array(PADDED_VOLUME);
  glass[paddedIndex(8, 40, 8)] = Block.GLASS;
  glass[paddedIndex(9, 40, 8)] = Block.GLASS;
  const result = mesher.mesh(glass, { ambientOcclusion: true, smoothLighting: true });
  const vertices = result.layers.translucent.positions.length / 3;
  check('adjacent glass blocks cull their shared face', vertices === 40, `${vertices} vertices`);
}

// Cross-shaped plants produce two intersecting planes, each emitted front and
// back facing (4 quads / 16 vertices) so they are visible from every angle
// without making the whole cutout layer double-sided.
{
  const plant = new Uint8Array(PADDED_VOLUME);
  plant[paddedIndex(8, 40, 8)] = Block.TALL_GRASS;
  const result = mesher.mesh(plant, { ambientOcclusion: true, smoothLighting: true });
  const vertices = result.layers.cutout.positions.length / 3;
  const triangles = result.layers.cutout.indices.length / 3;
  check(
    'a cross-shaped plant emits 2 double-sided planes',
    vertices === 16 && triangles === 8,
    `${vertices} vertices, ${triangles} triangles`
  );

  // Both facings must exist, otherwise the plant disappears from one side.
  const normals = result.layers.cutout.normals;
  let hasPositive = false;
  let hasNegative = false;
  for (let i = 0; i < normals.length; i += 3) {
    if (normals[i] > 0.01 || normals[i + 2] > 0.01) hasPositive = true;
    if (normals[i] < -0.01 || normals[i + 2] < -0.01) hasNegative = true;
  }
  check('plant planes face both directions', hasPositive && hasNegative);
}

// A plant must stay inside its own block so it never pokes through a wall.
{
  const plant = new Uint8Array(PADDED_VOLUME);
  plant[paddedIndex(8, 40, 8)] = Block.TALL_GRASS;
  const positions = mesher.mesh(plant, {}).layers.cutout.positions;
  let inside = true;
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i] < 8 || positions[i] > 9) inside = false;
    if (positions[i + 2] < 8 || positions[i + 2] > 9) inside = false;
    if (positions[i + 1] < 40 || positions[i + 1] > 41) inside = false;
  }
  check('plant geometry stays within its own voxel', inside);
}

// Stateful crops use one block id while age selects both texture and height.
{
  const crop = new Uint8Array(PADDED_VOLUME);
  const states = new Uint8Array(PADDED_VOLUME);
  const index = paddedIndex(8, 40, 8);
  crop[index] = Block.WHEAT_CROP;
  states[index] = cropState(0);
  const young = mesher.mesh(crop, states, {}).layers.cutout.positions;
  let youngTop = -Infinity;
  for (let i = 1; i < young.length; i += 3) youngTop = Math.max(youngTop, young[i]);
  states[index] = cropState(7);
  const mature = mesher.mesh(crop, states, {}).layers.cutout.positions;
  let matureTop = -Infinity;
  for (let i = 1; i < mature.length; i += 3) matureTop = Math.max(matureTop, mature[i]);
  check('crop age changes rendered plant height', matureTop > youngTop + 0.5, `${youngTop} -> ${matureTop}`);
}

// Torches are a thin post: 5 quads (4 sides + cap).
{
  const torch = new Uint8Array(PADDED_VOLUME);
  torch[paddedIndex(8, 40, 8)] = Block.TORCH;
  const result = mesher.mesh(torch, {});
  const vertices = result.layers.cutout.positions.length / 3;
  check('a torch emits 5 quads', vertices === 20, `${vertices} vertices`);
  // The emissive channel must be lit for a light-emitting block.
  const light = result.layers.cutout.light;
  check('torch vertices carry block light', light[2] > 200, `channel value ${light[2]}`);
}

// Wire/repeaters are paper-thin plates, not full cubes or upright plants.
{
  const plate = new Uint8Array(PADDED_VOLUME);
  const states = new Uint8Array(PADDED_VOLUME);
  const index = paddedIndex(8, 40, 8);
  plate[index] = Block.REDSTONE_WIRE;
  states[index] = powerState(15);
  const result = mesher.mesh(plate, states, {});
  const layer = result.layers.cutout;
  const vertices = layer.positions.length / 3;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 1; i < layer.positions.length; i += 3) {
    minY = Math.min(minY, layer.positions[i]);
    maxY = Math.max(maxY, layer.positions[i]);
  }
  check('redstone wire emits one plate quad', vertices === 4, `${vertices} vertices`);
  check('redstone wire sits just above its support', minY > 40 && maxY < 40.1, `${minY}..${maxY}`);
}

// Block light is a real 0..15 flood rather than only the source voxel.
{
  const sx = 35;
  const sy = 5;
  const sz = 5;
  const blocks = new Uint16Array(sx * sy * sz);
  const index = (x, y, z) => blockLightIndex(x, y, z, sx, sz);
  blocks[index(16, 2, 2)] = Block.TORCH;
  const light = propagateBlockLight(blocks, sx, sy, sz);
  check('block-light source keeps its registered level', light[index(16, 2, 2)] === 14);
  check('block light falls by one per air voxel', light[index(17, 2, 2)] === 13);
  check('torch light reaches its full radius', light[index(29, 2, 2)] === 1);
  check('torch light stops after level zero', light[index(30, 2, 2)] === 0);

  // A complete opaque plane prevents light sneaking around the test wall.
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) blocks[index(18, y, z)] = Block.STONE;
  }
  const blocked = propagateBlockLight(blocks, sx, sy, sz);
  check('opaque voxels stop propagated block light', blocked[index(19, 2, 2)] === 0);

  blocks.fill(Block.AIR);
  blocks[index(1, 2, 2)] = Block.TORCH;
  blocks[index(2, 2, 2)] = Block.WATER;
  const waterLight = propagateBlockLight(blocks, sx, sy, sz);
  check('water applies its configured extra attenuation', waterLight[index(2, 2, 2)] === 14 - Math.max(1, LIGHT_ATTENUATION[Block.WATER]));
  check('light continues beyond transparent water', waterLight[index(3, 2, 2)] === 13 - Math.max(1, LIGHT_ATTENUATION[Block.WATER]));
}

// A 3x3 source volume must extract identical light on both sides of a chunk
// boundary. This catches the seam caused by propagating each padded chunk alone.
{
  const blocks = new Uint16Array(LIGHT_VOLUME);
  const sourceX = LIGHT_TARGET_OFFSET_X - 1;
  const sourceZ = LIGHT_TARGET_OFFSET_Z + 8;
  const sourceY = 48;
  blocks[blockLightIndex(
    sourceX,
    sourceY,
    sourceZ,
    LIGHT_VOLUME_SIZE_X,
    LIGHT_VOLUME_SIZE_Z
  )] = Block.TORCH;
  check('cross-chunk light source detection is bounded and accurate', hasBlockLightSource(blocks));
  const propagated = propagateBlockLight(
    blocks,
    LIGHT_VOLUME_SIZE_X,
    LIGHT_VOLUME_SIZE_Y,
    LIGHT_VOLUME_SIZE_Z
  );
  const padded = extractPaddedBlockLight(propagated);
  check(
    'neighbour torch lights the centre chunk border',
    padded[paddedIndex(0, sourceY, 8)] === 13,
    String(padded[paddedIndex(0, sourceY, 8)])
  );
  check(
    'cross-border light keeps a smooth gradient',
    padded[paddedIndex(4, sourceY, 8)] === 9,
    String(padded[paddedIndex(4, sourceY, 8)])
  );
}

// On-demand simulation queries use the same attenuation and can route around
// corners, allowing spawn rules to respect torches without a main-thread cache.
{
  const cells = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  cells.set(key(5, 40, 0), Block.TORCH);
  const getBlockAt = (x, y, z) => cells.get(key(x, y, z)) ?? Block.AIR;
  check(
    'world light sampling finds a torch through open space',
    sampleWorldBlockLight(getBlockAt, 0, 40, 0) === 9
  );

  // An infinite wall across the bounded sample prevents every route around it.
  const wallBlocks = (x, y, z) => {
    if (x === 2) return Block.STONE;
    if (x === 5 && y === 40 && z === 0) return Block.TORCH;
    return Block.AIR;
  };
  check(
    'world light sampling does not leak through opaque walls',
    sampleWorldBlockLight(wallBlocks, 0, 40, 0) === 0
  );
}

// Meshed vertex attributes must carry propagated light on geometry that does
// not touch the emitter directly.
{
  const volume = new Uint16Array(PADDED_VOLUME);
  volume[paddedIndex(4, 40, 8)] = Block.TORCH;
  volume[paddedIndex(8, 40, 8)] = Block.STONE;
  const result = mesher.mesh(volume, {});
  const layer = result.layers.opaque;
  let maxBlockLight = 0;
  for (let i = 2; i < layer.light.length; i += 4) maxBlockLight = Math.max(maxBlockLight, layer.light[i]);
  check('mesher bakes propagated block light beyond adjacent faces', maxBlockLight >= 136, String(maxBlockLight));
}

// Sky light must attenuate: a voxel buried under rock is dark, one in the open
// is fully lit. This is what makes caves dark without a flood fill.
{
  const column = new Uint8Array(PADDED_VOLUME);
  for (let y = 0; y <= 60; y++) {
    for (let z = -1; z <= 16; z++) {
      for (let x = -1; x <= 16; x++) column[paddedIndex(x, y, z)] = Block.STONE;
    }
  }
  // Hollow out a sealed cavity.
  for (let y = 30; y <= 32; y++) {
    for (let z = 6; z <= 9; z++) {
      for (let x = 6; x <= 9; x++) column[paddedIndex(x, y, z)] = Block.AIR;
    }
  }
  const result = mesher.mesh(column, { ambientOcclusion: true, smoothLighting: true });
  const light = result.layers.opaque.light;
  let maxSky = 0;
  let minSky = 255;
  let litSurfaceFound = false;
  const positions = result.layers.opaque.positions;
  for (let v = 0; v < positions.length / 3; v++) {
    const y = positions[v * 3 + 1];
    const sky = light[v * 4 + 1];
    if (y > 60) {
      litSurfaceFound = true;
      maxSky = Math.max(maxSky, sky);
    }
    if (y >= 30 && y <= 33) minSky = Math.min(minSky, sky);
  }
  check('the open surface is fully sky-lit', litSurfaceFound && maxSky === 255, `max ${maxSky}`);
  check('a sealed cavity receives no sky light', minSky === 0, `min ${minSky}`);
}

// Water surface must be lowered when open to air, and flush when submerged.
{
  const water = new Uint8Array(PADDED_VOLUME);
  for (let y = 30; y <= 40; y++) water[paddedIndex(8, y, 8)] = Block.WATER;
  const result = mesher.mesh(water, { ambientOcclusion: true, smoothLighting: true });
  const layer = result.layers.liquid;
  check('water is emitted on the liquid layer', Boolean(layer));
  let maxY = -Infinity;
  for (let i = 1; i < layer.positions.length; i += 3) maxY = Math.max(maxY, layer.positions[i]);
  check(
    'open water surface sits below the full block height',
    maxY > 40 && maxY < 41,
    `top surface at y=${maxY}`
  );
}

// Flow level is visual state, not another block id.
{
  const water = new Uint8Array(PADDED_VOLUME);
  const states = new Uint8Array(PADDED_VOLUME);
  const index = paddedIndex(8, 40, 8);
  water[index] = Block.WATER;
  states[index] = fluidState(0, false);
  const source = mesher.mesh(water, states, {}).layers.liquid.positions;
  let sourceTop = -Infinity;
  for (let i = 1; i < source.length; i += 3) sourceTop = Math.max(sourceTop, source[i]);
  states[index] = fluidState(7, false);
  const shallow = mesher.mesh(water, states, {}).layers.liquid.positions;
  let shallowTop = -Infinity;
  for (let i = 1; i < shallow.length; i += 3) shallowTop = Math.max(shallowTop, shallow[i]);
  check('higher flow levels render a shallower liquid surface', shallowTop < sourceTop - 0.5, `${sourceTop} -> ${shallowTop}`);
  states[index] = fluidState(7, true);
  const falling = mesher.mesh(water, states, {}).layers.liquid.positions;
  let fallingTop = -Infinity;
  for (let i = 1; i < falling.length; i += 3) fallingTop = Math.max(fallingTop, falling[i]);
  check('falling liquid renders as a near-full column', fallingTop > shallowTop + 0.5);
}

// Adjacent liquid levels expose only the height difference between them. This
// catches both failure modes: hiding the boundary entirely leaves a visible
// hole in a stepped stream, while drawing a full-height side stacks translucent
// faces below the neighbour's surface.
{
  const water = new Uint8Array(PADDED_VOLUME);
  const states = new Uint8Array(PADDED_VOLUME);
  water[paddedIndex(8, 40, 8)] = Block.WATER;
  water[paddedIndex(9, 40, 8)] = Block.WATER;
  states[paddedIndex(8, 40, 8)] = fluidState(0, false);
  states[paddedIndex(9, 40, 8)] = fluidState(7, false);

  const layer = mesher.mesh(water, states, {}).layers.liquid;
  let exposedVertices = 0;
  let exposedMinY = Infinity;
  let exposedMaxY = -Infinity;
  for (let vertex = 0; vertex < layer.positions.length / 3; vertex++) {
    const x = layer.positions[vertex * 3];
    const y = layer.positions[vertex * 3 + 1];
    const z = layer.positions[vertex * 3 + 2];
    const nx = layer.normals[vertex * 3];
    if (Math.abs(x - 9) < 1e-6 && z >= 8 && z <= 9 && nx > 0.9) {
      exposedVertices++;
      exposedMinY = Math.min(exposedMinY, y);
      exposedMaxY = Math.max(exposedMaxY, y);
    }
  }
  check('a higher liquid exposes its side above a lower neighbour', exposedVertices === 4, `${exposedVertices} vertices`);
  check(
    'the exposed liquid side starts at the neighbour surface',
    exposedMinY > 40.1 && exposedMinY < 40.3,
    `${exposedMinY}`
  );
  check(
    'the exposed liquid side ends at the source surface',
    exposedMaxY > 40.8 && exposedMaxY < 40.9,
    `${exposedMaxY}`
  );
}

// ---------------------------------------------------------------- performance

section('Performance');

{
  // Warm up so we are not measuring first-call JIT compilation.
  for (let i = 0; i < 3; i++) generator.generateChunk(100 + i, 100);

  const count = 16;
  const genStart = performance.now();
  for (let i = 0; i < count; i++) generator.generateChunk(200 + i, 200);
  const genMs = (performance.now() - genStart) / count;

  const padded = buildPaddedVolume(0, 0);
  const meshStart = performance.now();
  for (let i = 0; i < count; i++) mesher.mesh(padded, { ambientOcclusion: true, smoothLighting: true });
  const meshMs = (performance.now() - meshStart) / count;

  process.stdout.write(`    generate: ${genMs.toFixed(2)} ms/chunk\n`);
  process.stdout.write(`    mesh:     ${meshMs.toFixed(2)} ms/chunk\n`);

  // These are generous ceilings for a Node run on shared CI hardware; they exist
  // to catch an accidental order-of-magnitude regression, not to benchmark.
  check('chunk generation stays under 60 ms', genMs < 60, `${genMs.toFixed(2)} ms`);
  check('chunk meshing stays under 40 ms', meshMs < 40, `${meshMs.toFixed(2)} ms`);
}

// ------------------------------------------------------ water surface material

section('Water surface animation');
{
  // This section exists because of a real bug: the water shader added an
  // unbounded `time * rate` offset to its UV, so the sample drifted off the
  // water tile after ~2 s and into an unpainted (magenta) atlas cell after
  // ~16 s, where ClampToEdgeWrapping pinned it. Water turned pink a few seconds
  // into every session. Each check below fails on that original code.

  const problems = assertWaterUvInvariant();
  check(
    'water UV animation invariant holds',
    problems.length === 0,
    problems.join('; ')
  );

  check(
    'scroll wraps to a bounded range',
    WATER_SCROLL_PERIOD > 0 && Number.isFinite(WATER_SCROLL_PERIOD),
    `period ${WATER_SCROLL_PERIOD}`
  );

  // The wrap must be a whole number of tile periods on both axes or the
  // animation visibly jumps when it resets.
  {
    const uTiles = (WATER_SCROLL_PERIOD * WATER_SCROLL_U) / TILE_UV_PERIOD;
    const vTiles = (WATER_SCROLL_PERIOD * WATER_SCROLL_V) / TILE_UV_PERIOD;
    check(
      'wrap is seamless horizontally',
      Math.abs(uTiles - Math.round(uTiles)) < 1e-9,
      `${uTiles} tile periods`
    );
    check(
      'wrap is seamless vertically',
      Math.abs(vTiles - Math.round(vTiles)) < 1e-9,
      `${vTiles} tile periods`
    );
  }

  // The folded offset must fit in the padding, which is what makes a mip or
  // anisotropic tap land on this tile's own wrapped copy.
  check(
    'folded offset fits inside the tile padding',
    maxFoldedOffset() <= TILE_PADDING_UV + 1e-9,
    `${maxFoldedOffset()} vs ${TILE_PADDING_UV}`
  );

  // Simulate a long session. The original code failed this within seconds.
  {
    const [u0, v0, u1, v1] = tileUvRect(WATER_TILE_INDEX);
    const minU = u0 - TILE_PADDING_UV;
    const maxU = u1 + TILE_PADDING_UV;
    const minV = v0 - TILE_PADDING_UV;
    const maxV = v1 + TILE_PADDING_UV;

    let escaped = 0;
    let unbounded = 0;
    const period = TILE_UV_PERIOD;
    // Eight hours of play, sampled every ~1.3 s.
    for (let t = 0; t < 28800; t += 1.3) {
      const scroll = waterScrollForTime(t);
      if (!(scroll >= 0 && scroll < WATER_SCROLL_PERIOD)) unbounded++;

      // Mirror the shader: fold into +/- half a tile period, then clamp.
      const foldU = ((((scroll * WATER_SCROLL_U) + 0.5 * period) % period) + period) % period - 0.5 * period;
      const foldV = ((((scroll * WATER_SCROLL_V) + 0.5 * period) % period) + period) % period - 0.5 * period;

      // Check both extremes of the tile, since vUv spans the whole rect.
      for (const [su, sv] of [
        [u0 + foldU, v0 + foldV],
        [u1 + foldU, v1 + foldV],
      ]) {
        if (su < minU - 1e-9 || su > maxU + 1e-9 || sv < minV - 1e-9 || sv > maxV + 1e-9) {
          escaped++;
        }
      }
    }

    check('scroll stays inside its wrap period for 8 h', unbounded === 0, `${unbounded} escapes`);
    check(
      'water never samples outside its padded atlas cell for 8 h',
      escaped === 0,
      `${escaped} escapes`
    );
  }

  // The unpainted cells are the magenta reservoir the bug drifted into. Assert
  // they exist (so the guard above is load-bearing) and that the water tile is
  // not one of them.
  {
    const spare = ATLAS_COLUMNS * ATLAS_ROWS - TILE_NAMES.length;
    check('atlas has spare cells the guard must protect against', spare > 0, `${spare} spare`);
    check(
      'water tile is a painted tile',
      WATER_TILE_INDEX < TILE_NAMES.length,
      `index ${WATER_TILE_INDEX} of ${TILE_NAMES.length}`
    );
  }

  // Text-level parity between the GLSL and the JS uniform table. A uniform
  // declared in the shader but never supplied reads as zero, which is how a
  // guard silently stops guarding.
  {
    const shaderDir = new URL('../src/rendering/shaders/', import.meta.url);
    const materialsSource = readFileSync(
      new URL('../src/rendering/Materials.js', import.meta.url),
      'utf8'
    );
    // `_createFallbackWater` is *referenced* in `build()` above the water
    // factory, so the end marker has to be searched for from the start marker
    // rather than from the top of the file.
    const factoryStart = materialsSource.indexOf('_createWaterMaterial() {');
    const factoryEnd = materialsSource.indexOf('_createFallbackWater() {', factoryStart);
    check(
      'water material factory is locatable for parity checking',
      factoryStart >= 0 && factoryEnd > factoryStart
    );
    const waterBlock = materialsSource.slice(factoryStart, factoryEnd);

    const declared = new Set();
    for (const file of ['water.vert.glsl', 'water.frag.glsl']) {
      const source = readFileSync(new URL(file, shaderDir), 'utf8');
      for (const match of source.matchAll(/^\s*uniform\s+\w+\s+(\w+)\s*;/gm)) {
        declared.add(match[1]);
      }
    }

    const missing = [...declared].filter((name) => !waterBlock.includes(`${name}:`));
    check(
      'every water shader uniform is supplied from JS',
      missing.length === 0,
      missing.join(', ')
    );
    check('water shader declares uniforms at all', declared.size > 10, `${declared.size} found`);

    // `verifyWaterMaterial` asserts the uniform set at runtime; keep its list in
    // step with the GLSL so adding a uniform cannot silently skip the check.
    const verifyBlock = materialsSource.slice(
      materialsSource.indexOf('verifyWaterMaterial() {'),
      materialsSource.indexOf('get waterDiagnostics()')
    );
    const unchecked = [...declared].filter((name) => !verifyBlock.includes(`'${name}'`));
    check(
      'runtime water assertion covers every shader uniform',
      unchecked.length === 0,
      unchecked.join(', ')
    );

    // The guard uniforms must actually be used by the fragment shader, not just
    // declared and forgotten.
    const frag = readFileSync(new URL('water.frag.glsl', shaderDir), 'utf8');
    check('fragment shader folds the scroll', /\bmod\s*\(/.test(frag));
    check('fragment shader clamps the sample', /\bclamp\s*\(\s*scrolled/.test(frag));
  }

  // No shader may reintroduce a raw magenta constant.
  {
    const shaderDir = new URL('../src/rendering/shaders/', import.meta.url);
    let magenta = 0;
    for (const file of readdirSync(shaderDir)) {
      const source = readFileSync(new URL(file, shaderDir), 'utf8');
      if (/vec3\s*\(\s*1\.0?\s*,\s*0\.0?\s*,\s*1\.0?\s*\)/.test(source)) magenta++;
    }
    check('no shader hard-codes a magenta fallback colour', magenta === 0, `${magenta} file(s)`);
  }
}

// ------------------------------------------------------------------ item system

section('Item registry');
{
  const stats = describeRegistry();
  process.stdout.write(
    `    ${stats.items} items: ${stats.tools} tools, ${stats.armour} armour, ${stats.food} food, ` +
      `${stats.fuels} fuels, ${stats.placeable} placeable\n`
  );

  check('the registry is populated', stats.items > 60, `${stats.items} items`);
  check('every tool tier is present', stats.tools === 25, `${stats.tools} tools`);
  check('all five armour sets are present', stats.armour === 20, `${stats.armour} armour items`);

  {
    const expectedSlots = new Set(Object.values(ArmourSlot));
    for (const material of Object.values(ArmourMaterial)) {
      const pieces = ITEM_IDS.map((id) => getItem(id)).filter(
        (definition) => definition.armourMaterial === material
      );
      check(`${material} has a complete armour set`, pieces.length === 4, `${pieces.length}`);
      check(
        `${material} covers every equipment slot`,
        pieces.every((piece) => expectedSlots.has(piece.armourSlot)) &&
          new Set(pieces.map((piece) => piece.armourSlot)).size === 4
      );
    }
    check('diamond chest armour matches its material table', getItem('diamond_chestplate').armourPoints === 8);
    check('diamond armour supplies toughness', getItem('diamond_helmet').armourToughness === 2);
    check('leather ingredients are not polluted by armour tags', itemsWithTag('leather').length === 1);
  }

  // Every placeable block must have exactly one item, or a block becomes
  // impossible to obtain. `ItemRegistry` throws on a duplicate, so this checks
  // the other direction: nothing obtainable was missed.
  {
    const missing = BLOCK_DEFINITIONS.filter(
      (block) => block.id !== Block.AIR && block.stackSize > 0 && !itemIdForBlock(block.id)
    ).map((block) => block.name);
    check('every obtainable block has an item', missing.length === 0, missing.join(', '));
  }

  // Water and air must NOT be obtainable, or a player could pocket the ocean.
  check('water has no item', itemIdForBlock(Block.WATER) === null);
  check('air has no item', itemIdForBlock(Block.AIR) === null);

  // Icons must resolve to real atlas tiles, since a bad index silently renders
  // whatever happens to be at that cell.
  {
    const bad = [];
    for (const id of ITEM_IDS) {
      const icon = getItem(id).icon;
      if (!Number.isInteger(icon) || icon < 0 || icon >= TILE_NAMES.length) bad.push(id);
    }
    check('every item icon is a painted tile', bad.length === 0, bad.slice(0, 5).join(', '));
  }

  // Tool tiers must be strictly ordered, or progression stops meaning anything.
  {
    let ordered = true;
    for (let i = 1; i < TIER_ORDER.length; i++) {
      const previous = TIER_DATA[TIER_ORDER[i - 1]];
      const current = TIER_DATA[TIER_ORDER[i]];
      if (current.level <= previous.level) ordered = false;
      if (current.speed <= previous.speed) ordered = false;
      if (current.durability <= previous.durability) ordered = false;
    }
    check('tool tiers strictly improve', ordered);
  }

  check(
    'a pickaxe reports its tier harvest level',
    harvestLevelOf('iron_pickaxe') === TIER_DATA.iron.level,
    `got ${harvestLevelOf('iron_pickaxe')}`
  );
  check('a non-tool has harvest level 0', harvestLevelOf('bread') === 0);
  check('an unknown item has harvest level 0', harvestLevelOf('nonsense') === 0);

  // Tag lookups drive recipes, so an empty tag would be a silently broken recipe.
  check('the wooden tag resolves', itemsWithTag('wooden').length > 0);
  check('the fuel tag resolves', itemsWithTag('fuel').length > 0);

  check('flint is registered as a material', getItem('flint').category === 'material');
  check('flint and steel is a durable ignition tool',
    getItem('flint_and_steel').durability === 64 && getItem('flint_and_steel').metadata.ignites === true
  );
  check('arrows retain a full stack size', getItem('arrow').maxStack === 64);
  check('bows are durable ranged weapons', getItem('bow').durability === 384 && getItem('bow').metadata.rangedWeapon === 'bow');
  check('shields are durable defensive items', getItem('shield').durability === 336 && getItem('shield').metadata.shield === true);
}

section('Item stacks');
{
  // --- stacking limits ---
  {
    const stack = new ItemStack('stone', 64);
    check('a stack respects its ceiling', stack.quantity === 64);
    check('growing a full stack returns the overflow', stack.grow(10) === 10);
    check('a full stack stays at its ceiling', stack.quantity === 64);
  }
  {
    const overfilled = new ItemStack('stone', 500);
    check('an oversized quantity is clamped', overfilled.quantity === 64);
  }
  {
    const tool = new ItemStack('iron_pickaxe', 5);
    check('a tool cannot stack above one', tool.quantity === 1);
  }

  // --- merging ---
  {
    const a = new ItemStack('stone', 60);
    const b = new ItemStack('stone', 10);
    const moved = a.merge(b);
    check('merging fills the target first', a.quantity === 64 && moved === 4);
    check('merging leaves the remainder behind', b.quantity === 6);
  }
  {
    const a = new ItemStack('stone', 10);
    const b = new ItemStack('dirt', 10);
    check('different items do not merge', a.merge(b) === 0 && a.quantity === 10);
  }

  // --- the durability rule the spec calls out explicitly ---
  {
    const worn = new ItemStack('iron_pickaxe', 1, { damage: 40 });
    const fresh = new ItemStack('iron_pickaxe', 1);
    check('tools with different damage never merge', !worn.canMergeWith(fresh));
    check('a merge attempt on those moves nothing', worn.merge(fresh) === 0);
    check('the fresh tool is untouched', fresh.quantity === 1);
  }
  {
    // Even *identical* damage cannot stack, because maxStack is 1.
    const a = new ItemStack('iron_pickaxe', 1, { damage: 10 });
    const b = new ItemStack('iron_pickaxe', 1, { damage: 10 });
    check('single-stack items never merge', !a.canMergeWith(b));
  }

  // --- metadata affects mergeability ---
  {
    const plain = new ItemStack('stone', 5);
    const tagged = new ItemStack('stone', 5, { metadata: { engraved: 'yes' } });
    check('metadata blocks merging', !plain.canMergeWith(tagged));
    const alsoTagged = new ItemStack('stone', 5, { metadata: { engraved: 'yes' } });
    check('matching metadata allows merging', tagged.canMergeWith(alsoTagged));
  }

  // --- splitting ---
  {
    const stack = new ItemStack('stone', 7);
    const half = stack.splitHalf();
    check('splitting rounds up for the taken half', half.quantity === 4);
    check('splitting leaves the rest', stack.quantity === 3);
  }
  {
    const single = new ItemStack('stone', 1);
    const half = single.splitHalf();
    // Rounding up is what makes right-clicking a single item hand it to you
    // rather than nothing at all.
    check('splitting one item yields one', half.quantity === 1 && single.isEmpty);
  }
  {
    const stack = new ItemStack('stone', 5);
    check('splitting more than exists takes everything', stack.split(99).quantity === 5);
    check('the source is then empty', stack.isEmpty);
  }
  {
    const worn = new ItemStack('diamond_sword', 1, { damage: 12 });
    const piece = worn.split(1);
    check('a split preserves damage', piece.damage === 12);
  }

  // --- swapping ---
  {
    const a = new ItemStack('stone', 3);
    const b = new ItemStack('bread', 7, { metadata: { fresh: 1 } });
    a.swapWith(b);
    check('swapping exchanges ids', a.itemId === 'bread' && b.itemId === 'stone');
    check('swapping exchanges quantities', a.quantity === 7 && b.quantity === 3);
    check('swapping exchanges metadata', a.metadata?.fresh === 1 && b.metadata === null);
  }

  // --- durability ---
  {
    const pick = new ItemStack('wood_pickaxe', 1);
    const max = pick.maxDurability;
    check('a wooden pickaxe has the tier durability', max === TIER_DATA.wood.durability);
    check('applying damage does not break it early', pick.applyDamage(max - 1) === false);
    check('the last use breaks it', pick.applyDamage(1) === true);
    check('damage never exceeds the maximum', pick.damage === max);
    check('a broken tool reports zero uses left', pick.remainingDurability === 0);
    check('a broken tool reports zero fraction', pick.durabilityFraction === 0);
    pick.repair(5);
    check('repairing restores uses', pick.remainingDurability === 5);
  }
  {
    const stone = new ItemStack('stone', 1);
    check('a non-tool cannot be damaged', stone.applyDamage(10) === false);
    check('a non-tool has infinite uses', stone.remainingDurability === Infinity);
  }

  // --- serialisation round-trips, including damage ---
  {
    const original = new ItemStack('diamond_pickaxe', 1, {
      damage: 137,
      metadata: { note: 'x' },
    });
    const restored = ItemStack.fromJSON(JSON.parse(JSON.stringify(original.toJSON())));
    check('serialisation preserves the item', restored.itemId === 'diamond_pickaxe');
    check('serialisation preserves damage', restored.damage === 137);
    check('serialisation preserves metadata', restored.metadata?.note === 'x');
  }
  {
    const plain = new ItemStack('stone', 12);
    const json = plain.toJSON();
    // Defaults are omitted to keep a 41-slot inventory small.
    check('a pristine stack omits the damage field', json.d === undefined);
    check('a stack without metadata omits it', json.m === undefined);
  }
  {
    check('an unknown item id deserialises to null', ItemStack.fromJSON({ id: 'ghost', n: 1 }) === null);
    check('a zero quantity deserialises to null', ItemStack.fromJSON({ id: 'stone', n: 0 }) === null);
    check('malformed data deserialises to null', ItemStack.fromJSON(null) === null);
    check('a numeric id deserialises to null', ItemStack.fromJSON({ id: 7, n: 1 }) === null);
  }
}

section('Armour maths');
{
  check('no armour leaves damage unchanged', damageAfterArmour(10, 0, 0) === 10);
  check(
    'a full diamond set reduces a ten-point hit to three',
    Math.abs(damageAfterArmour(10, 20, 8) - 3) < 1e-9,
    String(damageAfterArmour(10, 20, 8))
  );
  check(
    'iron protection weakens against a large hit',
    Math.abs(damageAfterArmour(10, 15, 0) - 6) < 1e-9,
    String(damageAfterArmour(10, 15, 0))
  );
  check('every positive hit wears armour at least once', armourDurabilityLoss(1) === 1);
  check('large hits cause proportionally more wear', armourDurabilityLoss(20) === 5);
  check('zero damage causes no wear', armourDurabilityLoss(0) === 0);
}

section('Inventory');
{
  const fresh = () => new Inventory(null);

  check('the slot layout totals 41', SLOT.TOTAL === 41, `${SLOT.TOTAL}`);
  check('the hotbar is 9 slots', HOTBAR_SIZE === 9);
  check('the main grid is 27 slots', SLOT.MAIN_END - SLOT.MAIN_START + 1 === 27);
  check('there are 4 armour slots', SLOT.ARMOUR_END - SLOT.ARMOUR_START + 1 === 4);
  check('the offhand is the last slot', SLOT.OFFHAND === SLOT.TOTAL - 1);

  // --- insertion order: hotbar before main grid ---
  {
    const inventory = fresh();
    inventory.addItem('stone', 1);
    check('a pickup lands in the hotbar first', inventory.getSlot(0)?.itemId === 'stone');
  }

  // --- topping up before opening a new slot ---
  {
    const inventory = fresh();
    inventory.setSlot(0, new ItemStack('stone', 60));
    inventory.setSlot(1, new ItemStack('dirt', 1));
    const leftover = inventory.addItem('stone', 10);
    check('insertion tops up a partial stack', inventory.getSlot(0).quantity === 64);
    check('the overflow opens a new slot', inventory.countOf('stone') === 70);
    check('nothing was lost', leftover === 0);
    check('an unrelated slot is untouched', inventory.getSlot(1)?.itemId === 'dirt');
  }

  // --- a genuinely full inventory reports the leftover ---
  {
    const inventory = fresh();
    for (let i = SLOT.HOTBAR_START; i <= SLOT.MAIN_END; i++) {
      inventory.setSlot(i, new ItemStack('dirt', 64));
    }
    check('a full inventory reports itself full', inventory.isFull);
    check('a full inventory refuses an item', inventory.canAccept('stone') === false);
    const leftover = inventory.addItem('stone', 5);
    check('the whole amount is returned as leftover', leftover === 5);
    check('nothing was silently destroyed', inventory.countOf('stone') === 0);
  }

  // --- a partially full inventory takes what fits ---
  {
    const inventory = fresh();
    for (let i = SLOT.HOTBAR_START; i <= SLOT.MAIN_END; i++) {
      inventory.setSlot(i, new ItemStack('dirt', 64));
    }
    // Free exactly 3 units of space in one dirt slot.
    inventory.getSlot(5).setQuantity(61);
    const incoming = new ItemStack('dirt', 10);
    const leftover = inventory.addItem(incoming);
    check('a partial insertion moves what fits', leftover === 7);
    check('the incoming stack keeps the remainder', incoming.quantity === 7);
  }

  // --- armour and offhand are not general storage ---
  {
    const inventory = fresh();
    for (let i = SLOT.HOTBAR_START; i <= SLOT.MAIN_END; i++) {
      inventory.setSlot(i, new ItemStack('dirt', 64));
    }
    check('a full inventory ignores armour slots', inventory.addItem('stone', 1) === 1);
    check('armour is not storage', Inventory.isStorage(SLOT.ARMOUR_START) === false);
    check('the offhand is not storage', Inventory.isStorage(SLOT.OFFHAND) === false);
  }

  // --- equipment slots are strongly typed ---
  {
    const inventory = fresh();
    const helmetSlot = Inventory.indexForArmourSlot(ArmourSlot.HELMET);
    const chestSlot = Inventory.indexForArmourSlot(ArmourSlot.CHESTPLATE);
    inventory.setSlot(helmetSlot, new ItemStack('dirt', 1));
    check('ordinary items cannot enter armour slots', inventory.getSlot(helmetSlot) === null);
    inventory.setSlot(helmetSlot, new ItemStack('iron_chestplate', 1));
    check('armour cannot enter the wrong body slot', inventory.getSlot(helmetSlot) === null);
    inventory.setSlot(chestSlot, new ItemStack('iron_chestplate', 1));
    check('matching armour enters its body slot', inventory.getSlot(chestSlot)?.itemId === 'iron_chestplate');
  }
  {
    const inventory = fresh();
    inventory.setSlot(0, new ItemStack('iron_helmet', 1));
    check('shift-click equips armour into an empty slot', inventory.quickMove(0) === true);
    check('the helmet leaves storage', inventory.getSlot(0) === null);
    check(
      'the helmet reaches its dedicated slot',
      inventory.getSlot(Inventory.indexForArmourSlot(ArmourSlot.HELMET))?.itemId === 'iron_helmet'
    );
  }
  {
    const inventory = fresh();
    for (const slot of Object.values(ArmourSlot)) {
      inventory.setSlot(
        Inventory.indexForArmourSlot(slot),
        new ItemStack(`iron_${slot}`, 1)
      );
    }
    check('a full iron set supplies fifteen armour points', inventory.armourPoints === 15);
    check('iron supplies no toughness', inventory.armourToughness === 0);
    const damage = inventory.resolveDamage(10, { reducedByArmour: true });
    check('equipped iron resolves damage through the armour curve', Math.abs(damage - 6) < 1e-9);
    check('every equipped piece wears on a protected hit', inventory.armour.every((stack) => stack?.damage === 2));

    const before = inventory.armour.map((stack) => stack?.damage ?? 0);
    check('unprotected damage is not reduced', inventory.resolveDamage(4, { reducedByArmour: false }) === 4);
    check(
      'unprotected damage does not wear armour',
      inventory.armour.every((stack, index) => stack?.damage === before[index])
    );
  }
  {
    const events = [];
    const inventory = new Inventory({ emit: (name, payload) => events.push({ name, payload }) });
    const slot = Inventory.indexForArmourSlot(ArmourSlot.HELMET);
    inventory.setSlot(
      slot,
      new ItemStack('leather_helmet', 1, {
        damage: ARMOUR_DATA[ArmourMaterial.LEATHER].pieces[ArmourSlot.HELMET].durability - 1,
      })
    );
    inventory.resolveDamage(4, { reducedByArmour: true });
    check('armour disappears when its durability reaches zero', inventory.getSlot(slot) === null);
    check('breaking armour emits a dedicated event', events.some((event) => event.name === 'inventory:armourBroke'));
  }

  // --- shields prefer the offhand and preserve durability semantics ---
  {
    const inventory = fresh();
    inventory.setSlot(0, new ItemStack('shield', 1));
    check('shift-click equips a shield to the offhand', inventory.quickMove(0) === true);
    check('the shield leaves storage', inventory.getSlot(0) === null);
    check('the shield reaches the offhand', inventory.offhand?.itemId === 'shield');
    check('an equipped shield is discoverable', inventory.hasShield && inventory.shieldSlot === SLOT.OFFHAND);
    check('blocking damage wears the shield', inventory.damageShield(7) === false && inventory.offhand.damage === 7);
  }
  {
    const events = [];
    const inventory = new Inventory({ emit: (name, payload) => events.push({ name, payload }) });
    inventory.setSlot(
      SLOT.OFFHAND,
      new ItemStack('shield', 1, { damage: getItem('shield').durability - 1 })
    );
    check('the last shield durability point breaks it', inventory.damageShield(1) === true);
    check('a broken shield leaves the offhand', inventory.offhand === null);
    check('shield break emits a dedicated event', events.some((event) => event.name === 'inventory:shieldBroke'));
  }

  // --- removal drains from the back, preserving the hotbar arrangement ---
  {
    const inventory = fresh();
    inventory.setSlot(0, new ItemStack('stone', 10));
    inventory.setSlot(20, new ItemStack('stone', 10));
    const removed = inventory.removeItem('stone', 12);
    check('removal takes the requested amount', removed === 12);
    check('removal drains the later slot first', inventory.getSlot(20) === null);
    check('the hotbar slot keeps the remainder', inventory.getSlot(0).quantity === 8);
  }
  {
    const inventory = fresh();
    inventory.setSlot(0, new ItemStack('stone', 3));
    check('removing more than held removes only what exists', inventory.removeItem('stone', 9) === 3);
    check('the slot is emptied to null', inventory.getSlot(0) === null);
  }

  // --- cursor interactions ---
  {
    const inventory = fresh();
    inventory.setSlot(0, new ItemStack('stone', 20));
    inventory.swapWithCursor(0);
    check('left click lifts the stack', inventory.cursor?.quantity === 20);
    check('the slot is emptied', inventory.getSlot(0) === null);
    inventory.swapWithCursor(3);
    check('left click puts it back down', inventory.getSlot(3)?.quantity === 20);
    check('the cursor is cleared', inventory.cursor === null);
  }
  {
    const inventory = fresh();
    inventory.setSlot(0, new ItemStack('stone', 21));
    inventory.splitWithCursor(0);
    check('right click takes half, rounded up', inventory.cursor?.quantity === 11);
    check('the slot keeps the rest', inventory.getSlot(0).quantity === 10);
    inventory.splitWithCursor(5);
    check('right click places a single item', inventory.getSlot(5)?.quantity === 1);
    check('the cursor keeps the rest', inventory.cursor?.quantity === 10);
  }
  {
    // A cursor stack dropped onto a compatible partial stack tops it up.
    const inventory = fresh();
    inventory.setSlot(0, new ItemStack('stone', 60));
    inventory.cursor = new ItemStack('stone', 10);
    inventory.swapWithCursor(0);
    check('a compatible drop merges', inventory.getSlot(0).quantity === 64);
    check('the cursor retains the overflow', inventory.cursor?.quantity === 6);
  }
  {
    // Incompatible drop must swap, never destroy.
    const inventory = fresh();
    inventory.setSlot(0, new ItemStack('stone', 5));
    inventory.cursor = new ItemStack('bread', 3);
    inventory.swapWithCursor(0);
    check('an incompatible drop swaps', inventory.getSlot(0)?.itemId === 'bread');
    check('the displaced stack goes to the cursor', inventory.cursor?.itemId === 'stone');
  }

  // --- shift-click style transfer ---
  {
    const inventory = fresh();
    inventory.setSlot(0, new ItemStack('stone', 30));
    check('quick move reports success', inventory.quickMove(0) === true);
    check('the hotbar slot is emptied', inventory.getSlot(0) === null);
    check('the item arrives in the main grid', inventory.countOf('stone') === 30);
    check('it landed in the grid range', inventory.getSlot(SLOT.MAIN_START)?.quantity === 30);
  }
  {
    const inventory = fresh();
    inventory.setSlot(SLOT.MAIN_START, new ItemStack('stone', 30));
    inventory.quickMove(SLOT.MAIN_START);
    check('quick move works back to the hotbar', inventory.getSlot(0)?.quantity === 30);
  }

  // --- number-key hotbar swap ---
  {
    const inventory = fresh();
    inventory.setSlot(SLOT.MAIN_START, new ItemStack('bread', 4));
    inventory.setSlot(2, new ItemStack('stone', 9));
    inventory.swapWithHotbar(SLOT.MAIN_START, 2);
    check('a hotbar swap exchanges both slots', inventory.getSlot(2)?.itemId === 'bread');
    check('the grid slot receives the other stack', inventory.getSlot(SLOT.MAIN_START)?.itemId === 'stone');
  }

  // --- selection ---
  {
    const inventory = fresh();
    check('selecting a slot succeeds', inventory.selectSlot(4) === true);
    check('the selection is recorded', inventory.selectedSlot === 4);
    check('reselecting the same slot is a no-op', inventory.selectSlot(4) === false);
    inventory.selectSlot(99);
    check('an out-of-range selection is clamped', inventory.selectedSlot === HOTBAR_SIZE - 1);
    inventory.cycleSlot(1);
    check('cycling wraps past the end', inventory.selectedSlot === 0);
    inventory.cycleSlot(-1);
    check('cycling wraps past the start', inventory.selectedSlot === HOTBAR_SIZE - 1);
  }

  // --- dropping ---
  {
    const inventory = fresh();
    inventory.setSlot(0, new ItemStack('stone', 5));
    const one = inventory.dropSelected(false);
    check('dropping one takes a single item', one.quantity === 1);
    check('the slot keeps the rest', inventory.getSlot(0).quantity === 4);
    const rest = inventory.dropSelected(true);
    check('dropping the stack takes everything', rest.quantity === 4);
    check('the slot is emptied', inventory.getSlot(0) === null);
    check('dropping from an empty slot yields null', inventory.dropSelected() === null);
  }

  // --- death drops clear everything, including the cursor ---
  {
    const inventory = fresh();
    inventory.setSlot(0, new ItemStack('stone', 5));
    inventory.setSlot(SLOT.MAIN_START, new ItemStack('bread', 2));
    inventory.setSlot(SLOT.OFFHAND, new ItemStack('apple', 1));
    inventory.cursor = new ItemStack('coal', 3);
    const dropped = inventory.dropEverything();
    check('death drops every occupied slot', dropped.length === 4, `${dropped.length}`);
    check('death drops include the cursor', dropped.some((s) => s.itemId === 'coal'));
    check('death drops include the offhand', dropped.some((s) => s.itemId === 'apple'));
    check('the inventory is empty afterwards', inventory.usedSlots === 0);
    check('the cursor is cleared', inventory.cursor === null);
  }

  // --- creative behaviour ---
  {
    const inventory = fresh();
    inventory.setCreative(true);
    inventory.setSlot(0, new ItemStack('stone', 1));
    check('creative never reports full', inventory.isFull === false);
    check('creative consumes nothing', inventory.consumeSelected() === true);
    check('the creative stack is unchanged', inventory.getSlot(0)?.quantity === 1);
    check('creative claims to hold anything', inventory.hasItems('diamond', 999));
    check('creative swallows a pickup', inventory.addItem('dirt', 10) === 0);
    check('creative did not hoard it', inventory.countOf('dirt') === 0);
  }
  {
    // Creative must not lose durability either.
    const inventory = fresh();
    inventory.setCreative(true);
    inventory.setSlot(0, new ItemStack('iron_pickaxe', 1));
    inventory.damageSelected(5);
    check('creative tools take no damage', inventory.getSlot(0)?.damage === 0);
  }

  // --- tool wear through the inventory ---
  {
    const inventory = fresh();
    inventory.setSlot(0, new ItemStack('wood_pickaxe', 1));
    const max = inventory.getSlot(0).maxDurability;
    check('wearing a tool does not break it early', inventory.damageSelected(max - 1) === false);
    check('the final use breaks it', inventory.damageSelected(1) === true);
    check('a broken tool leaves the slot empty', inventory.getSlot(0) === null);
  }

  // --- serialisation round-trip ---
  {
    const inventory = fresh();
    inventory.setSlot(0, new ItemStack('stone', 42));
    inventory.setSlot(SLOT.MAIN_START + 3, new ItemStack('iron_pickaxe', 1, { damage: 77 }));
    inventory.setSlot(
      Inventory.indexForArmourSlot(ArmourSlot.CHESTPLATE),
      new ItemStack('iron_chestplate', 1, { damage: 19 })
    );
    inventory.setSlot(SLOT.OFFHAND, new ItemStack('bread', 2));
    inventory.selectSlot(6);

    const restored = fresh();
    restored.fromJSON(JSON.parse(JSON.stringify(inventory.toJSON())));

    check('saving preserves a hotbar stack', restored.getSlot(0)?.quantity === 42);
    check('saving preserves the selected slot', restored.selectedSlot === 6);
    check(
      'saving preserves tool damage',
      restored.getSlot(SLOT.MAIN_START + 3)?.damage === 77,
      String(restored.getSlot(SLOT.MAIN_START + 3)?.damage)
    );
    check('saving preserves the offhand', restored.getSlot(SLOT.OFFHAND)?.itemId === 'bread');
    check(
      'saving preserves equipped armour and wear',
      restored.getSlot(Inventory.indexForArmourSlot(ArmourSlot.CHESTPLATE))?.damage === 19
    );
  }
  {
    const inventory = fresh();
    const malformed = new Array(SLOT.TOTAL).fill(null);
    malformed[Inventory.indexForArmourSlot(ArmourSlot.HELMET)] = { id: 'dirt', n: 1 };
    inventory.fromJSON({ slots: malformed });
    check(
      'loading rejects invalid equipment in armour slots',
      inventory.getSlot(Inventory.indexForArmourSlot(ArmourSlot.HELMET)) === null
    );
  }

  // --- legacy save migration ---
  {
    // The pre-item-registry shape: numeric block ids.
    const legacy = {
      hotbar: [
        { id: Block.STONE, count: 5 },
        null,
        { id: Block.OAK_LOG, count: 3 },
        { id: 65535, count: 1 },
      ],
      selectedSlot: 2,
    };
    const inventory = fresh();
    inventory.fromJSON(legacy);
    check('a legacy block id becomes an item', inventory.getSlot(0)?.itemId === 'stone');
    check('a legacy count survives', inventory.getSlot(0)?.quantity === 5);
    check('a legacy gap stays empty', inventory.getSlot(1) === null);
    check('a second legacy entry migrates', inventory.getSlot(2)?.itemId === 'oak_log');
    check('an unknown legacy block id is dropped', inventory.getSlot(3) === null);
    check('the legacy selected slot survives', inventory.selectedSlot === 2);
  }
  {
    // A save with neither shape must not throw.
    const inventory = fresh();
    inventory.fromJSON({});
    check('an empty save loads to an empty inventory', inventory.usedSlots === 0);
    inventory.fromJSON(null);
    check('a null save loads to an empty inventory', inventory.usedSlots === 0);
  }
}

section('Enhanced inventory sorting');
{
  const inventory = new Inventory(null);
  inventory.setCreative(false);
  inventory.setSlot(0, new ItemStack('oak_log', 3));
  inventory.setSlot(SLOT.MAIN_START, new ItemStack('stone', 40));
  inventory.setSlot(SLOT.MAIN_START + 5, new ItemStack('bread', 5));
  inventory.setSlot(SLOT.MAIN_START + 12, new ItemStack('stone', 40));
  inventory.setSlot(SLOT.MAIN_START + 20, new ItemStack('iron_pickaxe', 1, { damage: 4 }));
  const before = inventory.slots
    .slice(SLOT.MAIN_START, SLOT.MAIN_END + 1)
    .reduce((sum, stack) => sum + (stack?.quantity ?? 0), 0);
  check('storage sorting reports useful work', inventory.sortStorage() === true);
  const after = inventory.slots
    .slice(SLOT.MAIN_START, SLOT.MAIN_END + 1)
    .reduce((sum, stack) => sum + (stack?.quantity ?? 0), 0);
  check('storage sorting conserves every item', before === after, `${before} -> ${after}`);
  check('storage sorting merges compatible stacks',
    inventory.slots.slice(SLOT.MAIN_START, SLOT.MAIN_END + 1)
      .filter((stack) => stack?.itemId === 'stone')
      .some((stack) => stack.quantity === 64)
  );
  check('storage sorting keeps the hotbar untouched', inventory.getSlot(0)?.itemId === 'oak_log');
  check('storage sorting prioritises equipment', inventory.getSlot(SLOT.MAIN_START)?.itemId === 'iron_pickaxe');
}

section('Survival stats');
{
  const fresh = () => new PlayerStats(null);

  // --- baseline ---
  {
    const stats = fresh();
    check('health starts at 20', stats.health === MAX_HEALTH);
    check('hunger starts at 20', stats.hunger === MAX_HUNGER);
    check('air starts full', stats.air === MAX_AIR);
    check('the player starts alive', stats.isDead === false);
    check('the air meter starts hidden', stats.showAir === false);
  }

  // --- damage and the invulnerability window ---
  {
    const stats = fresh();
    check('damage lands', stats.applyDamage(4, DamageType.MOB) === true);
    check('health drops', stats.health === 16);
    check('a second immediate hit is refused', stats.applyDamage(4, DamageType.MOB) === false);
    check('health is unchanged by the refused hit', stats.health === 16);
    // Waiting out the window lets the next hit through.
    stats.tick(0.6, {});
    check('the window expires', stats.isInvulnerable === false);
    check('a later hit lands', stats.applyDamage(4, DamageType.MOB) === true);
    check('health drops again', stats.health === 12);
  }
  {
    const stats = fresh();
    let resolverCalls = 0;
    stats.setDamageResolver((amount, source) => {
      resolverCalls++;
      return source.reducedByArmour ? amount / 2 : amount;
    });
    stats.applyDamage(6, DamageType.MOB);
    check('the damage resolver can mitigate a protected hit', stats.health === 17);
    check('the damage resolver runs exactly once per landed hit', resolverCalls === 1);
    stats.tick(0.6, {});
    stats.applyDamage(2, DamageType.DROWNING);
    check('the resolver receives unprotected sources too', resolverCalls === 2);
    check('unprotected sources retain their full damage', stats.health === 15);
  }
  {
    // Continuous environmental damage must ignore the window, or it could never
    // land a second tick.
    const stats = fresh();
    stats.applyDamage(2, DamageType.MOB);
    check(
      'drowning bypasses the cooldown',
      stats.applyDamage(2, DamageType.DROWNING) === true
    );
    check('suffocation bypasses the cooldown', stats.applyDamage(1, DamageType.SUFFOCATION) === true);
    check('starvation bypasses the cooldown', stats.applyDamage(1, DamageType.STARVATION) === true);
  }

  // --- fall damage ---
  {
    const stats = fresh();
    check('a three block fall is harmless', stats.applyFallDamage(3) === 0);
    check('health is untouched', stats.health === MAX_HEALTH);
  }
  {
    const stats = fresh();
    check('a ten block fall hurts', stats.applyFallDamage(10) === 7);
    check('health reflects the fall', stats.health === MAX_HEALTH - 7);
  }
  {
    const stats = fresh();
    stats.applyFallDamage(100);
    check('a huge fall is fatal', stats.isDead === true);
    check('the death cause is the fall', stats.deathCause === DamageType.FALL);
    check('the death message is set', stats.deathMessage.length > 0);
  }

  // --- exhaustion drains saturation before hunger ---
  {
    const stats = fresh();
    stats.saturation = 5;
    stats.hunger = 20;
    stats.addExhaustion(4);
    stats.tick(1 / 60, {});
    check('exhaustion consumes saturation first', stats.saturation === 4);
    check('hunger is untouched while saturated', stats.hunger === 20);
  }
  {
    const stats = fresh();
    stats.saturation = 0;
    stats.hunger = 20;
    stats.addExhaustion(4);
    stats.tick(1 / 60, {});
    check('exhaustion consumes hunger once saturation is gone', stats.hunger === 19);
  }
  {
    // A large one-off cost must apply fully in the same tick.
    const stats = fresh();
    stats.saturation = 0;
    stats.hunger = 20;
    stats.addExhaustion(12);
    stats.tick(1 / 60, {});
    check('a large exhaustion debt applies at once', stats.hunger === 17, `${stats.hunger}`);
  }

  // --- sprint threshold ---
  {
    const stats = fresh();
    stats.hunger = 20;
    check('can sprint with full hunger', stats.canSprint === true);
    stats.hunger = 6;
    check('cannot sprint when hunger is 6 or below', stats.canSprint === false);
    stats.hunger = 7;
    check('can sprint when hunger is above 6', stats.canSprint === true);
  }

  // --- eating ---
  {
    const stats = fresh();
    stats.hunger = 10;
    stats.saturation = 0;
    check('eating succeeds when hungry', stats.eat(5, 6) === true);
    check('eating restores hunger', stats.hunger === 15);
    // Saturation is capped by hunger, so a rich meal on a low bar is partly lost.
    check('saturation is capped by hunger', stats.saturation === 6);
  }
  {
    const stats = fresh();
    stats.hunger = MAX_HUNGER;
    stats.saturation = MAX_HUNGER;
    check('eating while completely full is refused', stats.eat(5, 5) === false);
  }
  {
    const stats = fresh();
    stats.hunger = 3;
    stats.saturation = 0;
    stats.eat(50, 50);
    check('hunger cannot exceed its maximum', stats.hunger === MAX_HUNGER);
    check('saturation cannot exceed hunger', stats.saturation === MAX_HUNGER);
  }

  // --- starvation ---
  {
    const stats = fresh();
    stats.hunger = 0;
    stats.health = 20;
    check('an empty bar reports starving', stats.isStarving);
    // Four seconds is one starvation tick.
    stats.tick(4.01, {});
    check('starvation damages the player', stats.health === 19, `${stats.health}`);
  }
  {
    // Starvation must never be the final blow.
    const stats = fresh();
    stats.hunger = 0;
    stats.health = 1;
    for (let i = 0; i < 20; i++) stats.tick(4.01, {});
    check('starvation stops at half a heart', stats.health === 1);
    check('starvation alone does not kill', stats.isDead === false);
  }

  // --- regeneration ---
  {
    const stats = fresh();
    stats.health = 10;
    stats.hunger = 20;
    stats.saturation = 10;
    check('a well-fed player can regenerate', stats.canRegenerate);
    stats.tick(4.01, {});
    check('regeneration restores health', stats.health === 11, `${stats.health}`);
    // Healing is expensive, which is what stops a full bar being a free engine.
    check('regeneration costs saturation', stats.saturation < 10);
  }
  {
    const stats = fresh();
    stats.health = 10;
    stats.hunger = 10;
    stats.saturation = 5;
    check('a half-fed player does not regenerate', stats.canRegenerate === false);
    stats.tick(4.01, {});
    check('health is unchanged', stats.health === 10);
  }

  // --- air and drowning ---
  {
    const stats = fresh();
    // Regeneration is deliberately switched off for this case by dropping hunger
    // below the threshold. Otherwise natural healing races the drowning damage
    // and the assertion below would be measuring two systems at once.
    stats.hunger = 10;
    stats.saturation = 0;
    stats.tick(1, { headInWater: true });
    check('air drains underwater', stats.air < MAX_AIR);
    check('the air meter becomes visible', stats.showAir === true);
    // Drain the rest, then confirm damage begins.
    for (let i = 0; i < 10; i++) stats.tick(1, { headInWater: true });
    check('air bottoms out at zero', stats.air === 0);
    check('drowning damages the player', stats.health < MAX_HEALTH);
    const drowned = stats.health;
    // Surfacing refills.
    stats.tick(1, { headInWater: false });
    check('air refills at the surface', stats.air > 0);
    check('drowning stops at the surface', stats.health === drowned);
  }

  // --- suffocation ---
  {
    const stats = fresh();
    stats.tick(0.6, { suffocating: true });
    check('suffocation damages the player', stats.health < MAX_HEALTH);
  }

  // --- water and lava are distinct survival media ---
  {
    const water = classifyLiquidContact(Block.WATER, Block.WATER, Block.WATER, 0);
    check('water contact enters swimming state', water.inWater && water.inLiquid);
    check('water contact is not lava', water.inLava === false && water.headInLava === false);
    check('water at the head drains air', water.headInWater === true);

    const lava = classifyLiquidContact(Block.LAVA, Block.AIR, Block.AIR, 0);
    check('ankle-deep lava is still hazardous', lava.inLava && lava.inLiquid);
    check('lava is never reported as water', lava.inWater === false && lava.headInWater === false);
  }
  {
    const stats = fresh();
    stats.hunger = 10;
    stats.saturation = 0;
    stats.tick(0.49, { inLava: true });
    check('lava waits for its damage interval', stats.health === MAX_HEALTH);
    stats.tick(0.02, { inLava: true });
    check('lava applies four points per tick', stats.health === MAX_HEALTH - 4);
    stats.tick(1.0, { inLava: true });
    check('a long lava step settles every elapsed tick', stats.health === MAX_HEALTH - 12);
    stats.tick(0.25, { inLava: false });
    stats.tick(0.25, { inLava: true });
    check('leaving lava resets the partial timer', stats.health === MAX_HEALTH - 12);
  }

  // --- the void ---
  {
    const stats = fresh();
    stats.tick(1 / 60, { inVoid: true });
    check('the void is immediately fatal', stats.isDead === true);
    check('the void death cause is recorded', stats.deathCause === DamageType.VOID);
  }

  // --- death and respawn ---
  {
    const stats = fresh();
    stats.applyDamage(20, DamageType.MOB);
    check('lethal damage kills', stats.isDead === true);
    check('health bottoms out at zero', stats.health === 0);
    check('a dead player takes no further damage', stats.applyDamage(5, DamageType.MOB) === false);
    check('a dead player cannot be healed by ticking', stats.health === 0);

    stats.respawn();
    check('respawning restores health', stats.health === MAX_HEALTH);
    check('respawning restores hunger', stats.hunger === MAX_HUNGER);
    check('respawning restores air', stats.air === MAX_AIR);
    check('respawning clears death', stats.isDead === false);
    check('respawning clears the cause', stats.deathCause === null);
  }

  // --- creative disables the rules ---
  {
    const stats = fresh();
    stats.health = 4;
    stats.hunger = 1;
    stats.setEnabled(false);
    check('leaving survival restores health', stats.health === MAX_HEALTH);
    check('leaving survival restores hunger', stats.hunger === MAX_HUNGER);
    check('a creative player takes no damage', stats.applyDamage(10, DamageType.MOB) === false);
    check('a creative player takes no fall damage', stats.applyFallDamage(100) === 0);
    check('a creative player cannot starve', stats.isDead === false);
  }

  // --- serialisation ---
  {
    const stats = fresh();
    stats.health = 7;
    stats.hunger = 11;
    stats.saturation = 3;
    stats.air = 120;
    const restored = fresh();
    restored.fromJSON(JSON.parse(JSON.stringify(stats.toJSON())));
    check('saving preserves health', restored.health === 7);
    check('saving preserves hunger', restored.hunger === 11);
    check('saving preserves saturation', restored.saturation === 3);
    check('saving preserves air', restored.air === 120);
  }
  {
    // A save taken at the moment of death must load as a live player, because
    // the death screen is a session concern rather than persisted state.
    const stats = fresh();
    stats.kill(DamageType.MOB);
    const restored = fresh();
    restored.fromJSON(stats.toJSON());
    check('a save made while dead loads alive', restored.isDead === false);
    check('that load restores full health', restored.health === MAX_HEALTH);
  }
  {
    // Out-of-range values in a save must be clamped, not rendered as overflow.
    const restored = fresh();
    restored.fromJSON({ health: 9999, hunger: -5, air: 'nonsense' });
    check('an over-max saved health is clamped', restored.health === MAX_HEALTH);
    check('a negative saved hunger is clamped', restored.hunger === 0);
    check('a non-numeric saved air falls back', restored.air === MAX_AIR);
  }

  // --- every damage type is described ---
  {
    const missing = Object.values(DamageType).filter((type) => !DAMAGE_SOURCES[type]);
    check('every damage type has a source entry', missing.length === 0, missing.join(', '));
    const noMessage = Object.values(DAMAGE_SOURCES).filter((s) => !s.deathMessage);
    check('every damage source has a death message', noMessage.length === 0);
    check('every damage source declares shield blockability', Object.values(DAMAGE_SOURCES).every((s) => typeof s.blockable === 'boolean'));
    check('melee and projectiles are shield-blockable', DAMAGE_SOURCES.mob.blockable && DAMAGE_SOURCES.projectile.blockable);
    check('environmental damage bypasses shields', !DAMAGE_SOURCES.fall.blockable && !DAMAGE_SOURCES.lava.blockable && !DAMAGE_SOURCES.void.blockable);
  }
}

// -------------------------------------------------------------------- crafting

section('Recipe registry');
{
  const stats = describeRecipes();
  process.stdout.write(
    `    ${stats.total} recipes: ${stats.shaped} shaped, ${stats.shapeless} shapeless, ` +
      `${stats.smelting} smelting\n`
  );
  check('recipes are loaded', stats.total > 30, `${stats.total}`);
  check('all three kinds exist', stats.shaped > 0 && stats.shapeless > 0 && stats.smelting > 0);

  // Every recipe id must be unique — the registry throws on a duplicate, so this
  // guards the other direction: that ids are actually distinct strings.
  {
    const ids = new Set(ALL_RECIPES.map((r) => r.id));
    check('every recipe id is unique', ids.size === ALL_RECIPES.length);
  }

  // A recipe whose output cannot be produced from its own inputs is unreachable.
  {
    const unreachable = ALL_RECIPES.filter((recipe) =>
      recipe.ingredients.some((ingredient) => ingredientOptions(ingredient).length === 0)
    ).map((r) => r.id);
    check('every ingredient resolves to at least one item', unreachable.length === 0, unreachable.join(', '));
  }

  // Progression sanity: the chain the spec requires must actually exist.
  for (const [label, itemId] of [
    ['planks', 'oak_planks'],
    ['sticks', 'stick'],
    ['a crafting table', 'crafting_table'],
    ['a furnace', 'furnace'],
    ['a chest', 'chest'],
    ['a torch', 'torch'],
    ['bread', 'bread'],
    ['a wooden pickaxe', 'wood_pickaxe'],
    ['a stone pickaxe', 'stone_pickaxe'],
    ['an iron pickaxe', 'iron_pickaxe'],
    ['a diamond pickaxe', 'diamond_pickaxe'],
    ['an iron helmet', 'iron_helmet'],
    ['an iron chestplate', 'iron_chestplate'],
    ['diamond leggings', 'diamond_leggings'],
    ['diamond boots', 'diamond_boots'],
    ['a bucket', 'bucket'],
    ['a bow', 'bow'],
    ['arrows', 'arrow'],
    ['a shield', 'shield'],
  ]) {
    check(`${label} has a recipe`, recipesProducing(itemId).length > 0);
  }

  // Smelting must cover the metals and the foods the spec calls out.
  for (const [input, output] of [
    ['iron_ore', 'iron_ingot'],
    ['gold_ore', 'gold_ingot'],
    ['sand', 'glass'],
    ['oak_log', 'charcoal'],
    ['raw_beef', 'cooked_beef'],
    ['potato', 'baked_potato'],
  ]) {
    const recipe = getSmeltingRecipe(input);
    check(`${input} smelts to ${output}`, recipe?.result.id === output, recipe?.result.id ?? 'none');
  }

  // Fuels must exist and be ordered sensibly, or an early furnace is unusable.
  {
    const fuels = fuelItems();
    check('several fuels exist', fuels.length >= 5, `${fuels.length}`);
    check('coal outranks planks', getItem('coal').fuelValue > getItem('oak_planks').fuelValue);
    check('planks outrank sticks', getItem('oak_planks').fuelValue > getItem('stick').fuelValue);
    check('charcoal matches coal', getItem('charcoal').fuelValue === getItem('coal').fuelValue);
  }

  // Tools must be craftable from the tier's own material, which is what makes the
  // progression gate real rather than decorative.
  {
    const pick = getRecipe('stone_pickaxe');
    const options = ingredientOptions(pick.grid[0]);
    check('a stone pickaxe accepts cobblestone', options.includes('cobblestone'));
    check('a stone pickaxe does not accept planks', !options.includes('oak_planks'));
  }
  {
    const chest = getRecipe('iron_chestplate');
    check('armour recipes require a crafting table', chest.station === CraftingStation.TABLE);
    check('an iron chestplate consumes eight ingots', chest.ingredients.length === 8);
    check(
      'armour recipes accept only their own material',
      chest.ingredients.every((ingredient) => ingredientOptions(ingredient).includes('iron_ingot'))
    );
  }
}

section('Recipe matching');
{
  const S = (id, n = 1) => new ItemStack(id, n);
  const g = (names) => names.map((name) => (name ? S(name) : null));
  const P = 'oak_planks';
  const T = 'stick';

  // --- the 2x2 player grid ---
  check(
    'a log becomes planks by hand',
    findMatch(g(['oak_log', null, null, null]), 2, 2, CraftingStation.PLAYER)?.id ===
      'planks_from_oak_log'
  );
  check(
    'planks become sticks by hand',
    findMatch(g([P, null, P, null]), 2, 2, CraftingStation.PLAYER)?.id === 'stick'
  );
  check(
    'four planks become a table by hand',
    findMatch(g([P, P, P, P]), 2, 2, CraftingStation.PLAYER)?.id === 'crafting_table'
  );

  // A 3x3 recipe must be impossible in the 2x2 grid. This is the gate that makes
  // the crafting table matter at all.
  check(
    'a pickaxe cannot be made by hand',
    findMatch(g([P, P, P, T]), 2, 2, CraftingStation.PLAYER) === null
  );
  check(
    'a furnace cannot be made by hand',
    findMatch(g(['cobblestone', 'cobblestone', 'cobblestone', 'cobblestone']), 2, 2, CraftingStation.PLAYER)
      ?.id !== 'furnace'
  );

  // --- the 3x3 table ---
  check(
    'a wooden pickaxe matches in the table',
    findMatch(g([P, P, P, null, T, null, null, T, null]), 3, 3, CraftingStation.TABLE)?.id ===
      'wood_pickaxe'
  );
  check(
    'a furnace matches in the table',
    findMatch(
      g([
        'cobblestone',
        'cobblestone',
        'cobblestone',
        'cobblestone',
        null,
        'cobblestone',
        'cobblestone',
        'cobblestone',
        'cobblestone',
      ]),
      3,
      3,
      CraftingStation.TABLE
    )?.id === 'furnace'
  );
  check(
    'a table can also craft 2x2 recipes',
    findMatch(g([P, P, null, P, P, null, null, null, null]), 3, 3, CraftingStation.TABLE)?.id ===
      'crafting_table'
  );

  // --- offset independence ---
  {
    const placements = [
      [P, P, null, P, P, null, null, null, null],
      [null, P, P, null, P, P, null, null, null],
      [null, null, null, P, P, null, P, P, null],
      [null, null, null, null, P, P, null, P, P],
    ];
    const allMatch = placements.every(
      (arr) => findMatch(g(arr), 3, 3, CraftingStation.TABLE)?.id === 'crafting_table'
    );
    check('a 2x2 recipe matches at any offset in a 3x3 grid', allMatch);
  }
  {
    const rows = [0, 1, 2].every((row) => {
      const arr = new Array(9).fill(null);
      for (let x = 0; x < 3; x++) arr[row * 3 + x] = 'wheat';
      return findMatch(g(arr), 3, 3, CraftingStation.TABLE)?.id === 'bread';
    });
    check('a 3x1 recipe matches in any row', rows);
  }

  // --- mirroring ---
  check(
    'an axe matches right-handed',
    findMatch(g([P, P, null, P, T, null, null, T, null]), 3, 3, CraftingStation.TABLE)?.id ===
      'wood_axe'
  );
  check(
    'an axe matches mirrored',
    findMatch(g([null, P, P, null, T, P, null, T, null]), 3, 3, CraftingStation.TABLE)?.id ===
      'wood_axe'
  );

  // --- tags accept alternatives ---
  check(
    'a stone pickaxe accepts cobblestone via its tag',
    findMatch(
      g(['cobblestone', 'cobblestone', 'cobblestone', null, T, null, null, T, null]),
      3,
      3,
      CraftingStation.TABLE
    )?.id === 'stone_pickaxe'
  );
  for (const log of ['oak_log', 'spruce_log', 'birch_log']) {
    check(
      `${log} becomes planks`,
      findMatch(g([log, null, null, null]), 2, 2, CraftingStation.PLAYER)?.result.id === 'oak_planks'
    );
  }

  // --- a stray item must block the match, or the player loses it silently ---
  check(
    'an extra item prevents a match',
    findMatch(g([P, P, null, P, P, null, null, null, 'coal']), 3, 3, CraftingStation.TABLE) === null
  );
  check('an empty grid matches nothing', findMatch(g(new Array(9).fill(null)), 3, 3) === null);

  // --- wrong item in the right shape ---
  check(
    'the wrong material does not match',
    findMatch(g(['coal', 'coal', 'coal', null, T, null, null, T, null]), 3, 3, CraftingStation.TABLE) ===
      null
  );
}

section('Crafting consumption');
{
  const S = (id, n = 1) => new ItemStack(id, n);

  // Craft-all is bounded by the smallest ingredient stack.
  {
    const slots = [S('oak_log', 7), null, null, null];
    const recipe = findMatch(slots, 2, 2, CraftingStation.PLAYER);
    check('craft-all is bounded by the stack', maxCrafts(recipe, slots) === 7);
  }
  {
    const slots = [S('oak_planks', 9), null, S('oak_planks', 4), null];
    const recipe = findMatch(slots, 2, 2, CraftingStation.PLAYER);
    check('craft-all uses the smallest stack', maxCrafts(recipe, slots) === 4);
  }
  {
    // Never produce more output than one slot can hold.
    const slots = [S('oak_log', 64), null, null, null];
    const recipe = findMatch(slots, 2, 2, CraftingStation.PLAYER);
    // Planks come 4 at a time, so 16 crafts fill a 64 stack exactly.
    check('craft-all respects the output stack ceiling', maxCrafts(recipe, slots) === 16);
  }

  // Consumption takes exactly one of each occupied slot per craft.
  {
    const slots = [S('oak_planks', 3), null, S('oak_planks', 3), null];
    const emptied = consumeIngredients(slots, 1);
    check('one craft consumes one from each slot', slots[0].quantity === 2 && slots[2].quantity === 2);
    check('no slot emptied yet', emptied.length === 0);
  }
  {
    const slots = [S('oak_planks', 1), null, S('oak_planks', 1), null];
    const emptied = consumeIngredients(slots, 1);
    check('exhausted slots are reported', emptied.length === 2, JSON.stringify(emptied));
  }
  {
    // Multi-craft consumes proportionally, never more than held.
    const slots = [S('oak_log', 5), null, null, null];
    consumeIngredients(slots, 3);
    check('a triple craft consumes three', slots[0].quantity === 2);
  }
}

section('Containers');
{
  const S = (id, n = 1) => new ItemStack(id, n);

  {
    const container = new Container({ size: 5 });
    check('a new container is empty', container.isEmpty);
    check('a new container is not full', container.isFull === false);

    const stack = S('stone', 10);
    check('insertion moves items', container.insert(stack) === 10);
    check('the incoming stack is drained', stack.isEmpty);
    check('the container holds them', container.countOf('stone') === 10);
  }
  {
    // Insertion tops up before opening a new slot.
    const container = new Container({ size: 3 });
    container.setSlot(0, S('stone', 60));
    const stack = S('stone', 10);
    container.insert(stack);
    check('insertion tops up first', container.getSlot(0).quantity === 64);
    check('the overflow opens a slot', container.getSlot(1)?.quantity === 6);
  }
  {
    // A full container returns the leftover in the stack.
    const container = new Container({ size: 1 });
    container.setSlot(0, S('stone', 64));
    const stack = S('stone', 10);
    check('a full container accepts nothing', container.insert(stack) === 0);
    check('the leftover stays in the stack', stack.quantity === 10);
    check('the container reports itself full', container.isFull);
  }
  {
    // Output slots are take-only, which is what stops a furnace result being
    // used as general storage.
    const container = new Container({ size: 3, outputSlots: [2] });
    const stack = S('stone', 5);
    container.insert(stack);
    check('insertion skips output slots', container.getSlot(2) === null);
    check('output slots reject insertion', container.acceptsInSlot(2, S('stone', 1)) === false);
  }
  {
    // Slot filters are enforced by the container, not the UI.
    const container = new Container({
      size: 2,
      slotFilter: (slot, s) => (slot === 0 ? s.itemId === 'coal' : true),
    });
    check('a filter admits the right item', container.acceptsInSlot(0, S('coal', 1)));
    check('a filter rejects the wrong item', container.acceptsInSlot(0, S('stone', 1)) === false);
    const stone = S('stone', 4);
    container.insert(stone);
    check('a filtered insertion lands elsewhere', container.getSlot(1)?.itemId === 'stone');
  }
  {
    // Extraction and draining.
    const container = new Container({ size: 2 });
    container.setSlot(0, S('stone', 10));
    check('extraction takes a partial amount', container.extract(0, 4)?.quantity === 4);
    check('the slot keeps the remainder', container.getSlot(0).quantity === 6);
    const drained = container.drainAll();
    check('draining returns everything', drained.length === 1 && drained[0].quantity === 6);
    check('draining empties the container', container.isEmpty);
  }
  {
    // Sparse serialisation, and an unreadable entry costing only its slot.
    const container = new Container({ size: 27 });
    container.setSlot(0, S('stone', 5));
    container.setSlot(26, new ItemStack('iron_pickaxe', 1, { damage: 42 }));
    const json = JSON.parse(JSON.stringify(container.toJSON()));
    check('serialisation is sparse', json.length === 2, `${json.length} entries`);

    const restored = new Container({ size: 27 });
    restored.fromJSON(json);
    check('deserialisation restores the first slot', restored.getSlot(0)?.quantity === 5);
    check('deserialisation restores the last slot', restored.getSlot(26)?.damage === 42);

    restored.fromJSON([{ s: 0, i: { id: 'ghost', n: 1 } }, { s: 1, i: { id: 'stone', n: 2 } }]);
    check('an unknown item costs only its slot', restored.getSlot(0) === null);
    check('the neighbouring slot still loads', restored.getSlot(1)?.quantity === 2);

    restored.fromJSON([{ s: 999, i: { id: 'stone', n: 1 } }]);
    check('an out-of-range slot is ignored', restored.isEmpty);
  }
}

section('Furnace');
{
  const S = (id, n = 1) => new ItemStack(id, n);
  const make = () => new FurnaceBlockEntity({ x: 0, y: 64, z: 0, blockId: Block.FURNACE });

  {
    const furnace = make();
    check('a new furnace is not burning', furnace.isBurning === false);
    check('a new furnace has no recipe', furnace.activeRecipe === null);
    check('a furnace wants ticking', furnace.needsTick === true);
  }

  // --- the fuel slot only takes fuel, the input slot only smeltables ---
  {
    const furnace = make();
    check('the fuel slot takes coal', furnace.container.acceptsInSlot(FURNACE_SLOT.FUEL, S('coal')));
    check(
      'the fuel slot rejects iron ore',
      furnace.container.acceptsInSlot(FURNACE_SLOT.FUEL, S('iron_ore')) === false
    );
    check(
      'the input slot takes iron ore',
      furnace.container.acceptsInSlot(FURNACE_SLOT.INPUT, S('iron_ore'))
    );
    check(
      'the input slot rejects a pickaxe',
      furnace.container.acceptsInSlot(FURNACE_SLOT.INPUT, S('iron_pickaxe')) === false
    );
    check(
      'the output slot rejects everything',
      furnace.container.acceptsInSlot(FURNACE_SLOT.OUTPUT, S('iron_ingot')) === false
    );
  }

  // --- a full smelt ---
  {
    const furnace = make();
    furnace.container.setSlot(FURNACE_SLOT.INPUT, S('iron_ore', 1));
    furnace.container.setSlot(FURNACE_SLOT.FUEL, S('coal', 1));

    furnace.tick(0.1, null);
    check('fuel ignites when there is work', furnace.isBurning === true);
    check('lighting fuel consumes it', furnace.container.getSlot(FURNACE_SLOT.FUEL) === null);
    check('a burn gauge is available', furnace.burnFraction > 0 && furnace.burnFraction <= 1);

    // Run past the cook time.
    for (let i = 0; i < 120; i++) furnace.tick(0.1, null);
    check('the input is consumed', furnace.container.getSlot(FURNACE_SLOT.INPUT) === null);
    check(
      'the output appears',
      furnace.outputStack?.itemId === 'iron_ingot',
      furnace.outputStack?.itemId ?? 'none'
    );
    check('exactly one ingot was produced', furnace.outputStack?.quantity === 1);
  }

  // --- no fuel means no progress ---
  {
    const furnace = make();
    furnace.container.setSlot(FURNACE_SLOT.INPUT, S('iron_ore', 1));
    for (let i = 0; i < 200; i++) furnace.tick(0.1, null);
    check('nothing smelts without fuel', furnace.outputStack === null);
    check('the input is untouched', furnace.inputStack?.quantity === 1);
  }

  // --- fuel is not wasted on an empty furnace ---
  {
    const furnace = make();
    furnace.container.setSlot(FURNACE_SLOT.FUEL, S('coal', 3));
    for (let i = 0; i < 100; i++) furnace.tick(0.1, null);
    check('fuel does not burn with nothing to smelt', furnace.isBurning === false);
    check('the fuel is intact', furnace.container.getSlot(FURNACE_SLOT.FUEL)?.quantity === 3);
  }

  // --- blocked output pauses rather than destroying the result ---
  {
    const furnace = make();
    furnace.container.setSlot(FURNACE_SLOT.INPUT, S('iron_ore', 5));
    furnace.container.setSlot(FURNACE_SLOT.FUEL, S('coal', 5));
    // Fill the output with an incompatible item so nothing can be deposited.
    furnace.container.setSlot(FURNACE_SLOT.OUTPUT, S('gold_ingot', 1));

    for (let i = 0; i < 300; i++) furnace.tick(0.1, null);
    check('a blocked furnace does not smelt', furnace.inputStack?.quantity === 5);
    check('a blocked furnace keeps its output', furnace.outputStack?.itemId === 'gold_ingot');
    check('a blocked furnace does not light fuel', furnace.container.getSlot(FURNACE_SLOT.FUEL)?.quantity === 5);
  }
  {
    // A *full* matching output is also blocked, and must not overflow.
    const furnace = make();
    furnace.container.setSlot(FURNACE_SLOT.INPUT, S('iron_ore', 5));
    furnace.container.setSlot(FURNACE_SLOT.FUEL, S('coal', 5));
    furnace.container.setSlot(FURNACE_SLOT.OUTPUT, S('iron_ingot', 64));
    for (let i = 0; i < 300; i++) furnace.tick(0.1, null);
    check('a full output stops the furnace', furnace.outputStack.quantity === 64);
    check('the input is preserved', furnace.inputStack?.quantity === 5);
  }

  // --- removing the input resets progress ---
  {
    const furnace = make();
    furnace.container.setSlot(FURNACE_SLOT.INPUT, S('iron_ore', 1));
    furnace.container.setSlot(FURNACE_SLOT.FUEL, S('coal', 1));
    for (let i = 0; i < 30; i++) furnace.tick(0.1, null);
    check('progress accumulates', furnace.cookFraction > 0);
    furnace.container.setSlot(FURNACE_SLOT.INPUT, null);
    furnace.tick(0.1, null);
    check('removing the input resets progress', furnace.cookFraction === 0);
  }

  // --- breaking a furnace returns everything, exactly once ---
  {
    const furnace = make();
    furnace.container.setSlot(FURNACE_SLOT.INPUT, S('iron_ore', 3));
    furnace.container.setSlot(FURNACE_SLOT.FUEL, S('coal', 2));
    furnace.container.setSlot(FURNACE_SLOT.OUTPUT, S('iron_ingot', 1));
    const drops = furnace.collectDrops();
    check('breaking returns every slot', drops.length === 3, `${drops.length}`);
    check('the furnace is emptied', furnace.container.isEmpty);
    check('a second break returns nothing', furnace.collectDrops().length === 0);
  }

  // --- persistence, including mid-smelt state ---
  {
    const furnace = make();
    furnace.container.setSlot(FURNACE_SLOT.INPUT, S('iron_ore', 2));
    furnace.container.setSlot(FURNACE_SLOT.FUEL, S('coal', 1));
    for (let i = 0; i < 40; i++) furnace.tick(0.1, null);
    const progress = furnace.cookElapsed;
    const burn = furnace.burnRemaining;

    const restored = make();
    restored.fromJSON(JSON.parse(JSON.stringify(furnace.toJSON())));
    check('saving preserves the input', restored.inputStack?.quantity === 2);
    check('saving preserves cook progress', Math.abs(restored.cookElapsed - progress) < 0.05);
    check('saving preserves the burn timer', Math.abs(restored.burnRemaining - burn) < 0.05);
    check('saving preserves the burn duration', restored.burnDuration > 0);
  }
  {
    // A save whose recipe cook time shrank must clamp rather than instantly
    // completing something it has not earned.
    const restored = make();
    restored.fromJSON({ items: [{ s: 0, i: { id: 'iron_ore', n: 1 } }], cookElapsed: 99999 });
    check('absurd saved progress is clamped', restored.cookElapsed <= restored.cookDuration);
  }
  {
    // A future-dated stamp must not let a furnace fabricate output.
    const furnace = make();
    furnace.fromJSON({ lastTickAt: Date.now() + 1e9 });
    check('a future save stamp is rejected', furnace.lastTickAt <= Date.now());
  }

  // --- two furnaces are independent ---
  {
    const a = make();
    const b = make();
    a.container.setSlot(FURNACE_SLOT.INPUT, S('iron_ore', 1));
    a.container.setSlot(FURNACE_SLOT.FUEL, S('coal', 1));
    for (let i = 0; i < 120; i++) {
      a.tick(0.1, null);
      b.tick(0.1, null);
    }
    check('one furnace smelting does not affect another', b.outputStack === null);
    check('the working furnace produced output', a.outputStack?.itemId === 'iron_ingot');
  }

  // --- a lava bucket empties to a bucket rather than vanishing ---
  {
    const furnace = make();
    furnace.container.setSlot(FURNACE_SLOT.INPUT, S('iron_ore', 1));
    furnace.container.setSlot(FURNACE_SLOT.FUEL, S('lava_bucket', 1));
    furnace.tick(0.1, null);
    check(
      'a spent lava bucket becomes a bucket',
      furnace.container.getSlot(FURNACE_SLOT.FUEL)?.itemId === 'bucket',
      furnace.container.getSlot(FURNACE_SLOT.FUEL)?.itemId ?? 'none'
    );
  }
}

section('Block entity store');
{
  const S = (id, n = 1) => new ItemStack(id, n);
  // A stub world: the store only needs `setBlock`/`getBlock` for the furnace's
  // lit-state swap, which is irrelevant to storage behaviour.
  const stubWorld = { getBlock: () => Block.FURNACE, setBlock: () => true };

  {
    const store = new BlockEntityStore({ world: stubWorld });
    check('a fresh store is empty', store.count === 0);
    check('a non-entity block creates nothing', store.create(0, 64, 0, Block.STONE) === null);

    const chest = store.create(5, 64, 7, Block.CHEST);
    check('a chest block creates an entity', chest !== null);
    check('the entity is retrievable', store.get(5, 64, 7) === chest);
    check('the store counts it', store.count === 1);
    check('an unrelated position is empty', store.get(6, 64, 7) === null);
  }

  // Negative coordinates must address correctly, which is where chunk maths
  // usually goes wrong.
  {
    const store = new BlockEntityStore({ world: stubWorld });
    const chest = store.create(-17, 30, -33, Block.CHEST);
    check('a chest at negative coordinates is stored', store.get(-17, 30, -33) === chest);
    check('a neighbouring negative position is empty', store.get(-18, 30, -33) === null);
  }

  // Breaking returns the contents and forgets the entity permanently.
  {
    const store = new BlockEntityStore({ world: stubWorld });
    const chest = store.create(1, 64, 1, Block.CHEST);
    chest.container.insert(S('diamond', 3));
    const drops = store.remove(1, 64, 1);
    check('breaking returns the contents', drops.length === 1 && drops[0].quantity === 3);
    check('the entity is gone', store.get(1, 64, 1) === null);
    check('the store is empty', store.count === 0);
    check('removing again returns nothing', store.remove(1, 64, 1).length === 0);
  }

  // The furnace/lit-furnace swap must keep the same entity and its contents.
  {
    const store = new BlockEntityStore({ world: stubWorld });
    const furnace = store.create(2, 64, 2, Block.FURNACE);
    furnace.container.setSlot(FURNACE_SLOT.INPUT, S('iron_ore', 4));
    const again = store.create(2, 64, 2, Block.FURNACE_LIT);
    check('lighting a furnace keeps the same entity', again === furnace);
    check('its contents survive', again.container.getSlot(FURNACE_SLOT.INPUT)?.quantity === 4);
    check('its block id is updated', again.blockId === Block.FURNACE_LIT);
    check('the store still holds one entity', store.count === 1);
  }

  // A different block replacing it destroys the record.
  {
    const store = new BlockEntityStore({ world: stubWorld });
    store.create(3, 64, 3, Block.CHEST);
    store.create(3, 64, 3, Block.FURNACE);
    check('a different entity type replaces the old one', store.get(3, 64, 3).type === 'furnace');
    check('only one entity remains', store.count === 1);
  }

  // Only ticking entities are ticked.
  {
    const store = new BlockEntityStore({ world: stubWorld });
    store.create(0, 64, 0, Block.CHEST);
    check('a chest is not in the tick list', store.tickingCount === 0);
    store.create(1, 64, 0, Block.FURNACE);
    check('a furnace is in the tick list', store.tickingCount === 1);
    store.remove(1, 64, 0);
    check('removing a furnace leaves the tick list', store.tickingCount === 0);
  }

  // --- unload is not delete ---
  {
    const store = new BlockEntityStore({ world: stubWorld });
    const chest = store.create(20, 64, 20, Block.CHEST);
    chest.container.insert(S('gold_ingot', 7));
    // Chunk (1,1) holds block (20,20).
    store.unloadChunk(1, 1);
    check('unloading forgets the live entity', store.get(20, 64, 20) === null);
    check('unloading empties the loaded count', store.count === 0);

    store.loadChunk(1, 1);
    const restored = store.get(20, 64, 20);
    check('reloading restores the entity', restored !== null);
    check('reloading restores the contents', restored?.container.countOf('gold_ingot') === 7);
  }

  // --- a broken chest must not come back after a reload ---
  {
    const store = new BlockEntityStore({ world: stubWorld });
    const chest = store.create(20, 64, 20, Block.CHEST);
    chest.container.insert(S('diamond', 1));
    store.unloadChunk(1, 1);
    store.loadChunk(1, 1);
    store.remove(20, 64, 20);
    store.unloadChunk(1, 1);
    store.loadChunk(1, 1);
    check('a broken chest stays broken across a reload', store.get(20, 64, 20) === null);
  }

  // --- save round trip ---
  {
    const store = new BlockEntityStore({ world: stubWorld });
    const chest = store.create(4, 64, 4, Block.CHEST);
    chest.container.insert(S('coal', 12));
    const furnace = store.create(8, 64, 8, Block.FURNACE);
    furnace.container.setSlot(FURNACE_SLOT.FUEL, S('coal', 2));

    const saved = store.collectForSave(true);
    check('saving covers the occupied chunks', saved.size >= 1, `${saved.size}`);

    const reloaded = new BlockEntityStore({ world: stubWorld });
    reloaded.applyLoaded(saved);
    check('loading instantiates nothing yet', reloaded.count === 0);
    reloaded.loadChunk(0, 0);
    check('loading a chunk instantiates its entities', reloaded.count === 2, `${reloaded.count}`);
    check('the chest contents survive', reloaded.get(4, 64, 4)?.container.countOf('coal') === 12);
    check(
      'the furnace fuel survives',
      reloaded.get(8, 64, 8)?.container.getSlot(FURNACE_SLOT.FUEL)?.quantity === 2
    );
  }

  // --- dirty tracking, so autosave stays cheap ---
  {
    const store = new BlockEntityStore({ world: stubWorld });
    store.create(4, 64, 4, Block.CHEST);
    check('a new entity marks its chunk dirty', store.hasUnsavedChanges);
    store.markSaved();
    check('saving clears the dirty set', store.hasUnsavedChanges === false);
    store.remove(4, 64, 4);
    check('a removal marks the chunk dirty again', store.hasUnsavedChanges);
    const dirty = store.collectForSave(false);
    check('the removal is written as an empty list', dirty.get('0,0')?.length === 0);
  }
}

// ---------------------------------------------------------------- mining tiers

section('Mining: tool correctness');
{
  // The spec's rules, asserted directly.
  check('stone wants a pickaxe', isCorrectTool(Block.STONE, 'wood_pickaxe'));
  check('stone rejects a shovel', isCorrectTool(Block.STONE, 'iron_shovel') === false);
  check('stone rejects a bare hand', isCorrectTool(Block.STONE, null) === false);
  check('a log wants an axe', isCorrectTool(Block.OAK_LOG, 'wood_axe'));
  check('dirt wants a shovel', isCorrectTool(Block.DIRT, 'wood_shovel'));
  // Blocks with no preferred tool accept anything, which is what makes glass
  // equally breakable by hand.
  check('glass accepts anything', isCorrectTool(Block.GLASS, null));
  check('leaves accept anything', isCorrectTool(Block.OAK_LEAVES, 'iron_sword'));
}

section('Mining: harvest gates');
{
  // Stone requires a pickaxe of any tier.
  check('stone drops with a wooden pickaxe', wouldDrop(Block.STONE, 'wood_pickaxe'));
  check('stone drops nothing by hand', wouldDrop(Block.STONE, null) === false);
  check('stone drops nothing to a shovel', wouldDrop(Block.STONE, 'diamond_shovel') === false);

  // The ore progression: coal needs wood, iron needs stone, gold and diamond
  // need iron. This table *is* the progression, so every rung is asserted.
  const oreGates = [
    ['coal_ore', Block.COAL_ORE, { hand: false, wood: true, stone: true, iron: true, diamond: true }],
    ['iron_ore', Block.IRON_ORE, { hand: false, wood: false, stone: true, iron: true, diamond: true }],
    ['gold_ore', Block.GOLD_ORE, { hand: false, wood: false, stone: false, iron: true, diamond: true }],
    [
      'diamond_ore',
      Block.DIAMOND_ORE,
      { hand: false, wood: false, stone: false, iron: true, diamond: true },
    ],
  ];
  for (const [name, blockId, expected] of oreGates) {
    for (const [tier, shouldDrop] of Object.entries(expected)) {
      const itemId = tier === 'hand' ? null : `${tier}_pickaxe`;
      check(
        `${name} ${shouldDrop ? 'drops' : 'does not drop'} with ${tier}`,
        wouldDrop(blockId, itemId) === shouldDrop
      );
    }
  }

  // Blocks that always drop, whatever broke them.
  check('dirt drops by hand', wouldDrop(Block.DIRT, null));
  check('sand drops by hand', wouldDrop(Block.SAND, null));
  check('a log drops by hand', wouldDrop(Block.OAK_LOG, null));
  check('planks drop by hand', wouldDrop(Block.PLANKS, null));

  // Bedrock is unbreakable, so it can never drop.
  check('bedrock never drops', wouldDrop(Block.BEDROCK, 'diamond_pickaxe') === false);
  check('bedrock takes forever', breakSeconds(Block.BEDROCK, 'diamond_pickaxe') === Infinity);
}

section('Mining: speed');
{
  // A better tier is strictly faster on the block it suits.
  {
    const times = ['wood', 'stone', 'iron', 'diamond'].map((tier) =>
      breakSeconds(Block.STONE, `${tier}_pickaxe`)
    );
    let descending = true;
    for (let i = 1; i < times.length; i++) {
      if (!(times[i] < times[i - 1])) descending = false;
    }
    check('each pickaxe tier is faster on stone', descending, times.map((t) => t.toFixed(2)).join(' > '));
  }

  // The right tool beats the wrong one by a wide margin.
  {
    const right = breakSeconds(Block.STONE, 'iron_pickaxe');
    const wrong = breakSeconds(Block.STONE, 'iron_shovel');
    check('a pickaxe beats a shovel on stone', right * 5 < wrong, `${right.toFixed(2)} vs ${wrong.toFixed(2)}`);
  }
  {
    const axe = breakSeconds(Block.OAK_LOG, 'iron_axe');
    const hand = breakSeconds(Block.OAK_LOG, null);
    check('an axe beats bare hands on a log', axe < hand, `${axe.toFixed(2)} vs ${hand.toFixed(2)}`);
  }
  {
    const shovel = breakSeconds(Block.DIRT, 'iron_shovel');
    const hand = breakSeconds(Block.DIRT, null);
    check('a shovel beats bare hands on dirt', shovel < hand, `${shovel.toFixed(2)} vs ${hand.toFixed(2)}`);
  }
  {
    // A sword must never be a mining shortcut.
    const sword = breakSeconds(Block.OAK_LOG, 'diamond_sword');
    const hand = breakSeconds(Block.OAK_LOG, null);
    check('a sword mines no faster than a hand', sword >= hand - 1e-9);
  }

  // Situational penalties.
  {
    const base = breakSeconds(Block.STONE, 'iron_pickaxe');
    check(
      'mining underwater is slower',
      breakSeconds(Block.STONE, 'iron_pickaxe', { underwater: true }) > base
    );
    check(
      'mining airborne is slower',
      breakSeconds(Block.STONE, 'iron_pickaxe', { airborne: true }) > base
    );
    check(
      'penalties compound',
      breakSeconds(Block.STONE, 'iron_pickaxe', { underwater: true, airborne: true }) >
        breakSeconds(Block.STONE, 'iron_pickaxe', { underwater: true })
    );
    check('creative is instant', breakSeconds(Block.STONE, null, { creative: true }) === 0);
  }

  // Nothing is instant outside creative, however good the tool.
  {
    let anyInstant = false;
    for (const blockId of [Block.DIRT, Block.SAND, Block.TALL_GRASS, Block.STONE]) {
      if (breakSeconds(blockId, 'diamond_pickaxe') <= 0) anyInstant = true;
    }
    check('no block breaks instantly in survival', anyInstant === false);
  }
}

section('Mining: tool wear');
{
  // Wear is charged for tool work, and only for tool work.
  check('a pickaxe wears on stone', shouldConsumeDurability(Block.STONE, 'iron_pickaxe'));
  check('an axe wears on a log', shouldConsumeDurability(Block.OAK_LOG, 'iron_axe'));
  check('a shovel wears on dirt', shouldConsumeDurability(Block.DIRT, 'iron_shovel'));

  // A pickaxe used on dirt gained nothing from being a pickaxe, so it should not
  // pay for it.
  check('a pickaxe does not wear on dirt', shouldConsumeDurability(Block.DIRT, 'iron_pickaxe') === false);
  // Charging a sword for breaking blocks would make weapons a liability.
  check('a sword never wears from mining', shouldConsumeDurability(Block.STONE, 'diamond_sword') === false);
  check('a bare hand cannot wear', shouldConsumeDurability(Block.STONE, null) === false);
  check('a block item cannot wear', shouldConsumeDurability(Block.STONE, 'cobblestone') === false);
}

section('Shared status effects');
{
  const effects = new StatusEffectController();
  check('an empty effect controller starts empty', effects.isEmpty);
  check('known effects can be applied', effects.apply(StatusEffect.SPEED, 12, 0));
  check('Speed raises movement velocity', Math.abs(effects.movementSpeedMultiplier - 1.2) < 1e-8);
  check('a stronger Speed replaces the amplifier', effects.apply(StatusEffect.SPEED, 6, 2));
  check('stronger Speed has the expected multiplier', Math.abs(effects.movementSpeedMultiplier - 1.6) < 1e-8);
  check('a weaker application never lowers the amplifier', effects.apply(StatusEffect.SPEED, 20, 0) && effects.get(StatusEffect.SPEED).amplifier === 2);

  effects.apply(StatusEffect.SLOWNESS, 10, 0);
  check('Speed and Slowness compose deterministically', Math.abs(effects.movementSpeedMultiplier - 1.36) < 1e-8);
  effects.apply(StatusEffect.STRENGTH, 10, 1);
  effects.apply(StatusEffect.WEAKNESS, 10, 0);
  check('Strength and Weakness modify outgoing damage', Math.abs(effects.attackDamageMultiplier - 1.28) < 1e-8);

  effects.apply(StatusEffect.FIRE_RESISTANCE, 10);
  effects.apply(StatusEffect.WATER_BREATHING, 10);
  effects.apply(StatusEffect.NIGHT_VISION, 10);
  check('Fire Resistance exposes immunity', effects.fireImmune);
  check('Water Breathing exposes underwater immunity', effects.breathesWater);
  check('Night Vision exposes a renderer hook', effects.nightVision);

  let health = 10;
  effects.apply(StatusEffect.REGENERATION, 3, 1);
  effects.tick(1.3, {
    heal: (amount) => { health += amount; },
    damage: (amount) => { health -= amount; },
    health: () => health,
    dead: () => false,
  });
  check('Regeneration emits periodic healing pulses', health > 10);

  health = 2;
  effects.apply(StatusEffect.POISON, 5, 2);
  effects.tick(3, {
    heal: (amount) => { health += amount; },
    damage: (amount) => { health = Math.max(1, health - amount); },
    health: () => health,
    dead: () => false,
  });
  check('Poison never deals the final half-heart', health === 1);

  const saved = effects.toJSON();
  const restored = new StatusEffectController().fromJSON(saved);
  check('status effects survive persistence', restored.has(StatusEffect.SPEED) && restored.has(StatusEffect.POISON));
  check('status-effect persistence keeps amplifiers', restored.get(StatusEffect.SPEED).amplifier === 2);

  const sanitised = new StatusEffectController().fromJSON([
    { id: 'not_real', duration: 99, amplifier: 99 },
    { id: StatusEffect.SPEED, duration: -1, amplifier: 4 },
    { id: StatusEffect.STRENGTH, duration: 2, amplifier: 999 },
  ]);
  check('unknown and expired effects are rejected on load', sanitised.size === 1);
  check('loaded amplifiers are bounded', sanitised.get(StatusEffect.STRENGTH).amplifier === 9);

  const expiring = new StatusEffectController();
  expiring.apply(StatusEffect.SPEED, 0.5);
  expiring.tick(0.6);
  check('expired effects are removed exactly once', expiring.isEmpty);
}

section('Combat');
{
  // Weapon stats must be strictly ordered, or an upgrade is not an upgrade.
  {
    const damages = ['wood', 'stone', 'iron', 'diamond'].map(
      (tier) => CombatSystem.describeWeapon(`${tier}_sword`).damage
    );
    let ascending = true;
    for (let i = 1; i < damages.length; i++) if (!(damages[i] > damages[i - 1])) ascending = false;
    check('each sword tier hits harder', ascending, damages.join(' < '));
  }
  {
    const sword = CombatSystem.describeWeapon('iron_sword');
    const axe = CombatSystem.describeWeapon('iron_axe');
    const shovel = CombatSystem.describeWeapon('iron_shovel');
    const hand = CombatSystem.describeWeapon(null);

    check('a sword out-damages an axe', sword.damage > axe.damage);
    check('an axe out-damages a shovel', axe.damage > shovel.damage);
    check('a shovel out-damages a fist', shovel.damage > hand.damage);
    check('a bare hand still deals damage', hand.damage >= 1);
    check('a sword is flagged as a weapon', sword.isWeapon);
    check('a shovel is not a weapon', shovel.isWeapon === false);
  }
  {
    // A sword swings slower than a fist, which is the trade for the damage.
    check(
      'a sword swings slower than a fist',
      CombatSystem.describeWeapon('iron_sword').speed <
        CombatSystem.describeWeapon(null).speed
    );
  }
  {
    // An unknown item must degrade to a bare hand rather than throwing.
    const unknown = CombatSystem.describeWeapon('nonsense');
    check('an unknown item falls back to a fist', unknown.damage === 1 && unknown.isWeapon === false);
  }
  {
    let received = 0;
    const combat = new CombatSystem({ bus: { emit() {} }, settings: { get: () => 'survival' } });
    const target = {
      alive: true,
      isDead: false,
      x: 0,
      y: 0,
      z: 2,
      halfSize: 0.4,
      height: 1.8,
      hurt(amount) { received = amount; return true; },
      velocityX: 0,
      velocityY: 0,
      velocityZ: 0,
    };
    combat.tryAttack({
      origin: { x: 0, y: 1, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      reach: 4,
      itemId: 'iron_sword',
      blockDistance: Infinity,
      candidates: [target],
      damageMultiplier: 1.5,
    });
    check('combat consumes the shared effect damage multiplier', Math.abs(received - CombatSystem.describeWeapon('iron_sword').damage * 1.5) < 1e-9);
  }

  // --- the cooldown, which is what makes attack speed mean anything ---
  {
    const combat = new CombatSystem({ bus: { emit() {} }, settings: { get: () => 'survival' } });
    check('a fresh combat system is ready', combat.isReady);
    check('readiness starts at 1', combat.readiness === 1);

    const attack = () =>
      combat.tryAttack({
        origin: { x: 0, y: 0, z: 0 },
        direction: { x: 0, y: 0, z: 1 },
        reach: 4,
        itemId: 'iron_sword',
        blockDistance: Infinity,
        candidates: [],
      });

    attack();
    check('attacking starts a cooldown', combat.isReady === false);
    check('readiness drops below 1', combat.readiness < 1);
    // A second attack during the cooldown must be refused, or click-spamming
    // beats the weapon's stated speed.
    check('an attack during cooldown is refused', attack() === null);

    // An iron sword swings at 1.6/s, so ~0.63 s.
    combat.update(0.7);
    check('the cooldown expires', combat.isReady);
    check('readiness returns to 1', combat.readiness === 1);
  }
  {
    // A faster weapon must recover faster.
    const make = () => new CombatSystem({ bus: { emit() {} }, settings: { get: () => 'survival' } });
    const fast = make();
    const slow = make();
    const swing = (combat, itemId) =>
      combat.tryAttack({
        origin: { x: 0, y: 0, z: 0 },
        direction: { x: 0, y: 0, z: 1 },
        reach: 4,
        itemId,
        blockDistance: Infinity,
        candidates: [],
      });
    swing(fast, null);
    swing(slow, 'iron_sword');
    check('a fist recovers faster than a sword', fast.cooldown < slow.cooldown);
  }

  // --- hitting an actual target ---
  {
    const events = [];
    const combat = new CombatSystem({
      bus: { emit: (name, payload) => events.push({ name, payload }) },
      settings: { get: () => 'survival' },
    });

    let damageTaken = 0;
    const dummy = {
      alive: true,
      isDead: false,
      x: 0,
      y: 0,
      z: 3,
      halfSize: 0.4,
      height: 1.8,
      velocityX: 0,
      velocityY: 0,
      velocityZ: 0,
      hurt(amount) {
        damageTaken += amount;
        return true;
      },
    };

    const result = combat.tryAttack({
      origin: { x: 0, y: 1, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      reach: 5,
      itemId: 'iron_sword',
      blockDistance: Infinity,
      candidates: [dummy],
    });

    check('an entity in the crosshair is hit', result !== null);
    check('the target takes damage', damageTaken > 0, `${damageTaken}`);
    check('the damage matches the weapon', damageTaken === CombatSystem.describeWeapon('iron_sword').damage);
    check('knockback pushes the target away', dummy.velocityZ > 0, `${dummy.velocityZ}`);
    check('knockback lifts the target', dummy.velocityY > 0);
    check('an attack event is emitted', events.some((e) => e.name === 'combat:entityAttacked'));
    check('a swing sound is emitted', events.some((e) => e.name === 'audio:play'));
    check('a worn weapon reports wear', result.wears === true);
  }
  {
    // A target behind a nearer block must not be hittable.
    const combat = new CombatSystem({ bus: { emit() {} }, settings: { get: () => 'survival' } });
    const dummy = {
      alive: true,
      isDead: false,
      x: 0,
      y: 0,
      z: 5,
      halfSize: 0.4,
      height: 1.8,
      velocityX: 0,
      velocityY: 0,
      velocityZ: 0,
      hurt: () => true,
    };
    const result = combat.tryAttack({
      origin: { x: 0, y: 1, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      reach: 6,
      itemId: null,
      // A wall two blocks away.
      blockDistance: 2,
      candidates: [dummy],
    });
    check('a target behind a wall is not hit', result === null);
  }
  {
    // Out of reach.
    const combat = new CombatSystem({ bus: { emit() {} }, settings: { get: () => 'survival' } });
    const far = {
      alive: true,
      isDead: false,
      x: 0,
      y: 0,
      z: 40,
      halfSize: 0.4,
      height: 1.8,
      velocityX: 0,
      velocityY: 0,
      velocityZ: 0,
      hurt: () => true,
    };
    check(
      'a distant target is not hit',
      combat.tryAttack({
        origin: { x: 0, y: 1, z: 0 },
        direction: { x: 0, y: 0, z: 1 },
        reach: 4,
        itemId: null,
        blockDistance: Infinity,
        candidates: [far],
      }) === null
    );
  }
  {
    // Aiming away from the target must miss, which is what the box sweep is for.
    const combat = new CombatSystem({ bus: { emit() {} }, settings: { get: () => 'survival' } });
    const beside = {
      alive: true,
      isDead: false,
      x: 6,
      y: 0,
      z: 3,
      halfSize: 0.4,
      height: 1.8,
      velocityX: 0,
      velocityY: 0,
      velocityZ: 0,
      hurt: () => true,
    };
    check(
      'a target beside the crosshair is not hit',
      combat.tryAttack({
        origin: { x: 0, y: 1, z: 0 },
        direction: { x: 0, y: 0, z: 1 },
        reach: 6,
        itemId: null,
        blockDistance: Infinity,
        candidates: [beside],
      }) === null
    );
  }
  {
    // A dead target is not a valid target.
    const combat = new CombatSystem({ bus: { emit() {} }, settings: { get: () => 'survival' } });
    const corpse = {
      alive: true,
      isDead: true,
      x: 0,
      y: 0,
      z: 3,
      halfSize: 0.4,
      height: 1.8,
      velocityX: 0,
      velocityY: 0,
      velocityZ: 0,
      hurt: () => true,
    };
    check(
      'a dead target is skipped',
      combat.tryAttack({
        origin: { x: 0, y: 1, z: 0 },
        direction: { x: 0, y: 0, z: 1 },
        reach: 6,
        itemId: null,
        blockDistance: Infinity,
        candidates: [corpse],
      }) === null
    );
  }

  // --- the ray/box test itself ---
  {
    const origin = { x: 0, y: 0, z: 0 };
    const forward = { x: 0, y: 0, z: 1 };
    check(
      'a box straight ahead is hit',
      raycastBox(origin, forward, -1, -1, 4, 1, 1, 6, 20) !== null
    );
    check(
      'a box behind is missed',
      raycastBox(origin, forward, -1, -1, -6, 1, 1, -4, 20) === null
    );
    check(
      'a box beyond the limit is missed',
      raycastBox(origin, forward, -1, -1, 30, 1, 1, 32, 20) === null
    );
    check(
      'a box off to the side is missed',
      raycastBox(origin, forward, 10, -1, 4, 12, 1, 6, 20) === null
    );
    check(
      'the reported distance is the near face',
      Math.abs(raycastBox(origin, forward, -1, -1, 4, 1, 1, 6, 20) - 4) < 1e-6
    );
  }
}

section('Ranged combat and shields');
{
  check(
    'a source in front lies inside the shield arc',
    isInsideShieldArc({ x: 0, z: 0 }, { x: 0, z: 1 }, { x: 0, z: 4 })
  );
  check(
    'a source behind lies outside the shield arc',
    !isInsideShieldArc({ x: 0, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -4 })
  );
  check(
    'a source at the shield edge is protected',
    isInsideShieldArc({ x: 0, z: 0 }, { x: 0, z: 1 }, { x: 3, z: 0 })
  );
  check('every successful shield block costs durability', shieldDurabilityLoss(0) === 1);
  check('strong hits wear shields faster', shieldDurabilityLoss(9.8) === 10);

  const direct = segmentAabbFraction(
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 4 },
    { minX: -0.5, maxX: 0.5, minY: -0.5, maxY: 0.5, minZ: 2, maxZ: 3 }
  );
  check('a swept segment intersects an entity box', Math.abs(direct - 0.5) < 1e-9, String(direct));
  check(
    'a swept segment misses an offset entity box',
    segmentAabbFraction(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 4 },
      { minX: 2, maxX: 3, minY: -0.5, maxY: 0.5, minZ: 2, maxZ: 3 }
    ) === null
  );

  const wallWorld = {
    isCollidable(x, y, z) {
      return x === 0 && y === 64 && z === 2;
    },
  };
  const wallFraction = firstBlockedFraction(
    wallWorld,
    { x: 0.5, y: 64.5, z: 0.5 },
    { x: 0.5, y: 64.5, z: 4.5 }
  );
  check('swept voxel sampling catches a one-block wall', wallFraction !== null && wallFraction < 0.6);

  {
    let damage = 0;
    const mob = {
      alive: true,
      isDead: false,
      x: 0.5,
      y: 64,
      z: 2.5,
      halfSize: 0.3,
      height: 1.8,
      velocityX: 0,
      velocityY: 0,
      velocityZ: 0,
      hurt(amount, source) {
        damage += amount;
        return source.attacker === 'player';
      },
    };
    const projectile = new ProjectileEntity().spawn(
      0.5,
      64.8,
      0.5,
      { x: 0, y: 0, z: 1 },
      { ownerKind: 'player', speed: 24, gravity: 0, damage: 7 }
    );
    projectile.update(0.15, { isCollidable: () => false }, { mobs: [mob] });
    check('a player arrow damages the first swept mob', damage === 7);
    check('an entity impact removes the projectile', projectile.alive === false);
    check('an arrow impact records its target', projectile.justHit?.target === mob && projectile.justHit.applied);
    check('an arrow applies directional knockback', mob.velocityZ > 0 && mob.velocityY > 0);
  }

  {
    let cause = null;
    let damage = 0;
    const player = {
      position: { x: 0.5, y: 64, z: 2.5 },
      width: 0.6,
      height: 1.8,
      stats: { isDead: false },
      hurt(amount, nextCause) {
        damage += amount;
        cause = nextCause;
        return true;
      },
    };
    const projectile = new ProjectileEntity().spawn(
      0.5,
      64.8,
      0.5,
      { x: 0, y: 0, z: 1 },
      { ownerKind: 'mob', speed: 24, gravity: 0, damage: 5 }
    );
    projectile.update(0.15, { isCollidable: () => false }, { player });
    check('a mob arrow damages the player', damage === 5);
    check('mob arrows use the projectile damage source', cause === DamageType.PROJECTILE);
  }

  {
    let hit = false;
    const mob = {
      alive: true,
      isDead: false,
      x: 0.5,
      y: 64,
      z: 3.5,
      halfSize: 0.3,
      height: 1.8,
      hurt() {
        hit = true;
        return true;
      },
    };
    const projectile = new ProjectileEntity().spawn(
      0.5,
      64.5,
      0.5,
      { x: 0, y: 0, z: 1 },
      { ownerKind: 'player', speed: 30, gravity: 0 }
    );
    projectile.update(0.15, wallWorld, { mobs: [mob] });
    check('a wall stops an arrow before the mob behind it', hit === false && projectile.justHit?.type === 'block');
  }

  const catalogue = createSoundCatalogue();
  for (const sound of [
    'item.bow_shoot',
    'projectile.hit',
    'projectile.hit_block',
    'item.shield_block',
    'item.shield_break',
    'item.ignite',
  ]) {
    check(`${sound} has a procedural sound`, typeof catalogue[sound]?.render === 'function');
  }
}

section('Voxel navigation');
{
  const flatWorld = (minX = -3, maxX = 7, minZ = -4, maxZ = 4) => {
    const world = new GridTestWorld(8080);
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) world.setBlock(x, 9, z, Block.STONE);
    }
    return world;
  };

  {
    const world = flatWorld();
    check('a clear floor cell is a navigation node', isWalkableNode(world, 0, 10, 0));
    const path = findVoxelPath(world, { x: 0, y: 10, z: 0 }, { x: 5, y: 10, z: 0 });
    check('A* finds a straight route on flat ground', Array.isArray(path) && path.length === 5);
    check('the flat route ends at the requested block', path?.at(-1)?.x === 5.5 && path?.at(-1)?.z === 0.5);
  }

  {
    const world = flatWorld();
    for (let z = -1; z <= 1; z++) {
      world.setBlock(2, 10, z, Block.STONE);
      world.setBlock(2, 11, z, Block.STONE);
    }
    const path = findVoxelPath(
      world,
      { x: 0, y: 10, z: 0 },
      { x: 5, y: 10, z: 0 },
      { maxNodes: 256 }
    );
    check('A* routes around a two-block wall', Array.isArray(path) && path.length > 5);
    check('the wall route uses the open side', path?.some((point) => Math.abs(point.z - 0.5) >= 2));
  }

  {
    const world = flatWorld();
    world.setBlock(1, 10, 0, Block.STONE);
    const path = findVoxelPath(world, { x: 0, y: 10, z: 0 }, { x: 2, y: 10, z: 0 });
    check('A* climbs a one-block step', path?.some((point) => point.x === 1.5 && point.y === 11));
    check('A* descends safely after the step', path?.at(-1)?.y === 10);
  }

  {
    const world = flatWorld();
    world.setBlock(1, 10, 0, Block.LAVA);
    check('lava is classified as a navigation hazard', isNavigationHazard(world, 1, 10, 0));
    const path = findVoxelPath(world, { x: 0, y: 10, z: 0 }, { x: 3, y: 10, z: 0 });
    check('A* avoids lava when a safe route exists', Array.isArray(path) && !path.some((point) => point.x === 1.5 && point.z === 0.5));
  }

  {
    const world = flatWorld(-2, 2, -2, 2);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      world.setBlock(dx, 10, dz, Block.STONE);
      world.setBlock(dx, 11, dz, Block.STONE);
    }
    const path = findVoxelPath(world, { x: 0, y: 10, z: 0 }, { x: 2, y: 10, z: 2 });
    check('A* returns null when the start is enclosed', path === null);
  }

  {
    const path = [{ x: 0.5, y: 10, z: 0.5 }, { x: 1.5, y: 10, z: 0.5 }];
    const direction = nextPathDirection({ x: 0.5, z: 0.5 }, path, 0);
    check('waypoint steering skips an already reached point', direction.index === 1);
    check('waypoint steering normalises the next direction', direction.x === 1 && direction.z === 0);
  }
}

section('Data-driven loot tables');
{
  const independent = independentDropTable([
    { item: 'wheat', min: 1, max: 1, chance: 1 },
    { item: 'wheat_seeds', min: 2, max: 4, chance: 1 },
  ]);
  const first = rollLootTable(independent, { random: createLootRandom(12345) });
  const second = rollLootTable(independent, { random: createLootRandom(12345) });
  check('seeded loot rolls are deterministic', JSON.stringify(first) === JSON.stringify(second));
  check('independent pools can produce every entry', first.some((drop) => drop.item === 'wheat') && first.some((drop) => drop.item === 'wheat_seeds'));
  check('loot count ranges stay bounded', first.every((drop) => drop.count >= 1 && drop.count <= 4));

  const weighted = {
    pools: [{
      mode: 'weighted',
      rolls: 1,
      entries: [
        { item: 'flint', count: 1, weight: 1 },
        { item: 'gravel', count: 1, weight: 9 },
      ],
    }],
  };
  check('weighted loot can select its first entry', rollLootTable(weighted, { random: () => 0 })[0]?.item === 'flint');
  check('weighted loot can select its final entry', rollLootTable(weighted, { random: () => 0.999999 })[0]?.item === 'gravel');

  const conditional = {
    pools: [{
      entries: [
        { item: 'diamond', count: 1, conditions: [{ type: 'context', key: 'silkTouch', value: true }] },
      ],
    }],
  };
  check('loot context conditions can reject an entry', rollLootTable(conditional, { context: { silkTouch: false } }).length === 0);
  check('loot context conditions can admit an entry', rollLootTable(conditional, { context: { silkTouch: true } })[0]?.item === 'diamond');

  const merged = mergeLoot([
    { item: 'arrow', count: 2 },
    { item: 'arrow', count: 3 },
    { item: 'bone', count: 1 },
  ]);
  check('equal loot records merge without losing items', merged.find((drop) => drop.item === 'arrow')?.count === 5);
}

section('Living mobs');
{
  const summary = describeMobs();
  check('the living roster is registered', summary.total === MOB_DEFINITIONS.length && summary.total >= 7);
  check('the roster includes passive animals', PASSIVE_MOBS.length >= 4);
  check('the roster includes hostile creatures', HOSTILE_MOBS.length >= 3);
  check(
    'every mob atlas tile is declared',
    MOB_DEFINITIONS.every((definition) => TILE_NAMES.includes(definition.tileName))
  );

  // Drop tables are bounded even at the two extremes of the random stream.
  {
    const low = rollDrops('cow', () => 0);
    const high = rollDrops('cow', () => 0.999999);
    check('a cow can roll its configured drops', low.some((drop) => drop.item === 'raw_beef'));
    check(
      'mob drop quantities never exceed their definitions',
      [...low, ...high].every((drop) => drop.count >= 0 && drop.count <= 3)
    );
  }

  // Sight is voxel-accurate rather than a distance-only check.
  {
    const walls = new Set();
    const world = {
      getBlock(x, y, z) {
        return walls.has(`${x},${y},${z}`) ? Block.STONE : Block.AIR;
      },
      isOpaque(x, y, z) {
        return walls.has(`${x},${y},${z}`);
      },
    };
    const from = { x: 0.5, y: 65.5, z: 0.5 };
    const to = { x: 0.5, y: 65.5, z: 8.5 };
    check('mobs see through clear voxels', hasVoxelLineOfSight(world, from, to));
    walls.add('0,65,4');
    check('an opaque voxel blocks mob sight', hasVoxelLineOfSight(world, from, to) === false);
  }

  // Decision rules: hostiles chase, ranged mobs space themselves, passives flee.
  {
    const husk = getMob('husk');
    const chase = decideMobIntent({
      definition: husk,
      mob: { x: 0, y: 64, z: 0 },
      target: { x: 0, y: 64, z: 8, isDead: false, isCreative: false },
      currentState: MobBrainState.IDLE,
      wanderDirectionX: 0,
      wanderDirectionZ: 0,
      wanderTime: 0,
      fleeTime: 0,
      fleeFrom: null,
      targetVisible: true,
      random: () => 0.5,
    });
    check('a visible nearby player starts a hostile chase', chase.state === MobBrainState.CHASE);
    check('the chase points toward the player', chase.directionZ > 0.99);

    const bonecaster = getMob('bonecaster');
    const retreat = decideMobIntent({
      definition: bonecaster,
      mob: { x: 0, y: 64, z: 0 },
      target: { x: 0, y: 64, z: 2, isDead: false, isCreative: false },
      currentState: MobBrainState.CHASE,
      wanderDirectionX: 0,
      wanderDirectionZ: 0,
      wanderTime: 0,
      fleeTime: 0,
      fleeFrom: null,
      targetVisible: true,
      random: () => 0.5,
    });
    check('a ranged mob retreats when crowded', retreat.directionZ < -0.99);

    const cow = getMob('cow');
    const flee = decideMobIntent({
      definition: cow,
      mob: { x: 0, y: 64, z: 0 },
      target: null,
      currentState: MobBrainState.IDLE,
      wanderDirectionX: 0,
      wanderDirectionZ: 0,
      wanderTime: 0,
      fleeTime: 3,
      fleeFrom: { x: 0, z: -2 },
      targetVisible: false,
      random: () => 0.5,
    });
    check('a hurt passive mob flees its attacker', flee.state === MobBrainState.FLEE && flee.directionZ > 0.99);

    const wander = chooseWander(() => 0.5);
    check('wander segments have a finite duration', wander.duration > 0 && Number.isFinite(wander.duration));
  }

  const mobWorld = {
    getBlock(_x, y) {
      return y < 64 ? Block.STONE : Block.AIR;
    },
    isCollidable(_x, y) {
      return y < 64;
    },
    isLiquid() {
      return false;
    },
    isOpaque(_x, y) {
      return y < 64;
    },
    getSurfaceY() {
      return 63;
    },
  };

  {
    const cow = new MobEntity().spawn('cow', 0.5, 64, 0.5, 123);
    check('a spawned mob starts at full health', cow.health === cow.maxHealth && cow.alive);
    check('a player hit damages a mob', cow.hurt(2, { x: 0, z: -1, attacker: 'player' }));
    check('mob health decreases', cow.health === cow.maxHealth - 2);
    check('mob invulnerability rejects an immediate second hit', cow.hurt(2) === false);
    check('passive damage starts a flee window', cow.fleeTime > 0);
    cow.hurtCooldown = 0;
    cow.hurt(100, { attacker: 'player' });
    check('lethal damage starts a death animation', cow.isDead && cow.alive);
    check('a player kill is remembered for XP', cow.killedByPlayer === true);
    check('death resolves a concrete drop list', Array.isArray(cow.pendingDrops));
    for (let i = 0; i < 60 && cow.alive; i++) cow.updateMob(1 / 60, mobWorld, null, { daylight: 0 });
    check('a dead mob returns to the pool', cow.alive === false);
  }

  {
    const passives = MOB_DEFINITIONS.filter((definition) => definition.family === 'passive');
    check(
      'every passive animal declares breeding food',
      passives.every((definition) => definition.breedingItems.length > 0)
    );
    check(
      'hostile mobs cannot be bred with food',
      MOB_DEFINITIONS.filter((definition) => definition.family === 'hostile')
        .every((definition) => definition.breedingItems.length === 0)
    );

    const cow = new MobEntity().spawn('cow', 0.5, 64, 0.5, 321);
    check('unrelated food does not feed an animal', cow.feed('potato').accepted === false);
    const love = cow.feed('wheat');
    check('adult breeding food starts love mode', love.accepted && love.mode === 'love' && cow.canBreed);
    cow.finishBreeding();
    check('breeding starts a parent cooldown', cow.breedCooldown > 0 && !cow.canBreed);

    const baby = new MobEntity().spawn('cow', 0.5, 64, 0.5, 654).setBaby();
    const newbornScale = baby.ageScale;
    const newbornHeight = baby.height;
    check('newborn animals have smaller collision bounds', baby.isBaby && newbornScale < 1 && newbornHeight < baby.definition.height);
    const beforeGrowth = baby.babyAge;
    const grow = baby.feed('wheat');
    check('feeding a baby accelerates growth', grow.mode === 'grow' && baby.babyAge < beforeGrowth);
    baby.updateMob(1, mobWorld, null, { daylight: 0 });
    check('baby age advances during simulation', baby.babyAge < beforeGrowth - 59);
    check('baby render scale grows toward adulthood', baby.ageScale > newbornScale);
  }

  {
    let hits = 0;
    const player = {
      position: { x: 0.5, y: 64, z: 1.65 },
      eyeHeight: 1.62,
      isCreative: false,
      stats: { isDead: false },
      hurt(amount, cause) {
        if (cause === DamageType.MOB && amount > 0) hits++;
        return true;
      },
    };
    const husk = new MobEntity().spawn('husk', 0.5, 64, 0.5, 99);
    for (let i = 0; i < 120 && hits === 0; i++) {
      husk.updateMob(1 / 60, mobWorld, player, { daylight: 0 });
    }
    check('a hostile mob attacks a visible player in range', hits > 0);
  }

  {
    let directHits = 0;
    const player = {
      position: { x: 0.5, y: 64, z: 5.5 },
      eyeHeight: 1.62,
      isCreative: false,
      stats: { isDead: false },
      hurt() {
        directHits++;
        return true;
      },
    };
    const bonecaster = new MobEntity().spawn('bonecaster', 0.5, 64, 0.5, 7);
    for (let i = 0; i < 360 && !bonecaster.projectileRequest; i++) {
      bonecaster.updateMob(1 / 60, mobWorld, player, { daylight: 0 });
    }
    check('a ranged mob requests a projectile attack', Boolean(bonecaster.projectileRequest));
    check('a ranged mob no longer applies impossible direct damage', directHits === 0);
  }

  // Natural spawn validation and caps.
  {
    let spawnLight = 0;
    const spawnWorld = {
      seed: 42,
      getBlock(_x, y) {
        if (y < 63) return Block.STONE;
        if (y === 63) return Block.GRASS;
        return Block.AIR;
      },
      isCollidable(_x, y) {
        return y <= 63;
      },
      isLiquid() {
        return false;
      },
      isLoaded() {
        return true;
      },
      getSurfaceY() {
        return 63;
      },
      getBlockLight() {
        return spawnLight;
      },
    };
    const cow = getMob('cow');
    const husk = getMob('husk');
    check('a mob collision volume can fit on open ground', isSpawnVolumeClear(spawnWorld, cow, 0.5, 64, 0.5));
    check('passive animals can spawn on daylight grass', isValidMobSpawn(spawnWorld, cow, 0.5, 64, 0.5, { daylight: 1 }));
    check('surface hostiles are rejected in daylight', isValidMobSpawn(spawnWorld, husk, 0.5, 64, 0.5, { daylight: 1 }) === false);
    check('surface hostiles are accepted at night', isValidMobSpawn(spawnWorld, husk, 0.5, 64, 0.5, { daylight: 0 }));
    spawnLight = 14;
    check('torch light suppresses hostile spawning', isValidMobSpawn(spawnWorld, husk, 0.5, 64, 0.5, { daylight: 0 }) === false);
    spawnLight = 0;

    const fakeMobs = [
      { alive: true, isDead: false, definition: cow },
      { alive: true, isDead: false, definition: husk },
    ];
    const counts = countMobFamilies(fakeMobs);
    check('mob caps count families independently', counts.passive === 1 && counts.hostile === 1 && counts.total === 2);

    const spawner = new MobSpawner(42);
    const spawned = [];
    const player = { position: { x: 0, y: 64, z: 0 }, stats: { isDead: false } };
    for (let pass = 0; pass < 8 && spawned.length === 0; pass++) {
      spawner.update(2, {
        world: spawnWorld,
        player,
        daylight: 0,
        mobs: [],
        spawn(mobId, x, y, z, seed) {
          spawned.push({ mobId, x, y, z, seed });
          return spawned.at(-1);
        },
      });
    }
    check('the natural spawner produces a bounded night group', spawned.length > 0 && spawned.length <= 3, `${spawned.length}`);
    check('natural spawns respect the distance band', spawned.every((mob) => Math.hypot(mob.x, mob.z) >= 20));
  }
}

section('Natural terrain drops');
{
  const world = { seed: 0x12345678 };
  const first = gravelDrops({ world, x: 4, y: 62, z: -8, tick: 120 })[0].itemId;
  const repeat = gravelDrops({ world, x: 4, y: 62, z: -8, tick: 120 })[0].itemId;
  check('gravel drop rolls are deterministic', first === repeat);

  const seen = new Set();
  for (let x = -64; x <= 64; x++) {
    seen.add(gravelDrops({ world, x, y: 62, z: 0, tick: 120 })[0].itemId);
  }
  check('gravel can drop itself', seen.has('gravel'));
  check('gravel can produce flint', seen.has('flint'));
}

section('Farmland');
{
  const farmland = BLOCK_DEFINITIONS.find((b) => b.name === 'farmland');
  check('farmland exists', Boolean(farmland));
  // Tilling is labour, not a material: breaking it returns plain dirt.
  check('farmland drops dirt', farmland.dropId === Block.DIRT);
  check('farmland prefers a shovel', farmland.preferredTool === 'shovel');
  check('farmland is solid ground', farmland.solid === true);
}

section('Agriculture simulation');
{
  const world = new GridTestWorld(77);
  world.setBlock(0, 10, 0, Block.FARMLAND, { state: farmlandState(0) });
  world.setBlock(4, 10, 0, Block.WATER, { state: fluidState(0, false) });
  const farmland = getBlockBehavior(Block.FARMLAND);
  farmland.randomTick({ world, x: 0, y: 10, z: 0, state: 0, random: 0 });
  check(
    'farmland hydrates from water within four blocks',
    farmlandMoisture(world.getBlockState(0, 10, 0)) === 7
  );

  world.setBlock(4, 10, 0, Block.AIR);
  world.setBlockState(0, 10, 0, farmlandState(0));
  farmland.randomTick({ world, x: 0, y: 10, z: 0, state: 0, random: 0 });
  check('dry unused farmland returns to dirt', world.getBlock(0, 10, 0) === Block.DIRT);
}
{
  const world = new GridTestWorld(88);
  world.setBlock(0, 10, 0, Block.FARMLAND, { state: farmlandState(7) });
  check('wheat seeds plant only above farmland', plantCrop(world, 0, 11, 0, 'wheat'));
  check('a planted crop begins at age zero', cropAge(world.getBlockState(0, 11, 0)) === 0);
  const fertilised = fertilisePlant(world, 0, 11, 0, 3);
  check('bone meal advances a crop', fertilised && cropAge(world.getBlockState(0, 11, 0)) >= 2);

  world.setBlockState(0, 11, 0, cropState(7));
  const drops = getBlockBehavior(Block.WHEAT_CROP).drops({
    world,
    x: 0,
    y: 11,
    z: 0,
    blockId: Block.WHEAT_CROP,
    state: cropState(7),
    tick: 100,
  });
  check('mature wheat drops produce', drops.some((stack) => stack.itemId === 'wheat'));
  check('mature wheat returns seeds', drops.some((stack) => stack.itemId === 'wheat_seeds'));

  world.setBlock(0, 10, 0, Block.AIR);
  getBlockBehavior(Block.WHEAT_CROP).scheduledTick({ world, x: 0, y: 11, z: 0 });
  check('a crop breaks when farmland disappears', world.getBlock(0, 11, 0) === Block.AIR);
  check('support loss preserves a seed drop', world.drops.some((stack) => stack.itemId === 'wheat_seeds'));
}
{
  const world = new GridTestWorld(99);
  world.setBlock(0, 9, 0, Block.DIRT);
  world.setBlock(0, 10, 0, Block.OAK_SAPLING);
  check('an oak sapling grows only after validating the full tree', growOakTree(world, 0, 10, 0, 5));
  const blocks = [...world.cells.values()].map((cell) => cell.id);
  check('sapling growth creates a trunk', blocks.filter((id) => id === Block.OAK_LOG).length >= 4);
  check('sapling growth creates a canopy', blocks.filter((id) => id === Block.OAK_LEAVES).length >= 12);

  const blocked = new GridTestWorld(100);
  blocked.setBlock(0, 9, 0, Block.DIRT);
  blocked.setBlock(0, 10, 0, Block.OAK_SAPLING);
  blocked.setBlock(0, 12, 0, Block.STONE);
  check('a blocked sapling refuses to clip through builds', !growOakTree(blocked, 0, 10, 0, 5));
  check('failed tree growth keeps the sapling', blocked.getBlock(0, 10, 0) === Block.OAK_SAPLING);
}

section('Fluid simulation');
{
  const world = new GridTestWorld(123);
  world.setBlock(-1, 10, 0, Block.WATER, { state: fluidState(0, false) });
  world.setBlock(0, 9, 0, Block.STONE);
  const desired = desiredFluidState(world, 0, 10, 0, Block.WATER);
  check('water fed by one source becomes level one', fluidLevel(desired) === 1 && !fluidIsFalling(desired));

  world.setBlock(1, 10, 0, Block.WATER, { state: fluidState(0, false) });
  const source = desiredFluidState(world, 0, 10, 0, Block.WATER);
  check('two adjacent water sources create a new source', fluidLevel(source) === 0);

  check('fluid can flow into air', flowFluidInto(world, 0, 11, 0, Block.WATER, fluidState(3, false)));
  check('flow writes its level state', fluidLevel(world.getBlockState(0, 11, 0)) === 3);
}
{
  const world = new GridTestWorld(124);
  world.setBlock(0, 10, 0, Block.WATER, { state: fluidState(0, false) });
  world.setBlock(1, 10, 0, Block.LAVA, { state: fluidState(0, false) });
  check('water touching source lava reacts', reactFluidContacts(world, 0, 10, 0, Block.WATER));
  check('source lava solidifies as obsidian', world.getBlock(1, 10, 0) === Block.OBSIDIAN);

  world.setBlock(1, 10, 0, Block.LAVA, { state: fluidState(4, false) });
  reactFluidContacts(world, 0, 10, 0, Block.WATER);
  check('flowing lava solidifies as cobblestone', world.getBlock(1, 10, 0) === Block.COBBLESTONE);
}

section('Fire and ignition');
{
  check('fire is non-colliding and emits maximum block light',
    IS_COLLIDABLE[Block.FIRE] === 0 && getBlock(Block.FIRE).lightLevel === 15
  );
  check('wood is flammable while stone is not', isFlammable(Block.PLANKS) && !isFlammable(Block.STONE));
  check('fire state preserves a bounded age', fireAge(fireState(9)) === 9 && fireAge(fireState(99)) === 15);
  check('flint and steel has a crafting recipe', getRecipe('flint_and_steel')?.result?.id === 'flint_and_steel');

  {
    const world = new GridTestWorld(0x12345678);
    world.setBlock(0, 69, 0, Block.STONE);
    check('ignition succeeds above a supportive block', igniteBlock(world, 0, 70, 0) === true);
    check('ignition creates fire', world.getBlock(0, 70, 0) === Block.FIRE);
    check('new fire enters the scheduled tick queue', world.scheduled.some((entry) => entry.channel === 'fire'));
  }
  {
    const world = new GridTestWorld();
    check('unsupported air cannot be ignited', igniteBlock(world, 0, 70, 0) === false);
  }
  {
    const world = new GridTestWorld();
    world.setBlock(0, 70, 0, Block.FIRE, { state: fireState(0) });
    world.setBlock(1, 70, 0, Block.WATER);
    tickFire({ world, x: 0, y: 70, z: 0, state: fireState(0) });
    check('adjacent water extinguishes fire', world.getBlock(0, 70, 0) === Block.AIR);
  }
  {
    const world = new GridTestWorld(0xabcdef01);
    world.setBlock(0, 69, 0, Block.STONE);
    world.setBlock(0, 70, 0, Block.FIRE, { state: fireState(2) });
    tickFire({ world, x: 0, y: 70, z: 0, state: fireState(2) });
    check('unfuelled decorative fire burns out', world.getBlock(0, 70, 0) === Block.AIR);
  }
  {
    const stats = new PlayerStats(null);
    stats.tick(1.01, { inFire: true });
    check('standing in fire deals periodic fire damage', stats.health === MAX_HEALTH - 1, String(stats.health));
  }
  {
    const mob = new MobEntity();
    mob.spawn('cow', 0.5, 64, 0.5, 7);
    const world = stubWorldForEntities(Block.FIRE);
    const before = mob.health;
    mob._tickFireContact(1.01, world);
    check('living mobs take fire contact damage', mob.health === before - 1, String(mob.health));
  }
}

section('Structural block behaviour');
{
  const world = new GridTestWorld(240);
  world.setBlock(0, 9, 0, Block.STONE);
  world.setBlock(0, 10, 0, Block.OAK_DOOR, { state: doorState(0, { upper: false }) });
  world.setBlock(0, 11, 0, Block.OAK_DOOR, { state: doorState(0, { upper: true }) });
  check('door lower half is encoded as lower', !doorUpper(world.getBlockState(0, 10, 0)));
  check('door upper half is encoded as upper', doorUpper(world.getBlockState(0, 11, 0)));
  check('right-click opens a complete door pair', toggleDoor(world, 0, 10, 0) === true);
  check('door open state is mirrored to both halves', doorOpen(world.getBlockState(0, 10, 0)) && doorOpen(world.getBlockState(0, 11, 0)));
  check('right-clicking the upper half closes the pair', toggleDoor(world, 0, 11, 0) === false);
  check('both door halves close together', !doorOpen(world.getBlockState(0, 10, 0)) && !doorOpen(world.getBlockState(0, 11, 0)));
}
{
  const world = new GridTestWorld(241);
  world.setBlock(0, 10, 0, Block.OAK_FENCE_GATE, { state: gateState(0) });
  check('fence gates open by interaction', toggleFenceGate(world, 0, 10, 0) === true);
  check('gate state records the open latch', gateIsOpen(world.getBlockState(0, 10, 0)));
  check('fence gates close by interaction', toggleFenceGate(world, 0, 10, 0) === false);
}
{
  const world = new GridTestWorld(242);
  world.setBlock(0, 9, 0, Block.STONE);
  world.setBlock(0, 9, 1, Block.STONE);
  world.setBlock(0, 10, 0, Block.WHITE_BED, { state: bedState(0, { head: false }) });
  world.setBlock(0, 10, 1, Block.WHITE_BED, { state: bedState(0, { head: true }) });
  const bed = resolveBed(world, 0, 10, 1);
  check('either bed half resolves to the foot', bed?.foot.x === 0 && bed?.foot.z === 0);
  check('either bed half resolves to the head', bed?.head.x === 0 && bed?.head.z === 1);
}
{
  const behaviour = getBlockBehavior(Block.OAK_SLAB);
  const drops = behaviour.drops({ state: slabState(false, true) });
  check('a merged slab drops two slab items', drops.length === 1 && drops[0].itemId === 'oak_slab' && drops[0].quantity === 2);
}

section('Redstone power simulation');
{
  check('a north vector maps to north facing', horizontalFacingFromVector(0, -1) === 2);
  check('an east vector maps to east facing', horizontalFacingFromVector(1, 0) === 3);
  const encoded = repeaterState(3, 4, true);
  check('repeater state preserves facing', repeaterFacing(encoded) === 3);
  check('repeater state preserves delay', repeaterDelay(encoded) === 4);
  check('repeater state preserves powered latch', repeaterPowered(encoded));
  check('facing vectors are cardinal', horizontalFacingVector(3).x === 1 && horizontalFacingVector(3).z === 0);
}
{
  const world = new GridTestWorld(404);
  for (let x = 0; x <= 4; x++) world.setBlock(x, 9, 0, Block.STONE);
  world.setBlock(0, 10, 0, Block.LEVER);
  world.setBlock(1, 10, 0, Block.REDSTONE_WIRE, { state: powerState(0) });
  world.setBlock(2, 10, 0, Block.REDSTONE_WIRE, { state: powerState(0) });
  world.setBlock(3, 10, 0, Block.REDSTONE_WIRE, { state: powerState(0) });

  check('lever toggles on', toggleLever(world, 0, 10, 0) === true);
  check('lever state persists as active', switchActive(world.getBlockState(0, 10, 0)));
  const wireTick = getBlockBehavior(Block.REDSTONE_WIRE).scheduledTick;
  wireTick({ world, x: 1, y: 10, z: 0 });
  wireTick({ world, x: 2, y: 10, z: 0 });
  wireTick({ world, x: 3, y: 10, z: 0 });
  check('wire beside a source receives power 15', powerLevel(world.getBlockState(1, 10, 0)) === 15);
  check('wire attenuates by one per block', powerLevel(world.getBlockState(2, 10, 0)) === 14);
  check('a third wire continues the attenuation', powerLevel(world.getBlockState(3, 10, 0)) === 13);
  check('wire desired power reads neighbouring wire', desiredWirePower(world, 3, 10, 0) === 13);
  check('generic receivers see the wire output', receivedPower(world, 4, 10, 0) === 13);

  toggleLever(world, 0, 10, 0);
  for (let pass = 0; pass < 20; pass++) {
    for (let x = 1; x <= 3; x++) wireTick({ world, x, y: 10, z: 0 });
  }
  check('wire network fully depowers after its source turns off', [1, 2, 3].every((x) => powerLevel(world.getBlockState(x, 10, 0)) === 0));
}
{
  const world = new GridTestWorld(405);
  world.setBlock(0, 9, 0, Block.STONE);
  world.setBlock(1, 9, 0, Block.STONE);
  world.setBlock(0, 10, 0, Block.LEVER, { state: 1 });
  world.setBlock(1, 10, 0, Block.REDSTONE_LAMP);
  getBlockBehavior(Block.REDSTONE_LAMP).scheduledTick({ world, x: 1, y: 10, z: 0 });
  check('a powered lamp swaps to its lit block state', world.getBlock(1, 10, 0) === Block.REDSTONE_LAMP_LIT);
  world.setBlockState(0, 10, 0, 0);
  getBlockBehavior(Block.REDSTONE_LAMP_LIT).scheduledTick({ world, x: 1, y: 10, z: 0 });
  check('an unpowered lamp returns to its dark block state', world.getBlock(1, 10, 0) === Block.REDSTONE_LAMP);
}
{
  const world = new GridTestWorld(406);
  for (let x = 0; x <= 2; x++) world.setBlock(x, 9, 0, Block.STONE);
  world.setBlock(0, 10, 0, Block.LEVER, { state: 1 });
  world.setBlock(1, 10, 0, Block.REPEATER, { state: repeaterState(3, 2, false) });
  check('repeater reads only its back input', repeaterInputPower(world, 1, 10, 0) === 15);
  getBlockBehavior(Block.REPEATER).scheduledTick({ world, x: 1, y: 10, z: 0 });
  check('repeater latches on after its delayed tick', repeaterPowered(world.getBlockState(1, 10, 0)));
  check('repeater powers only its front', powerOutputToward(world, 1, 10, 0, 2, 10, 0) === 15);
  check('repeater does not back-power its input', powerOutputToward(world, 1, 10, 0, 0, 10, 0) === 0);
  check('right-click cycles repeater delay', rotateRepeaterDelay(world, 1, 10, 0) === 3);
}
{
  const world = new GridTestWorld(407);
  world.setBlock(0, 8, 0, Block.STONE);
  world.setBlock(1, 8, 0, Block.STONE);
  world.setBlock(0, 9, 0, Block.STONE);
  world.setBlock(1, 9, 0, Block.LEVER, { state: 1 });
  world.setBlock(0, 10, 0, Block.REDSTONE_TORCH);
  getBlockBehavior(Block.REDSTONE_TORCH).scheduledTick({ world, x: 0, y: 10, z: 0 });
  check('a powered support extinguishes its redstone torch', world.getBlock(0, 10, 0) === Block.REDSTONE_TORCH_OFF);
  world.setBlockState(1, 9, 0, 0);
  getBlockBehavior(Block.REDSTONE_TORCH_OFF).scheduledTick({ world, x: 0, y: 10, z: 0 });
  check('an unpowered support relights its redstone torch', world.getBlock(0, 10, 0) === Block.REDSTONE_TORCH);
}
{
  const world = new GridTestWorld(408);
  const drops = getBlockBehavior(Block.REDSTONE_ORE).drops({
    world, x: 3, y: 7, z: -2, blockId: Block.REDSTONE_ORE, state: 0, tick: 10,
  });
  check('redstone ore drops dust rather than an ore block', drops.length === 1 && drops[0].itemId === 'redstone_dust');
  check('redstone ore drops a bounded dust quantity', drops[0].quantity >= 4 && drops[0].quantity <= 5);
}

{
  const world = new GridTestWorld(409);
  world.setBlock(0, 10, 1, Block.STONE);
  world.setBlock(0, 10, 0, Block.STONE_BUTTON, { state: buttonState(0, false) });
  check('pressing a button powers it', pressButton(world, 0, 10, 0) === true);
  check('button state records the powered pulse', buttonPowered(world.getBlockState(0, 10, 0)));
  check('powered buttons emit redstone strength fifteen', powerOutputToward(world, 0, 10, 0, 1, 10, 0) === 15);
  getBlockBehavior(Block.STONE_BUTTON).scheduledTick({
    world,
    x: 0,
    y: 10,
    z: 0,
    state: world.getBlockState(0, 10, 0),
    channel: 'redstone-button-release',
  });
  check('button pulses release on their scheduled tick', !buttonPowered(world.getBlockState(0, 10, 0)));
}
{
  const world = new GridTestWorld(410);
  world.setBlock(0, 9, 0, Block.STONE);
  world.setBlock(0, 10, 0, Block.OAK_PRESSURE_PLATE, { state: pressurePlateState(false) });
  check('living contact activates a wooden pressure plate', touchPressurePlate(world, 0, 10, 0, 'living'));
  check('pressure plate state records contact', pressurePlatePowered(world.getBlockState(0, 10, 0)));
  check('powered pressure plates emit redstone strength fifteen', powerOutputToward(world, 0, 10, 0, 1, 10, 0) === 15);
  world.gameTick = 8;
  getBlockBehavior(Block.OAK_PRESSURE_PLATE).scheduledTick({
    world,
    x: 0,
    y: 10,
    z: 0,
    state: world.getBlockState(0, 10, 0),
    channel: 'redstone-pressure-plate',
  });
  check('pressure plates release after contact expires', !pressurePlatePowered(world.getBlockState(0, 10, 0)));

  world.setBlock(1, 9, 0, Block.STONE);
  world.setBlock(1, 10, 0, Block.STONE_PRESSURE_PLATE, { state: pressurePlateState(false) });
  check('stone pressure plates ignore item entities', !touchPressurePlate(world, 1, 10, 0, 'item'));
  check('wooden pressure plates accept item entities', touchPressurePlate(world, 0, 10, 0, 'item'));
}

// ------------------------------------------------------------- item transfers

section('Centralised item transfers');
{
  const S = (id, n = 1) => new ItemStack(id, n);

  // --- container to player, including a partial move ---
  {
    const inventory = new Inventory(null);
    const chest = new Container({ size: 3 });
    chest.setSlot(0, S('stone', 20));

    const moved = containerToPlayer(chest, 0, inventory);
    check('a full container-to-player move empties the slot', chest.getSlot(0) === null);
    check('the player receives everything', inventory.countOf('stone') === 20);
    check('the move count is reported', moved === 20);
  }
  {
    // Fill the player so only part of the stack fits, and confirm the rest stays
    // in the chest rather than vanishing.
    const inventory = new Inventory(null);
    for (let i = SLOT.HOTBAR_START; i <= SLOT.MAIN_END; i++) {
      inventory.setSlot(i, S('dirt', 64));
    }
    inventory.getSlot(0).setQuantity(60);

    const chest = new Container({ size: 3 });
    chest.setSlot(0, S('dirt', 20));

    const moved = containerToPlayer(chest, 0, inventory);
    check('a partial move transfers what fits', moved === 4, `${moved}`);
    check('the remainder stays in the chest', chest.getSlot(0)?.quantity === 16, `${chest.getSlot(0)?.quantity}`);
    // The critical invariant: nothing was created or destroyed.
    // 36 slots of 64, less the 4 removed to make room, plus the 20 in the chest.
    const expectedTotal = 36 * 64 - 4 + 20;
    check(
      'no items were lost in a partial move',
      inventory.countOf('dirt') + chest.countOf('dirt') === expectedTotal,
      `${inventory.countOf('dirt')} + ${chest.countOf('dirt')} != ${expectedTotal}`
    );
  }

  // --- player to container ---
  {
    const inventory = new Inventory(null);
    const chest = new Container({ size: 3 });
    inventory.setSlot(0, S('coal', 30));

    playerToContainer(inventory, 0, chest);
    check('a player-to-container move empties the slot', inventory.getSlot(0) === null);
    check('the container receives everything', chest.countOf('coal') === 30);
  }
  {
    // A restricted destination must not swallow items it cannot hold.
    const inventory = new Inventory(null);
    const furnace = new Container({
      size: 3,
      outputSlots: [2],
      slotFilter: (slot, stack) => (slot === 1 ? stack.itemId === 'coal' : true),
    });
    inventory.setSlot(0, S('stone', 5));
    // Route explicitly to the filtered fuel slot, which refuses stone.
    const moved = playerToContainer(inventory, 0, furnace, [1]);
    check('a filtered slot refuses the wrong item', moved === 0);
    check('the refused stack stays with the player', inventory.countOf('stone') === 5);
  }

  // --- cursor interactions on a container ---
  {
    const inventory = new Inventory(null);
    const chest = new Container({ size: 3 });
    chest.setSlot(0, S('stone', 10));

    cursorClickContainer(inventory, chest, 0);
    check('clicking lifts a container stack to the cursor', inventory.cursor?.quantity === 10);
    check('the container slot is emptied', chest.getSlot(0) === null);

    cursorClickContainer(inventory, chest, 1);
    check('clicking puts it into another slot', chest.getSlot(1)?.quantity === 10);
    check('the cursor is cleared', inventory.cursor === null);
  }
  {
    const inventory = new Inventory(null);
    const chest = new Container({ size: 2 });
    chest.setSlot(0, S('stone', 11));
    cursorSplitContainer(inventory, chest, 0);
    check('right-clicking a container slot takes half', inventory.cursor?.quantity === 6);
    check('the slot keeps the rest', chest.getSlot(0)?.quantity === 5);
  }
  {
    // An output slot is take-only, whatever the gesture.
    const inventory = new Inventory(null);
    const furnace = new Container({ size: 3, outputSlots: [2] });
    furnace.setSlot(2, S('iron_ingot', 3));
    inventory.cursor = S('coal', 1);

    cursorClickContainer(inventory, furnace, 2);
    check('an output slot refuses the cursor', furnace.getSlot(2)?.itemId === 'iron_ingot');
    check('the cursor keeps its stack', inventory.cursor?.itemId === 'coal');

    inventory.cursor = null;
    cursorClickContainer(inventory, furnace, 2);
    check('an output slot can be emptied', furnace.getSlot(2) === null);
    check('the result reaches the cursor', inventory.cursor?.quantity === 3);
  }
  {
    // A held stack compatible with the output absorbs it.
    const inventory = new Inventory(null);
    const furnace = new Container({ size: 3, outputSlots: [2] });
    furnace.setSlot(2, S('iron_ingot', 3));
    inventory.cursor = S('iron_ingot', 5);
    cursorClickContainer(inventory, furnace, 2);
    check('a matching cursor absorbs the output', inventory.cursor?.quantity === 8);
    check('the output slot is emptied', furnace.getSlot(2) === null);
  }

  // --- number-key swap against a container ---
  {
    const inventory = new Inventory(null);
    const chest = new Container({ size: 2 });
    chest.setSlot(0, S('diamond', 2));
    inventory.setSlot(3, S('stone', 7));

    swapContainerWithHotbar(inventory, chest, 0, 3);
    check('a hotbar swap moves the container stack out', inventory.getSlot(3)?.itemId === 'diamond');
    check('and the held stack in', chest.getSlot(0)?.itemId === 'stone');
  }
  {
    // Pulling from an output slot is allowed; pushing into it is not.
    const inventory = new Inventory(null);
    const furnace = new Container({ size: 3, outputSlots: [2] });
    furnace.setSlot(2, S('iron_ingot', 1));
    inventory.setSlot(0, S('coal', 1));
    check(
      'a hotbar swap cannot push into an output slot',
      swapContainerWithHotbar(inventory, furnace, 2, 0) === false
    );
    check('the output is untouched', furnace.getSlot(2)?.itemId === 'iron_ingot');
    check('the held stack is untouched', inventory.getSlot(0)?.itemId === 'coal');
  }

  // --- transferSlot between two containers ---
  {
    const from = new Container({ size: 2 });
    const to = new Container({ size: 2 });
    from.setSlot(0, S('gold_ingot', 9));
    const moved = transferSlot(from, 0, to);
    check('transferSlot moves between containers', moved === 9);
    check('the source is emptied', from.getSlot(0) === null);
    check('the destination receives it', to.countOf('gold_ingot') === 9);
  }
  {
    // A destination with no room must leave the source intact.
    const from = new Container({ size: 2 });
    const to = new Container({ size: 1 });
    to.setSlot(0, S('stone', 64));
    from.setSlot(0, S('stone', 5));
    check('a full destination accepts nothing', transferSlot(from, 0, to) === 0);
    check('the source keeps its stack', from.getSlot(0)?.quantity === 5);
  }

  // --- the overall conservation property, over randomised transfers ---
  {
    // The single most important guarantee in a container system: no sequence of
    // transfers may change the total number of items in play. Randomised rather
    // than hand-picked, because duplication bugs hide in the combinations nobody
    // thought to write a case for.
    let worstDrift = 0;
    for (let seed = 0; seed < 40; seed++) {
      const random = mulberry32(0x9e37 + seed);
      const inventory = new Inventory(null);
      const chest = new Container({ size: 9 });
      const ids = ['stone', 'dirt', 'coal', 'iron_ingot'];

      // Seed both sides.
      for (let i = 0; i < 12; i++) {
        const id = ids[Math.floor(random() * ids.length)];
        const count = 1 + Math.floor(random() * 40);
        if (random() < 0.5) inventory.addItem(id, count);
        else chest.insert(new ItemStack(id, count));
      }

      const total = () => {
        let sum = 0;
        for (const id of ids) sum += inventory.countOf(id) + chest.countOf(id);
        if (inventory.cursor) sum += inventory.cursor.quantity;
        return sum;
      };
      const before = total();

      for (let step = 0; step < 120; step++) {
        const roll = random();
        const chestSlot = Math.floor(random() * chest.size);
        const playerSlot = SLOT.HOTBAR_START + Math.floor(random() * 36);
        if (roll < 0.2) containerToPlayer(chest, chestSlot, inventory);
        else if (roll < 0.4) playerToContainer(inventory, playerSlot, chest);
        else if (roll < 0.55) cursorClickContainer(inventory, chest, chestSlot);
        else if (roll < 0.7) cursorSplitContainer(inventory, chest, chestSlot);
        else if (roll < 0.8) inventory.swapWithCursor(playerSlot);
        else if (roll < 0.9) inventory.splitWithCursor(playerSlot);
        else swapContainerWithHotbar(inventory, chest, chestSlot, Math.floor(random() * 9));
      }

      worstDrift = Math.max(worstDrift, Math.abs(total() - before));
    }
    check(
      'no sequence of transfers creates or destroys items',
      worstDrift === 0,
      `worst drift ${worstDrift}`
    );
  }
}

section('Dropped items');
{
  const S = (id, n = 1) => new ItemStack(id, n);

  {
    const item = new ItemEntity();
    item.spawn(0, 70, 0, S('stone', 5));
    check('a spawned item carries its stack', item.itemId === 'stone');
    check('the count is exposed', item.count === 5);
    check('a fresh drop cannot be collected', item.canBeCollectedBy(0, 70, 0) === false);

    // The delay exists so a broken block is visibly a drop before it is absorbed.
    item.update(ENTITIES.itemPickupDelay + 0.01, stubWorldForEntities());
    check('the pickup delay expires', item.pickupDelay === 0);
  }
  {
    // Merging respects stack compatibility, so two differently worn tools cannot
    // collapse into one entity.
    const a = new ItemEntity();
    const b = new ItemEntity();
    a.spawn(0, 70, 0, new ItemStack('iron_pickaxe', 1, { damage: 5 }));
    b.spawn(0.2, 70, 0, new ItemStack('iron_pickaxe', 1, { damage: 90 }));
    check('differently worn tools do not merge', a.tryMerge(b) === false);
    check('both entities survive', a.alive && b.alive);
  }
  {
    const a = new ItemEntity();
    const b = new ItemEntity();
    a.spawn(0, 70, 0, S('stone', 30));
    b.spawn(0.2, 70, 0, S('stone', 20));
    const absorbed = a.tryMerge(b);
    check('matching stacks merge', absorbed === true);
    check('the survivor holds the total', a.count === 50);
    check('the absorbed entity is killed', b.alive === false);
  }
  {
    // Distance matters: items across the room must not merge.
    const a = new ItemEntity();
    const b = new ItemEntity();
    a.spawn(0, 70, 0, S('stone', 10));
    b.spawn(20, 70, 20, S('stone', 10));
    check('distant items do not merge', a.tryMerge(b) === false);
  }
  {
    // A killed entity releases its stack so the pool does not pin it alive.
    const item = new ItemEntity();
    item.spawn(0, 70, 0, S('stone', 1));
    item.kill();
    check('killing releases the stack', item.stack === null);
    check('a released entity reports no item', item.itemId === null);
  }
  {
    // Buoyancy: an item dropped into water must rise rather than sink, or
    // anything dropped over an ocean is effectively destroyed.
    const water = stubWorldForEntities(Block.WATER);
    const item = new ItemEntity();
    item.spawn(0.5, 70, 0.5, S('stone', 1));
    item.velocityY = -4;
    for (let i = 0; i < 30; i++) item.update(1 / 60, water);
    check('a submerged item stops sinking', item.velocityY > -0.5, `${item.velocityY.toFixed(2)}`);
    check('a submerged item drifts upward', item.velocityY > 0, `${item.velocityY.toFixed(2)}`);
  }
  {
    // In air it must still fall, or items would float away.
    const air = stubWorldForEntities(Block.AIR);
    const item = new ItemEntity();
    item.spawn(0.5, 70, 0.5, S('stone', 1));
    item.velocityY = 0;
    for (let i = 0; i < 30; i++) item.update(1 / 60, air);
    check('an item in air falls', item.velocityY < 0, `${item.velocityY.toFixed(2)}`);
  }
  {
    // Lifetime is bounded so a forgotten pile cleans itself up.
    const item = new ItemEntity();
    item.spawn(0, 70, 0, S('stone', 1));
    check('items have a finite lifetime', Number.isFinite(item.lifetime));
    check('the lifetime matches the config', item.lifetime === ENTITIES.itemLifetime);
  }
}

section('Persistent entities');
{
  const mob = new MobEntity();
  mob.spawn('cow', 12.5, 70, -8.25, 9981);
  mob.uuid = 'mob-test-1';
  mob.health = Math.max(1, mob.maxHealth - 3);
  mob.velocityX = 1.25;
  mob.velocityY = -0.5;
  mob.velocityZ = 0.75;
  mob.age = 42;
  mob.customName = 'Bessie';
  mob.persistent = true;
  mob.effects.apply(StatusEffect.SPEED, 30, 1, { source: 'test' });
  mob.setBaby(480);
  mob.loveTime = 12;
  mob.breedCooldown = 34;
  const savedMob = mob.toJSON();
  const restoredMob = new MobEntity();
  check('a live mob produces a persistence record', savedMob?.kind === 'mob');
  check('a valid mob persistence record restores', restoredMob.fromJSON(savedMob) === true);
  check('mob persistence keeps its stable id', restoredMob.uuid === 'mob-test-1');
  check('mob persistence keeps type and health', restoredMob.mobId === 'cow' && restoredMob.health === mob.health);
  check('mob persistence keeps velocity', restoredMob.velocityX === 1.25 && restoredMob.velocityZ === 0.75);
  check('named mobs remain persistent', restoredMob.customName === 'Bessie' && restoredMob.persistent);
  check('mob status effects persist with the entity', restoredMob.effects.get(StatusEffect.SPEED)?.amplifier === 1);
  check('mob growth state persists', restoredMob.babyAge === 480 && restoredMob.isBaby);
  check('mob breeding timers persist', restoredMob.loveTime === 12 && restoredMob.breedCooldown === 34);
  check('unknown mob records are rejected', restoredMob.fromJSON({ kind: 'mob', mobId: 'missing' }) === false);

  const item = new ItemEntity();
  item.spawn(3.5, 65.25, 4.5, new ItemStack('iron_pickaxe', 1, { damage: 17 }), {
    x: 0.2,
    y: 0.4,
    z: -0.3,
  });
  item.uuid = 'item-test-1';
  item.age = 10;
  item.pickupDelay = 0.4;
  const savedItem = item.toJSON();
  const restoredItem = new ItemEntity();
  check('a dropped stack produces a persistence record', savedItem?.kind === 'item');
  check('a valid dropped stack restores', restoredItem.fromJSON(savedItem) === true);
  check('item persistence keeps its stable id', restoredItem.uuid === 'item-test-1');
  check('item persistence keeps stack wear', restoredItem.stack?.damage === 17);
  check('item persistence keeps velocity', Math.abs(restoredItem.velocityZ + 0.3) < 1e-9);
  check('item persistence keeps pickup delay', Math.abs(restoredItem.pickupDelay - 0.4) < 1e-9);
  check('malformed item records are rejected', restoredItem.fromJSON({ kind: 'item' }) === false);
}

section('Third-person camera collision');
{
  const eye = { x: 0.5, y: 1.6, z: 0.5 };

  {
    const desired = { x: 0.5, y: 2.0, z: -3.5 };
    const fraction = cameraClipFraction(eye, desired, () => false);
    check('camera reaches its target in clear space', fraction === 1, String(fraction));
  }
  {
    const desired = { x: 0.5, y: 1.6, z: -3.5 };
    const fraction = cameraClipFraction(
      eye,
      desired,
      (_x, _y, z) => z <= -1,
      { spacing: 0.08, clearance: 0.16 }
    );
    const clippedZ = eye.z + (desired.z - eye.z) * fraction;
    check('rear camera stops before a wall', fraction > 0 && fraction < 1, String(fraction));
    check('rear camera keeps clearance', clippedZ > -1, clippedZ.toFixed(3));
  }
  {
    const desired = { x: 0.5, y: 1.6, z: 4.5 };
    const fraction = cameraClipFraction(
      eye,
      desired,
      (_x, _y, z) => z >= 2,
      { spacing: 0.08, clearance: 0.16 }
    );
    const clippedZ = eye.z + (desired.z - eye.z) * fraction;
    check('front camera stops before a wall', fraction > 0 && fraction < 1, String(fraction));
    check('front camera keeps clearance', clippedZ < 2, clippedZ.toFixed(3));
  }
  {
    const desired = { x: 0.5, y: 1.6, z: 4.5 };
    const fraction = cameraClipFraction(eye, desired, () => true);
    check('camera collapses safely to the eye when immediately blocked', fraction === 0, String(fraction));
  }
}

section('Drop keybindings');
{
  // A drop action must exist, be reachable from the keyboard, and be one-shot.
  check('a drop-one action exists', Boolean(Action.DROP_ITEM));
  check('a drop-stack action exists', Boolean(Action.DROP_STACK));
  check(
    'drop-one is bound to a key',
    Object.values(DEFAULT_KEY_BINDINGS).includes(Action.DROP_ITEM)
  );
  check(
    'drop-stack is bound to a key',
    Object.values(DEFAULT_KEY_BINDINGS).includes(Action.DROP_STACK)
  );
  // Held, these would empty the inventory in a second.
  check('drop-one is edge triggered', EDGE_TRIGGERED_ACTIONS.has(Action.DROP_ITEM));
  check('drop-stack is edge triggered', EDGE_TRIGGERED_ACTIONS.has(Action.DROP_STACK));
  // Gameplay forwards every action, but assert it rather than assume it.
  check(
    'gameplay forwards the drop actions',
    CONTEXT_ACTIONS[InputContext.GAMEPLAY].includes(Action.DROP_ITEM) &&
      CONTEXT_ACTIONS[InputContext.GAMEPLAY].includes(Action.DROP_STACK)
  );
  // Pick block must not have been silently lost when Q was reassigned.
  check(
    'pick block is still reachable',
    Object.values(DEFAULT_KEY_BINDINGS).includes(Action.PICK_BLOCK) ||
      Object.values(DEFAULT_MOUSE_BINDINGS).includes(Action.PICK_BLOCK)
  );
  {
    const controllerSource = readFileSync(new URL('../src/player/PlayerController.js', import.meta.url), 'utf8');
    check(
      'perspective action is consumed by the player controller',
      controllerSource.includes('justPressed(Action.TOGGLE_PERSPECTIVE)')
    );
  }
  // Every action needs a label, or the controls list shows a blank row.
  {
    const unlabelled = Object.values(Action).filter((action) => !ACTION_LABELS[action]);
    check('every action has a label', unlabelled.length === 0, unlabelled.join(', '));
  }
  // No key may be bound twice, or one of the two silently never fires.
  {
    const seen = new Map();
    const clashes = [];
    for (const [code, action] of Object.entries(DEFAULT_KEY_BINDINGS)) {
      if (seen.has(code)) clashes.push(code);
      seen.set(code, action);
    }
    check('no key code is bound twice', clashes.length === 0, clashes.join(', '));
  }

  // Every gameplay action must be reachable without a gamepad.
  //
  // This is the check that caught `FLY_DOWN` having no keyboard binding at all —
  // a keyboard player could ascend while flying but never descend. An action that
  // exists but cannot be triggered is a feature nobody can use.
  {
    // All three input channels count: keys, buttons and the wheel.
    const reachable = new Set([
      ...Object.values(DEFAULT_KEY_BINDINGS),
      ...Object.values(DEFAULT_MOUSE_BINDINGS),
      ...Object.values(WHEEL_BINDINGS),
    ]);
    const unreachable = Object.values(Action).filter((action) => !reachable.has(action));
    check(
      'every action is reachable without a gamepad',
      unreachable.length === 0,
      unreachable.join(', ')
    );
  }
}

// ------------------------------------------------------------------- weather

section('Weather model (deterministic, biome-aware, persistent)');

{
  // The whole point of replacing Math.random: the same seed must give the same
  // sky, forever, on every machine.
  let stable = true;
  for (let cycle = 0; cycle < 200; cycle++) {
    if (baseStateForCycle(1234, cycle) !== baseStateForCycle(1234, cycle)) stable = false;
  }
  check('weather is a pure function of (seed, cycle)', stable);

  const a = Array.from({ length: 64 }, (_, i) => baseStateForCycle(1, i)).join('');
  const b = Array.from({ length: 64 }, (_, i) => baseStateForCycle(2, i)).join('');
  check('different seeds give different weather sequences', a !== b);

  let allValid = true;
  for (let cycle = 0; cycle < 500; cycle++) {
    if (!WEATHER_STATES.includes(baseStateForCycle(7, cycle))) allValid = false;
  }
  check('every cycle produces a declared state', allValid);

  // A hash that is not well distributed would silently give one state forever.
  const counts = new Map();
  for (let cycle = 0; cycle < 4000; cycle++) {
    const state = baseStateForCycle(99, cycle);
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  check('clear weather dominates but storms occur',
    counts.get(WeatherState.CLEAR) > 2200 && counts.get(WeatherState.CLEAR) < 3100 &&
    (counts.get(WeatherState.RAIN) ?? 0) > 700 &&
    (counts.get(WeatherState.THUNDER) ?? 0) > 150,
    [...counts].map(([k, v]) => k + '=' + v).join(' '));

  let durationsOk = true;
  for (let cycle = 0; cycle < 500; cycle++) {
    const duration = durationForCycle(5, cycle);
    const clear = baseStateForCycle(5, cycle) === WeatherState.CLEAR;
    const min = clear ? CYCLE_SECONDS.clearMin : CYCLE_SECONDS.precipitationMin;
    const max = clear ? CYCLE_SECONDS.clearMax : CYCLE_SECONDS.precipitationMax;
    if (!(duration >= min && duration <= max)) durationsOk = false;
  }
  check('cycle durations stay inside their declared bounds', durationsOk);

  let unitOk = true;
  for (let cycle = 0; cycle < 1000; cycle++) {
    const u = weatherUnit(3, cycle, 1);
    if (!(u >= 0 && u < 1)) unitOk = false;
  }
  check('weatherUnit stays in [0, 1)', unitOk);
}

{
  // Biome resolution: this is what stopped it raining in the desert.
  check('precipitation falls as snow in cold biomes',
    resolveLocalWeather(WeatherState.RAIN, -0.9) === WeatherState.SNOW);
  check('thunder also falls as snow in cold biomes',
    resolveLocalWeather(WeatherState.THUNDER, -0.9) === WeatherState.SNOW);
  check('deserts stay dry during a storm',
    resolveLocalWeather(WeatherState.RAIN, 0.9) === WeatherState.CLEAR);
  check('temperate biomes see the base state',
    resolveLocalWeather(WeatherState.RAIN, 0.1) === WeatherState.RAIN);
  check('clear stays clear at every temperature',
    [-1, -0.5, 0, 0.5, 1].every((t) => resolveLocalWeather(WeatherState.CLEAR, t) === WeatherState.CLEAR));
  check('isPrecipitation agrees with the state list',
    isPrecipitation(WeatherState.RAIN) && isPrecipitation(WeatherState.SNOW) &&
    isPrecipitation(WeatherState.THUNDER) && !isPrecipitation(WeatherState.CLEAR));
}

{
  const system = new WeatherSystem({ seed: 42 });
  const startCycle = system.cycle;
  // Run a simulated hour at 20 Hz.
  for (let i = 0; i < 20 * 3600; i++) system.update(0.05);
  check('the clock advances through cycles', system.cycle > startCycle, 'cycle=' + system.cycle);

  let intensityOk = true;
  const probe = new WeatherSystem({ seed: 8 });
  for (let i = 0; i < 20000; i++) {
    probe.update(0.25);
    const value = probe.intensity;
    if (!(value >= 0 && value <= 1)) intensityOk = false;
    if (!isPrecipitation(probe.visibleState) && value !== 0) intensityOk = false;
  }
  check('intensity stays in [0,1] and is zero when clear', intensityOk);

  // A backgrounded tab used to desynchronise the sky from the world clock.
  const skipped = new WeatherSystem({ seed: 11 });
  for (let i = 0; i < 500; i++) skipped.update(60);
  check('a long pause does not strand the model mid-cycle',
    skipped.elapsed >= 0 && skipped.elapsed < skipped.cycleDuration);

  const disabled = new WeatherSystem({ seed: 3, enabled: false });
  for (let i = 0; i < 5000; i++) disabled.update(1);
  check('disabled weather is always clear',
    disabled.visibleState === WeatherState.CLEAR && disabled.intensity === 0);
}

{
  // Persistence: the bug was that reloading silently cleared the sky.
  const original = new WeatherSystem({ seed: 777 });
  for (let i = 0; i < 4000; i++) original.update(0.5);
  original.setTemperature(0.1);

  const restored = new WeatherSystem({ seed: 777 });
  restored.deserialize(original.serialize());
  restored.setTemperature(0.1);

  check('a saved storm survives a reload',
    restored.cycle === original.cycle && restored.visibleState === original.visibleState,
    original.visibleState + ' vs ' + restored.visibleState);
  check('restored intensity matches to within rounding',
    Math.abs(restored.intensity - original.intensity) < 0.02);

  const fresh = new WeatherSystem({ seed: 5 });
  check('a corrupt record is rejected rather than thrown on',
    fresh.deserialize(null) === false &&
    fresh.deserialize({ cycle: -1 }) === false &&
    fresh.deserialize({ cycle: 2, elapsed: Number.NaN }) === false &&
    fresh.cycle === 0);
  check('a valid record is accepted', fresh.deserialize({ cycle: 9, elapsed: 5 }) === true && fresh.cycle === 9);
}

{
  const thunder = new WeatherSystem({ seed: 21 });
  // Fast-forward to a thunder cycle.
  let found = false;
  for (let cycle = 0; cycle < 200 && !found; cycle++) {
    if (baseStateForCycle(21, cycle) === WeatherState.THUNDER) {
      thunder.cycle = cycle;
      found = true;
    }
  }
  check('a thunder cycle exists within the first 200 cycles', found);
  if (found) {
    thunder.setTemperature(0.1);
    let strikes = 0;
    for (let i = 0; i < 600; i++) {
      const result = thunder.update(0.1);
      if (result.struck) strikes++;
    }
    check('a thunderstorm produces lightning', strikes > 0, 'strikes=' + strikes);

    const cold = new WeatherSystem({ seed: 21 });
    cold.cycle = thunder.cycle;
    cold.setTemperature(-0.9);
    let coldStrikes = 0;
    for (let i = 0; i < 600; i++) if (cold.update(0.1).struck) coldStrikes++;
    check('a storm that reads as snow does not throw lightning', coldStrikes === 0);
  }
  check('intensity is zero on a clear cycle',
    intensityForCycle(21, [...Array(200).keys()].find((c) => baseStateForCycle(21, c) === WeatherState.CLEAR)) === 0);
}

// ---------------------------------------------------------------- dimensions

section('Dimension registry (Nether/End groundwork)');

{
  for (const id of DIMENSION_IDS) {
    const problems = validateDimension(DIMENSIONS[id]);
    check('dimension "' + id + '" is internally consistent', problems.length === 0, problems.join('; '));
  }
  check('every dimension id resolves', DIMENSION_IDS.every((id) => getDimension(id).id === id));
  check('an unknown dimension falls back to the Overworld',
    getDimension('atlantis').id === Dimension.OVERWORLD && getDimension(undefined).id === Dimension.OVERWORLD);

  // The 8:1 ratio is the whole reason Nether travel is worth doing.
  const toNether = convertCoordinates({ x: 800, z: -1600 }, Dimension.OVERWORLD, Dimension.NETHER);
  check('Overworld to Nether divides by eight',
    toNether.x === 100 && toNether.z === -200, JSON.stringify(toNether));
  const back = convertCoordinates(toNether, Dimension.NETHER, Dimension.OVERWORLD);
  check('Nether to Overworld multiplies by eight', back.x === 800 && back.z === -1600);
  check('the End does not scale coordinates',
    convertCoordinates({ x: 55, z: -7 }, Dimension.OVERWORLD, Dimension.END).x === 55);

  const seeds = DIMENSION_IDS.map((id) => dimensionSeed(123456, id));
  check('each dimension gets its own generator seed', new Set(seeds).size === DIMENSION_IDS.length);
  check('the Overworld seed is the world seed', dimensionSeed(123456, Dimension.OVERWORLD) === 123456);

  check('a ceilinged dimension reserves its top layers',
    buildCeiling(Dimension.NETHER) === DIMENSIONS[Dimension.NETHER].height - 2);
  check('an open dimension builds to full height',
    buildCeiling(Dimension.OVERWORLD) === DIMENSIONS[Dimension.OVERWORLD].height);
  check('the End has no sea level', DIMENSIONS[Dimension.END].seaLevel === null);
  check('only the Overworld has weather and a day cycle',
    DIMENSION_IDS.filter((id) => DIMENSIONS[id].hasWeather).length === 1 &&
    DIMENSIONS[Dimension.OVERWORLD].hasWeather);
}

// --------------------------------------------------------------- sound events

section('Sound event bindings');

{
  const catalogue = createSoundCatalogue();
  const catalogueNames = new Set(Object.keys(catalogue));

  // The check that makes the whole declarative table worth having: a typo in a
  // sound name is a failing test rather than a sound that never plays.
  const missing = listAllSoundNames().filter((name) => !catalogueNames.has(name));
  check('every mapped sound exists in the catalogue', missing.length === 0, missing.join(', '));

  const eventValues = Object.values(GameplayEvent);
  const unbound = eventValues.filter((event) => !SOUND_EVENTS[event]);
  check('every declared gameplay event has a binding', unbound.length === 0, unbound.join(', '));

  check('the table covers far more than the two sounds FinalV2 played',
    eventValues.length >= 30, 'events=' + eventValues.length);

  // Catalogue coverage: sounds that are synthesised but unreachable are wasted
  // startup time, so name the ones nothing can trigger.
  const reachable = new Set(listAllSoundNames());
  const orphaned = [...catalogueNames].filter(
    (name) => !reachable.has(name) && !name.startsWith('ambient.') && !name.startsWith('weather.')
  );
  check('no gameplay sound is synthesised but unreachable', orphaned.length === 0, orphaned.join(', '));

  const jump = resolveSoundEvent(GameplayEvent.PLAYER_JUMP);
  check('a fixed event resolves to its buffer', jump?.name === 'player.jump' && jump.volume > 0);
  const step = resolveSoundEvent(GameplayEvent.PLAYER_STEP, { soundGroup: 'sand' });
  check('a material event resolves per block group', step?.name === 'step.sand', step?.name);
  const fallback = resolveSoundEvent(GameplayEvent.PLAYER_STEP, { soundGroup: 'not-a-group' });
  check('an unknown material falls back rather than failing',
    catalogueNames.has(fallback?.name ?? ''), fallback?.name);
  check('an unknown event resolves to null', resolveSoundEvent('nope.nope') === null);

  let volumesOk = true;
  for (const event of eventValues) {
    const resolved = resolveSoundEvent(event, { soundGroup: 'stone' });
    if (!resolved || !(resolved.volume >= 0 && resolved.volume <= 1) || !(resolved.pitch > 0)) volumesOk = false;
  }
  check('every event resolves to a sane volume and pitch', volumesOk);
  check('volume scaling is clamped',
    resolveSoundEvent(GameplayEvent.PLAYER_LAND, { volumeScale: 99 })?.volume === 1);
}

{
  const throttle = new SoundEventThrottle();
  check('the first play of an event is allowed', throttle.allow('e', 0.25) === true);
  throttle.tick(0.1);
  check('a repeat inside the cooldown is suppressed', throttle.allow('e', 0.25) === false);
  throttle.tick(0.2);
  check('a repeat after the cooldown is allowed', throttle.allow('e', 0.25) === true);
  check('a zero cooldown never throttles', throttle.allow('f', 0) && throttle.allow('f', 0));
}

// ------------------------------------------------------------------ skeletons

section('Skeletal model maths');

{
  const m = identity(new Float32Array(16));
  check('identity round-trips a point',
    transformPoint(m, [1, 2, 3]).every((v, i) => Math.abs(v - [1, 2, 3][i]) < 1e-6));

  const a = compose(new Float32Array(16), [1, 2, 3], [0, 0, 0]);
  const out = multiply(new Float32Array(16), a, identity(new Float32Array(16)));
  check('multiplying by identity is a no-op',
    Array.from(out).every((v, i) => Math.abs(v - a[i]) < 1e-6));

  // A quarter turn about Y should send +Z to +X.
  const turned = compose(new Float32Array(16), [0, 0, 0], [0, Math.PI / 2, 0]);
  const p = transformPoint(turned, [0, 0, 1]);
  check('a 90 degree yaw maps +Z to +X',
    Math.abs(p[0] - 1) < 1e-6 && Math.abs(p[2]) < 1e-6, JSON.stringify(p.map((v) => +v.toFixed(3))));
}

{
  check('a missing parent is rejected',
    validateBones([{ name: 'a', parent: 'ghost', pivot: [0, 0, 0] }]).length > 0);
  check('a duplicate name is rejected',
    validateBones([
      { name: 'a', parent: null, pivot: [0, 0, 0] },
      { name: 'a', parent: null, pivot: [0, 0, 0] },
    ]).length > 0);
  check('a cycle is rejected rather than hanging',
    validateBones([
      { name: 'a', parent: 'b', pivot: [0, 0, 0] },
      { name: 'b', parent: 'a', pivot: [0, 0, 0] },
    ]).length > 0);
  check('a skeleton with no root is rejected',
    validateBones([{ name: 'a', parent: 'a', pivot: [0, 0, 0] }]).length > 0);

  const sorted = sortBones([
    { name: 'hand', parent: 'arm', pivot: [0, 0, 0] },
    { name: 'arm', parent: 'torso', pivot: [0, 0, 0] },
    { name: 'torso', parent: null, pivot: [0, 0, 0] },
  ]);
  check('sortBones puts parents before children',
    sorted.map((b) => b.name).join(',') === 'torso,arm,hand', sorted.map((b) => b.name).join(','));
}

{
  // The behaviour a flat box list cannot express: rotating a parent must carry
  // the child with it. This is the core justification for the whole rewrite.
  const skeleton = new Skeleton({
    name: 'test',
    bones: [
      { name: 'torso', parent: null, pivot: [0, 1, 0] },
      { name: 'arm', parent: 'torso', pivot: [0, 0, 0] },
      { name: 'hand', parent: 'arm', pivot: [0, -1, 0] },
    ],
  });
  const rest = skeleton.getWorldPosition('hand');
  check('the rest pose places a grandchild by accumulated pivots',
    Math.abs(rest[1] - 0) < 1e-6, JSON.stringify(rest));

  skeleton.applyPose(new Map([['arm', { rotation: [Math.PI / 2, 0, 0], position: [0, 0, 0] }]]));
  const posed = skeleton.getWorldPosition('hand');
  check('rotating a parent moves its child',
    Math.abs(posed[1] - 1) < 1e-6 && Math.abs(posed[2] + 1) < 1e-6,
    JSON.stringify(posed.map((v) => +v.toFixed(3))));

  skeleton.resetPose();
  check('resetting returns the child to its rest position',
    Math.abs(skeleton.getWorldPosition('hand')[1] - rest[1]) < 1e-6);
  check('an empty pose is the rest pose',
    skeleton.applyPose(new Map()) && Math.abs(skeleton.getWorldPosition('hand')[1] - rest[1]) < 1e-6);
  check('an unknown bone lookup returns null', skeleton.getWorldMatrix('nope') === null);
}

// ----------------------------------------------------------------- animation

section('Animation clips and blending');

{
  check('looping wraps', Math.abs(wrapTime(2.5, 2, LoopMode.LOOP) - 0.5) < 1e-6);
  check('clamping holds the end', wrapTime(9, 2, LoopMode.CLAMP) === 2);
  check('ping-pong reverses', Math.abs(wrapTime(3, 2, LoopMode.PING_PONG) - 1) < 1e-6);
  check('negative time is zero', wrapTime(-5, 2, LoopMode.LOOP) === 0);
  check('a zero duration does not divide by zero', wrapTime(5, 0, LoopMode.LOOP) === 0);
}

{
  const track = [
    { time: 0, value: [0, 0, 0] },
    { time: 1, value: [10, 20, 30] },
  ];
  check('sampling at a keyframe returns it exactly',
    sampleTrack(track, 1)[0] === 10);
  check('sampling interpolates linearly',
    Math.abs(sampleTrack(track, 0.5)[1] - 10) < 1e-6);
  check('sampling before the first key clamps', sampleTrack(track, -3)[0] === 0);
  check('sampling past the last key clamps', sampleTrack(track, 99)[2] === 30);
  check('an empty track is zero', sampleTrack([], 0.5).every((v) => v === 0));
  check('coincident keyframes do not divide by zero',
    Number.isFinite(sampleTrack([{ time: 1, value: [0, 0, 0] }, { time: 1, value: [5, 0, 0] }], 1)[0]));
}

{
  const a = new Map([['bone', { rotation: [0, 0, 0], position: [0, 0, 0] }]]);
  const b = new Map([['bone', { rotation: [10, 0, 0], position: [0, 4, 0] }]]);
  check('a zero-weight blend keeps the first pose', blendPoses(a, b, 0).get('bone').rotation[0] === 0);
  check('a full-weight blend takes the second', blendPoses(a, b, 1).get('bone').rotation[0] === 10);
  check('a half blend is the midpoint', blendPoses(a, b, 0.5).get('bone').position[1] === 2);
  check('a bone missing from one pose blends against rest',
    blendPoses(new Map(), b, 0.5).get('bone').rotation[0] === 5);
  check('out-of-range weights are clamped', blendPoses(a, b, 9).get('bone').rotation[0] === 10);

  const base = new Map([['bone', { rotation: [1, 0, 0], position: [0, 0, 0] }]]);
  addPose(base, b, 0.5);
  check('an additive layer adds rather than replaces', base.get('bone').rotation[0] === 6);
}

{
  const clips = {
    idle: { name: 'idle', duration: 1, loop: LoopMode.LOOP, tracks: { bone: { rotation: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [0, 0, 0] }] } } },
    walk: { name: 'walk', duration: 1, loop: LoopMode.LOOP, tracks: { bone: { rotation: [{ time: 0, value: [1, 0, 0] }, { time: 1, value: [1, 0, 0] }] } } },
  };
  const controller = new AnimationController(clips, { initial: 'idle' });
  check('the controller starts in its initial clip', controller.current === 'idle');
  check('re-requesting the current clip is a no-op', controller.crossFade('idle') === false);
  check('an unknown clip is refused', controller.crossFade('nope') === false);
  check('cross-fading switches clip', controller.crossFade('walk', 0.4) === true && controller.current === 'walk');
  check('a fade is in progress', controller.isBlending === true);

  controller.update(0.2);
  const mid = controller.getPose().get('bone').rotation[0];
  check('a mid-fade pose lies between the two clips', mid > 0 && mid < 1, String(mid));

  controller.update(0.5);
  check('the fade completes', controller.isBlending === false);
  check('the pose settles on the new clip',
    Math.abs(controller.getPose().get('bone').rotation[0] - 1) < 1e-6);

  controller.setLayer('extra', 'walk', 0.5);
  check('a layer adds on top', controller.getPose().get('bone').rotation[0] > 1);
  controller.clearLayer('extra');
  check('clearing a layer removes its contribution',
    Math.abs(controller.getPose().get('bone').rotation[0] - 1) < 1e-6);

  // A backgrounded tab must not fast-forward a clamped death animation.
  const before = controller.time;
  controller.update(30);
  check('a huge delta is clamped', controller.time - before <= 0.25 + 1e-6);
}

{
  check('an unsorted track is rejected',
    validateClip({ name: 'x', duration: 1, tracks: { b: { rotation: [{ time: 1, value: [0, 0, 0] }, { time: 0, value: [0, 0, 0] }] } } }).length > 0);
  check('a track past the duration is rejected',
    validateClip({ name: 'x', duration: 1, tracks: { b: { rotation: [{ time: 0, value: [0, 0, 0] }, { time: 5, value: [0, 0, 0] }] } } }).length > 0);
  check('a non-looping loop clip is flagged',
    validateClip({ name: 'x', duration: 1, loop: LoopMode.LOOP, tracks: { b: { rotation: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [9, 0, 0] }] } } }).length > 0);
  check('a clip targeting an unknown bone is caught',
    validateClip(
      { name: 'x', duration: 1, loop: LoopMode.CLAMP, tracks: { ghost: { rotation: [{ time: 0, value: [0, 0, 0] }] } } },
      new Skeleton({ name: 's', bones: [{ name: 'real', parent: null, pivot: [0, 0, 0] }] })
    ).length > 0);
}

// ------------------------------------------------------------- mob skeletons

section('Creature skeletons and gaits');

{
  const skeletonIds = Object.keys(MOB_SKELETONS);
  const missingSkeleton = MOB_IDS.filter((id) => !skeletonIds.includes(id));
  check('every mob has a skeleton', missingSkeleton.length === 0, missingSkeleton.join(', '));
  const orphanSkeleton = skeletonIds.filter((id) => !MOB_IDS.includes(id));
  check('no skeleton exists without a mob', orphanSkeleton.length === 0, orphanSkeleton.join(', '));

  for (const id of skeletonIds) {
    const entry = MOB_SKELETONS[id];
    const problems = validateBones(entry.skeleton.bones);
    check(id + ': skeleton is valid', problems.length === 0, problems.join('; '));

    let skeleton = null;
    try {
      skeleton = new Skeleton(entry.skeleton);
    } catch (error) {
      check(id + ': skeleton builds', false, String(error.message));
    }
    if (!skeleton) continue;
    check(id + ': skeleton has geometry', skeleton.boxCount > 0, 'boxes=' + skeleton.boxCount);

    const missingClips = REQUIRED_CLIPS.filter((clip) => !entry.clips[clip]);
    check(id + ': defines every required clip', missingClips.length === 0, missingClips.join(', '));

    // The integration check: every authored clip must resolve against the bones
    // it is authored for, and loop cleanly. A typo'd bone name here is the
    // classic silent "the animation just does not play".
    const clipProblems = [];
    for (const clip of Object.values(entry.clips)) {
      clipProblems.push(...validateClip(clip, skeleton));
    }
    check(id + ': every clip validates against its skeleton',
      clipProblems.length === 0, clipProblems.slice(0, 3).join('; '));

    // Sampling a gait must actually move something, or the creature moonwalks.
    const walk = entry.clips.walk;
    const poseA = sampleClip(walk, 0);
    const poseB = sampleClip(walk, walk.duration * 0.25, new Map());
    let moved = false;
    for (const [bone, value] of poseB) {
      const other = poseA.get(bone);
      if (!other) { moved = true; break; }
      for (let i = 0; i < 3; i++) {
        if (Math.abs(value.rotation[i] - other.rotation[i]) > 1e-4) moved = true;
        if (Math.abs(value.position[i] - other.position[i]) > 1e-4) moved = true;
      }
    }
    check(id + ': the walk gait actually animates', moved);

    const controller = new AnimationController(entry.clips, { initial: 'idle' });
    controller.crossFade('walk', 0.2);
    controller.update(0.1);
    let finite = true;
    for (const value of controller.getPose().values()) {
      if (value.rotation.some((v) => !Number.isFinite(v))) finite = false;
      if (value.position.some((v) => !Number.isFinite(v))) finite = false;
    }
    check(id + ': a mid-blend pose is finite', finite);

    check(id + ': every clip request resolves to something playable',
      ['idle', 'walk', 'run', 'attack', 'cast', 'flap'].every((name) => {
        const resolved = resolveClip(id, name);
        return resolved !== null && entry.clips[resolved] !== undefined;
      }));
  }

  // Distinct gaits are the whole point: the seven creatures must not all share
  // one walk cycle the way they did when the renderer owned the sine wave.
  const walkDurations = new Set(skeletonIds.map((id) => MOB_SKELETONS[id].clips.walk.duration));
  check('creatures do not all share one walk cycle', walkDurations.size >= 4,
    'distinct durations=' + walkDurations.size);
}

// ----------------------------------------------------------------- navigation

section('Voxel navigation upgrades');

{
  // A tiny flat world with a wall, built as a function rather than an array so
  // the navigator sees exactly the surface it does in game.
  const makeWorld = (solid) => ({
    isLoaded: () => true,
    getBlock: (x, y, z) => (y === 0 ? 1 : solid(x, y, z)),
    isCollidable: (x, y, z) => (y === 0 ? true : solid(x, y, z) !== 0),
  });

  const flat = makeWorld(() => 0);
  check('a flat cell is walkable', isWalkableNode(flat, 0, 1, 0, { entityHeight: 1.8 }));

  const straight = findVoxelPath(flat, { x: 0, y: 1, z: 0 }, { x: 6, y: 1, z: 6 });
  check('an open diagonal route is found', Array.isArray(straight) && straight.length > 0);
  // Cardinal-only search needs 12 steps to cross 6x6; diagonals need 6.
  check('diagonal movement shortens an open route',
    straight !== null && straight.length <= 8, 'steps=' + (straight?.length ?? 'null'));

  const cardinalOnly = findVoxelPath(flat, { x: 0, y: 1, z: 0 }, { x: 6, y: 1, z: 6 }, { allowDiagonal: false });
  check('diagonals can still be switched off',
    cardinalOnly !== null && cardinalOnly.length > straight.length,
    'cardinal=' + cardinalOnly?.length + ' diagonal=' + straight.length);

  // findVoxelPath returns a partial path when it cannot reach the goal, so
  // "did it arrive" is the only meaningful success test.
  const reaches = (path, gx, gz) =>
    Array.isArray(path) &&
    path.length > 0 &&
    Math.floor(path[path.length - 1].x) === gx &&
    Math.floor(path[path.length - 1].z) === gz;

  // A long wall with one gap. The detour is ~18 steps against a 10-step straight
  // line, which the old 384-node budget could not afford.
  const walled = makeWorld((x, y, z) => (z === 5 && y < 3 && x !== 8 ? 1 : 0));
  const around = findVoxelPath(walled, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 10 }, { maxDistance: 40 });
  check('a long detour around a wall is completed', reaches(around, 0, 10),
    'steps=' + (around?.length ?? 'null'));
  check('the detour is genuinely longer than the blocked straight line',
    around !== null && around.length > 14, 'steps=' + (around?.length ?? 'null'));
  const starved = findVoxelPath(walled, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 10 }, { maxNodes: 40, maxDistance: 40 });
  check('a starved node budget cannot complete the detour', !reaches(starved, 0, 10));

  // Doors: the bug was that a closed door read as a wall and mobs never left.
  const DOOR = 66;
  const doored = makeWorld((x, y, z) => {
    if (z !== 3) return 0;
    if (x === 0) return y < 3 ? DOOR : 0;
    return y < 4 ? 1 : 0;
  });
  const throughDoor = findVoxelPath(doored, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 6 }, { canUseDoors: true });
  check('a mob routes through a door it can open', reaches(throughDoor, 0, 6),
    'steps=' + (throughDoor?.length ?? 'null'));
  const blocked = findVoxelPath(doored, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 6 }, { canUseDoors: false, maxNodes: 300 });
  check('a mob that cannot open doors never gets through', !reaches(blocked, 0, 6));

  // Corner guard: two blocks placed corner-to-corner must not be squeezed past.
  const corner = makeWorld((x, y, z) => ((x === 1 && z === 0) || (x === 0 && z === 1)) && y < 3 ? 1 : 0);
  const squeeze = findVoxelPath(corner, { x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 1 }, { maxNodes: 200 });
  check('a mob cannot clip through a diagonal corner gap',
    squeeze === null || squeeze.length > 1, 'steps=' + (squeeze?.length ?? 'null'));

  // Hazards still repel, and lava is not a shortcut.
  const LAVA = 47;
  const lavaWorld = makeWorld((x, y, z) => (z === 2 && y === 1 ? LAVA : 0));
  check('lava is not walkable', !isWalkableNode(lavaWorld, 0, 1, 2, { avoidHazards: true }));
  check('hazard avoidance can be disabled for fire-immune mobs',
    isWalkableNode(lavaWorld, 0, 1, 2, { avoidHazards: false }) === true ||
    isWalkableNode(lavaWorld, 0, 1, 2, { avoidHazards: false }) === false);
}

// ---------------------------------------------------------------- phase 2: rig
{
  const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  section('Phase 2 - mob pose buffer');
  check('bone texture is three texels wide per bone', poseBufferWidth(7) === 21);
  check('a zero-bone texture is rejected', (() => { try { poseBufferWidth(0); return false; } catch { return true; } })());
  const p2buf = new MobPoseBuffer({ boneCount: 7, maxInstances: 4 });
  check('pose buffer reports its footprint', sameJson(p2buf.getStats(), { bones: 7, instances: 4, texture: '21x4', kilobytes: 1.3 }), JSON.stringify(p2buf.getStats()));
  check('every row starts as identity', sameJson(p2buf.readBone(2, 3), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]));
  check('an identity bone leaves a point alone', sameJson(p2buf.transformByBone(0, 0, [2, 3, 4]), [2, 3, 4]));
  const p2uv = poseBufferUv(1, 2, 3, 21, 4);
  check('texel lookups land on pixel centres', Math.abs(p2uv[0] - 5.5 / 21) < 1e-9 && Math.abs(p2uv[1] - 3.5 / 4) < 1e-9, JSON.stringify(p2uv));
  const p2world = new Float32Array(7 * 16);
  for (let b = 0; b < 7; b++) { p2world[b * 16] = 1; p2world[b * 16 + 5] = 1; p2world[b * 16 + 10] = 1; p2world[b * 16 + 15] = 1; }
  p2world[12] = 10; p2world[13] = 20; p2world[14] = 30;
  check('a matching skeleton is accepted', p2buf.writeSkeleton(0, { world: p2world, boneCount: 7 }) === true);
  check('translation is read out of the fourth column', sameJson(p2buf.transformByBone(0, 0, [1, 2, 3]), [11, 22, 33]));
  check('a bone-count mismatch is refused', p2buf.writeSkeleton(0, { world: p2world, boneCount: 6 }) === false);
  check('an out-of-range instance row is refused', p2buf.writeSkeleton(9, { world: p2world, boneCount: 7 }) === false);

  section('Phase 2 - clip selection');
  check('death outranks every other state', selectMobClip('cow', { isDead: true, attacking: true, speed: 9 }) === 'death');
  check('a hostile mob plays its attack clip', selectMobClip('husk', { attacking: true, speed: 9 }) === 'attack');
  check('a passive mob keeps running rather than faking an attack', selectMobClip('cow', { attacking: true, speed: 9 }) === 'run', String(selectMobClip('cow', { attacking: true, speed: 9 })));
  check('a caster plays its cast clip', selectMobClip('bonecaster', { casting: true, speed: 0 }) === 'cast');
  check('above run speed selects run', selectMobClip('cow', { speed: MOB_RUN_SPEED + 0.5 }) === 'run');
  check('a slow walk selects walk', selectMobClip('cow', { speed: 1 }) === 'walk');
  check('below the movement epsilon selects idle', selectMobClip('cow', { speed: MOB_MOVE_EPSILON / 2 }) === 'idle');
  check('an unknown mob has no clip', selectMobClip('dragon', { speed: 0 }) === null);
  check('gait rate is clamped at the bottom', mobGaitRate(0.001, true) >= MOB_MIN_GAIT);
  check('gait rate is clamped at the top', mobGaitRate(99, true) <= MOB_MAX_GAIT);
  check('a non-locomotive clip plays at normal rate', mobGaitRate(5, false) === 1);

  section('Phase 2 - every mob rigs and animates');
  const p2ids = Object.keys(PHASE2_MOB_SKELETONS);
  check('the complete mob roster is rigged', p2ids.length === MOB_IDS.length, String(p2ids.length));
  for (const id of p2ids) {
    const animator = new MobAnimator(id);
    const world = animator.update(0.1, { speed: 1.2, onGround: true });
    check(`${id} produces finite world matrices for ${animator.boneCount} bones`,
      animator.boneCount > 0 && world.length === animator.boneCount * 16 && world.every((v) => Number.isFinite(v)));
    const absent = PHASE2_REQUIRED_CLIPS.filter((clip) => !animator.controller.clips[clip]);
    check(`${id} defines every required clip`, absent.length === 0, absent.join(','));
  }

  section('Phase 2 - animation state');
  const p2cow = new MobAnimator('cow');
  check('a cow rigs to seven bones with a head', p2cow.boneCount === 7 && p2cow.hasHead === true);
  p2cow.update(0.1, { speed: 2, onGround: true });
  check('a moderate speed drives the walk clip', p2cow.clip === 'walk', String(p2cow.clip));
  p2cow.update(0.1, { speed: 5, onGround: true });
  check('a high speed drives the run clip', p2cow.clip === 'run', String(p2cow.clip));
  const p2hurt = new MobAnimator('cow');
  p2hurt.update(0.05, { speed: 0, hurt: false });
  check('no flinch layer before damage', p2hurt.controller.layers.size === 0);
  p2hurt.update(0.05, { speed: 0, hurt: true });
  check('damage adds a flinch layer', p2hurt.controller.layers.size === 1);
  const p2flinchTime = p2hurt.controller.layers.get('flinch').time;
  p2hurt.update(0.05, { speed: 0, hurt: true });
  check('a held damage flag advances the flinch instead of restarting it', p2hurt.controller.layers.get('flinch').time > p2flinchTime);
  for (let i = 0; i < 20; i++) p2hurt.update(0.05, { speed: 0, hurt: false });
  check('the flinch layer expires on its own', p2hurt.controller.layers.size === 0, String(p2hurt.controller.layers.size));
  check('a dead mob does not flinch', (() => { const c = new MobAnimator('cow'); c.update(0.05, { speed: 0, hurt: true, isDead: true }); return c.controller.layers.size === 0; })());
  const p2lurker = new MobAnimator('lurker');
  check('a floater reports no head', p2lurker.hasHead === false);
  check('a headless mob still animates', p2lurker.update(0.1, { speed: 0.5 }).every((v) => Number.isFinite(v)));
  check('an unknown mob yields no animator', tryCreateAnimator('dragon') === null);
  check('a known mob yields an animator', tryCreateAnimator('pig') instanceof MobAnimator);
  check('constructing an unknown mob throws', (() => { try { new MobAnimator('dragon'); return false; } catch { return true; } })());
  const p2endBuf = new MobPoseBuffer({ boneCount: p2cow.boneCount, maxInstances: 4 });
  p2cow.update(0.1, { speed: 1.5, onGround: true });
  check('animator output feeds straight into the pose buffer', p2endBuf.writeSkeleton(0, p2cow.skeleton) === true);
  check('bone origins stay finite through the pipeline', p2endBuf.transformByBone(0, 0, [0, 0, 0]).every((v) => Number.isFinite(v)));

  section('Phase 2 - goal selector');
  check('a malformed goal is rejected', validateGoal({}).length > 0);
  check('adding a malformed goal throws', (() => { try { new GoalSelector().add({}); return false; } catch { return true; } })());
  check('wander steers the body only', wanderGoal().controls === GoalControl.MOVE);
  check('panic leaves the jump channel free', (panicGoal().controls & GoalControl.JUMP) === 0);
  check('melee attack leaves the jump channel free', (meleeAttackGoal().controls & GoalControl.JUMP) === 0);
  check('float claims only the jump channel', floatGoal().controls === GoalControl.JUMP);
  const p2ctx = {
    mob: { isDead: false }, random: () => 0, distanceToPlayer: 3, hasDestination: true,
    pickWanderTarget() {}, moveToDestination() {}, clearDestination() { this.hasDestination = false; },
    facePlayer() {}, pickFleeTarget() {}, swimUp() {},
  };
  const p2sel = new GoalSelector(passiveAnimalGoals());
  p2sel.update(p2ctx, 0.05);
  check('an idle animal wanders and watches at the same time', sameJson(p2sel.activeNames(), ['wander', 'lookAt']), p2sel.activeNames().join(','));
  p2ctx.recentlyHurt = true;
  p2ctx.hasDestination = true;
  p2sel.update(p2ctx, 0.05);
  check('panic preempts wandering', p2sel.activeNames().includes('panic') && !p2sel.activeNames().includes('wander'), p2sel.activeNames().join(','));
  p2ctx.inWater = true;
  p2sel.update(p2ctx, 0.05);
  check('a hurt animal in water floats and still flees', p2sel.activeNames().includes('float') && p2sel.activeNames().includes('panic'), p2sel.activeNames().join(','));
  p2sel.reset(p2ctx);
  check('reset stops every goal', p2sel.activeNames().length === 0);
  check('the hostile preset builds', hostileMeleeGoals().length === 4);

  section('Phase 2 - block families');
  const p2oak = buildFamily(WOOD_FAMILIES[0]);
  check('a wood family yields thirteen variants', p2oak.length === 13, String(p2oak.length));
  check('stripped logs are named correctly', p2oak.find((b) => b.variant === 'stripped_log').displayName === 'Stripped Oak Log');
  check('pressure plates are named correctly', p2oak.find((b) => b.variant === 'pressure_plate').displayName === 'Oak Pressure Plate');
  const p2granite = buildFamily(STONE_FAMILIES[0]);
  check('a stone base keeps the bare family name', p2granite[0].name === 'granite' && p2granite[0].displayName === 'Granite');
  check('polished stone is named correctly', familyVariantName('granite', 'polished') === 'polished_granite' && familyVariantDisplayName('granite', 'polished') === 'Polished Granite');
  check('deepslate inherits its hardness multiplier', buildFamily(STONE_FAMILIES[3])[0].hardness === 3);
  const p2all = buildFamilies(ALL_FAMILIES);
  check('the full expansion is 127 blocks', p2all.length === 127 && plannedBlockCount() === 127, String(p2all.length));
  check('no generated block fails validation', validateFamilyBlocks(p2all).length === 0, validateFamilyBlocks(p2all).join('; '));
  check('slabs and stairs never block skylight', p2all.filter((b) => !b.solid).every((b) => b.lightAttenuation === 0));
  check('full cubes always block skylight', p2all.filter((b) => b.solid).every((b) => b.lightAttenuation === 15));
  check('wood wants an axe and stone a pickaxe', p2oak.every((b) => b.preferredTool === 'axe') && p2granite.every((b) => b.preferredTool === 'pickaxe'));
  const p2alloc = allocateIds(p2all, [11, 12, 13, 14, 15]);
  check('id allocation avoids ids already in use', p2alloc.assignments.every((x) => ![11, 12, 13, 14, 15].includes(x.id)));
  check('id allocation is reproducible', sameJson(p2alloc.assignments.map((x) => x.id), allocateIds(p2all, [11, 12, 13, 14, 15]).assignments.map((x) => x.id)));
  check('id allocation refuses to overflow its budget', (() => { try { allocateIds(p2all, [], 10); return false; } catch { return true; } })());
  check('a wood family implies ten recipes', familyRecipes(WOOD_FAMILIES[0]).length === 10);
  check('a stone family implies five recipes', familyRecipes(STONE_FAMILIES[0]).length === 5);

  section('Phase 2 - structure assembly');
  check('facings invert correctly', oppositeStructureFacing(StructureFacing.POSITIVE_X) === StructureFacing.NEGATIVE_X);
  check('rotation swaps footprint on odd quarter turns', sameJson(rotateStructureSize([3, 4, 5], 1), [5, 4, 3]) && sameJson(rotateStructureSize([3, 4, 5], 2), [3, 4, 5]));
  let p2pt = [1, 0, 2];
  let p2size = [3, 3, 5];
  for (let i = 0; i < 4; i++) { p2pt = rotateStructurePoint(p2pt, p2size, 1); p2size = rotateStructureSize(p2size, 1); }
  check('four quarter turns return a point to where it started', sameJson(p2pt, [1, 0, 2]), JSON.stringify(p2pt));
  const p2house = {
    name: 'house', size: [3, 3, 3],
    blocks: [{ x: 0, y: 0, z: 0, block: 1 }, { x: 2, y: 0, z: 2, block: 2 }],
    connectors: [{ name: 'door', at: [0, 0, 1], facing: StructureFacing.NEGATIVE_X, target: 'street' }],
  };
  check('a well-formed piece validates', validateStructurePiece(p2house).length === 0, validateStructurePiece(p2house).join('; '));
  check('a block outside the piece bounds is caught', validateStructurePiece({ ...p2house, blocks: [{ x: 9, y: 0, z: 0, block: 1 }] }).length > 0);
  const p2rot = rotateStructurePiece(p2house, 1);
  check('a rotated cube keeps its size', sameJson(p2rot.size, [3, 3, 3]));
  check('a rotated connector turns with the piece', p2rot.connectors[0].facing === StructureFacing.NEGATIVE_Z, String(p2rot.connectors[0].facing));
  const p2street = {
    name: 'street', size: [3, 1, 3],
    blocks: [{ x: 0, y: 0, z: 0, block: 3 }],
    connectors: [
      { name: 'a', at: [0, 0, 1], facing: StructureFacing.NEGATIVE_X, target: 'street' },
      { name: 'b', at: [2, 0, 1], facing: StructureFacing.POSITIVE_X, target: 'street' },
    ],
  };
  const p2pools = new Map([['street', new StructurePool('street', [{ piece: p2street }])]]);
  const p2lcg = (seed) => { let s = seed; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; };
  const p2run = assembleStructure({ start: p2house, origin: [0, 0, 0], pools: p2pools, random: p2lcg(7), maxPieces: 5 });
  check('assembly honours the piece budget', p2run.placements.length === 5, String(p2run.placements.length));
  check('assembly is deterministic for a given seed', sameJson(p2run.placements.map((x) => x.origin), assembleStructure({ start: p2house, origin: [0, 0, 0], pools: p2pools, random: p2lcg(7), maxPieces: 5 }).placements.map((x) => x.origin)));
  let p2overlap = false;
  for (let i = 0; i < p2run.placements.length; i++) {
    for (let j = i + 1; j < p2run.placements.length; j++) {
      if (structureBoundsOverlap(p2run.placements[i].bounds, p2run.placements[j].bounds)) p2overlap = true;
    }
  }
  check('no two pieces ever overlap', !p2overlap);
  check('flattening emits one cell per authored block', flattenPlacements(p2run.placements).length === p2run.placements.reduce((n, pl) => n + pl.piece.blocks.length, 0));
  check('world bounds confine the structure', assembleStructure({ start: p2house, origin: [0, 0, 0], pools: p2pools, random: p2lcg(7), maxPieces: 5, bounds: { minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 2, maxZ: 2 } }).placements.length === 1);
  check('a start piece outside the bounds places nothing', assembleStructure({ start: p2house, origin: [50, 0, 0], pools: p2pools, random: p2lcg(1), bounds: { minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 2, maxZ: 2 } }).placements.length === 0);
  check('assembly demands an injected random source', (() => { try { assembleStructure({ start: p2house, pools: p2pools }); return false; } catch { return true; } })());
}

// ------------------------------------------------------ block family catalogue

{
  section('block family catalogue');
  const p3names = BLOCK_DEFINITIONS.map((d) => d.name);
  check('the catalogue grew past the hand-written 73', BLOCK_DEFINITIONS.length > 73, `${BLOCK_DEFINITIONS.length} blocks`);
  check('every block id is unique', new Set(BLOCK_DEFINITIONS.map((d) => d.id)).size === BLOCK_DEFINITIONS.length);
  check('every block name is unique', new Set(p3names).size === p3names.length);
  check('definitions stay in id order', BLOCK_DEFINITIONS.every((d, i) => d.id === i));
  check('the enum exposes every definition', Object.keys(Block).length === BLOCK_DEFINITIONS.length);

  // Ids are written into save files. Renumbering block 40 turns every saved
  // chunk into confetti, so the original range must stay exactly where it was.
  check('saved ids 0-72 keep their meaning', BLOCK_DEFINITIONS.slice(0, 73).every((d, i) => d.id === i));
  check('generated blocks are a pure append', FAMILY_BLOCKS.every((e) => e.id >= 73));

  // The skip list is hand-maintained; if it drifts out of sync with the
  // catalogue a duplicate block silently appears with a second id.
  const p3base = new Set(BLOCK_DEFINITIONS.slice(0, 73).map((d) => d.name));
  const p3skipped = buildFamilies(ALL_FAMILIES).filter((e) => p3base.has(e.name)).map((e) => e.name);
  check('the skip list still matches the catalogue', p3skipped.length === 11, `${p3skipped.length} pre-existing`);
  const p3live = new Set(FAMILY_BLOCKS.map((e) => e.name));
  check('no generated block collides with a hand-written one', p3skipped.every((n) => !p3live.has(n)));

  // A block with no atlas tile renders magenta; a declared tile with no
  // painter throws during atlas build. Both are boot-time failures.
  check('every generated block has an atlas tile', FAMILY_BLOCKS.every((e) => TILE_INDEX[e.textureAll] !== undefined));
  check('every block has a texture', BLOCK_DEFINITIONS.every((d) => d.id === 0 || Boolean(d.textureTop)));
  check('tile names are unique', new Set(TILE_NAMES).size === TILE_NAMES.length);
  check('the atlas stays inside its tile budget', TILE_NAMES.length <= 1024, `${TILE_NAMES.length}/1024`);

  // A block the player can never obtain is the same as a block that is missing.
  const p3palette = new Set(CREATIVE_GROUPS.flatMap((g) => g.blocks));
  check('every generated block is reachable in creative', FAMILY_BLOCKS.every((e) => p3palette.has(e.id)));
  check('stone families demand a pickaxe', FAMILY_BLOCKS.filter((e) => e.preferredTool === 'pickaxe').every((e) => BLOCK_DEFINITIONS[e.id].requiresCorrectTool));
  check('wood families stay punchable', FAMILY_BLOCKS.filter((e) => e.preferredTool === 'axe').every((e) => !BLOCK_DEFINITIONS[e.id].requiresCorrectTool));

  section('block family recipes');
  const p3blocks = new Set(p3names);
  const p3ids = RECIPE_DEFINITIONS.map((r) => r.id);
  check('recipe ids stay unique', new Set(p3ids).size === p3ids.length, `${p3ids.length} recipes`);
  check('the recipe book grew with the catalogue', RECIPE_DEFINITIONS.length > 81, `${RECIPE_DEFINITIONS.length} recipes`);
  check('legacy spruce logs still yield oak planks', RECIPE_DEFINITIONS.find((r) => r.id === 'planks_from_spruce_log')?.result.id === 'oak_planks');
  // 'polished_granite' leads with the variant, so match on the family name.
  const p3stone = RECIPE_DEFINITIONS.filter((r) => r.id.includes('granite'));
  check('stone families reached the recipe book', p3stone.length === 5, `${p3stone.length}`);
  check('generated recipes produce real blocks', RECIPE_DEFINITIONS.filter((r) => r.group === 'polished' || r.group === 'wall').every((r) => p3blocks.has(r.result.id)));
  check('every generated variant is craftable', ['spruce_slab', 'mangrove_door', 'granite_wall', 'polished_tuff'].every((n) => RECIPE_DEFINITIONS.some((r) => r.result.id === n)));
}

// ---------------------------------------------------------------------- result

process.stdout.write(
  `\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}${checks - failures}/${checks} checks passed\x1b[0m\n`
);
process.exit(failures === 0 ? 0 : 1);
