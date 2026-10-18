// Eddie's theme contract as a Token Sync adapter (FEATURE-SPEC §8, §9, §10 Q1).
//
// Token Sync is design-system-agnostic: on any page it sets the custom
// properties it's sent and nothing more. On an Eddie page this adapter adds
// what only Eddie's contract knows:
//
// - `contract:<path>` knobs. `contract:color.background-brand` is one value
//   that Eddie expands into every token derived from it (buttons, links, text
//   on brand), with `expandContract()`. `contract:color.background.brand`
//   (a contract path, Eddie's form) is just that token's custom property.
// - Legibility. Whenever a knob, or a raw value that lands on a contract
//   path, changes a colour, `solve()` checks the contract's foreground/
//   background pairs and moves *derived* text colours until each clears
//   WCAG AA. What it moved is reported, never hidden, and so is anything it
//   couldn't fix.
//
// A raw value outside the contract is passed through unsolved, exactly as on
// a page with no adapter.
//
// The contract module ships in @brad-frost-web/eddie-design-tokens (checked
// with npm pack: contract/ is in the published package). It is imported by
// relative path into node_modules so the same file runs unbundled in a
// browser, in Node, and through tools/bundle.js.

import { BUTTON_KNOBS, COLOR_KNOBS, customPropertyToPath, expandContract, knownPaths, pathToCustomProperty } from '../../../node_modules/@brad-frost-web/eddie-design-tokens/contract/contract.js';
import { solve } from '../../../node_modules/@brad-frost-web/eddie-design-tokens/contract/solve.js';
import { toHex } from '../../../node_modules/@brad-frost-web/eddie-design-tokens/contract/color.js';
import { buttonScale } from '../../../node_modules/@brad-frost-web/eddie-design-tokens/contract/pairs.js';

const PREFIX = 'contract:';
const COLOR_KEYS = new Set(COLOR_KNOBS.map((k) => k.key));
const PATHS = new Set(knownPaths());
/** A contract path that holds a colour: color.background.brand, link.color.content.hover. */
const isColourPath = (path) => /(^|\.)color(\.|$)/.test(path);
/** A token named as a colour, the same test Eddie's applier uses. */
const isColourName = (name) => /-color-|-color$/.test(name);

/**
 * `contract:color.background.brand` names a contract path (Eddie's form,
 * docs/TOKEN-SYNC.md): it is that path's custom property, nothing more.
 * `contract:color.background-brand` is a knob, which re-derives what hangs off it.
 */
export function contractPathProperty(name) {
  const path = name.slice(PREFIX.length);

  return PATHS.has(path) ? pathToCustomProperty(path) : null;
}
const BUTTON_KEYS = new Set(BUTTON_KNOBS.map((k) => k.key));

/** Does this page look like an Eddie page? It defines Eddie's theme tokens. */
export function isEddiePage(readComputed) {
  return Boolean(readComputed('--ed-theme-color-background-default')?.trim());
}

/**
 * Turn `contract:color.background-brand` into where it goes in a contract
 * object, or explain why it can't.
 * @returns {{ group: 'color' | 'buttons', key: string } | { error: string }}
 */
export function parseKnob(name) {
  const path = name.slice(PREFIX.length);
  const dot = path.indexOf('.');
  const group = path.slice(0, dot);
  const key = path.slice(dot + 1);
  if (group === 'color' && COLOR_KEYS.has(key)) return { group: 'color', key };
  if (group === 'buttons' && BUTTON_KEYS.has(key)) return { group: 'buttons', key };

  return { error: `${name} isn't a contract knob this adapter knows (colour and button knobs are supported)` };
}

/** "button.primary.color.content.default" → "button primary content default", for a sentence. */
const readable = (path) => path.replace(/\b(color|ed-theme)\b\.?/g, '').replace(/[.-]+/g, ' ').trim();

/** The sentence for one thing the solver moved: a text colour, or (rarely) a derived background it had to ease. */
export function describeMove(move) {
  if (typeof move.lightnessDelta !== 'number') return `Eased ${readable(move.path)} so the text on it stays readable.`;
  const amount = Math.round(Math.abs(move.lightnessDelta) * 100);
  const direction = move.lightnessDelta < 0 ? 'darker' : 'lighter';

  return `Nudged ${readable(move.path)} ${amount}% ${direction} to stay readable.`;
}

/**
 * @param {{ readComputed: (name: string) => string }} options reads the page's
 *   own value of a custom property. The theme is read right here, when the
 *   adapter is made — before anything is applied — so it is the theme, not
 *   the room.
 */
