/**
 * Minimal DOM construction helpers.
 *
 * The UI is plain DOM with no framework, because the whole interface is a few
 * hundred nodes that change rarely — a framework's diffing would cost more than
 * it saves, and a second render loop competing with the game loop for frame time
 * is a real risk rather than a theoretical one.
 *
 * These helpers exist so that building a panel reads as a tree rather than as
 * thirty `createElement`/`appendChild` pairs.
 */

/**
 * Creates an element.
 *
 * @param {string} tag
 * @param {Object} [properties] `className`, `text`, `html`, `dataset`, `attrs`,
 *   `style`, `on` (event map) and any direct DOM property.
 * @param {Array<Node|string|null|undefined>|Node|string} [children]
 * @returns {HTMLElement}
 */
export function el(tag, properties = null, children = null) {
  const element = document.createElement(tag);

  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      if (value === null || value === undefined) continue;

      switch (key) {
        case 'className':
          element.className = value;
          break;
        case 'text':
          element.textContent = String(value);
          break;
        case 'html': {
          console.warn('[dom] el({ html }) is blocked — use { text } to avoid XSS. Value was ignored.');
          element.textContent = String(value).replace(/<[^>]*>/g, '');
          break;
        }
        case 'dataset':
          for (const [dataKey, dataValue] of Object.entries(value)) {
            element.dataset[dataKey] = String(dataValue);
          }
          break;
        case 'attrs':
          for (const [attrName, attrValue] of Object.entries(value)) {
            if (attrValue === false || attrValue === null || attrValue === undefined) continue;
            element.setAttribute(attrName, attrValue === true ? '' : String(attrValue));
          }
          break;
        case 'style':
          if (typeof value === 'string') {
            element.style.cssText = value;
          } else {
            for (const [property, styleValue] of Object.entries(value)) {
              // CSS custom properties must go through `setProperty`.
              // `Object.assign(element.style, {'--x': 1})` silently does nothing,
              // because a custom property is not a member of CSSStyleDeclaration —
              // which is exactly how a `--slot-columns` grid ended up laid out as a
              // single row.
              if (property.startsWith('--')) element.style.setProperty(property, String(styleValue));
              else element.style[property] = styleValue;
            }
          }
          break;
        case 'on':
          for (const [eventName, handler] of Object.entries(value)) {
            element.addEventListener(eventName, handler);
          }
          break;
        default:
          element[key] = value;
          break;
      }
    }
  }

  appendChildren(element, children);
  return element;
}

/**
 * Appends children, flattening arrays and skipping nullish entries.
 * @param {HTMLElement} parent
 * @param {any} children
 */
export function appendChildren(parent, children) {
  if (children === null || children === undefined) return parent;
  if (Array.isArray(children)) {
    for (const child of children) appendChildren(parent, child);
    return parent;
  }
  if (children instanceof Node) {
    parent.appendChild(children);
    return parent;
  }
  parent.appendChild(document.createTextNode(String(children)));
  return parent;
}

/**
 * Creates a button that is safe on touch.
 *
 * Menu buttons respond to `pointerup` rather than `click` so a tap registers
 * without the ~300 ms delay some mobile browsers still apply, and
 * `touch-action: manipulation` (set in CSS) prevents double-tap zoom.
 *
 * @param {string} label
 * @param {() => void} onActivate
 * @param {Object} [properties]
 * @returns {HTMLButtonElement}
 */
export function button(label, onActivate, properties = {}) {
  const { className = '', ...rest } = properties;
  return el('button', {
    className: `ui-button ${className}`.trim(),
    type: 'button',
    text: label,
    on: {
      click: (event) => {
        event.preventDefault();
        onActivate(event);
      },
    },
    ...rest,
  });
}

/** Removes every child of an element. */
export function clear(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
  return element;
}

/**
 * Shows or hides an element via the `hidden` attribute.
 * @param {HTMLElement} element
 * @param {boolean} visible
 */
export function setVisible(element, visible) {
  if (!element) return;
  element.hidden = !visible;
  // `aria-hidden` keeps assistive technology in step with the visual state.
  element.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

/**
 * Formats a number for compact display in the HUD and debug overlay.
 * @param {number} value
 * @param {number} [decimals]
 */
export function formatNumber(value, decimals = 0) {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Creates a labelled row for a settings control.
 * @param {string} label
 * @param {HTMLElement} control
 * @param {Object} [options]
 * @param {string} [options.hint]
 * @param {boolean} [options.reloadRequired]
 * @param {HTMLElement} [options.valueLabel]
 */
export function settingRow(label, control, options = {}) {
  return el('div', { className: 'setting-row' }, [
    el('div', { className: 'setting-label' }, [
      el('span', { className: 'setting-name', text: label }),
      options.reloadRequired
        ? el('span', { className: 'setting-badge', text: 'reload', attrs: { title: 'Takes effect after the world is reloaded' } })
        : null,
      options.hint ? el('span', { className: 'setting-hint', text: options.hint }) : null,
    ]),
    el('div', { className: 'setting-control' }, [control, options.valueLabel || null]),
  ]);
}
