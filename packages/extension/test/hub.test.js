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
    scripting: {
      executeScript: async ({ target }) => {
        if (target.tabId === 666) throw new Error('Cannot access contents of the page');
        injected.push(target.tabId);
      },
    },
    tabs: { get: async (tabId) => ({ id: tabId, url: tabs[tabId] }) },
    runtime: { getURL: (path) => `chrome-extension://abc/${path}` },
    grant: (origin) => granted.push(origin),
  };
}
const tabs = { 7: 'https://bradfrost.com/blog', 1: 'https://bradfrost.com/', 2: 'https://atomicdesign.bradfrost.com/' };

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

test('every synced tab gets every change at once, over one relay connection', async () => {
  const chrome = fakeChrome({ granted: ['https://bradfrost.com/*', 'https://atomicdesign.bradfrost.com/*'] });
  const relay = fakeTransport();
  const hub = createHub({ chrome, createTransport: relay.create });
  await hub.sync({ tabId: 1, url: 'https://bradfrost.com/', room: 'detach', relay: 'https://r.example' });
  await hub.sync({ tabId: 2, url: 'https://atomicdesign.bradfrost.com/', room: 'detach', relay: 'https://r.example' });
  await hub.sync({ tabId: 7, url: 'https://bradfrost.com/blog', room: 'detach', relay: 'https://r.example' });
  assert.equal(relay.made.length, 1); // the second and third tab join the same connection
  assert.deepEqual(hub.session.tabIds, [1, 2, 7]);
  assert.deepEqual(chrome.injected, [1, 2, 7]);
  const pages = [fakePort(1), fakePort(2), fakePort(7)];
  for (const page of pages) await hub.onPortConnect(page);
  relay.made[0].push(set({ '--ed-theme-border-radius-md': '1rem' }, 20));
  for (const page of pages) {
    assert.equal(page.sent.some((m) => m === 'disconnected' || m.kind === 'stop'), false);
    assert.equal(page.sent.at(-1).msg.props['--ed-theme-border-radius-md'], '1rem');
  }
  assert.deepEqual(chrome.local['token-sync:allowlists'], { detach: ['https://atomicdesign.bradfrost.com', 'https://bradfrost.com'] });
});

test('a page that connects while its applier is still being injected is let in', async () => {
  const chrome = fakeChrome();
  const relay = fakeTransport();
  const hub = createHub({ chrome, createTransport: relay.create });
  const port = fakePort(7);
  // In a real browser the content script connects before executeScript resolves.
  chrome.scripting.executeScript = async ({ target }) => {
    chrome.injected.push(target.tabId);
    await hub.onPortConnect(port);
  };
  await hub.sync({ tabId: 7, url: 'https://bradfrost.com/', room: 'detach', relay: 'https://r.example' });
  assert.deepEqual(port.sent[0], { kind: 'config', room: 'detach' });
});

test('syncing a tab twice keeps it once', async () => {
  const relay = fakeTransport();
  const hub = createHub({ chrome: fakeChrome(), createTransport: relay.create });
  await hub.sync({ tabId: 7, url: 'https://bradfrost.com/', room: 'detach', relay: 'https://r.example' });
  await hub.sync({ tabId: 7, url: 'https://bradfrost.com/', room: 'detach', relay: 'https://r.example' });
  assert.deepEqual(hub.session.tabIds, [7]);
  assert.equal(relay.made.length, 1);
});

test('stopping one tab leaves the others in the room; the last one out leaves it', async () => {
  const chrome = fakeChrome({ granted: ['https://bradfrost.com/*', 'https://atomicdesign.bradfrost.com/*'] });
  const relay = fakeTransport();
  const hub = createHub({ chrome, createTransport: relay.create });
  await hub.sync({ tabId: 1, url: 'https://bradfrost.com/', room: 'detach', relay: 'https://r.example' });
  await hub.sync({ tabId: 2, url: 'https://atomicdesign.bradfrost.com/', room: 'detach', relay: 'https://r.example' });
  const one = fakePort(1);
  const two = fakePort(2);
  await hub.onPortConnect(one);
  await hub.onPortConnect(two);
  await hub.onMessage({ type: 'stop', tabId: 1 });
  assert.ok(one.sent.some((m) => m.kind === 'stop'));
  assert.equal(two.sent.some((m) => m.kind === 'stop'), false);
  assert.deepEqual(hub.session.tabIds, [2]);
  assert.equal(relay.made[0].closed, false);
  relay.made[0].push(set({ '--a': '1px' }, 21));
  assert.equal(one.sent.filter((m) => m.kind === 'msg').length, 0);
  assert.equal(two.sent.at(-1).msg.props['--a'], '1px');
  await hub.onTabRemoved(2);
  assert.equal(hub.session, null);
  assert.equal(relay.made[0].closed, true);
});

