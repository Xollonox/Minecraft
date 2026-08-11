/**
 * Web Audio mixer and playback.
 *
 * ## Autoplay and the first gesture
 *
 * Browsers refuse to start an `AudioContext` before the user has interacted with
 * the page, and a context created too early lands in the `suspended` state where
 * it stays until resumed. So construction is deferred entirely: nothing is created
 * until `unlock()` is called from a real click, key press or touch. Every call
 * before that is a silent no-op rather than a queued sound, because a burst of
 * delayed sounds firing the moment audio unlocks is worse than silence.
 *
 * ## Mixer graph
 *
 * ```
 * source -> [voice gain] -> [category gain] -> [master gain] -> destination
 * ```
 *
 * Category gains map one-to-one onto the audio settings group, so a slider moves
 * exactly one node. Gain changes use short ramps rather than direct assignment:
 * setting `gain.value` mid-playback produces an audible click.
 *
 * ## Voices
 *
 * `AudioBufferSourceNode` is single-use by design — the correct pattern is one per
 * playback — but the *buffers* are rendered once at startup and shared, and the
 * number of simultaneous voices per category is capped. That is what stops a
 * cave-in from spawning two hundred overlapping impacts and clipping the mix.
 */

import { Events } from '../core/EventBus.js';
import { clamp } from '../utils/MathUtils.js';
import { SoundCategory, createSoundCatalogue, renderSound, soundKeyFor } from './SoundRegistry.js';
import { SoundEventThrottle, resolveSoundEvent } from './SoundEvents.js';

/** Maximum simultaneous one-shot voices per category. */
const VOICE_LIMITS = {
  [SoundCategory.BLOCKS]: 10,
  [SoundCategory.UI]: 4,
  [SoundCategory.AMBIENT]: 4,
  [SoundCategory.WEATHER]: 3,
  [SoundCategory.MUSIC]: 2,
};

/** Seconds over which volume changes are ramped. */
const RAMP_TIME = 0.06;
/** Minimum gap between two plays of the same sound, in seconds. */
const RETRIGGER_GAP = 0.02;

export class AudioManager {
  /**
   * @param {Object} options
   * @param {import('../core/EventBus.js').EventBus} options.bus
   * @param {import('../core/SettingsManager.js').SettingsManager} options.settings
   * @param {import('../utils/DeviceDetector.js').DeviceCapabilities} options.capabilities
   */
  constructor({ bus, settings, capabilities }) {
    this._bus = bus;
    this._settings = settings;
    this._caps = capabilities;

    /** @type {AudioContext|null} */
    this._context = null;
    /** @type {GainNode|null} */
    this._masterGain = null;
    /** @type {Record<string, GainNode>} */
    this._categoryGains = Object.create(null);
    /** @type {Record<string, AudioBuffer>} */
    this._buffers = Object.create(null);
    /** @type {Record<string, Object>} */
    this._catalogue = createSoundCatalogue();
    /** @type {Record<string, number>} Live voice count per category. */
    this._voiceCounts = Object.create(null);
    /** @type {Record<string, number>} Last play time per sound key. */
    this._lastPlayed = Object.create(null);
    /** @type {Map<string, {source: AudioBufferSourceNode, gain: GainNode}>} */
    this._loops = new Map();

    this.available = Boolean(capabilities.webAudioSupported);
    this.unlocked = false;
    /** True while audio is deliberately silenced (tab hidden). */
    this.ducked = false;
    this._failed = false;
  }

  /** True when sound can currently be heard. */
  get isActive() {
    return this.unlocked && !this._failed && this._context?.state === 'running';
  }

