/** Deterministic outer-End cities and ships for version 7. */

import { hash3 } from '../utils/MathUtils.js';
import { floorDiv } from '../utils/CoordinateUtils.js';
import { Block } from './BlockTypes.js';
import { END_VOID_RADIUS } from './EndGenerator.js';

export const END_CITY_REGION_CHUNKS = 32;
export const END_CITY_BASE_Y = 86;

function regionSite(regionX, regionZ, seed) {
  const roll = hash3(regionX, 731, regionZ, seed) >>> 0;
  const chunkX = regionX * END_CITY_REGION_CHUNKS + 8 + (roll & 15);
  const chunkZ = regionZ * END_CITY_REGION_CHUNKS + 8 + ((roll >>> 8) & 15);
  const distance = Math.hypot(chunkX * 16, chunkZ * 16);
  // Keep the central dragon arena and void ring pristine. Roughly one city in
  // three candidate regions survives, sparse enough to make exploration matter.
  const present = distance > END_VOID_RADIUS + 96 && ((roll >>> 20) % 3 === 0);
  return Object.freeze({ present, regionX, regionZ, chunkX, chunkZ, seed: roll });
}

/** Returns the city whose footprint can touch a chunk, if any. */
export function endCitiesNearChunk(chunkX, chunkZ, seed) {
  const regionX = floorDiv(chunkX, END_CITY_REGION_CHUNKS);
  const regionZ = floorDiv(chunkZ, END_CITY_REGION_CHUNKS);
  const cities = [];
  for (let rz = regionZ - 1; rz <= regionZ + 1; rz++) {
    for (let rx = regionX - 1; rx <= regionX + 1; rx++) {
      const site = regionSite(rx, rz, seed >>> 0);
      if (!site.present) continue;
      if (Math.abs(site.chunkX - chunkX) > 2 || Math.abs(site.chunkZ - chunkZ) > 2) continue;
      cities.push(site);
    }
  }
  return cities;
}

/** Nearest generated city to a world position, for gateways and tests. */
export function nearestEndCity(worldX, worldZ, seed, searchRegions = 8) {
  const startX = floorDiv(floorDiv(worldX, 16), END_CITY_REGION_CHUNKS);
  const startZ = floorDiv(floorDiv(worldZ, 16), END_CITY_REGION_CHUNKS);
  let best = null;
  let bestDistance = Infinity;
  for (let radius = 0; radius <= searchRegions; radius++) {
    for (let rz = startZ - radius; rz <= startZ + radius; rz++) {
      for (let rx = startX - radius; rx <= startX + radius; rx++) {
        if (radius > 0 && rx !== startX - radius && rx !== startX + radius &&
            rz !== startZ - radius && rz !== startZ + radius) continue;
        const site = regionSite(rx, rz, seed >>> 0);
        if (!site.present) continue;
        const x = site.chunkX * 16 + 8;
        const z = site.chunkZ * 16 + 8;
        const distance = (x - worldX) ** 2 + (z - worldZ) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { ...site, x, y: END_CITY_BASE_Y + 2, z };
        }
      }
    }
    if (best) return best;
  }
  return best;
}

function pushBox(cells, minX, minY, minZ, maxX, maxY, maxZ, block, hollow = false) {
  for (let y = minY; y <= maxY; y++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        if (hollow && x > minX && x < maxX && y > minY && y < maxY && z > minZ && z < maxZ) continue;
        cells.push({ x, y, z, block });
      }
    }
  }
}

/**
 * Authored city footprint: entrance tower, bridge, upper tower and an End ship.
 * Cells are world coordinates and deterministic for the site.
 */
export function buildEndCity(site) {
  if (!site?.present) return Object.freeze([]);
  const ox = site.chunkX * 16 + 8;
  const oz = site.chunkZ * 16 + 8;
  const y = END_CITY_BASE_Y;
  const cells = [];

  // Solid foundation so a noise island can never clip the route into the city.
  pushBox(cells, ox - 7, y - 2, oz - 7, ox + 7, y, oz + 7, Block.END_STONE_BRICKS);
  pushBox(cells, ox - 5, y + 1, oz - 5, ox + 5, y + 10, oz + 5, Block.PURPUR_BLOCK, true);
  pushBox(cells, ox - 3, y + 11, oz - 3, ox + 3, y + 21, oz + 3, Block.PURPUR_PILLAR, true);

  // Bridge to the ship. End rods make its edge legible in the dark sky.
  for (let x = ox + 6; x <= ox + 27; x++) {
    for (let z = oz - 2; z <= oz + 2; z++) cells.push({ x, y: y + 13, z, block: Block.PURPUR_BLOCK });
    if ((x - ox) % 5 === 0) {
      cells.push({ x, y: y + 14, z: oz - 2, block: Block.END_ROD });
      cells.push({ x, y: y + 14, z: oz + 2, block: Block.END_ROD });
    }
  }

  // Ship hull and mast. The elytra display is a guaranteed unique loot point.
  pushBox(cells, ox + 24, y + 11, oz - 5, ox + 42, y + 15, oz + 5, Block.PURPUR_BLOCK, true);
  for (let x = ox + 20; x <= ox + 46; x++) {
    const width = Math.max(0, 5 - Math.floor(Math.abs(x - (ox + 34)) / 3));
    for (let z = oz - width; z <= oz + width; z++) cells.push({ x, y: y + 10, z, block: Block.PURPUR_BLOCK });
  }
  for (let mastY = y + 16; mastY <= y + 25; mastY++) {
    cells.push({ x: ox + 34, y: mastY, z: oz, block: Block.PURPUR_PILLAR });
  }
  cells.push({ x: ox + 39, y: y + 13, z: oz, block: Block.ELYTRA_DISPLAY });
  cells.push({ x: ox + 28, y: y + 12, z: oz - 3, block: Block.SHULKER_BOX });
  cells.push({ x: ox + 30, y: y + 12, z: oz + 3, block: Block.SHULKER_BOX });

  return Object.freeze(cells.map(Object.freeze));
}

/** Paints just the cells belonging to one generated chunk. */
export function paintEndCities(blocks, chunkX, chunkZ, seed, indexOf) {
  const originX = chunkX * 16;
  const originZ = chunkZ * 16;
  let written = 0;
  for (const site of endCitiesNearChunk(chunkX, chunkZ, seed)) {
    for (const cell of buildEndCity(site)) {
      const localX = cell.x - originX;
      const localZ = cell.z - originZ;
      if (localX < 0 || localX > 15 || localZ < 0 || localZ > 15 || cell.y < 0 || cell.y > 255) continue;
      blocks[indexOf(localX, cell.y, localZ)] = cell.block;
      written++;
    }
  }
  return written;
}

export default buildEndCity;
