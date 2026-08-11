/**
 * Priority goal selector for creature behaviour.
 *
 * ## Why this exists
 *
 * `MobBrain.js` hand-writes each creature's behaviour as one state machine. That
 * works for seven creatures and collapses at thirty: every new mob re-implements
 * "flee when hurt", "drift when idle", "follow whoever holds wheat", and any fix
 * has to be applied in every copy.
 *
 * Here behaviour is composed from independent goals with priorities. A sheep is
 * a list; a wolf is a longer list; neither needs new control-flow code.
 *
 * ## The part that is easy to get wrong
 *
 * Goals are not mutually exclusive. Looking at the player and wandering should
 * run together; wandering and fleeing must not. So each goal declares the
 * *controls* it occupies, and two goals coexist exactly when their controls are
 * disjoint. Without this you either get mobs that cannot walk and look at once,
 * or mobs being steered by two goals simultaneously and jittering in place.
 *
 * Renderer-free and world-free: goals receive a context object, so the whole
 * selector is testable in Node.
 */

/**
 * Control channels a goal can occupy.
 *
 * A bitmask rather than strings because the conflict test runs for every goal
 * on every mob every tick.
 */
export const Control = Object.freeze({
  MOVE: 1,
  LOOK: 2,
  JUMP: 4,
  TARGET: 8,
});

/** Convenience combinations. */
export const Controls = Object.freeze({
  NONE: 0,
  MOVE: Control.MOVE,
  LOOK: Control.LOOK,
  MOVE_LOOK: Control.MOVE | Control.LOOK,
  MOVE_LOOK_JUMP: Control.MOVE | Control.LOOK | Control.JUMP,
  TARGET: Control.TARGET,
});

/**
 * @typedef {Object} Goal
 * @property {string} name
 * @property {number} priority Lower runs first and preempts higher numbers.
 * @property {number} controls Bitmask from `Control`.
 * @property {(ctx:Object) => boolean} canStart
 * @property {(ctx:Object) => boolean} [canContinue] Defaults to `canStart`.
 * @property {(ctx:Object) => void} [onStart]
 * @property {(ctx:Object, dt:number) => void} [onTick]
 * @property {(ctx:Object) => void} [onStop]
 */

/**
 * Validates a goal definition.
 * @param {Goal} goal
 * @returns {string[]} Problems; empty means valid.
 */
export function validateGoal(goal) {
  const problems = [];
  if (!goal || typeof goal !== 'object') return ['goal is not an object'];
  if (typeof goal.name !== 'string' || goal.name.length === 0) problems.push('missing name');
  if (!Number.isFinite(goal.priority)) problems.push(`${goal.name ?? '?'}: priority must be a number`);
  if (!Number.isInteger(goal.controls) || goal.controls < 0) {
    problems.push(`${goal.name ?? '?'}: controls must be a non-negative bitmask`);
  }
  if (typeof goal.canStart !== 'function') problems.push(`${goal.name ?? '?'}: canStart must be a function`);
  for (const hook of ['canContinue', 'onStart', 'onTick', 'onStop']) {
    if (goal[hook] !== undefined && typeof goal[hook] !== 'function') {
      problems.push(`${goal.name ?? '?'}: ${hook} must be a function when present`);
    }
  }
  return problems;
}

/**
 * Runs a creature's goals.
 */
export class GoalSelector {
  /**
   * @param {Goal[]} [goals]
   */
  constructor(goals = []) {
    /** @type {Goal[]} Sorted by ascending priority. */
    this.goals = [];
    /** @type {Set<Goal>} */
    this.running = new Set();
    this.ticks = 0;
    for (const goal of goals) this.add(goal);
  }

  /**
   * @param {Goal} goal
   * @throws {Error} On an invalid definition — a malformed goal that silently
   *   never runs is far harder to diagnose than a startup error.
   */
  add(goal) {
    const problems = validateGoal(goal);
    if (problems.length > 0) throw new Error(`invalid goal: ${problems.join('; ')}`);
    this.goals.push(goal);
    this.goals.sort((a, b) => a.priority - b.priority);
    return this;
  }

  /** Stops and removes a goal by name. */
  remove(name, ctx = null) {
    const goal = this.goals.find((entry) => entry.name === name);
    if (!goal) return false;
    if (this.running.has(goal)) this._stop(goal, ctx);
    this.goals = this.goals.filter((entry) => entry !== goal);
    return true;
  }

  /** Names of currently running goals, in priority order. */
  activeNames() {
    return this.goals.filter((goal) => this.running.has(goal)).map((goal) => goal.name);
  }

