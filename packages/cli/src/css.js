// Read custom properties out of a stylesheet, and work out what changed.
//
// Not a CSS parser: it understands comments, strings, blocks and declarations
// well enough to find `--name: value` pairs and the selector they sit under,
// which is all a token file needs. Values are not judged here; the protocol's
// checks refuse what they refuse before anything is sent.

/**
 * Every custom property declaration, in order, with the selector of the
 * block it sits in (nested blocks such as @media report their innermost
 * selector).
 * @param {string} css
 * @returns {{ name: string, value: string, selector: string }[]}
 */
export function readCustomProperties(css) {
  const out = [];
  const stack = [];
  let buffer = '';
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== ch) j += css[j] === '\\' ? 2 : 1;
      buffer += css.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '{') {
      stack.push(buffer.trim());
      buffer = '';
    } else if (ch === '}' || ch === ';') {
      declare(buffer, stack.at(-1) ?? '', out);
      buffer = '';
      if (ch === '}') stack.pop();
    } else {
      buffer += ch;
    }
    i += 1;
  }

  return out;
}

function declare(text, selector, out) {
  const match = /^\s*(--[A-Za-z0-9_-]+)\s*:([\s\S]*)$/.exec(text);
  if (!match || !selector) return;
  out.push({ name: match[1], value: match[2].trim().replace(/\s+/g, ' '), selector });
}

/**
 * The custom properties a stylesheet ends up defining, last declaration
 * winning, optionally only those under one selector (`:root`, `.bfw`).
 * @param {string} css
 * @param {{ selector?: string }} [options]
 * @returns {Record<string, string>}
 */
export function tokensFrom(css, { selector } = {}) {
  const tokens = {};
  for (const decl of readCustomProperties(css)) {
    if (selector !== undefined && decl.selector !== selector) continue;
    tokens[decl.name] = decl.value;
  }

  return tokens;
}

/**
 * What changed between two token sets. A property that disappeared can't be
 * un-set over the wire (the protocol has no delete), so it's reported apart.
 * @param {Record<string, string>} before
 * @param {Record<string, string>} after
 */
export function diffTokens(before, after) {
  const changed = {};
  for (const [name, value] of Object.entries(after)) if (before[name] !== value) changed[name] = value;
  const removed = Object.keys(before).filter((name) => !(name in after));

  return { changed, removed };
}
