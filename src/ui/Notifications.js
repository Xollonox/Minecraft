/**
 * Transient on-screen messages.
 *
 * Non-blocking by design: a shader fallback, a failed autosave or a storage
 * warning must inform the player without interrupting play. A modal dialog for
 * "your GPU rejected the bloom pass" would be far worse than a line of text that
 * fades away.
 *
 * Messages are de-duplicated by `id`, so a warning that fires every frame (a
 * worker failing repeatedly, say) shows once and refreshes its timer instead of
 * stacking a hundred identical toasts.
 */

import { el, setVisible } from './dom.js';

/** Default lifetime in milliseconds. */
const DEFAULT_DURATION = 4200;
/** Maximum simultaneous notifications. */
const MAX_VISIBLE = 4;

export class Notifications {
  /**
   * @param {HTMLElement} root
   */
  constructor(root) {
    this.element = el('div', {
      className: 'notifications',
      attrs: { role: 'status', 'aria-live': 'polite' },
    });
    root.appendChild(this.element);
    /** @type {Map<string, {node: HTMLElement, timer: number}>} */
    this._active = new Map();
    this._counter = 0;
  }

  /**
   * Shows a message.
   *
   * @param {Object|string} options A message string, or a descriptor.
   * @param {string} [options.message]
   * @param {'info'|'success'|'warning'|'error'} [options.level]
   * @param {string} [options.id] De-duplication key.
   * @param {number} [options.duration] Milliseconds; 0 keeps it until dismissed.
   */
  show(options) {
    const descriptor = typeof options === 'string' ? { message: options } : options || {};
    const message = String(descriptor.message ?? '').trim();
    if (!message) return null;

    const level = descriptor.level || 'info';
    const id = descriptor.id || `notification-${++this._counter}`;
    const duration = descriptor.duration ?? DEFAULT_DURATION;

    // Refresh an existing notification rather than duplicating it.
    const existing = this._active.get(id);
    if (existing) {
      existing.node.textContent = message;
      existing.node.className = `notification notification--${level}`;
      if (existing.timer) clearTimeout(existing.timer);
      existing.timer = duration > 0 ? setTimeout(() => this.dismiss(id), duration) : 0;
      return id;
    }

    // Drop the oldest when full, so a burst does not fill the screen.
    while (this._active.size >= MAX_VISIBLE) {
      const oldest = this._active.keys().next().value;
      this.dismiss(oldest, true);
    }

    const node = el('div', {
      className: `notification notification--${level}`,
      text: message,
    });
    this.element.appendChild(node);

    const timer = duration > 0 ? setTimeout(() => this.dismiss(id), duration) : 0;
    this._active.set(id, { node, timer });
    return id;
  }

  /** Convenience wrappers. */
  info(message, options = {}) {
    return this.show({ ...options, message, level: 'info' });
  }

  success(message, options = {}) {
    return this.show({ ...options, message, level: 'success' });
  }

  warning(message, options = {}) {
    return this.show({ ...options, message, level: 'warning' });
  }

  error(message, options = {}) {
    return this.show({ ...options, message, level: 'error', duration: options.duration ?? 8000 });
  }

  /**
   * Removes a notification.
   * @param {string} id
   * @param {boolean} [immediate] Skip the exit animation.
   */
  dismiss(id, immediate = false) {
    const entry = this._active.get(id);
    if (!entry) return;
    this._active.delete(id);
    if (entry.timer) clearTimeout(entry.timer);

    if (immediate) {
      entry.node.remove();
      return;
    }

    entry.node.classList.add('is-leaving');
    // Remove on animation end, with a timeout fallback in case the animation is
    // suppressed (reduced-motion, or a background tab).
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      entry.node.remove();
    };
    entry.node.addEventListener('animationend', remove, { once: true });
    setTimeout(remove, 400);
  }

  /** Removes every notification. */
  clearAll() {
    for (const id of Array.from(this._active.keys())) this.dismiss(id, true);
  }

  /** Shows or hides the whole stack. */
  setVisible(visible) {
    setVisible(this.element, visible);
  }

  /** Removes the container and cancels every timer. */
  destroy() {
    this.clearAll();
    this.element.remove();
  }
}

export default Notifications;
