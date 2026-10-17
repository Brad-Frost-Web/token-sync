import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { bundle } from '../bundle.js';
import { bookmarkletSource, bookmarkletUrl, tokenSyncScript } from '../../packages/bookmarklet/build.js';

/** Write a throwaway module graph and hand back its directory. */
function fixture(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'token-sync-bundle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source);

  return dir;
}

test('bundles imports, renames, re-exports and star exports into one script', (t) => {
  const dir = fixture(t, {
    'a.js': "export const A = 1;\nexport function twice(n) {\n  return n * 2;\n}\n",
    'b.js': "import { A as one, twice } from './a.js';\nexport const B = twice(one) + 1;\n",
    'index.js': "export * from './a.js';\nexport { B } from './b.js';\n",
  });
  const exports = vm.runInNewContext(bundle(join(dir, 'index.js')));
  assert.equal(exports.A, 1);
  assert.equal(exports.B, 3);
  assert.equal(exports.twice(5), 10);
});

test('refuses module syntax it does not translate, naming the file and line', (t) => {
  const dir = fixture(t, {
    'default.js': 'export default 1;\n',
    'namespace.js': "import * as x from './default.js';\n",
    'dynamic.js': "const m = await import('./default.js');\n",
  });
  assert.throws(() => bundle(join(dir, 'default.js')), /unsupported module syntax at .*default\.js:1/);
  assert.throws(() => bundle(join(dir, 'namespace.js')), /unsupported module syntax/);
  assert.throws(() => bundle(join(dir, 'dynamic.js')), /unsupported module syntax/);
});

test('refuses an import cycle', (t) => {
  const dir = fixture(t, {
    'a.js': "import { b } from './b.js';\nexport const a = 1;\n",
    'b.js': "import { a } from './a.js';\nexport const b = 2;\n",
  });
  assert.throws(() => bundle(join(dir, 'a.js')), /import cycle/);
});

test('the output never carries the build machine\'s paths', () => {
  assert.equal(tokenSyncScript().includes(process.cwd()), false);
});

test('the drop-in bundle exposes TokenSync and stays inert without a room', () => {
  const sandbox = { console, URLSearchParams };
  vm.runInNewContext(tokenSyncScript(), sandbox);
  assert.equal(typeof sandbox.TokenSync.start, 'function');
  assert.equal(sandbox.TokenSync.resolveRoom({ search: '?token-sync=detach' }), 'detach');
  assert.equal(sandbox.tokenSync, undefined); // no window: no autostart
});

test('the bookmarklet is a javascript: URL that decodes to the source', () => {
  const url = bookmarkletUrl();
  assert.ok(url.startsWith('javascript:'));
  assert.equal(decodeURIComponent(url.slice('javascript:'.length)), bookmarkletSource());
  assert.doesNotThrow(() => new vm.Script(bookmarkletSource()));
});

