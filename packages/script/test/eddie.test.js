import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier, lazyEddieAdapter } from '../src/token-sync-eddie.js';

test('the adapter appears once the page shows Eddie\'s tokens, even if they arrive late', () => {
  let tokens = {};
  const adapter = lazyEddieAdapter({ readComputed: (name) => tokens[name] ?? '' });
  const early = adapter.resolve({ 'contract:color.background-brand': '#1b4dd8', '--gap': '1rem' });
  assert.deepEqual(early.props, { '--gap': '1rem' });
  assert.match(early.refused[0].reason, /Eddie's tokens/);
  tokens = { '--ed-theme-color-background-default': '#fbfaf5', '--ed-theme-color-background-brand': '#9e5600', '--ed-theme-color-content-default': '#110000' };
  const later = adapter.resolve({ 'contract:color.background-brand': '#1b4dd8' });
  assert.equal(later.props['--ed-theme-color-background-brand'], '#1b4dd8');
});

/** A page with ed-toast defined, recording what toasts show. */
function fakePage() {
  const body = { children: [], append: (el) => body.children.push(el) };
  const created = [];
  const document = {
    body,
    createElement: (tag) => {
      const el = { tag, children: [], replaceChildren: (...kids) => (el.children = kids), remove: () => body.children.splice(body.children.indexOf(el), 1) };
      created.push(el);

      return el;
    },
  };
  globalThis.customElements = { get: (name) => name === 'ed-toast' };

  return { document, body, shown: () => body.children.map((t) => t.children.map((p) => p.textContent)) };
}

test('one toast, reused: nudges show briefly, problems stay until they clear', (t) => {
  const info = console.info;
  console.info = () => {};
  t.after(() => {
    console.info = info;
    delete globalThis.customElements;
  });
  const page = fakePage();
  const timers = [];
  const notify = createNotifier(page.document, { setTimeout: (fn) => timers.push(fn), clearTimeout: () => {} });
  notify({ moved: ['Nudged a'], problems: [], unchecked: 0 });
  assert.deepEqual(page.shown(), [['Nudged a']]);
  notify({ moved: ['Nudged a'], problems: [], unchecked: 0 }); // same state: nothing new
  assert.equal(page.body.children.length, 1);
  notify({ moved: [], problems: ["Couldn't keep b readable"], unchecked: 0 });
  assert.deepEqual(page.shown(), [["Couldn't keep b readable"]]); // the same toast, new words
  notify({ moved: [], problems: [], unchecked: 0 });
  assert.equal(page.body.children.length, 0); // cleared, so gone
});

test('raw values outside the contract are announced as unchecked when more arrive', (t) => {
  const info = console.info;
  console.info = () => {};
  t.after(() => {
    console.info = info;
    delete globalThis.customElements;
  });
  const page = fakePage();
  const notify = createNotifier(page.document, { setTimeout: () => {}, clearTimeout: () => {} });
  notify({ moved: [], problems: [], unchecked: 2 });
  assert.match(page.shown()[0][0], /2 values outside Eddie's contract applied as sent/);
});
