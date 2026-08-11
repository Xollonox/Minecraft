/**
 * Execution probe for Nether portals. Drives the real portal code against an
 * in-memory world so every claim about portals is backed by a run, not a read.
 */

import { Block } from './src/world/BlockTypes.js';
import { Dimension } from './src/world/DimensionConfig.js';
import {
  PortalAxis,
  PortalTracker,
  buildPortal,
  detectFrame,
  extinguishPortal,
  findExistingPortal,
  lightPortal,
  linkedDimension,
  linkedPosition,
  portalAxis,
  resolveDestination,
} from './src/world/NetherPortal.js';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

class FakeWorld {
  constructor(fill = Block.AIR) {
    this.blocks = new Map();
    this.fill = fill;
    this.writes = 0;
  }

  _key(x, y, z) {
    return `${x},${y},${z}`;
  }

  getBlock(x, y, z) {
    if (y < 0 || y >= 128) return Block.AIR;
    const value = this.blocks.get(this._key(x, y, z));
    return value === undefined ? this.fill : value;
  }

  getBlockState(x, y, z) {
    return this.states?.get(this._key(x, y, z)) ?? 0;
  }

  setBlock(x, y, z, id, options = {}) {
    if (y < 0 || y >= 128) return false;
    this.blocks.set(this._key(x, y, z), id);
    if (!this.states) this.states = new Map();
    this.states.set(this._key(x, y, z), options.state ?? 0);
    this.writes++;
    return true;
  }

  isLoaded() {
    return true;
  }

  count(id) {
    let total = 0;
    for (const value of this.blocks.values()) if (value === id) total++;
    return total;
  }
}

/** Builds a classic obsidian frame with a `width` x `height` interior. */
function buildFrame(world, x, y, z, width, height, axis) {
  const dx = axis === PortalAxis.Z ? 0 : 1;
  const dz = axis === PortalAxis.Z ? 1 : 0;
  for (let i = -1; i <= width; i++) {
    world.setBlock(x + dx * i, y - 1, z + dz * i, Block.OBSIDIAN);
    world.setBlock(x + dx * i, y + height, z + dz * i, Block.OBSIDIAN);
  }
  for (let j = 0; j < height; j++) {
    world.setBlock(x - dx, y + j, z - dz, Block.OBSIDIAN);
    world.setBlock(x + dx * width, y + j, z + dz * width, Block.OBSIDIAN);
  }
}

console.log('\nframe detection');
{
  const world = new FakeWorld(Block.AIR);
  buildFrame(world, 10, 40, 10, 2, 3, PortalAxis.X);

  const frame = detectFrame(world, 10, 41, 10, PortalAxis.X);
  check('a 2x3 frame is detected from inside', frame !== null);
  check('the interior width is measured', frame?.width === 2, `got ${frame?.width}`);
  check('the interior height is measured', frame?.height === 3, `got ${frame?.height}`);
  check('the base is the bottom row', frame?.originY === 40, `got ${frame?.originY}`);
  check('the wrong axis does not match', detectFrame(world, 10, 41, 10, PortalAxis.Z) === null);
}

console.log('\nlighting');
{
  const world = new FakeWorld(Block.AIR);
  buildFrame(world, 10, 40, 10, 2, 3, PortalAxis.X);

  const frame = lightPortal(world, 10, 41, 10);
  check('the portal lights', frame !== null);
  check('every interior cell is filled', world.count(Block.NETHER_PORTAL) === 6, `got ${world.count(Block.NETHER_PORTAL)}`);
  check('the axis is stored in the block state', portalAxis(world.getBlockState(10, 40, 10)) === PortalAxis.X);
  // Re-lighting a live portal must report "nothing happened" so the caller
  // does not spend a flint and steel durability point on a no-op.
  check(
    're-lighting a lit portal is a no-op',
    lightPortal(world, 10, 41, 10) === null && world.count(Block.NETHER_PORTAL) === 6
  );
}

console.log('\nz-axis portals');
{
  const world = new FakeWorld(Block.AIR);
  buildFrame(world, 20, 50, 20, 3, 4, PortalAxis.Z);
  const frame = lightPortal(world, 20, 51, 20);
  check('a z-axis portal lights', frame !== null && frame.axis === PortalAxis.Z);
  check('a 3x4 interior is filled', world.count(Block.NETHER_PORTAL) === 12, `got ${world.count(Block.NETHER_PORTAL)}`);
  check('the z axis is stored', portalAxis(world.getBlockState(20, 50, 20)) === PortalAxis.Z);
}

console.log('\nrejection');
{
  const narrow = new FakeWorld(Block.AIR);
  buildFrame(narrow, 10, 40, 10, 1, 3, PortalAxis.X);
  check('a 1-wide frame is rejected', lightPortal(narrow, 10, 41, 10) === null);

  const short = new FakeWorld(Block.AIR);
  buildFrame(short, 10, 40, 10, 2, 2, PortalAxis.X);
  check('a 2-tall frame is rejected', lightPortal(short, 10, 41, 10) === null);

  const holed = new FakeWorld(Block.AIR);
  buildFrame(holed, 10, 40, 10, 2, 3, PortalAxis.X);
  holed.setBlock(9, 41, 10, Block.AIR);
  check('a frame with a hole in the wall is rejected', lightPortal(holed, 10, 41, 10) === null);

  const open = new FakeWorld(Block.AIR);
  check('bare air is not a portal', lightPortal(open, 0, 40, 0) === null);

  const cobble = new FakeWorld(Block.AIR);
  buildFrame(cobble, 10, 40, 10, 2, 3, PortalAxis.X);
  cobble.setBlock(9, 41, 10, Block.COBBLESTONE);
  check('a cobblestone frame is rejected', lightPortal(cobble, 10, 41, 10) === null);
}