test('stop with no tab stops every tab', async () => {
  const chrome = fakeChrome({ granted: ['https://bradfrost.com/*', 'https://atomicdesign.bradfrost.com/*'] });
  const hub = createHub({ chrome, createTransport: fakeTransport().create });
  await hub.sync({ tabId: 1, url: 'https://bradfrost.com/', room: 'detach', relay: 'https://r.example' });
  await hub.sync({ tabId: 2, url: 'https://atomicdesign.bradfrost.com/', room: 'detach', relay: 'https://r.example' });
  const one = fakePort(1);
  const two = fakePort(2);
  await hub.onPortConnect(one);
  await hub.onPortConnect(two);
  await hub.onMessage({ type: 'stop' });
  assert.ok(one.sent.some((m) => m.kind === 'stop'));
  assert.ok(two.sent.some((m) => m.kind === 'stop'));
  assert.equal(hub.session, null);
});

test('choosing a different room moves the preview: the old room\'s tabs stop', async () => {
  const chrome = fakeChrome({ granted: ['https://bradfrost.com/*', 'https://atomicdesign.bradfrost.com/*'] });
  const relay = fakeTransport();
  const hub = createHub({ chrome, createTransport: relay.create });
  await hub.sync({ tabId: 1, url: 'https://bradfrost.com/', room: 'detach', relay: 'https://r.example' });
  const first = fakePort(1);
  await hub.onPortConnect(first);
  await hub.sync({ tabId: 2, url: 'https://atomicdesign.bradfrost.com/', room: 'studio', relay: 'https://r.example' });
  assert.ok(first.sent.some((m) => m.kind === 'stop'));
  assert.equal(relay.made[0].closed, true);
  assert.equal(hub.session.room, 'studio');
  assert.deepEqual(hub.session.tabIds, [2]);
});

