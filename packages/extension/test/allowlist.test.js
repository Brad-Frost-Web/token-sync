import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allow, disallow, isAllowed, permissionFor, siteOf } from '../src/allowlist.js';

test('only web pages have a site; browser and local pages never do', () => {
  assert.equal(siteOf('https://bradfrost.com/blog/post/x?y=1'), 'https://bradfrost.com');
  assert.equal(siteOf('http://127.0.0.1:4321/demo/target.html'), 'http://127.0.0.1:4321');
  for (const url of ['chrome://extensions', 'file:///Users/x/a.html', 'about:blank', 'chrome-extension://abc/popup.html', 'nonsense']) {
    assert.equal(siteOf(url), null, url);
  }
});

test('each room keeps its own list of sites', () => {
  let lists = {};
  lists = allow(lists, 'detach', 'https://bradfrost.com');
  lists = allow(lists, 'detach', 'https://atomicdesign.bradfrost.com');
  lists = allow(lists, 'detach', 'https://bradfrost.com'); // no duplicates
  lists = allow(lists, 'studio', 'http://127.0.0.1:6006');
  assert.deepEqual(lists.detach, ['https://atomicdesign.bradfrost.com', 'https://bradfrost.com']);
  assert.equal(isAllowed(lists, 'detach', 'https://bradfrost.com/about'), true);
  assert.equal(isAllowed(lists, 'studio', 'https://bradfrost.com/about'), false);
  assert.equal(isAllowed(lists, 'detach', 'https://evil.example/'), false);
});

test('removing the last site removes the room', () => {
  const lists = disallow(allow({}, 'r', 'https://a.example'), 'r', 'https://a.example');
  assert.deepEqual(lists, {});
});

test('the permission asked for covers that one site and nothing else', () => {
  assert.equal(permissionFor('https://bradfrost.com'), 'https://bradfrost.com/*');
});
