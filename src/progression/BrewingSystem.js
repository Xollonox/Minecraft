import { StatusEffect } from '../entities/StatusEffects.js';

export const Potion = Object.freeze({ AWKWARD:'awkward', THICK:'thick', MUNDANE:'mundane', WATER:'water' });
export const POTION_RECIPES = Object.freeze({
  nether_wart:{from:'water',to:'awkward'}, sugar:{from:'awkward',to:StatusEffect.SPEED},
  rabbit_foot:{from:'awkward',to:'jump_boost'}, blaze_powder:{from:'awkward',to:StatusEffect.STRENGTH},
  glistering_melon:{from:'awkward',to:'instant_health'}, spider_eye:{from:'awkward',to:StatusEffect.POISON},
  magma_cream:{from:'awkward',to:StatusEffect.FIRE_RESISTANCE}, pufferfish:{from:'awkward',to:StatusEffect.WATER_BREATHING},
  golden_carrot:{from:'awkward',to:StatusEffect.NIGHT_VISION}, phantom_membrane:{from:'awkward',to:'slow_falling'},
});
export const CORRUPTION = Object.freeze({ speed:'slowness', instant_health:'instant_damage', poison:'instant_damage', night_vision:'invisibility' });

export function brewPotion(input, ingredient) {
  if (!input || !ingredient) return null;
  if (ingredient === 'gunpowder' && input.form === 'drink') return { ...input, form:'splash' };
  if (ingredient === 'dragon_breath' && input.form === 'splash') return { ...input, form:'lingering' };
  if ((ingredient === 'redstone_dust' || ingredient === 'redstone') && input.effect && !input.extended) return { ...input, duration: input.duration * 2.66, extended:true };
  if (ingredient === 'glowstone_dust' && input.effect && !input.strong) return { ...input, amplifier:(input.amplifier ?? 0)+1, duration: input.duration * 0.5, strong:true };
  if (ingredient === 'fermented_spider_eye' && CORRUPTION[input.effect]) return { ...input, effect:CORRUPTION[input.effect] };
  const recipe = POTION_RECIPES[ingredient];
  if (!recipe || recipe.from !== (input.effect ?? Potion.WATER)) return null;
  return { effect:recipe.to, duration:180, amplifier:0, form:input.form ?? 'drink', extended:false, strong:false };
}

export class BrewingStand {
  constructor() { this.bottles = [null,null,null]; this.ingredient = null; this.fuel = 0; this.progress = 0; }
  addFuel(units=20) { this.fuel = Math.min(20, this.fuel + Math.max(0, Math.floor(units))); }
  tick(dt) {
    if (!this.ingredient || this.fuel <= 0) { this.progress = 0; return false; }
    const possible = this.bottles.some(potion => brewPotion(potion, this.ingredient));
    if (!possible) { this.progress = 0; return false; }
    this.progress += Math.max(0, Number(dt)||0);
    if (this.progress < 20) return false;
    this.bottles = this.bottles.map(potion => brewPotion(potion, this.ingredient) ?? potion);
    this.fuel--; this.progress = 0; this.ingredient = null; return true;
  }
  toJSON() { return { bottles:this.bottles, ingredient:this.ingredient, fuel:this.fuel, progress:this.progress }; }
  fromJSON(data={}) { this.bottles = Array.isArray(data.bottles) ? data.bottles.slice(0,3) : [null,null,null]; while(this.bottles.length<3)this.bottles.push(null); this.ingredient=data.ingredient??null; this.fuel=Math.max(0,Math.min(20,Number(data.fuel)||0)); this.progress=Math.max(0,Number(data.progress)||0); return this; }
}

export function applyPotion(controller, potion, scale = 1) {
  if (!controller || !potion?.effect || potion.effect === 'instant_health' || potion.effect === 'instant_damage') return false;
  return controller.apply(potion.effect, Math.max(1, potion.duration * Math.max(0,scale)), potion.amplifier ?? 0, { source:`potion:${potion.form}` });
}

export default BrewingStand;
