// Eddie's theme contract as a Token Sync adapter (FEATURE-SPEC §8, §9, §10 Q1).
//
// Token Sync is design-system-agnostic: on any page it sets the custom
// properties it's sent and nothing more. On an Eddie page this adapter adds
// what only Eddie's contract knows:
//
// - `contract:<path>` knobs. `contract:color.background-brand` is one value
//   that Eddie expands into every token derived from it (buttons, links, text
//   on brand), with `expandContract()`.
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

/** The sentence for one thing the solver moved. */
export function describeMove(move) {
  const amount = Math.round(Math.abs(move.lightnessDelta) * 100);
  const direction = move.lightnessDelta < 0 ? 'darker' : 'lighter';

  return `Nudged ${readable(move.path)} ${amount}% ${direction} to stay readable.`;
}

/**
 * @param {{ readComputed: (name: string) => string }} options reads the page's
 *   own value of a custom property — called before anything is applied, so it
 *   sees the theme, not the room.
 */
export function createEddieAdapter({ readComputed }) {
  /** The theme's own colours, by contract path, read once. */
  let base = null;
  /**
   * The theme's button type ramp. Button labels may use the 3:1 large-text
   * floor only when this theme's smallest button qualifies; without it every
   * button would be held to 4.5:1 and nudged on pages that are fine.
   */
  let scale = null;
  let lastNotice = '';

  function themeTokens() {
    if (base) return base;
    scale = buttonScale((path) => readComputed(pathToCustomProperty(path))?.trim() || null);
    base = {};
    for (const path of knownPaths()) {
      const hex = toHex(readComputed(pathToCustomProperty(path)) ?? '');
      if (hex) base[path] = hex;
    }

    return base;
  }

  /**
   * Resolve a room's props into the custom properties to apply.
   * @param {Record<string, string>} props
   * @returns {{ props: Record<string, string>, notices: string[], refused: { name: string, value: string, reason: string }[] }}
   */
  function resolve(props) {
    const contract = { color: {}, buttons: {} };
    const passthrough = {};
    const onContract = {};
    const refused = [];
    let knobs = 0;

    for (const [name, value] of Object.entries(props)) {
      if (name.startsWith(PREFIX)) {
        const knob = parseKnob(name);
        const hex = toHex(value);
        if ('error' in knob) refused.push({ name, value, reason: knob.error });
        else if (!hex) refused.push({ name, value, reason: 'contract colour knobs take a colour the solver can read (a hex or named colour)' });
        else {
          contract[knob.group][knob.key] = hex;
          knobs += 1;
        }
        continue;
      }
      const path = customPropertyToPath(name);
      const hex = path && toHex(value);
      if (path && hex) onContract[path] = hex;
      else passthrough[name] = value;
    }

    if (!knobs && !Object.keys(onContract).length) return { props: passthrough, notices: [], refused };

    const theme = themeTokens();
    // Knobs re-derive everything that hangs off them; raw values on contract
    // paths are explicit, so they win over a derived guess and count as
    // authored (the solver moves them only as a last resort).
    const expanded = knobs ? expandContract(contract, theme) : { tokens: { ...theme }, authored: new Set() };
    const tokens = { ...expanded.tokens, ...onContract };
    const authored = new Set([...expanded.authored, ...Object.keys(onContract)]);
    const { tokens: solved, report } = solve(tokens, { authored, scale });

    const out = { ...passthrough };
    for (const [path, value] of Object.entries(solved)) {
      if (theme[path] !== value || path in onContract) out[pathToCustomProperty(path)] = value;
    }

    const notices = [...report.moved.map(describeMove), ...report.unresolved.map((u) => `Couldn't keep ${readable(u.path)} readable on every background it sits on.`)];
    // The same state is resolved on every message; only say it when it changes.
    const key = notices.join('\n');
    const fresh = key !== lastNotice ? notices : [];
    lastNotice = key;

    return { props: out, notices: fresh, refused };
  }

  return { resolve };
}
