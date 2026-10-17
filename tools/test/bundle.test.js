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
