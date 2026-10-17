// A deliberately small bundler for this repo's own modules.
//
// Token Sync's packages are plain ES modules that import each other by
// relative path. A page can load them as-is, but a bookmarklet and a one-tag
// drop-in need one self-contained file. This turns a module graph into a
// single script without a third-party bundler, because the packages only use
// a handful of import/export forms:
//
//   import { a, b as c } from './x.js';
//   export function f() {}      export const X = …;
//   export { a, b } from './x.js';
//   export * from './x.js';
//
// Anything else — default exports, namespace imports, dynamic import(),
// import.meta, cycles — is refused with the file and line, rather than
// guessed at. A bundler that silently mistranslates is worse than none.

import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const IMPORT = /^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?\s*$/;
const EXPORT_FROM = /^export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?\s*$/;
const EXPORT_STAR = /^export\s*\*\s*from\s*['"]([^'"]+)['"];?\s*$/;
const EXPORT_DECL = /^export\s+(?:async\s+)?(function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/;

/** Parse `a, b as c` into [[imported, local]]. */
function specifiers(list) {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [imported, local = imported] = s.split(/\s+as\s+/).map((x) => x.trim());

      return [imported, local];
    });
}

/**
 * Bundle an entry module and everything it imports into one script.
 * @param {string} entry absolute path of the entry module
 * @param {{ globalName?: string, stripComments?: boolean }} [options]
 *   `globalName`: assign the entry's exports to `globalThis[globalName]`;
 *   otherwise the bundle is an expression that evaluates to them.
 *   `stripComments`: drop whole-line comments and leading indentation, for a
 *   bookmarklet where every byte is in the URL. Only whole lines that start a
 *   comment are dropped — never part of a line — so string contents are safe.
 * @returns {string}
 */
export function bundle(entry, { globalName, stripComments = false } = {}) {
  const order = [];
  const modules = new Map();
  const visiting = new Set();

  function load(file) {
    if (modules.has(file)) return;
    if (visiting.has(file)) throw new Error(`bundle: import cycle through ${relative(REPO_ROOT, file)}`);
    visiting.add(file);

    const source = readFileSync(file, 'utf8');
    const deps = [];
    const exportNames = [];
    const reexports = [];
    const stars = [];
    const lines = source.split('\n').map((line, index) => {
      const where = `${relative(REPO_ROOT, file)}:${index + 1}`;
      const trimmed = line.trim();
      let m;
      if ((m = IMPORT.exec(trimmed))) {
        const dep = resolve(dirname(file), m[2]);
        deps.push(dep);
        const binds = specifiers(m[1]).map(([imported, local]) => (imported === local ? local : `${imported}: ${local}`));

        return `const { ${binds.join(', ')} } = __modules[${JSON.stringify(dep)}];`;
      }
      if ((m = EXPORT_FROM.exec(trimmed))) {
        const dep = resolve(dirname(file), m[2]);
        deps.push(dep);
        for (const [imported, local] of specifiers(m[1])) reexports.push({ dep, imported, local });

        return '';
      }
      if ((m = EXPORT_STAR.exec(trimmed))) {
        const dep = resolve(dirname(file), m[1]);
        deps.push(dep);
        stars.push(dep);

        return '';
      }
      if ((m = EXPORT_DECL.exec(trimmed))) {
        exportNames.push(m[2]);

        return line.replace(/^(\s*)export\s+/, '$1');
      }
      if (/^(import|export)\b/.test(trimmed) || /\bimport\s*\(|import\.meta/.test(line)) {
        throw new Error(`bundle: unsupported module syntax at ${where}: ${trimmed}`);
      }

      return line;
    });

    for (const dep of deps) load(dep);
    visiting.delete(file);
    modules.set(file, { lines, exportNames, reexports, stars });
    order.push(file);
  }

  load(resolve(entry));

  const parts = ['(() => {', "'use strict';", 'const __modules = {};'];
  for (const file of order) {
    const { lines, exportNames, reexports, stars } = modules.get(file);
    const exported = [
      ...stars.map((dep) => `...__modules[${JSON.stringify(dep)}]`),
      ...reexports.map(({ dep, imported, local }) => `${local}: __modules[${JSON.stringify(dep)}].${imported}`),
      ...exportNames,
    ];
    parts.push(
      `// ${relative(REPO_ROOT, file)}`,
      `__modules[${JSON.stringify(file)}] = (() => {`,
      ...lines,
      `return { ${exported.join(', ')} };`,
      '})();',
    );
  }
  const entryExports = `__modules[${JSON.stringify(resolve(entry))}]`;
  parts.push(globalName ? `globalThis[${JSON.stringify(globalName)}] = ${entryExports};` : `return ${entryExports};`, '})()');

  // Absolute paths are only keys; replace them so the output doesn't carry the
  // build machine's directory layout.
  let out = parts.join('\n');
  if (stripComments) {
    let inBlock = false;
    out = out
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        if (inBlock) {
          if (t.includes('*/')) inBlock = false;

          return false;
        }
        if (t.startsWith('/*')) {
          inBlock = !t.includes('*/');

          return false;
        }

        return t !== '' && !t.startsWith('//');
      })
      .map((line) => line.trim())
      .join('\n');
  }
  for (const file of order) out = out.split(JSON.stringify(file)).join(JSON.stringify(relative(REPO_ROOT, file)));

  return `${out};\n`;
}
