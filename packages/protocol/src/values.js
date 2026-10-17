// Value checks for token-sync/1 (FEATURE-SPEC §6, guardrail Q18).
//
// Every value is a string that ends up in `style.setProperty(name, value)`.
// setProperty can't break out into new rules, but a custom property value is
// an arbitrary token stream, and it is read later by real properties — so a
// `url(` smuggled into `--brand` becomes a network request the moment a
// `background` uses it. Two layers stop that:
//
// 1. Refusals: `url(`, `;`, `{`, `}`, `!important`, plus backslashes (a CSS
//    escape spells `url(` as `u\72l(`) and anything outside printable ASCII.
// 2. A function allowlist: the only functions a value may call are colour and
//    math functions plus `var()`. Everything that can fetch (`image-set`,
//    `src`, `element`, `cross-fade`, …) is out because it is not on the list.
//
// Then, when the applier knows what kind of value a property holds, the value
// must parse as that kind: colours as colours, lengths as lengths.
//
// The limit, stated plainly: `var(--x)` is allowed, so a value can point at a
// property the page itself declares — including one the page set to a url().
// That can only reach resources the page already references; no value can name
// a new one. Likewise a property the page doesn't define is typed `any`, and
// fetches only if the page's own CSS wraps it in something that loads it.

export const MAX_VALUE_LENGTH = 200;

const ALLOWED_FUNCTIONS = new Set([
  'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch',
  'color', 'color-mix', 'light-dark',
  'calc', 'clamp', 'min', 'max',
  'var',
]);

const COLOR_FUNCTIONS = new Set([
  'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'light-dark',
]);

const MATH_FUNCTIONS = new Set(['calc', 'clamp', 'min', 'max']);

const LENGTH_UNITS = [
  'px', 'rem', 'em', 'ex', 'ch', 'cap', 'ic', 'lh', 'rlh',
  'vw', 'vh', 'vi', 'vb', 'vmin', 'vmax',
  'svw', 'svh', 'lvw', 'lvh', 'dvw', 'dvh',
  'cqw', 'cqh', 'cqi', 'cqb', 'cqmin', 'cqmax',
  'cm', 'mm', 'q', 'in', 'pt', 'pc', '%',
];

// The CSS named colours, plus the keywords that are colours.
const NAMED_COLORS = new Set(`aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue
blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan
darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon
darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey
dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey
honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral
lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue
lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine
mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise
mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered
orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple
rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue
slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow
yellowgreen transparent currentcolor`.split(/\s+/));

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const LENGTH = new RegExp(`^[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:${LENGTH_UNITS.join('|')})$`, 'i');
const VAR_REF = /^var\(\s*--[a-z0-9_-]+\s*(?:,[^()]*)?\)$/i;
const FONT_FAMILY = /^[a-z0-9 ,'"_-]+$/i;

/**
 * Check a value against the refusal list and the function allowlist.
 * @param {unknown} value
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkSafety(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'value must be a string' };
  if (value.length === 0) return { ok: false, reason: 'value is empty' };
  if (value.length > MAX_VALUE_LENGTH) return { ok: false, reason: `value is longer than ${MAX_VALUE_LENGTH} characters` };
  // Printable ASCII only. Rules out control characters, newlines, and any
  // Unicode lookalike someone hopes a parser will normalise.
  if (!/^[\x20-\x7e]+$/.test(value)) return { ok: false, reason: 'value contains characters outside printable ASCII' };
  const lower = value.toLowerCase();
  if (/url\s*\(/.test(lower)) return { ok: false, reason: 'url( is refused' };
  if (/!\s*important/.test(lower)) return { ok: false, reason: '!important is refused' };
  for (const ch of [';', '{', '}', '\\', '<', '>', '@']) {
    if (value.includes(ch)) return { ok: false, reason: `"${ch}" is refused` };
  }
  for (const match of lower.matchAll(/([a-z-]+)\s*\(/g)) {
    if (!ALLOWED_FUNCTIONS.has(match[1])) return { ok: false, reason: `${match[1]}() is not an allowed function` };
  }
  if (!balancedParens(value)) return { ok: false, reason: 'parentheses are unbalanced' };
  if (!balancedQuotes(value)) return { ok: false, reason: 'quotes are unbalanced' };

  return { ok: true };
}

/**
 * Check a value is safe AND parses as the given type.
 * @param {unknown} value
 * @param {string} [type='any']
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkValue(value, type = 'any') {
  const safety = checkSafety(value);
  if (!safety.ok) return safety;
  const v = /** @type {string} */ (value).trim();
  // A reference to another custom property is valid for every type: pointing
  // one token at another is the most ordinary edit there is.
  if (VAR_REF.test(v)) return { ok: true };
  switch (type) {
    case 'any':
      return { ok: true };
    case 'color':
      return isColor(v) ? { ok: true } : { ok: false, reason: `"${v}" is not a color` };
    case 'length':
      return isLength(v) ? { ok: true } : { ok: false, reason: `"${v}" is not a length` };
    case 'number':
      return NUMBER.test(v) ? { ok: true } : { ok: false, reason: `"${v}" is not a number` };
    case 'font-family':
      return FONT_FAMILY.test(v) ? { ok: true } : { ok: false, reason: `"${v}" is not a font-family list` };
    default:
      return { ok: false, reason: `unknown value type "${type}"` };
  }
}

