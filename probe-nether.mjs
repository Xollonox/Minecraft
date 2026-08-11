// Throwaway harness: generates real Nether chunks and asserts the dimension is
// actually shaped like the Nether. Deleted before packaging.

import { WORLD_HEIGHT, BEDROCK_HEIGHT } from './src/config/GameConfig.js';
import { voxelIndex } from './src/utils/CoordinateUtils.js';
import { Block, BLOCK_DEFINITIONS } from './src/world/BlockTypes.js';
import { NetherGenerator } from './src/world/NetherGenerator.js';
import { Dimension, dimensionSeed, buildCeiling, getDimension } from './src/world/DimensionConfig.js';
import { NETHER_BIOME_IDS, getNetherBiome } from './src/world/NetherBiomes.js';

const nameById = new Map(BLOCK_DEFINITIONS.map((d) => [d.id, d.name]));
const seed = dimensionSeed(1337, Dimension.NETHER);
const generator = new NetherGenerator(seed);
const ceilingY = buildCeiling(getDimension(Dimension.NETHER));

// Scattered over ~1500 blocks rather than one contiguous block, so biome
// variety is measured across a realistic exploration range instead of inside a
// single noise cell.
const COORDS = [];
for (let cx = -24; cx <= 24; cx += 6) for (let cz = -24; cz <= 24; cz += 6) COORDS.push([cx, cz]);

const counts = new Map();
const biomesSeen = new Set();
let totalVoxels = 0;
let airVoxels = 0;
let standableColumns = 0;
let columnsTotal = 0;
let worstFloor = Infinity;
let bestFloor = -Infinity;

const problems = [];

for (const [cx, cz] of COORDS) {
  const chunk = generator.generateChunk(cx, cz);

  for (let i = 0; i < chunk.blocks.length; i++) {
    const id = chunk.blocks[i];
    totalVoxels++;
    if (id === Block.AIR) { airVoxels++; continue; }
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  for (let localZ = 0; localZ < 16; localZ++) {
    for (let localX = 0; localX < 16; localX++) {
      const mapIndex = localX + (localZ * 16);
      columnsTotal++;
      biomesSeen.add(chunk.biomeMap[mapIndex]);

      // Bedrock shell must be intact in every single column.
      if (chunk.blocks[voxelIndex(localX, 0, localZ)] !== Block.BEDROCK) {
        problems.push(`chunk ${cx},${cz} column ${localX},${localZ} has no bedrock floor`);
      }
      if (chunk.blocks[voxelIndex(localX, WORLD_HEIGHT - 1, localZ)] !== Block.BEDROCK) {
        problems.push(`chunk ${cx},${cz} column ${localX},${localZ} has no bedrock ceiling`);
      }
      // Nothing may sit above the build ceiling except bedrock.
      for (let y = ceilingY; y < WORLD_HEIGHT; y++) {
        const id = chunk.blocks[voxelIndex(localX, y, localZ)];
        if (id !== Block.AIR && id !== Block.BEDROCK) {
          problems.push(`chunk ${cx},${cz} has ${nameById.get(id)} at y=${y}, above the roof`);
        }
      }
      // No air pockets below the lava level: the ocean must be flooded.
      for (let y = BEDROCK_HEIGHT + 1; y <= generator.lavaLevel; y++) {
        if (chunk.blocks[voxelIndex(localX, y, localZ)] === Block.AIR) {
          problems.push(`chunk ${cx},${cz} has an air pocket at y=${y}, below the lava sea`);
          y = generator.lavaLevel;
        }
      }

      const floor = chunk.heightMap[mapIndex];
      if (floor > generator.lavaLevel && floor < ceilingY - 3) {
        standableColumns++;
        worstFloor = Math.min(worstFloor, floor);
        bestFloor = Math.max(bestFloor, floor);
      }
    }
  }
}

const byCount = [...counts.entries()].sort((a, b) => b[1] - a[1]);
console.log(`chunks generated : ${COORDS.length}`);
console.log(`air              : ${((airVoxels / totalVoxels) * 100).toFixed(1)}%`);
console.log(`standable columns: ${((standableColumns / columnsTotal) * 100).toFixed(1)}% (floors y=${worstFloor}..${bestFloor})`);
console.log(`biomes seen      : ${[...biomesSeen].sort((a, b) => a - b).map((id) => getNetherBiome(id)?.name ?? `??${id}`).join(', ')}`);
console.log('top blocks       :');
for (const [id, count] of byCount.slice(0, 18)) {
  console.log(`   ${String(count).padStart(8)}  ${nameById.get(id) ?? id}`);
}

// Everything the Nether is required to contain.
const REQUIRED = [
  'netherrack', 'lava', 'bedrock', 'glowstone', 'nether_quartz_ore',
  'nether_gold_ore', 'soul_sand', 'soul_soil', 'crimson_nylium',
  'warped_nylium', 'basalt', 'blackstone', 'crimson_stem', 'warped_stem',
  'nether_wart_block', 'warped_wart_block', 'shroomlight', 'crimson_roots',
  'warped_roots', 'nether_sprouts', 'weeping_vines', 'twisting_vines',
  'crimson_fungus', 'warped_fungus', 'magma_block', 'ancient_debris',
  'gilded_blackstone', 'soul_fire',
];
const present = new Set([...counts.keys()].map((id) => nameById.get(id)));
const absent = REQUIRED.filter((name) => !present.has(name));

console.log(`required blocks  : ${REQUIRED.length - absent.length}/${REQUIRED.length} present`);
if (absent.length) console.log(`   ABSENT: ${absent.join(', ')}`);

// Overworld blocks that must never appear down here.
const FORBIDDEN = ['grass_block', 'dirt', 'water', 'sand', 'oak_log', 'oak_leaves', 'stone', 'snow'];
const leaked = FORBIDDEN.filter((name) => present.has(name));
if (leaked.length) problems.push(`Overworld blocks leaked into the Nether: ${leaked.join(', ')}`);

if (biomesSeen.size < NETHER_BIOME_IDS.length) {
  problems.push(`only ${biomesSeen.size}/${NETHER_BIOME_IDS.length} Nether biomes appeared across ${COORDS.length} sampled chunks`);
}
if (standableColumns / columnsTotal < 0.5) {
  problems.push(`only ${((standableColumns / columnsTotal) * 100).toFixed(1)}% of columns are standable; the Nether would be unplayable`);
}

// Determinism: the same seed must produce the same chunk twice.
const a = new NetherGenerator(seed).generateChunk(2, -3);
const b = new NetherGenerator(seed).generateChunk(2, -3);
let identical = a.blocks.length === b.blocks.length;
for (let i = 0; identical && i < a.blocks.length; i++) if (a.blocks[i] !== b.blocks[i]) identical = false;
if (!identical) problems.push('generation is not deterministic for a fixed seed');
console.log(`deterministic    : ${identical}`);

const unique = [...new Set(problems)];
console.log(`problems         : ${unique.length}`);
for (const problem of unique.slice(0, 20)) console.log(`   ! ${problem}`);

const ok = unique.length === 0 && absent.length === 0;
console.log(ok ? 'NETHER TERRAIN: VALID' : 'NETHER TERRAIN: PROBLEMS FOUND');
process.exit(ok ? 0 : 1);