  /**
   * Creates the context and renders every buffer.
   *
   * Must be called from inside a user-gesture handler. Safe to call repeatedly;
   * subsequent calls only resume a suspended context.
   *
   * @returns {Promise<boolean>} True when audio is running.
   */
  async unlock() {
    if (!this.available || this._failed) return false;

    if (!this._context) {
      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        this._context = new AudioContextClass({ latencyHint: 'interactive' });
        this._buildMixer();
        this._renderBuffers();
      } catch (error) {
        console.warn('[Audio] could not initialise Web Audio:', error);
        this._failed = true;
        this.available = false;
        return false;
      }
    }

    try {
      if (this._context.state === 'suspended' || this._context.state === 'interrupted') await this._context.resume();
    } catch (error) {
      // iOS in particular can reject a resume that is not close enough to the
      // gesture; the next gesture will try again.
      console.warn('[Audio] resume was rejected:', error);
      return false;
    }

    this.unlocked = this._context.state === 'running';
    if (this.unlocked) this.applySettings(this._settings.values.audio);
    return this.unlocked;
  }

  _buildMixer() {
    const context = this._context;
    this._masterGain = context.createGain();
    this._masterGain.gain.value = 0.0001;
    this._masterGain.connect(context.destination);

    for (const category of Object.values(SoundCategory)) {
      const gain = context.createGain();
      gain.gain.value = 1;
      gain.connect(this._masterGain);
      this._categoryGains[category] = gain;
      this._voiceCounts[category] = 0;
    }
  }

  /**
   * Renders every catalogue entry.
   *
   * Synchronous and measured in a few tens of milliseconds for the whole set,
   * which is acceptable inside the loading screen and far simpler than an async
   * pipeline that would have to handle partial availability.
   */
  _renderBuffers() {
    const context = this._context;
    const start = performance.now();
    let rendered = 0;

    for (const [name, definition] of Object.entries(this._catalogue)) {
      try {
        this._buffers[name] = renderSound(context, name, definition);
        rendered++;
      } catch (error) {
        // A single failed sound must not take the rest of the game's audio down.
        console.warn(`[Audio] could not render "${name}":`, error);
      }
    }

    const elapsed = performance.now() - start;
    console.info(`[Audio] rendered ${rendered} sounds in ${elapsed.toFixed(0)} ms`);
  }

  // ------------------------------------------------------------------ playback

  /**
   * Plays a one-shot sound.
   *
   * @param {string} name Catalogue key.
   * @param {Object} [options]
   * @param {number} [options.volume] 0..1, multiplied with the baseline gain.
   * @param {number} [options.pitch] Playback rate multiplier.
   * @param {boolean} [options.ignoreLimit] Bypass the per-category voice cap.
   * @returns {boolean} True when a voice was started.
   */
  /**
   * Advances the event throttle's clock. Call once per frame.
   *
   * The throttle keeps its own clock rather than reading `AudioContext.currentTime`
   * so cooldowns behave identically while the context is suspended or the game
   * is paused, and so the whole thing is testable without Web Audio.
   *
   * @param {number} dt Seconds.
   */
  tickEvents(dt) {
    if (!this._eventThrottle) this._eventThrottle = new SoundEventThrottle();
    this._eventThrottle.tick(dt);
  }

  /**
   * Plays a gameplay event.
   *
   * This is the entry point gameplay code should use. `play()` takes a raw
   * buffer name, which is how FinalV2 ended up with thirty synthesised sounds
   * and two call sites: nothing connected the moment to the buffer. An event
   * name is resolved through `SoundEvents`, which the self-test validates, so a
   * mistyped event fails a test instead of going silent.
   *
   * @param {string} event A `GameplayEvent` value.
   * @param {Object} [context]
   * @param {string} [context.soundGroup] Block sound group for material events.
   * @param {number} [context.volumeScale]
   * @param {number} [context.pitchScale]
   * @returns {boolean} True when a buffer was actually started.
   */
  playEvent(event, context = {}) {
    const resolved = resolveSoundEvent(event, context);
    if (!resolved) return false;
    // Per-event throttling, distinct from the per-buffer retrigger guard in
    // play(): footsteps on two different materials are two buffers but one
    // event, and should still be rate-limited as one.
    if (!this._eventThrottle) this._eventThrottle = new SoundEventThrottle();
    if (!this._eventThrottle.allow(event, resolved.cooldown)) return false;
    return this.play(resolved.name, {
      volume: resolved.volume,
      rate: resolved.pitch,
    });
  }

  play(name, options = {}) {
    if (!this.isActive || this.ducked) return false;

    const definition = this._catalogue[name];
    const buffer = this._buffers[name];
    if (!definition || !buffer) return false;

    const context = this._context;
    const now = context.currentTime;

    // Retrigger guard: two identical impacts in the same millisecond just sound
    // like one louder impact, and they consume two voices.
    if (now - (this._lastPlayed[name] || -1) < RETRIGGER_GAP) return false;

    const category = definition.category;
    const limit = VOICE_LIMITS[category] ?? 8;
    if (!options.ignoreLimit && (this._voiceCounts[category] || 0) >= limit) return false;

    let source;
    let gain;
    try {
      source = context.createBufferSource();
      source.buffer = buffer;

      // Pitch variance makes repeated sounds (footsteps, mining) sound organic
      // instead of like a machine gun.
      const variance = definition.pitchVariance || 0;
      const pitch = (options.pitch ?? 1) * (1 + (Math.random() * 2 - 1) * variance);
      source.playbackRate.value = clamp(pitch, 0.35, 3);

      gain = context.createGain();
      gain.gain.value = clamp((definition.gain ?? 1) * (options.volume ?? 1), 0, 4);

      source.connect(gain);
      gain.connect(this._categoryGains[category] || this._masterGain);
      source.start();
    } catch (error) {
      console.warn(`[Audio] could not play "${name}":`, error);
      return false;
    }

    this._lastPlayed[name] = now;
    this._voiceCounts[category] = (this._voiceCounts[category] || 0) + 1;

    source.onended = () => {
      this._voiceCounts[category] = Math.max(0, (this._voiceCounts[category] || 1) - 1);
      try {
        source.disconnect();
        gain.disconnect();
      } catch {
        // Already torn down.
      }
    };

    return true;
  }

  /**
   * Plays a block-material sound.
   * @param {string} action `'break'`, `'place'` or `'step'`
   * @param {string} soundGroup
   * @param {Object} [options]
   */
  playMaterial(action, soundGroup, options) {
    return this.play(soundKeyFor(action, soundGroup), options);
  }

  /**
   * Starts or updates a looping sound.
   *
   * @param {string} name Catalogue key; must be a looping definition.
   * @param {number} volume 0..1. Zero stops the loop.
   */
  setLoop(name, volume) {
    if (!this.isActive) return;
    const target = clamp(volume, 0, 1);
    const existing = this._loops.get(name);

    if (target <= 0.001) {
      if (existing) this._stopLoop(name);
      return;
    }

    if (existing) {
      existing.gain.gain.cancelScheduledValues(this._context.currentTime);
      existing.gain.gain.setTargetAtTime(target, this._context.currentTime, 0.25);
      return;
    }

    const definition = this._catalogue[name];
    const buffer = this._buffers[name];
    if (!definition || !buffer) return;

    try {
      const source = this._context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const gain = this._context.createGain();
      // Fade in: a loop starting at full volume is jarring.
      gain.gain.value = 0.0001;
      gain.gain.setTargetAtTime(target, this._context.currentTime, 0.4);
      source.connect(gain);
      gain.connect(this._categoryGains[definition.category] || this._masterGain);
      source.start();
      this._loops.set(name, { source, gain });
    } catch (error) {
      console.warn(`[Audio] could not start loop "${name}":`, error);
    }
  }

  _stopLoop(name) {
    const loop = this._loops.get(name);
    if (!loop) return;
    this._loops.delete(name);
    const context = this._context;
    try {
      loop.gain.gain.cancelScheduledValues(context.currentTime);
      loop.gain.gain.setTargetAtTime(0.0001, context.currentTime, 0.2);
      // Stop after the fade so there is no click.
      loop.source.stop(context.currentTime + 0.8);
      loop.source.onended = () => {
        try {
          loop.source.disconnect();
          loop.gain.disconnect();
        } catch {
          /* already gone */
        }
      };
    } catch {
      /* the source may already have stopped */
    }
  }

  /** Stops every looping sound. */
  stopAllLoops() {
    for (const name of Array.from(this._loops.keys())) this._stopLoop(name);
  }

  // ------------------------------------------------------------------ mixing

  /**
   * Applies the audio settings group.
   * @param {Object} audio
   */
  applySettings(audio) {
    if (!this._context || !this._masterGain) return;
    const now = this._context.currentTime;

    const master = this.ducked ? 0.0001 : Math.max(0.0001, clamp(audio.master, 0, 1));
    this._masterGain.gain.setTargetAtTime(master, now, RAMP_TIME);

    for (const category of Object.values(SoundCategory)) {
      const gain = this._categoryGains[category];
      if (!gain) continue;
      const value = Math.max(0.0001, clamp(audio[category] ?? 1, 0, 1));
      gain.gain.setTargetAtTime(value, now, RAMP_TIME);
    }
  }

  /**
   * Silences or restores audio, used when the tab is hidden or unfocused.
   * @param {boolean} ducked
   */
  setDucked(ducked) {
    if (this.ducked === ducked) return;
    this.ducked = ducked;
    if (this._context && this._masterGain) {
      const audio = this._settings.values.audio;
      const target = ducked ? 0.0001 : Math.max(0.0001, clamp(audio.master, 0, 1));
      this._masterGain.gain.setTargetAtTime(target, this._context.currentTime, 0.12);
    }
  }

  /**
   * Suspends the context entirely, freeing the audio thread while hidden.
   * @param {boolean} suspended
   */
  async setSuspended(suspended) {
    if (!this._context) return;
    try {
      if (suspended && this._context.state === 'running') await this._context.suspend();
      else if (!suspended && (this._context.state === 'suspended' || this._context.state === 'interrupted') && this.unlocked) {
        await this._context.resume();
      }
    } catch {
      // Suspension is an optimisation; failing to do it is not an error.
    }
  }

  /**
   * Drives the ambience loops from world state.
   *
   * Called once per frame. Wind fades with altitude and daylight; the underwater
   * loop replaces it entirely when submerged, because hearing wind while under a
   * lake is the kind of detail that quietly breaks immersion.
   *
   * @param {Object} state
   * @param {boolean} state.underwater
   * @param {number} state.altitude Player Y.
   * @param {number} state.daylight 0..1
   * @param {number} state.rainIntensity 0..1
   * @param {boolean} state.paused
   * @param {string} [state.dimension] Dimension id; 'nether' swaps the soundscape.
   */
  updateAmbience(state) {
    if (!this.isActive) return;

    if (state.paused) {
      // Keep loops alive but quiet, so resuming does not restart them.
      this.setLoop('ambient.wind', 0.02);
      this.setLoop('weather.rain', 0);
      this.setLoop('ambient.underwater', 0);
      this.setLoop('ambient.nether', 0);
      this.setLoop('ambient.end', 0);
      return;
    }

    // The Nether has no sky, so wind and rain are silenced outright and the
    // rumble takes over. Checked before water because there is none down there.
    if (state.dimension === 'nether') {
      this.setLoop('ambient.nether', 0.6);
      this.setLoop('ambient.end', 0);
      this.setLoop('ambient.wind', 0);
      this.setLoop('weather.rain', 0);
      this.setLoop('ambient.underwater', 0);
      return;
    }

    if (state.dimension === 'end') {
      this.setLoop('ambient.end', 0.62);
      this.setLoop('ambient.nether', 0);
      this.setLoop('ambient.wind', 0);
      this.setLoop('weather.rain', 0);
      this.setLoop('ambient.underwater', 0);
      return;
    }

    if (state.underwater) {
      this.setLoop('ambient.underwater', 0.75);
      this.setLoop('ambient.wind', 0);
      // Rain is heavily muffled from below the surface.
      this.setLoop('weather.rain', state.rainIntensity * 0.18);
      return;
    }

    this.setLoop('ambient.underwater', 0);
    this.setLoop('ambient.nether', 0);
    this.setLoop('ambient.end', 0);
    // Wind is stronger high up and at night.
    const altitudeFactor = clamp((state.altitude - 50) / 60, 0, 1);
    const windTarget = 0.16 + altitudeFactor * 0.5 + (1 - state.daylight) * 0.12;
    this.setLoop('ambient.wind', clamp(windTarget, 0, 0.85));
    this.setLoop('weather.rain', state.rainIntensity);
  }

  /** Diagnostics for the debug overlay. */
  getStats() {
    let voices = 0;
    for (const category of Object.values(SoundCategory)) voices += this._voiceCounts[category] || 0;
    return {
      available: this.available,
      unlocked: this.unlocked,
      state: this._context?.state ?? 'none',
      sampleRate: this._context?.sampleRate ?? 0,
      voices,
      loops: this._loops.size,
      buffers: Object.keys(this._buffers).length,
    };
  }

  /**
   * Wires the manager to the event bus so gameplay does not have to call it
   * directly for common sounds.
   * @param {import('../core/EventBus.js').SubscriptionGroup} subscriptions
   */
  attachEvents(subscriptions) {
    subscriptions.on(this._bus, Events.BLOCK_BROKEN, (event) => {
      this.playMaterial('break', event.soundGroup);
    });
    subscriptions.on(this._bus, Events.BLOCK_PLACED, (event) => {
      this.playMaterial('place', event.soundGroup);
    });
    // Only audible damage gets a sound: starvation ticks every four seconds and
    // would otherwise turn into a metronome.
    subscriptions.on(this._bus, Events.PLAYER_DAMAGED, (event) => {
      if (event.cause === 'starvation') return;
      this.play('player.hurt', { volume: 0.9 });
    });
    subscriptions.on(this._bus, Events.PLAYER_STEP, (event) => {
      if (event.inWater) this.play('player.swim', { volume: 0.5 });
      else this.playMaterial('step', groupForBlock(event.blockId));
    });
    subscriptions.on(this._bus, Events.PLAYER_WATER_STATE, (event) => {
      if (event.underwater) this.play('player.splash');
    });
    subscriptions.on(this._bus, Events.PLAY_SOUND, (event) => {
      if (event?.name) this.play(event.name, event);
    });
  }

  /** Closes the context and releases every buffer. */
  async destroy() {
    this.stopAllLoops();
    this._buffers = Object.create(null);
    if (this._context) {
      try {
        await this._context.close();
      } catch {
        /* already closed */
      }
    }
    this._context = null;
    this._masterGain = null;
    this._categoryGains = Object.create(null);
    this.unlocked = false;
  }
}

/**
 * Resolves a block id to its sound group without importing the whole registry
 * into the audio layer's hot path.
 */
function groupForBlock(blockId) {
  // Imported lazily through the registry module, which is already loaded.
  return blockSoundGroup(blockId);
}

/** @type {(blockId: number) => string} */
let blockSoundGroup = () => 'stone';

/**
 * Injects the block-id-to-sound-group lookup.
 *
 * Done as an injection rather than a direct import so `audio/` has no dependency
 * on `world/`, which keeps the audio layer usable in isolation (and testable
 * without the block registry).
 *
 * @param {(blockId: number) => string} resolver
 */
export function setBlockSoundGroupResolver(resolver) {
  if (typeof resolver === 'function') blockSoundGroup = resolver;
}

export default AudioManager;