console.log('\nmissing corners');
{
  const world = new FakeWorld(Block.AIR);
  buildFrame(world, 10, 40, 10, 2, 3, PortalAxis.X);
  // Players routinely leave the four corners out; that must still work.
  world.setBlock(9, 39, 10, Block.AIR);
  world.setBlock(12, 39, 10, Block.AIR);
  world.setBlock(9, 43, 10, Block.AIR);
  world.setBlock(12, 43, 10, Block.AIR);
  check('a cornerless frame still lights', lightPortal(world, 10, 41, 10) !== null);
}

console.log('\nbreaking');
{
  const world = new FakeWorld(Block.AIR);
  buildFrame(world, 10, 40, 10, 2, 3, PortalAxis.X);
  lightPortal(world, 10, 41, 10);
  const cleared = extinguishPortal(world, 10, 41, 10);
  check('breaking the frame clears the whole plane', cleared === 6, `cleared ${cleared}`);
  check('no portal blocks remain', world.count(Block.NETHER_PORTAL) === 0);
  check('clearing a non-portal is a no-op', extinguishPortal(world, 0, 40, 0) === 0);
}

console.log('\nlinking');
{
  check('the Overworld links to the Nether', linkedDimension(Dimension.OVERWORLD) === Dimension.NETHER);
  check('the Nether links back', linkedDimension(Dimension.NETHER) === Dimension.OVERWORLD);

  const down = linkedPosition({ x: 800, y: 70, z: -160 }, Dimension.OVERWORLD, Dimension.NETHER);
  check('entering the Nether divides by eight', down.x === 100 && down.z === -20, JSON.stringify(down));
  check('height is preserved', down.y === 70, `got ${down.y}`);

  const up = linkedPosition({ x: 100, y: 70, z: -20 }, Dimension.NETHER, Dimension.OVERWORLD);
  check('leaving the Nether multiplies by eight', up.x === 800 && up.z === -160, JSON.stringify(up));

  const high = linkedPosition({ x: 0, y: 127, z: 0 }, Dimension.OVERWORLD, Dimension.NETHER);
  check('arrival is clamped below the Nether roof', high.y <= 124, `got ${high.y}`);
}

console.log('\ndestination in solid rock');
{
  // The realistic worst case: the linked coordinate is buried in netherrack.
  const world = new FakeWorld(Block.NETHERRACK);
  const built = buildPortal(world, { x: 100, y: 70, z: -20 }, Dimension.NETHER, PortalAxis.X);
  check('a portal is carved out of solid rock', built !== null);
  check('the new portal is lit', world.count(Block.NETHER_PORTAL) === 6, `got ${world.count(Block.NETHER_PORTAL)}`);
  check('the arrival cell is a portal block', world.getBlock(built.x, built.y, built.z) === Block.NETHER_PORTAL);
  check('there is a floor under the portal', world.getBlock(built.x, built.y - 1, built.z) === Block.OBSIDIAN);

  let headroom = true;
  for (let h = 0; h < 3; h++) {
    const id = world.getBlock(built.x, built.y + h, built.z);
    if (id !== Block.NETHER_PORTAL && id !== Block.AIR) headroom = false;
  }
  check('the arrival has headroom', headroom);
}

console.log('\nround trip');
{
  const nether = new FakeWorld(Block.NETHERRACK);
  const first = resolveDestination(nether, { x: 800, y: 70, z: -160 }, Dimension.OVERWORLD, Dimension.NETHER);
  check('the first crossing builds a portal', first !== null && first.created === true);

  const second = resolveDestination(nether, { x: 800, y: 70, z: -160 }, Dimension.OVERWORLD, Dimension.NETHER);
  check('the second crossing reuses it', second !== null && second.created === false);
  check('both crossings land in the same place', Math.abs(first.x - second.x) <= 2 && Math.abs(first.z - second.z) <= 2, `${JSON.stringify(first)} vs ${JSON.stringify(second)}`);
  check('only one portal exists', nether.count(Block.NETHER_PORTAL) === 6, `got ${nether.count(Block.NETHER_PORTAL)}`);

  const found = findExistingPortal(nether, { x: Math.floor(first.x), y: first.y, z: Math.floor(first.z) });
  check('the portal is findable afterwards', found !== null);
}

console.log('\ntravel timing');
{
  const tracker = new PortalTracker();
  let fired = 0;
  for (let i = 0; i < 39; i++) if (tracker.tick(true)) fired++;
  check('travel does not fire early', fired === 0);
  check('progress is reported', tracker.progress > 0.9 && tracker.progress < 1);
  check('travel fires on the dwell tick', tracker.tick(true) === true);

  tracker.startCooldown();
  let bounced = false;
  for (let i = 0; i < 60; i++) if (tracker.tick(true)) bounced = true;
  check('arrival does not bounce straight back', bounced === false);

  const brush = new PortalTracker();
  let brushed = false;
  for (let i = 0; i < 200; i++) if (brush.tick(i % 3 === 0)) brushed = true;
  check('brushing a portal never triggers travel', brushed === false);

  const walkAway = new PortalTracker();
  for (let i = 0; i < 30; i++) walkAway.tick(true);
  walkAway.tick(false);
  check('stepping out resets the charge', walkAway.charge === 0);
}

console.log(`\n${passed}/${passed + failed} portal checks passed`);
if (failed > 0) console.log('PORTALS: BROKEN');
else console.log('PORTALS: VALID');
process.exit(failed === 0 ? 0 : 1);
