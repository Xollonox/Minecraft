/**
 * Minimal static file server for the production build.
 *
 * Used by the browser smoke test in this sandbox, where `vite preview` is
 * awkward to keep alive. Serves `dist/` with the handful of MIME types the build
 * produces, and nothing else — this is a test harness, not a deployment target.
 *
 * Usage: node scripts/serve.mjs [port]
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../dist', import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 4173);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    // Strip the leading slash and normalise, then verify the result is still
    // inside the root so `..` cannot escape the served directory.
    const requested = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const candidate = resolve(join(ROOT, normalize(requested)));
    if (!candidate.startsWith(ROOT)) {
      response.writeHead(403).end('Forbidden');
      return;
    }

    let filePath = candidate;
    const info = await stat(filePath).catch(() => null);
    if (info?.isDirectory()) filePath = join(filePath, 'index.html');

    const body = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, () => {
  // Bound to every interface so the sandbox's headless browser, which may run in
  // a separate network namespace, can reach it.
  console.log(`serving ${ROOT} on port ${PORT}`);
});
