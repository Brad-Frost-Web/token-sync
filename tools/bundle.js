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
const EXPORT_DECL = /^export\s+(?:async\s+)?(function\*?|const|class)\s+([A-Za-z_$][\w$]*)/;

/**
 * Does this line leave us inside a multi-line template literal? Counts
 * unescaped backticks; `${…}` holding a nested template is not handled, and
 * this repo's source has none.
 */
function togglesTemplate(line) {
  return (line.replace(/\\./g, '').split('`').length - 1) % 2 === 1;
}

/** Is there a top-level comma in this declaration, i.e. more than one declarator? */
function declaresSeveral(line) {
  let depth = 0;
  let quote = null;
  for (const ch of line.replace(/\\./g, '')) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) return true;
  }

  return false;
}

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
 *   bookmarklet where every byte is in the URL. Only lines that are nothing
 *   but a comment are dropped, never part of a line, and lines inside a
 *   multi-line template literal are left exactly as written.
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
    const imports = [];
    const exportNames = [];
    const reexports = [];
    const stars = [];
    let inTemplate = false;
    const lines = source.split('\n').map((original, index) => {
      const where = `${relative(REPO_ROOT, file)}:${index + 1}`;
      // Inside a multi-line template literal every line is string content.
      const startedInTemplate = inTemplate;
      if (togglesTemplate(original)) inTemplate = !inTemplate;
      if (startedInTemplate) return original;
      // A leading /* … */ is only a comment: drop it so `/* note */ export …`
      // is read as the export it is.
      const line = original.replace(/^(\s*)\/\*.*?\*\/\s*/, '$1');
      const trimmed = line.trim();
      const local = (specifier) => {
        if (!/^\.{1,2}\//.test(specifier)) throw new Error(`bundle: only relative imports are bundled, at ${where}: ${specifier}`);

        return resolve(dirname(file), specifier);
      };
      let m;
      if ((m = IMPORT.exec(trimmed))) {
        const dep = local(m[2]);
        deps.push(dep);
        for (const [imported] of specifiers(m[1])) imports.push({ dep, imported, where });
        const binds = specifiers(m[1]).map(([imported, local]) => (imported === local ? local : `${imported}: ${local}`));

        return `const { ${binds.join(', ')} } = __modules[${JSON.stringify(dep)}];`;
      }
      if ((m = EXPORT_FROM.exec(trimmed))) {
        const dep = local(m[2]);
        deps.push(dep);
        for (const [imported, local] of specifiers(m[1])) {
          reexports.push({ dep, imported, local });
          imports.push({ dep, imported, where });
        }

        return '';
      }
      if ((m = EXPORT_STAR.exec(trimmed))) {
        const dep = local(m[1]);
        deps.push(dep);
        stars.push(dep);

        return '';
      }
      if ((m = EXPORT_DECL.exec(trimmed))) {
        if (m[1] === 'const' && declaresSeveral(trimmed)) {
          throw new Error(`bundle: one declarator per export, please, at ${where}: ${trimmed}`);
        }
        exportNames.push(m[2]);

        return line.replace(/^(\s*)export\s+/, '$1');
      }
      // `export let` is refused too: its live binding can't survive the copy into an exports object.
      if (/^(import|export)\b/.test(trimmed) || /\bimport\s*\(|import\.meta/.test(line)) {
        throw new Error(`bundle: unsupported module syntax at ${where}: ${trimmed}`);
      }

      return line;
    });

    for (const dep of deps) load(dep);
    visiting.delete(file);
    modules.set(file, { lines, exportNames, reexports, stars, imports });
    order.push(file);
  }

  load(resolve(entry));

  // Every imported name must be exported by its module, as a real module
  // loader would insist — a typo must fail the build, not become undefined.
  const exportsOf = (file) => {
    const { exportNames, reexports, stars } = modules.get(file);

    return new Set([...exportNames, ...reexports.map((r) => r.local), ...stars.flatMap((dep) => [...exportsOf(dep)])]);
  };
  for (const file of order) {
    for (const { dep, imported, where } of modules.get(file).imports) {
      if (!exportsOf(dep).has(imported)) throw new Error(`bundle: ${relative(REPO_ROOT, dep)} does not export "${imported}" (imported at ${where})`);
    }
  }

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
    let inString = false;
    const kept = [];
    for (const line of out.split('\n')) {
      const t = line.trim();
      // Template-literal content is kept exactly: not trimmed, not dropped.
      if (inString) {
        kept.push(line);
        if (togglesTemplate(line)) inString = false;
        continue;
      }
      if (inBlock) {
        if (t.includes('*/')) inBlock = false;
        continue;
      }
      if (t === '' || t.startsWith('//')) continue;
      if (t.startsWith('/*')) {
        const end = t.indexOf('*/');
        if (end === -1) {
          inBlock = true;
          continue;
        }
        // A whole-line comment goes; a comment with code after it stays.
        if (t.slice(end + 2).trim() === '') continue;
      }
      kept.push(t);
      if (togglesTemplate(line)) inString = true;
    }
    out = kept.join('\n');
  }
  for (const file of order) out = out.split(JSON.stringify(file)).join(JSON.stringify(relative(REPO_ROOT, file)));

  return `${out};\n`;
}