/**
 * Work out what kind of value a property holds from the value it holds now —
 * how an applier on an arbitrary page knows `--brand` is a colour without any
 * schema. Unrecognised values fall back to `any`: safety-checked, untyped.
 * @param {string | null | undefined} currentValue
 * @returns {'color' | 'length' | 'number' | 'any'}
 */
export function inferType(currentValue) {
  if (typeof currentValue !== 'string') return 'any';
  const v = currentValue.trim();
  if (!v) return 'any';
  if (isColor(v)) return 'color';
  if (isLength(v)) return 'length';
  if (NUMBER.test(v)) return 'number';

  return 'any';
}

/** @param {string} v */
export function isColor(v) {
  const lower = v.trim().toLowerCase();
  if (HEX_COLOR.test(lower)) return true;
  if (NAMED_COLORS.has(lower)) return true;
  const fn = /^([a-z-]+)\(/.exec(lower);

  return Boolean(fn && COLOR_FUNCTIONS.has(fn[1]) && isOneCall(lower));
}

/** @param {string} v */
export function isLength(v) {
  const lower = v.trim().toLowerCase();
  if (lower === '0') return true;
  if (LENGTH.test(lower)) return true;
  const fn = /^([a-z-]+)\(/.exec(lower);

  return Boolean(fn && MATH_FUNCTIONS.has(fn[1]) && isOneCall(lower));
}

/**
 * Is the whole value a single function call — its first `(` closing at the
 * very last character? `rgb(0 0 0) 12px` is a colour followed by junk, not a colour.
 * @param {string} v
 */
function isOneCall(v) {
  let depth = 0;
  for (let i = 0; i < v.length; i += 1) {
    if (v[i] === '(') depth += 1;
    if (v[i] === ')') {
      depth -= 1;
      if (depth === 0) return i === v.length - 1;
      if (depth < 0) return false;
    }
  }

  return false;
}

/** @param {string} v */
function balancedParens(v) {
  let depth = 0;
  for (const ch of v) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth < 0) return false;
  }

  return depth === 0;
}

/**
 * Does every quoted string close? Tracks which quote opened, so an apostrophe
 * inside double quotes (`"it's"`) is just a character.
 * @param {string} v
 */
function balancedQuotes(v) {
  let open = null;
  for (const ch of v) {
    if (open) {
      if (ch === open) open = null;
    } else if (ch === '"' || ch === "'") {
      open = ch;
    }
  }

  return open === null;
}
