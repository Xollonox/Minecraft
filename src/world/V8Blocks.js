/** Version 8 append-only blocks. IDs begin after every Version 7 block. */
const descriptors = Object.freeze([
  Object.freeze({
    name:'iron_bars', displayName:'Iron Bars', top:'iron_bars', side:'iron_bars', bottom:'iron_bars',
    shape:'post', layer:'cutout', hardness:5, tool:'pickaxe', tier:'stone', correctTool:true,
    light:0, attenuation:0, solid:false, collidable:true, breakable:true, transparent:true,
    cull:false, sway:'none', sound:'metal', needsSupport:false, gravity:false,
    dropsAlways:false, stackSize:64, tags:Object.freeze(['v8','metal','end_cage']),
  }),
]);

export const V8_BLOCK_DESCRIPTORS = descriptors;
export const V8_BLOCK_NAMES = Object.freeze(descriptors.map((entry) => entry.name));
export const V8_TILE_NAMES = Object.freeze(['iron_bars']);

export default V8_BLOCK_DESCRIPTORS;