export function createEddieAdapter({ readComputed }) {
  /**
   * The theme's button type ramp. Button labels may use the 3:1 large-text
   * floor only when this theme's smallest button qualifies; without it every
   * button would be held to 4.5:1 and nudged on pages that are fine.
   */
  const scale = buttonScale((path) => readComputed(pathToCustomProperty(path))?.trim() || null);
  /** The theme's own colours, by contract path. */
  const theme = {};
  for (const path of knownPaths()) {
    const hex = toHex(readComputed(pathToCustomProperty(path)) ?? '');
    if (hex) theme[path] = hex;
  }
  /**
   * What the adapter would produce with no knobs at all. Expanding re-derives
   * every token that hangs off the theme's brand, and those guesses differ a
   * little from the theme's hand-tuned values; comparing against this, rather
   * than the raw theme, means only what a knob actually changed is written.
   */
  const unknobbed = solve(expandContract({}, theme).tokens, { scale }).tokens;
  const plain = solve({ ...theme }, { scale }).tokens;
  /** A knob's last readable value, kept while someone is mid-way through typing a colour. */
  const lastGood = {};

  /**
   * Resolve a room's props into the custom properties to apply.
   * @param {Record<string, string>} props
   * @returns {{
   *   props: Record<string, string>,
   *   refused: { name: string, value: string, reason: string }[],
   *   status: { moved: string[], problems: string[], unchecked: number },
   * }} `moved`: what the solver changed; `problems`: what it couldn't fix or
   *   couldn't check (show these until they clear); `unchecked`: raw values
   *   outside the contract, applied as sent with no contrast check.
   */
  function resolve(props) {
    const contract = { color: {}, buttons: {} };
    const passthrough = {};
    const onContract = {};
    const refused = [];
    const problems = [];
    let knobs = 0;
    let unchecked = 0;
    /** Contract colours set to contrast-color(): they pick their own contrast, so the solver leaves them be. */
    const selfContrasting = new Set();

    for (const [key, value] of Object.entries(props)) {
      const name = (key.startsWith(PREFIX) && contractPathProperty(key)) || key;
      if (name.startsWith(PREFIX)) {
        const knob = parseKnob(name);
        if ('error' in knob) {
          refused.push({ name, value, reason: knob.error });
          continue;
        }
        const hex = toHex(value);
        if (hex) lastGood[name] = hex;
        else refused.push({ name, value, reason: 'contract colour knobs take a hex colour (#rgb or #rrggbb)' });
        // A knob mid-edit keeps its last good value rather than snapping the page back.
        if (lastGood[name]) {
          contract[knob.group][knob.key] = lastGood[name];
          knobs += 1;
        }
        continue;
      }
      // Only colours take part in contrast: the contract also knows radii,
      // borders and the like, and those pass through with nothing to say.
      const path = customPropertyToPath(name);
      const colourPath = path && isColourPath(path) ? path : null;
      const hex = colourPath && toHex(value);
      if (colourPath && hex) onContract[colourPath] = hex;
      else {
        passthrough[name] = value;
        // contrast-color() picks the contrasting colour itself: nothing to check.
        if (colourPath && /^contrast-color\(/i.test(value.trim())) selfContrasting.add(colourPath);
        else if (colourPath) problems.push(`Couldn't contrast-check ${name}: only hex colours can be checked, so ${value} was applied as sent.`);
        else if (!path && isColourName(name)) unchecked += 1;
      }
    }

    if (!knobs && !Object.keys(onContract).length) return { props: passthrough, refused, status: { moved: [], problems, unchecked } };

    // Knobs re-derive what hangs off them. Raw values on contract paths are
    // explicit: they win over a derived guess. The solver keeps authored
    // *backgrounds* where they are; any text colour, raw ones included, may be
    // moved to stay legible.
    const expanded = knobs ? expandContract(contract, theme) : { tokens: { ...theme }, authored: new Set() };
    const tokens = { ...expanded.tokens, ...onContract };
    const authored = new Set([...expanded.authored, ...Object.keys(onContract)]);
    const { tokens: solved, report } = solve(tokens, { authored, scale });
    const baseline = knobs ? unknobbed : plain;

    const out = { ...passthrough };
    for (const [path, value] of Object.entries(solved)) {
      if (selfContrasting.has(path)) continue;
      if (baseline[path] !== value || path in onContract) out[pathToCustomProperty(path)] = value;
    }

    const moved = report.moved.filter((m) => !selfContrasting.has(m.path) && baseline[m.path] !== solved[m.path]).map(describeMove);
    for (const u of report.unresolved.filter((entry) => !selfContrasting.has(entry.path))) problems.push(`Couldn't keep ${readable(u.path)} readable on every background it sits on.`);
    for (const skip of report.skipped ?? []) problems.push(`Couldn't contrast-check ${skip.label ?? readable(skip.fgPath ?? skip.path ?? '')}: one of its colours isn't a hex value.`);

    return { props: out, refused, status: { moved, problems, unchecked } };
  }

  return { resolve };
}
