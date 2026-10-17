import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub, socketUrl } from '../src/hub.js';

/** Enough of the extension APIs for the hub, recording what it does. */
function fakeChrome({ granted = ['https://bradfrost.com/*'] } = {}) {
  const local = {};
  const session = {};
  const injected = [];
  const area = (store) => ({
    get: async (key) => ({ [key]: store[key] }),
    set: async (values) => Object.assign(store, values),
  });

  return {
    injected,
    local,
    storage: { local: area(local), session: area(session) },
    permissions: {
      contains: async ({ origins }) => origins.every((o) => granted.includes(o)),
      remove: async ({ origins }) => origins.forEach((o) => granted.splice(granted.indexOf(o), 1)),
    },
    scripting: { executeScript: async ({ target }) => injected.push(target.tabId) },
  };
}

/** A relay connection the test drives by hand. */
function fakeTransport() {
  const made = [];
  const create = (options) => {
    const listeners = new Set();
    const t = { options, closed: false, push: (msg) => listeners.forEach((fn) => fn(msg)), subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)), close: () => (t.closed = true) };
    made.push(t);

    return t;
  };

  return { made, create };
}

function fakePort(tabId) {
  const sent = [];
  const disconnects = [];

  return {
    name: 'token-sync',
    sender: { tab: { id: tabId } },
    sent,
    postMessage: (m) => sent.push(m),
    disconnect: () => sent.push('disconnected'),
    onDisconnect: { addListener: (fn) => disconnects.push(fn) },
    drop: () => disconnects.forEach((fn) => fn()),
  };
}

const set = (props, ts) => ({ v: 1, room: 'detach', op: 'set', from: 'controller', props, ts });

test('the relay socket comes from the relay URL, and only http(s) relays are accepted', () => {
  assert.equal(socketUrl('https://relay.example', 'detach'), 'wss://relay.example/rooms/detach/socket');
  assert.throws(() => socketUrl('javascript:alert(1)', 'r'));
});

test('syncing a tab connects to the room, injects the applier and allows the site', async () => {
  const chrome = fakeChrome();
  const relay = fakeTransport();
  const hub = createHub({ chrome, createTransport: relay.create });
  await hub.sync({ tabId: 7, url: 'https://bradfrost.com/blog', room: 'detach', relay: 'https://relay.example' });
  assert.equal(relay.made[0].options.url, 'wss://relay.example/rooms/detach/socket');
  assert.deepEqual(chrome.injected, [7]);
  assert.deepEqual(chrome.local['token-sync:allowlists'], { detach: ['https://bradfrost.com'] });
});

