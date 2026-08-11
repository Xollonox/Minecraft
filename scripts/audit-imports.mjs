/**
 * Import/export consistency audit.
 *
 * Walks every module under `src/`, resolves each relative import, and checks that
 * the target file exists with **exactly** the casing used in the import, and that
 * every named import is actually exported by the target.
 *
 * Case sensitivity is the point: a `./Blockregistry.js` import works on macOS and
 * Windows and fails on Linux and on most CI, so a mismatch has to be caught here
 * rather than at deploy time. The bundler catches missing files but is happy to
 * resolve a differently-cased path on a case-insensitive filesystem.
 *
 * Usage: node scripts/audit-imports.mjs
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

/** @type {string[]} */
const problems = [];
let moduleCount = 0;
let importCount = 0;

/** Recursively lists files under a directory. */
async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else files.push(full);
  }
  return files;
}

/** True when `path` exists with exactly this casing. */
async function existsWithExactCase(path) {
  try {
    await stat(path);
  } catch {
    return false;
  }
  // `stat` is case-insensitive on some filesystems, so compare against the real
  // directory listing.
  const entries = await readdir(dirname(path));
  return entries.includes(path.slice(dirname(path).length + 1));
}

/** Extracts the exported names from a module's source. */
function collectExports(source) {
  const names = new Set();

  // export const/let/var/function/class/async function NAME
  for (const match of source.matchAll(
    /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm
  )) {
    names.add(match[1]);
  }
  // export { a, b as c }
  for (const match of source.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of match[1].split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const asMatch = trimmed.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      names.add(asMatch ? asMatch[1] : trimmed);
    }
  }
  if (/^\s*export\s+default\b/m.test(source)) names.add('default');
  // `export * from` re-exports cannot be resolved statically here.
  if (/^\s*export\s+\*/m.test(source)) names.add('*');

  return names;
}

/** Extracts static imports as `{ source, names }`. */
function collectImports(source) {
  const results = [];
  const pattern = /import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+)|([\w$]+))?\s*(?:from\s*)?['"]([^'"]+)['"]/g;

  for (const match of source.matchAll(pattern)) {
    const [, defaultWithNamed, namedBlock, namespaceName, bareDefault, specifier] = match;
    const names = [];
    if (defaultWithNamed) names.push('default');
    if (bareDefault && !namedBlock && !namespaceName) names.push('default');
    if (namedBlock) {
      for (const part of namedBlock.split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        names.push(trimmed.split(/\s+as\s+/)[0].trim());
      }
    }
    results.push({ specifier, names, namespace: Boolean(namespaceName) });
  }
  return results;
}

const files = (await listFiles(SRC)).filter((file) => file.endsWith('.js'));
/** @type {Map<string, Set<string>>} */
const exportsByFile = new Map();

for (const file of files) {
  exportsByFile.set(file, collectExports(await readFile(file, 'utf8')));
}

for (const file of files) {
  moduleCount++;
  const source = await readFile(file, 'utf8');
  const here = dirname(file);

  for (const entry of collectImports(source)) {
    const specifier = entry.specifier;
    // Only relative imports are ours to verify.
    if (!specifier.startsWith('.')) continue;
    importCount++;

    // Strip Vite query suffixes (`?raw`, `?worker`).
    const [rawPath] = specifier.split('?');
    const target = resolve(here, rawPath);
    const shown = relative(SRC, file);

    if (!(await existsWithExactCase(target))) {
      problems.push(`${shown}: imports "${specifier}" which does not exist with that exact casing`);
      continue;
    }

    // Named-export checks only apply to our own JS modules.
    if (!target.endsWith('.js') || specifier.includes('?')) continue;
    const available = exportsByFile.get(target);
    if (!available || available.has('*')) continue;

    for (const name of entry.names) {
      if (!available.has(name)) {
        problems.push(
          `${shown}: imports { ${name} } from "${specifier}", which does not export it`
        );
      }
    }
  }
}

process.stdout.write(`Audited ${moduleCount} modules and ${importCount} relative imports.\n`);
if (problems.length === 0) {
  process.stdout.write('\x1b[32mNo import/export problems found.\x1b[0m\n');
  process.exit(0);
}
for (const problem of problems) process.stdout.write(`\x1b[31m✗\x1b[0m ${problem}\n`);
process.exit(1);
