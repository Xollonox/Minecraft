/** Deterministic, shared damage resolution used by players, mobs and bosses. */
export const DamageStage = Object.freeze({
  BASE: 'base', ENCHANTMENT: 'enchantment', ARMOUR: 'armour',
  RESISTANCE: 'resistance', ABSORPTION: 'absorption', FINAL: 'final',
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

export class DamageEvent {
  constructor({ amount, type = 'generic', attacker = null, target = null, projectile = false,
    critical = false, sweeping = false, bypassesArmour = false, metadata = {} } = {}) {
    this.baseAmount = Math.max(0, Number(amount) || 0);
    this.amount = this.baseAmount;
    this.type = type;
    this.attacker = attacker;
    this.target = target;
    this.projectile = Boolean(projectile);
    this.critical = Boolean(critical);
    this.sweeping = Boolean(sweeping);
    this.bypassesArmour = Boolean(bypassesArmour);
    this.metadata = { ...metadata };
    this.absorbed = 0;
    this.blocked = false;
    this.trace = [];
  }

  record(stage, before, detail = null) {
    this.trace.push(Object.freeze({ stage, before, after: this.amount, detail }));
  }
}

/**
 * Canonical order: source -> crit/enchantments -> shield -> armour -> resistance
 * -> absorption -> final health damage. Hooks are data callbacks so this module
 * remains usable in workers and headless tests.
 */
export class DamagePipeline {
  resolve(input, context = {}) {
    const event = input instanceof DamageEvent ? input : new DamageEvent(input);
    let before = event.amount;
    if (event.critical) event.amount *= 1.5;
    event.amount += Math.max(0, Number(context.bonusDamage?.(event)) || 0);
    event.record(DamageStage.ENCHANTMENT, before, event.critical ? 'critical' : null);

    before = event.amount;
    if (context.shield?.(event)) {
      event.blocked = true;
      event.amount = 0;
    }
    event.record('shield', before, event.blocked ? 'blocked' : null);

    before = event.amount;
    if (!event.bypassesArmour && event.amount > 0) {
      const reduced = context.armour?.(event.amount, event);
      if (Number.isFinite(reduced)) event.amount = Math.max(0, reduced);
    }
    event.record(DamageStage.ARMOUR, before);

    before = event.amount;
    const resistance = clamp(context.resistanceLevel ?? 0, 0, 4);
    event.amount *= 1 - resistance * 0.2;
    event.record(DamageStage.RESISTANCE, before, resistance);

    before = event.amount;
    const availableAbsorption = Math.max(0, Number(context.absorption ?? 0));
    event.absorbed = Math.min(availableAbsorption, event.amount);
    event.amount -= event.absorbed;
    event.record(DamageStage.ABSORPTION, before, event.absorbed);

    event.amount = Math.max(0, Math.round(event.amount * 1000) / 1000);
    event.record(DamageStage.FINAL, event.amount);
    return event;
  }
}

export function attackProfile({ falling = false, onGround = true, sprinting = false,
  cooldown = 1, weapon = 'hand', nearbyTargets = 0 } = {}) {
  const charge = clamp(cooldown, 0, 1);
  const critical = falling && !onGround && charge > 0.9;
  const sweeping = weapon === 'sword' && onGround && !sprinting && charge > 0.9 && nearbyTargets > 0;
  return Object.freeze({
    charge,
    damageMultiplier: 0.2 + charge * charge * 0.8,
    critical,
    sweeping,
    sprintKnockback: sprinting && charge > 0.9 ? 1 : 0,
  });
}

export function projectileDamage({ charge = 0, base = 2, power = 0, critical = false } = {}) {
  const c = clamp(charge, 0, 1);
  const velocity = Math.min(1, (c * c + c * 2) / 3);
  const amount = base * (0.25 + velocity * 1.75) + Math.max(0, power) * 0.5;
  return Math.round(amount * (critical ? 1.5 : 1) * 1000) / 1000;
}

export default DamagePipeline;