test('a tab the browser refuses is left out, and the tabs already in the room carry on', async () => {
  const chrome = fakeChrome();
  const relay = fakeTransport();
  const hub = createHub({ chrome, createTransport: relay.create });
  await hub.sync({ tabId: 7, url: 'https://bradfrost.com/', room: 'detach', relay: 'https://r.example' });
  await assert.rejects(hub.sync({ tabId: 666, url: 'https://bradfrost.com/', room: 'detach', relay: 'https://r.example' }), /won't let extensions run/);
  assert.deepEqual(hub.session.tabIds, [7]);
  assert.equal(relay.made[0].closed, false);
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

test('if the browser refuses to run on the page, nothing is left half-started', async () => {
  const chrome = fakeChrome();
  const relay = fakeTransport();
  const hub = createHub({ chrome, createTransport: relay.create });
  await assert.rejects(hub.sync({ tabId: 666, url: 'https://bradfrost.com/', room: 'detach', relay: 'https://r.example' }), /won't let extensions run/);
  assert.equal(hub.session, null);
  assert.equal(relay.made[0].closed, true);
  assert.equal(chrome.local['token-sync:allowlists'], undefined);
});

test('a sync waiting on the permission prompt finishes when the permission arrives, popup or no popup', async () => {
  const chrome = fakeChrome({ granted: [] });
  const hub = createHub({ chrome, createTransport: fakeTransport().create });
  const reply = await hub.onMessage({ type: 'sync', tabId: 7, url: 'https://bradfrost.com/blog', room: 'detach', relay: 'https://r.example' });
  assert.deepEqual(reply, { pending: true });
  assert.equal(hub.session, null);
  chrome.grant('https://bradfrost.com/*');
  await hub.onPermissionsAdded({ origins: ['https://bradfrost.com/*'] });
  assert.equal(hub.session.room, 'detach');
  assert.deepEqual(chrome.injected, [7]);
});

test('forgetting a site keeps its permission while another room still lists it', async () => {
  const chrome = fakeChrome();
  const hub = createHub({ chrome, createTransport: fakeTransport().create });
  await hub.sync({ tabId: 7, url: 'https://bradfrost.com/blog', room: 'detach', relay: 'https://r.example' });
  await hub.sync({ tabId: 7, url: 'https://bradfrost.com/blog', room: 'studio', relay: 'https://r.example' });
  await hub.onMessage({ type: 'forget-site', room: 'detach', site: 'https://bradfrost.com' });
  assert.equal(await chrome.permissions.contains({ origins: ['https://bradfrost.com/*'] }), true);
  assert.equal(hub.session.room, 'studio'); // a different room's preview carries on
});

test('forgetting the site being previewed stops the preview', async () => {
  const hub = createHub({ chrome: fakeChrome(), createTransport: fakeTransport().create });
  await hub.sync({ tabId: 7, url: 'https://bradfrost.com/blog', room: 'detach', relay: 'https://r.example' });
  await hub.onMessage({ type: 'forget-site', room: 'detach', site: 'https://bradfrost.com' });
  assert.equal(hub.session, null);
});

test('forgetting a site stops only the tabs on that site', async () => {
  const chrome = fakeChrome({ granted: ['https://bradfrost.com/*', 'https://atomicdesign.bradfrost.com/*'] });
  const hub = createHub({ chrome, createTransport: fakeTransport().create });
  await hub.sync({ tabId: 1, url: 'https://bradfrost.com/', room: 'detach', relay: 'https://r.example' });
  await hub.sync({ tabId: 2, url: 'https://atomicdesign.bradfrost.com/', room: 'detach', relay: 'https://r.example' });
  await hub.onMessage({ type: 'forget-site', room: 'detach', site: 'https://bradfrost.com' });
  assert.deepEqual(hub.session.tabIds, [2]);
});

test('content scripts cannot make popup requests', async () => {
  const hub = createHub({ chrome: fakeChrome(), createTransport: fakeTransport().create });
  await assert.rejects(hub.onMessage({ type: 'stop' }, { tab: { id: 7 }, url: 'https://bradfrost.com/' }), /come from the popup/);
  // The popup page opened in a tab is still the popup.
  assert.deepEqual(await hub.onMessage({ type: 'stop' }, { tab: { id: 9 }, url: 'chrome-extension://abc/popup.html' }), { ok: true });
  // So is the controls window.
  assert.ok((await hub.onMessage({ type: 'status' }, { tab: { id: 10 }, url: 'chrome-extension://abc/controls.html?room=detach' })).lists);
});

test('a restarted background brings the room back to every synced tab', async () => {
  const chrome = fakeChrome({ granted: ['https://bradfrost.com/*', 'https://atomicdesign.bradfrost.com/*'] });
  const first = createHub({ chrome, createTransport: fakeTransport().create });
  await first.sync({ tabId: 7, url: 'https://bradfrost.com/blog', room: 'detach', relay: 'https://r.example' });
  await first.sync({ tabId: 2, url: 'https://atomicdesign.bradfrost.com/', room: 'detach', relay: 'https://r.example' });
  chrome.injected.length = 0;
  const relay = fakeTransport();
  const revived = createHub({ chrome, createTransport: relay.create });
  await revived.restore();
  assert.deepEqual(chrome.injected, [7, 2]);
  assert.equal(relay.made.length, 1);
});

test('a session saved by the one-tab version is picked up as a room of one', async () => {
  const chrome = fakeChrome();
  await chrome.storage.session.set({ 'token-sync:session': { tabId: 7, room: 'detach', relay: 'https://r.example' } });
  await chrome.storage.local.set({ 'token-sync:allowlists': { detach: ['https://bradfrost.com'] } });
  const hub = createHub({ chrome, createTransport: fakeTransport().create });
  await hub.restore();
  assert.deepEqual(hub.session, { room: 'detach', relay: 'https://r.example', tabIds: [7] });
  assert.deepEqual(chrome.injected, [7]);
});
