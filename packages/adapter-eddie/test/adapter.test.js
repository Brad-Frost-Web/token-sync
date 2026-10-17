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
  const { props, status } = adapter.resolve({ 'contract:color.background-brand': '#f5d76e' });
  const result = auditPage(readComputed, pageAfter(readComputed, props));
  assert.equal(result.failures.filter((f) => f.ratio !== null).length, 0, JSON.stringify(result.failures.slice(0, 3)));
  assert.ok(status.moved.length > 0);
  assert.match(status.moved[0], /Nudged .* (darker|lighter) to stay readable/);
});

test('a raw value that lands on a contract path is kept, and what pairs with it is solved', () => {
  const readComputed = bfwTheme();
  const adapter = createEddieAdapter({ readComputed });
  // Brand text made too pale to read on the page: the solver darkens what renders on it.
  const { props, status } = adapter.resolve({ '--ed-theme-color-content-brand': '#e8c07a' });
  assert.ok(props['--ed-theme-color-content-brand']);
  const result = auditPage(readComputed, pageAfter(readComputed, props));
  assert.equal(result.failures.filter((f) => f.ratio !== null).length, 0, JSON.stringify(result.failures.slice(0, 3)));
  assert.ok(status.moved.some((n) => /content brand/.test(n)));
});

test('what the solver cannot fix is said out loud, never hidden', () => {
  const adapter = createEddieAdapter({ readComputed: bfwTheme() });
  // A dark page with the theme's light "subtle" background left as it is: no
  // single text colour can clear both, and the solver says so.
  const { props, status } = adapter.resolve({ '--ed-theme-color-background-default': '#111111' });
  assert.equal(props['--ed-theme-color-background-default'], '#111111');
  assert.ok(status.problems.some((n) => /Couldn't keep .* readable/.test(n)));
});

test('a raw value outside the contract passes through untouched, and only a colour is counted as unchecked', () => {
  const adapter = createEddieAdapter({ readComputed: bfwTheme() });
  const { props, status } = adapter.resolve({ '--my-site-gap': '2rem' });
  assert.deepEqual(props, { '--my-site-gap': '2rem' });
  assert.deepEqual(status, { moved: [], problems: [], unchecked: 0 });
  assert.equal(adapter.resolve({ '--my-site-color-accent': '#ff00aa' }).status.unchecked, 1);
});

test('a non-colour contract token (a radius) passes through with nothing to report', () => {
  const adapter = createEddieAdapter({ readComputed: bfwTheme() });
  const { props, status } = adapter.resolve({ '--ed-theme-border-radius-md': '18px' });
  assert.deepEqual(props, { '--ed-theme-border-radius-md': '18px' });
  assert.deepEqual(status, { moved: [], problems: [], unchecked: 0 });
});

test('a knob only writes what it changed: an unrelated knob leaves the brand alone, and a knob at the theme\'s own value writes nothing', () => {
  const readComputed = bfwTheme();
  const accent = createEddieAdapter({ readComputed }).resolve({ 'contract:color.accent-3': '#c0ffee' });
  assert.ok(Object.keys(accent.props).every((name) => /accent-3/.test(name)), Object.keys(accent.props).join(', '));
  assert.deepEqual(accent.status.moved.filter((m) => /brand/.test(m)), []);
  const same = createEddieAdapter({ readComputed }).resolve({ 'contract:color.background-brand': readComputed('--ed-theme-color-background-brand') });
  assert.deepEqual(same.props, {});
});

test('a colour on a contract path that cannot be checked is applied, and said so', () => {
  const adapter = createEddieAdapter({ readComputed: bfwTheme() });
  const { props, status } = adapter.resolve({ '--ed-theme-color-background-brand': 'oklch(60% 0.2 30)' });
  assert.equal(props['--ed-theme-color-background-brand'], 'oklch(60% 0.2 30)');
  assert.match(status.problems[0], /Couldn't contrast-check --ed-theme-color-background-brand/);
});

test('a knob being typed keeps its last good value instead of snapping back', () => {
  const adapter = createEddieAdapter({ readComputed: bfwTheme() });
  adapter.resolve({ 'contract:color.background-brand': '#1b4dd8' });
  const typing = adapter.resolve({ 'contract:color.background-brand': '#1b4d' });
  assert.equal(typing.props['--ed-theme-color-background-brand'], '#1b4dd8');
  assert.equal(typing.refused.length, 1);
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
  const { status } = adapter.resolve({ '--ed-theme-color-background-brand': brand });
  assert.deepEqual(status.moved, []);
  assert.deepEqual(status.problems, []);
});

test('a background the solver eases is described without a percentage', () => {
  assert.equal(describeMove({ path: 'button.primary.color.background.active', kind: 'background' }), 'Eased button primary background active so the text on it stays readable.');
});

test("a contract path key (Eddie's form) is that token's property, contrast-solved like any raw value on the contract", () => {
  const adapter = createEddieAdapter({ readComputed: bfwTheme() });
  const path = 'color.background.brand';
  assert.ok(knownPaths().includes(path));
  const { props, refused } = adapter.resolve({ [`contract:${path}`]: '#1b4dd8' });
  assert.deepEqual(refused, []);
  assert.equal(props[pathToCustomProperty(path)], '#1b4dd8');
  assert.deepEqual(adapter.resolve({ 'contract:color.nope.nope': '#1b4dd8' }).refused.length, 1);
});
