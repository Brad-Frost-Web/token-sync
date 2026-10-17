import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tokensFrom } from '../../cli/src/css.js';
import { createEddieAdapter, describeMove, isEddiePage, parseKnob } from '../src/adapter.js';
import { audit } from '../../../node_modules/@brad-frost-web/eddie-design-tokens/contract/solve.js';
import { buttonScale } from '../../../node_modules/@brad-frost-web/eddie-design-tokens/contract/pairs.js';
import { customPropertyToPath, knownPaths, pathToCustomProperty } from '../../../node_modules/@brad-frost-web/eddie-design-tokens/contract/contract.js';

/** Eddie's real built bfw theme, with var() references resolved — what a page's getComputedStyle would say. */
function bfwTheme() {
  const css = readFileSync(fileURLToPath(new URL('../../../node_modules/@brad-frost-web/eddie-design-tokens/bfw/build/css/tokens.css', import.meta.url)), 'utf8');
  const raw = tokensFrom(css);
  const resolve = (value, depth = 0) => value.replace(/var\((--[\w-]+)\)/g, (_, name) => (depth > 10 ? '' : resolve(raw[name] ?? '', depth + 1)));

  return (name) => resolve(raw[name] ?? '');
}

/** Audit with the theme's own button scale, as Eddie's contrast gate does. */
const auditPage = (readComputed, tokens) => audit(tokens, { scale: buttonScale((path) => readComputed(pathToCustomProperty(path)) || null) });

/** The page after applying `props` on top of the theme, as contract tokens. */
function pageAfter(readComputed, props) {
  const tokens = {};
  for (const path of knownPaths()) {
    const value = props[pathToCustomProperty(path)] ?? readComputed(pathToCustomProperty(path));
    if (/^#[0-9a-f]{3,8}$/i.test(value)) tokens[path] = value;
  }

  return tokens;
}

test('knows an Eddie page when it sees one', () => {
  assert.equal(isEddiePage(bfwTheme()), true);
  assert.equal(isEddiePage(() => ''), false);
});

test('parses colour and button knobs, and explains anything else', () => {
  assert.deepEqual(parseKnob('contract:color.background-brand'), { group: 'color', key: 'background-brand' });
  assert.deepEqual(parseKnob('contract:buttons.primary-bg'), { group: 'buttons', key: 'primary-bg' });
  assert.match(parseKnob('contract:shadow.scale').error, /isn't a contract knob/);
});

test('one brand knob becomes every token derived from it, buttons included', () => {
  const adapter = createEddieAdapter({ readComputed: bfwTheme() });
  const { props } = adapter.resolve({ 'contract:color.background-brand': '#1b4dd8' });
  assert.equal(props['--ed-theme-color-background-brand'], '#1b4dd8');
  assert.equal(props['--ed-theme-button-primary-color-background-default'], '#1b4dd8');
  assert.ok(props['--ed-theme-link-color-content-default'], 'links follow the brand');
  assert.ok(Object.keys(props).length > 5);
});

test('a knob that would make text illegible is solved: every contract pair clears AA, and the move is reported', () => {
  const readComputed = bfwTheme();
  const adapter = createEddieAdapter({ readComputed });
  // A pale brand: white button text on it would fail.
  const { props, notices } = adapter.resolve({ 'contract:color.background-brand': '#f5d76e' });
  const result = auditPage(readComputed, pageAfter(readComputed, props));
  assert.equal(result.failures.filter((f) => f.ratio !== null).length, 0, JSON.stringify(result.failures.slice(0, 3)));
  assert.ok(notices.length > 0);
  assert.match(notices[0], /Nudged .* (darker|lighter) to stay readable/);
});

test('a raw value that lands on a contract path is kept, and what pairs with it is solved', () => {
  const readComputed = bfwTheme();
  const adapter = createEddieAdapter({ readComputed });
  // Brand text made too pale to read on the page: the solver darkens what renders on it.
  const { props, notices } = adapter.resolve({ '--ed-theme-color-content-brand': '#e8c07a' });
  assert.ok(props['--ed-theme-color-content-brand']);
  const result = auditPage(readComputed, pageAfter(readComputed, props));
  assert.equal(result.failures.filter((f) => f.ratio !== null).length, 0, JSON.stringify(result.failures.slice(0, 3)));
  assert.ok(notices.some((n) => /content brand/.test(n)));
});

test('what the solver cannot fix is said out loud, never hidden', () => {
  const adapter = createEddieAdapter({ readComputed: bfwTheme() });
  // A dark page with the theme's light "subtle" background left as it is: no
  // single text colour can clear both, and the solver says so.
  const { props, notices } = adapter.resolve({ '--ed-theme-color-background-default': '#111111' });
  assert.equal(props['--ed-theme-color-background-default'], '#111111');
  assert.ok(notices.some((n) => /Couldn't keep .* readable/.test(n)));
});

test('a raw value outside the contract passes through untouched, and nothing else changes', () => {
  const adapter = createEddieAdapter({ readComputed: bfwTheme() });
  const { props, notices } = adapter.resolve({ '--my-site-gap': '2rem' });
  assert.deepEqual(props, { '--my-site-gap': '2rem' });
  assert.deepEqual(notices, []);
});

test('the same notices are not repeated on every message', () => {
  const adapter = createEddieAdapter({ readComputed: bfwTheme() });
  const first = adapter.resolve({ 'contract:color.background-brand': '#f5d76e' }).notices;
  const again = adapter.resolve({ 'contract:color.background-brand': '#f5d76e', '--x': '1px' }).notices;
  assert.ok(first.length > 0);
  assert.deepEqual(again, []);
});

test('unknown knobs and unreadable colours are refused with a reason', () => {
  const adapter = createEddieAdapter({ readComputed: bfwTheme() });
  const { refused } = adapter.resolve({ 'contract:shadow.scale': '2', 'contract:color.background-brand': 'var(--x)' });
  assert.equal(refused.length, 2);
});

test('describes a move in plain words', () => {
  assert.equal(describeMove({ path: 'button.primary.color.content.default', lightnessDelta: -0.08 }), 'Nudged button primary content default 8% darker to stay readable.');
  assert.equal(customPropertyToPath('--ed-theme-color-background-brand'), 'color.background.brand');
});

test('the theme as shipped needs nothing: a no-op change nudges nothing', () => {
  const readComputed = bfwTheme();
  const adapter = createEddieAdapter({ readComputed });
  const brand = readComputed('--ed-theme-color-background-brand');
  const { notices } = adapter.resolve({ '--ed-theme-color-background-brand': brand });
  assert.deepEqual(notices, []);
});