test('nothing changes without the site permission, on a page that is not http(s), or with a bad room', async () => {
  const hub = createHub({ chrome: fakeChrome({ granted: [] }), createTransport: fakeTransport().create });
  await assert.rejects(hub.sync({ tabId: 1, url: 'https://bradfrost.com/', room: 'detach', relay: 'https://r.example' }), /no permission/);
  await assert.rejects(hub.sync({ tabId: 1, url: 'chrome://extensions', room: 'detach', relay: 'https://r.example' }), /can't be previewed/);
  await assert.rejects(hub.sync({ tabId: 1, url: 'https://bradfrost.com/', room: 'bad room', relay: 'https://r.example' }), /room codes/);
  assert.equal(hub.session, null);
});

test('one tab at a time: syncing another tab stops the first and tells its page to leave', async () => {
  const chrome = fakeChrome({ granted: ['https://bradfrost.com/*', 'https://atomicdesign.bradfrost.com/*'] });
  const relay = fakeTransport();
  const hub = createHub({ chrome, createTransport: relay.create });
  await hub.sync({ tabId: 1, url: 'https://bradfrost.com/', room: 'detach', relay: 'https://r.example' });
  const first = fakePort(1);
  await hub.onPortConnect(first);
  await hub.sync({ tabId: 2, url: 'https://atomicdesign.bradfrost.com/', room: 'detach', relay: 'https://r.example' });
  assert.ok(first.sent.some((m) => m.kind === 'stop'));
  assert.equal(relay.made[0].closed, true);
  assert.equal(hub.session.tabId, 2);
});

test('a page in the synced tab gets the room on arrival, then every change', async () => {
  const relay = fakeTransport();
  const hub = createHub({ chrome: fakeChrome(), createTransport: relay.create });
  await hub.sync({ tabId: 7, url: 'https://bradfrost.com/', room: 'detach', relay: 'https://r.example' });
  relay.made[0].push(set({ '--brand': '#0a7f5a' }, 10));
  const port = fakePort(7);
  await hub.onPortConnect(port);
  assert.deepEqual(port.sent[0], { kind: 'config', room: 'detach' });
  assert.equal(port.sent[1].msg.props['--brand'], '#0a7f5a'); // the snapshot
  relay.made[0].push(set({ '--radius': '4px' }, 11));
  assert.equal(port.sent.at(-1).msg.props['--radius'], '4px');
});

test('pages in any other tab are turned away', async () => {
  const hub = createHub({ chrome: fakeChrome(), createTransport: fakeTransport().create });
  await hub.sync({ tabId: 7, url: 'https://bradfrost.com/', room: 'detach', relay: 'https://r.example' });
  const stranger = fakePort(99);
  await hub.onPortConnect(stranger);
  assert.deepEqual(stranger.sent, [{ kind: 'stop' }, 'disconnected']);
});

test('the relay\'s messages are validated before any page sees them', async () => {
  const relay = fakeTransport();
  const hub = createHub({ chrome: fakeChrome(), createTransport: relay.create });
  await hub.sync({ tabId: 7, url: 'https://bradfrost.com/', room: 'detach', relay: 'https://r.example' });
  const port = fakePort(7);
  await hub.onPortConnect(port);
  relay.made[0].push(set({ '--bg': 'url(https://example.com/x.png)' }, 12));
  relay.made[0].push({ ...set({ '--a': '1px' }, 13), room: 'other' });
  assert.equal(port.sent.filter((m) => m.kind === 'msg').length, 0);
});

test('after navigation the applier is re-injected only on allowed, permitted sites', async () => {
  const chrome = fakeChrome();
  const hub = createHub({ chrome, createTransport: fakeTransport().create });
  await hub.sync({ tabId: 7, url: 'https://bradfrost.com/', room: 'detach', relay: 'https://r.example' });
  await hub.onTabUpdated(7, { status: 'complete' }, { url: 'https://bradfrost.com/about' });
  await hub.onTabUpdated(7, { status: 'complete' }, { url: 'https://elsewhere.example/' });
  await hub.onTabUpdated(8, { status: 'complete' }, { url: 'https://bradfrost.com/' }); // another tab
  await hub.onTabUpdated(7, { status: 'loading' }, { url: 'https://bradfrost.com/x' });
  assert.deepEqual(chrome.injected, [7, 7]);
});

test('closing the synced tab ends the session; forgetting a site removes it and its permission', async () => {
  const chrome = fakeChrome();
  const relay = fakeTransport();
  const hub = createHub({ chrome, createTransport: relay.create });
  await hub.sync({ tabId: 7, url: 'https://bradfrost.com/', room: 'detach', relay: 'https://r.example' });
  await hub.onTabRemoved(7);
  assert.equal(hub.session, null);
  assert.equal(relay.made[0].closed, true);
  await hub.onMessage({ type: 'forget-site', room: 'detach', site: 'https://bradfrost.com' });
  assert.deepEqual(chrome.local['token-sync:allowlists'], {});
  assert.equal(await chrome.permissions.contains({ origins: ['https://bradfrost.com/*'] }), false);
});

test('a restarted background picks the session back up', async () => {
  const chrome = fakeChrome();
  const first = createHub({ chrome, createTransport: fakeTransport().create });
  await first.sync({ tabId: 7, url: 'https://bradfrost.com/', room: 'detach', relay: 'https://r.example' });
  const relay = fakeTransport();
  const revived = createHub({ chrome, createTransport: relay.create });
  await revived.restore();
  assert.equal(revived.session.room, 'detach');
  assert.equal(relay.made.length, 1);
});
