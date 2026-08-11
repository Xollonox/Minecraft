/**
 * Entry point.
 *
 * Responsibilities are deliberately narrow: import the stylesheet, find the canvas,
 * construct the `Game`, and turn any failure during construction into something a
 * human can read. Everything else belongs to `Game`.
 *
 * ## Why the error path matters
 *
 * The failure modes here — no WebGL, a driver that refuses a context, a browser
 * with hardware acceleration disabled — all produce a black screen if left
 * unhandled, and a black screen tells the player nothing. So construction is
 * wrapped and any error replaces the boot screen with an explanation plus the
 * actual message, which is the difference between "it's broken" and "enable
 * hardware acceleration".
 */

import './styles/main.css';

import { Game } from './Game.js';

/** True when running under `vite dev`. */
const isDevelopment = Boolean(import.meta.env?.DEV);

async function bootstrap() {
  const canvas = document.getElementById('game-canvas');
  if (!(canvas instanceof HTMLCanvasElement)) {
    showFatalError('The page is missing its canvas element.', null);
    return;
  }

  // Suppress the browser context menu on the canvas from the very first frame.
  // `InputManager` refines this to "only during gameplay" once it attaches, but
  // until then a long-press on mobile should not pop a menu over the game.
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  let game = null;
  try {
    game = new Game(canvas);
    await game.initialise();
  } catch (error) {
    console.error('[main] the engine failed to start:', error);
    if (game) {
      try {
        game.destroy();
      } catch (disposeError) {
        console.error('[main] teardown after a failed start also failed:', disposeError);
      }
    }
    showFatalError(
      'The engine could not start.',
      error instanceof Error ? error.message : String(error)
    );
    return;
  }

  // A single global handle. Useful for poking at the engine from the console
  // during development; harmless in production, and explicitly not an API.
  if (isDevelopment) {
    window.game = game;
    console.info('[main] development build — `window.game` is available');
  }

  // Vite's hot module replacement would otherwise stack a second engine (and a
  // second set of workers and GL contexts) on top of the first.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      game.destroy();
      if (isDevelopment) delete window.game;
    });
  }

  // Surface unexpected runtime errors rather than letting them vanish into the
  // console while the player wonders why the world stopped moving.
  window.addEventListener('error', (event) => {
    console.error('[main] uncaught error:', event.error || event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    console.error('[main] unhandled promise rejection:', event.reason);
  });
}

/**
 * Replaces the boot screen with a readable failure message.
 * @param {string} headline
 * @param {string|null} detail
 */
function showFatalError(headline, detail) {
  const boot = document.getElementById('boot-screen');
  if (boot) boot.remove();

  const container = document.createElement('div');
  container.className = 'fatal-error';

  const title = document.createElement('h1');
  title.textContent = headline;
  container.appendChild(title);

  const advice = document.createElement('p');
  advice.textContent =
    'This game needs WebGL. Check that hardware acceleration is enabled in your browser settings, ' +
    'close other heavy tabs, and try again. WebGL 2 gives the best results but WebGL 1 also works.';
  container.appendChild(advice);

  if (detail) {
    const code = document.createElement('code');
    code.textContent = detail;
    container.appendChild(code);
  }

  document.body.appendChild(container);
}

// `DOMContentLoaded` may already have fired: the module script is deferred, but
// checking makes the boot order independent of how the bundle is injected.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
