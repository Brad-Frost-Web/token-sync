import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relaySocketUrl, resolveRoom, STORAGE_KEY } from '../src/token-sync.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));

  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

test('does nothing on an ordinary page view', () => {
  assert.equal(resolveRoom({ search: '', storage: memoryStorage() }), null);
  assert.equal(resolveRoom({ search: '?utm_source=x', storage: memoryStorage() }), null);
});

test('?token-sync=<room> joins the room and remembers it for the session', () => {
  const storage = memoryStorage();
  assert.equal(resolveRoom({ search: '?token-sync=detach', storage }), 'detach');
  assert.equal(storage.data.get(STORAGE_KEY), 'detach');
  // The next page in the same tab has no parameter, and stays in the room.
  assert.equal(resolveRoom({ search: '', storage }), 'detach');
});

test('?token-sync=off leaves', () => {
  const storage = memoryStorage({ [STORAGE_KEY]: 'detach' });
  assert.equal(resolveRoom({ search: '?token-sync=off', storage }), null);
  assert.equal(resolveRoom({ search: '', storage }), null);
});

test('ignores a room code that is not valid, from the URL or from storage', () => {
  assert.equal(resolveRoom({ search: '?token-sync=%3Cscript%3E', storage: memoryStorage() }), null);
  assert.equal(resolveRoom({ search: '', storage: memoryStorage({ [STORAGE_KEY]: 'bad room' }) }), null);
});

test('still works from the URL when storage throws', () => {
  const throwing = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
    removeItem() {
      throw new Error('denied');
    },
  };
  assert.equal(resolveRoom({ search: '?token-sync=detach', storage: throwing }), 'detach');
  assert.equal(resolveRoom({ search: '', storage: throwing }), null);
});

test('a relay declared by the page becomes the room\'s socket URL', () => {
  assert.equal(relaySocketUrl('https://relay.example', 'detach'), 'wss://relay.example/rooms/detach/socket');
  assert.equal(relaySocketUrl('http://127.0.0.1:8787/', 'demo'), 'ws://127.0.0.1:8787/rooms/demo/socket');
  assert.equal(relaySocketUrl('https://example.com/token-sync/?x=1#y', 'r'), 'wss://example.com/token-sync/rooms/r/socket');
});

test('anything that is not an http(s) or ws(s) URL means no relay', () => {
  for (const base of [undefined, '', 'not a url', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/plain,x']) {
    assert.equal(relaySocketUrl(base, 'r'), null, String(base));
  }
});