/** A page, as far as the bookmarklet can tell. */
function fakePage(answer) {
  const storage = new Map();
  const style = new Map();
  const documentElement = {
    dataset: {},
    style: {
      setProperty: (n, v) => style.set(n, v),
      getPropertyValue: (n) => style.get(n) ?? '',
      removeProperty: (n) => style.delete(n),
    },
  };
  const sandbox = {
    console: { info() {}, warn() {} },
    URLSearchParams,
    BroadcastChannel,
    CustomEvent: class extends Event {
      constructor(type, init) {
        super(type);
        this.detail = init?.detail;
      }
    },
    queueMicrotask,
    setTimeout,
    clearTimeout,
    prompt: () => answer,
    location: { search: '' },
    sessionStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
    document: { documentElement, dispatchEvent() {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  return { sandbox, documentElement, storage };
}

test('running the bookmarklet joins the room typed into the prompt', (t) => {
  const { sandbox, documentElement, storage } = fakePage('detach');
  vm.runInNewContext(bookmarkletSource(), sandbox);
  t.after(() => sandbox.tokenSync?.close());
  assert.equal(documentElement.dataset.tokenSync, 'detach');
  assert.equal(storage.get('token-sync:room'), 'detach');
  assert.equal(sandbox.tokenSync.room, 'detach');
});

test('running it again with "off" leaves the room', (t) => {
  const { sandbox, documentElement } = fakePage('detach');
  vm.runInNewContext(bookmarkletSource(), sandbox);
  sandbox.prompt = () => 'off';
  vm.runInNewContext(bookmarkletSource(), sandbox);
  t.after(() => sandbox.tokenSync?.close());
  assert.equal(sandbox.tokenSync, null);
  assert.equal(documentElement.dataset.tokenSync, undefined);
});

test('cancelling the prompt changes nothing', () => {
  const { sandbox, documentElement } = fakePage(null);
  vm.runInNewContext(bookmarkletSource(), sandbox);
  assert.equal(documentElement.dataset.tokenSync, undefined);
});

test('a name its module does not export fails the build instead of becoming undefined', (t) => {
  const dir = fixture(t, {
    'a.js': 'export const A = 1;\n',
    'b.js': "import { Typo } from './a.js';\nexport const B = Typo;\n",
  });
  assert.throws(() => bundle(join(dir, 'b.js')), /does not export "Typo"/);
});

test('refuses forms that would lose meaning: several declarators, export let, non-relative imports', (t) => {
  const dir = fixture(t, {
    'several.js': 'export const a = 1, b = 2;\n',
    'let.js': 'export let n = 0;\n',
    'bare.js': "import { readFileSync } from 'node:fs';\n",
    'fine.js': "export const LIST = ['a', 'b'];\nexport const fn = (x, y) => x + y;\n",
  });
  assert.throws(() => bundle(join(dir, 'several.js')), /one declarator/);
  assert.throws(() => bundle(join(dir, 'let.js')), /unsupported module syntax/);
  assert.throws(() => bundle(join(dir, 'bare.js')), /only relative imports/);
  assert.equal(JSON.stringify(vm.runInNewContext(bundle(join(dir, 'fine.js'))).LIST), '["a","b"]');
});

test('multi-line template literals pass through untouched, with or without comment stripping', (t) => {
  const source = 'export const T = `a\n// not a comment\n\n   import { x } from \'./y.js\';\nb`;\n/* note */ export const after = 1;\n';
  const dir = fixture(t, { 't.js': source });
  for (const stripComments of [false, true]) {
    const out = vm.runInNewContext(bundle(join(dir, 't.js'), { stripComments }));
    assert.equal(out.T, "a\n// not a comment\n\n   import { x } from './y.js';\nb", `stripComments: ${stripComments}`);
    assert.equal(out.after, 1);
  }
});

test('a line that starts with a comment but carries code keeps the code', (t) => {
  const dir = fixture(t, { 'c.js': 'export const a = 1;\n/* keep */ const b = a + 1;\nexport function get() {\n  return b;\n}\n' });
  assert.equal(vm.runInNewContext(bundle(join(dir, 'c.js'), { stripComments: true })).get(), 2);
});

test('a room code that is not valid changes nothing: the tab stays in its room', (t) => {
  const { sandbox, documentElement, storage } = fakePage('alpha');
  vm.runInNewContext(bookmarkletSource(), sandbox);
  t.after(() => sandbox.tokenSync?.close());
  sandbox.prompt = () => 'bad room!';
  vm.runInNewContext(bookmarkletSource(), sandbox);
  assert.equal(sandbox.tokenSync.room, 'alpha');
  assert.equal(documentElement.dataset.tokenSync, 'alpha');
  assert.equal(storage.get('token-sync:room'), 'alpha');
});

test('the bookmarklet does not leave its autostart switch behind', (t) => {
  const { sandbox } = fakePage('alpha');
  vm.runInNewContext(bookmarkletSource(), sandbox);
  t.after(() => sandbox.tokenSync?.close());
  assert.equal('TOKEN_SYNC_MANUAL_START' in sandbox, false);
});

test('the bundled bookmarklet carries the guardrails: refusals and damping', async (t) => {
  const { sandbox, documentElement } = fakePage('guarded');
  const writes = [];
  const setProperty = documentElement.style.setProperty;
  documentElement.style.setProperty = (n, v) => {
    writes.push([n, v]);
    setProperty(n, v);
  };
  vm.runInNewContext(bookmarkletSource(), sandbox);
  t.after(() => sandbox.tokenSync?.close());
  const sender = new BroadcastChannel('token-sync/1:guarded');
  t.after(() => sender.close());
  const ts = Date.now();
  const set = (props, i) => sender.postMessage({ kind: 'msg', msg: { v: 1, room: 'guarded', op: 'set', from: 'controller', props, ts: ts + i } });
  set({ '--bg': 'url(https://example.com/x.png)' }, 0); // refused outright
  for (let i = 1; i <= 10; i += 1) set({ '--n': `${i}px` }, i); // a burst
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(writes.some(([n]) => n === '--bg'), false);
  assert.ok(writes.length <= 2, `a burst of 10 within 100 ms made ${writes.length} writes`);
});

test('backticks in a comment are prose, not the start of a template literal', (t) => {
  const dir = fixture(t, {
    'a.js': "/**\n * The default, `\\`, is rarely bound.\n */\nexport const A = 1;\n// one more `\nexport function b() {\n  return 2;\n}\n",
  });
  const out = vm.runInNewContext(bundle(join(dir, 'a.js')));
  assert.equal(out.A, 1);
  assert.equal(out.b(), 2);
});