  /** Controls currently occupied. */
  activeControls() {
    let mask = 0;
    for (const goal of this.running) mask |= goal.controls;
    return mask;
  }

  _stop(goal, ctx) {
    this.running.delete(goal);
    goal.onStop?.(ctx);
  }

  /**
   * Evaluates and advances every goal.
   *
   * @param {Object} ctx Passed to every hook.
   * @param {number} dt Seconds.
   */
  update(ctx, dt = 0) {
    this.ticks++;

    // 1. Drop goals that no longer apply, so their controls free up before
    //    anything competes for them this tick.
    for (const goal of [...this.running]) {
      const test = goal.canContinue ?? goal.canStart;
      let keep = false;
      try {
        keep = test(ctx) === true;
      } catch {
        keep = false;
      }
      if (!keep) this._stop(goal, ctx);
    }

    // 2. Walk goals in priority order. A higher-priority goal that wants to run
    //    evicts every lower-priority goal blocking its controls; equal or lower
    //    priority goals simply wait.
    for (const goal of this.goals) {
      if (this.running.has(goal)) continue;

      let wants = false;
      try {
        wants = goal.canStart(ctx) === true;
      } catch {
        wants = false;
      }
      if (!wants) continue;

      const blockers = [];
      let blocked = false;
      for (const active of this.running) {
        if ((active.controls & goal.controls) === 0) continue;
        if (active.priority > goal.priority) blockers.push(active);
        else {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      for (const victim of blockers) this._stop(victim, ctx);
      this.running.add(goal);
      goal.onStart?.(ctx);
    }

    // 3. Advance survivors in priority order for deterministic ordering.
    for (const goal of this.goals) {
      if (this.running.has(goal)) goal.onTick?.(ctx, dt);
    }
    return this;
  }

  /** Stops everything, e.g. on despawn. */
  reset(ctx = null) {
    for (const goal of [...this.running]) this._stop(goal, ctx);
    return this;
  }

  getStats() {
    return { goals: this.goals.length, active: this.activeNames(), ticks: this.ticks };
  }
}

// ------------------------------------------------------------ goal factories

/**
 * Drift to random nearby points when nothing else is happening.
 * @param {{priority?:number, chance?:number, radius?:number}} [options]
 */
export function wanderGoal({ priority = 70, chance = 0.012, radius = 8 } = {}) {
  return {
    name: 'wander',
    priority,
    // MOVE only. Strolling steers the body, not the head, so head-tracking runs
    // alongside it; claiming LOOK here is what stops a wandering cow from ever
    // turning to watch the player.
    controls: Controls.MOVE,
    canStart: (ctx) => !ctx.mob?.isDead && (ctx.random?.() ?? 1) < chance,
    // Keep going until arrival rather than re-rolling every tick, otherwise the
    // creature twitches between destinations and never actually travels.
    canContinue: (ctx) => !ctx.mob?.isDead && ctx.hasDestination === true,
    onStart: (ctx) => ctx.pickWanderTarget?.(radius),
    onTick: (ctx, dt) => ctx.moveToDestination?.(dt),
    onStop: (ctx) => ctx?.clearDestination?.(),
  };
}

/**
 * Run away after taking damage.
 * @param {{priority?:number, seconds?:number, speed?:number}} [options]
 */
export function panicGoal({ priority = 10, seconds = 4, speed = 1.5 } = {}) {
  let remaining = 0;
  return {
    name: 'panic',
    priority,
    // Deliberately not JUMP. Float outranks panic and would otherwise evict the
    // whole flee behaviour just to claim the jump channel, leaving a hurt animal
    // bobbing in water instead of escaping.
    controls: Controls.MOVE_LOOK,
    canStart: (ctx) => ctx.mob?.isDead !== true && ctx.recentlyHurt === true,
    canContinue: () => remaining > 0,
    onStart: (ctx) => {
      remaining = seconds;
      ctx.pickFleeTarget?.();
    },
    onTick: (ctx, dt) => {
      remaining -= dt;
      ctx.moveToDestination?.(dt, speed);
    },
    onStop: (ctx) => {
      remaining = 0;
      ctx?.clearDestination?.();
    },
  };
}

/**
 * Chase and strike the current target.
 * @param {{priority?:number, reach?:number, speed?:number}} [options]
 */
export function meleeAttackGoal({ priority = 20, reach = 1.6, speed = 1.25 } = {}) {
  return {
    name: 'meleeAttack',
    priority,
    // Not JUMP, so swimming attackers keep chasing instead of being preempted.
    controls: Controls.MOVE_LOOK,
    canStart: (ctx) => !ctx.mob?.isDead && ctx.target != null,
    canContinue: (ctx) => !ctx.mob?.isDead && ctx.target != null && ctx.targetAlive !== false,
    onTick: (ctx, dt) => {
      const distance = ctx.distanceToTarget ?? Infinity;
      ctx.faceTarget?.();
      if (distance > reach) ctx.moveToTarget?.(dt, speed);
      else ctx.strikeTarget?.();
    },
    onStop: (ctx) => ctx?.clearDestination?.(),
  };
}

/**
 * Follow a player holding a tempting item.
 * @param {{priority?:number, range?:number, speed?:number}} [options]
 */
export function followTemptGoal({ priority = 40, range = 10, speed = 1.1 } = {}) {
  return {
    name: 'followTempt',
    priority,
    controls: Controls.MOVE_LOOK,
    canStart: (ctx) =>
      !ctx.mob?.isDead && ctx.tempter != null && (ctx.distanceToTempter ?? Infinity) <= range,
    canContinue: (ctx) =>
      !ctx.mob?.isDead && ctx.tempter != null && (ctx.distanceToTempter ?? Infinity) <= range * 1.5,
    onTick: (ctx, dt) => {
      ctx.faceTempter?.();
      if ((ctx.distanceToTempter ?? Infinity) > 2.2) ctx.moveToTempter?.(dt, speed);
    },
    onStop: (ctx) => ctx?.clearDestination?.(),
  };
}

/**
 * Keep away from a threat, e.g. a sheep from a wolf.
 * @param {{priority?:number, range?:number, speed?:number}} [options]
 */
export function avoidGoal({ priority = 15, range = 8, speed = 1.4 } = {}) {
  return {
    name: 'avoid',
    priority,
    controls: Controls.MOVE_LOOK,
    canStart: (ctx) => !ctx.mob?.isDead && (ctx.distanceToThreat ?? Infinity) < range,
    canContinue: (ctx) => !ctx.mob?.isDead && (ctx.distanceToThreat ?? Infinity) < range * 1.4,
    onStart: (ctx) => ctx.pickFleeTarget?.(),
    onTick: (ctx, dt) => ctx.moveToDestination?.(dt, speed),
    onStop: (ctx) => ctx?.clearDestination?.(),
  };
}

/**
 * Turn the head toward something interesting. Occupies only LOOK, so it runs
 * alongside walking — which is the whole reason controls are a bitmask.
 * @param {{priority?:number, range?:number}} [options]
 */
export function lookAtGoal({ priority = 90, range = 8 } = {}) {
  return {
    name: 'lookAt',
    priority,
    controls: Controls.LOOK,
    canStart: (ctx) => !ctx.mob?.isDead && (ctx.distanceToPlayer ?? Infinity) <= range,
    onTick: (ctx) => ctx.facePlayer?.(),
  };
}

/**
 * Seek a mate while in love mode.
 * @param {{priority?:number, speed?:number}} [options]
 */
export function breedGoal({ priority = 30, speed = 1 } = {}) {
  return {
    name: 'breed',
    priority,
    controls: Controls.MOVE_LOOK,
    canStart: (ctx) => !ctx.mob?.isDead && ctx.inLove === true && ctx.mate != null,
    canContinue: (ctx) => !ctx.mob?.isDead && ctx.inLove === true && ctx.mate != null,
    onTick: (ctx, dt) => {
      ctx.faceMate?.();
      if ((ctx.distanceToMate ?? Infinity) > 1.4) ctx.moveToMate?.(dt, speed);
      else ctx.produceOffspring?.();
    },
    onStop: (ctx) => ctx?.clearDestination?.(),
  };
}

/**
 * Swim up so a land animal does not drown. Highest priority of all — drowning
 * while calmly wandering is the classic goal-ordering bug.
 * @param {{priority?:number}} [options]
 */
export function floatGoal({ priority = 5 } = {}) {
  return {
    name: 'float',
    priority,
    controls: Control.JUMP,
    canStart: (ctx) => ctx.inWater === true && ctx.mob?.isDead !== true,
    onTick: (ctx) => ctx.swimUp?.(),
  };
}

/**
 * A sensible default set for a passive land animal.
 * @returns {Goal[]}
 */
export function passiveAnimalGoals() {
  return [floatGoal(), panicGoal(), followTemptGoal(), breedGoal(), wanderGoal(), lookAtGoal()];
}

/**
 * A sensible default set for a ground melee attacker.
 * @returns {Goal[]}
 */
export function hostileMeleeGoals() {
  return [floatGoal(), meleeAttackGoal(), wanderGoal(), lookAtGoal()];
}

export default GoalSelector;
