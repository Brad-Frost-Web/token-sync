// The extension's background: one synced tab, one room.
//
// The background holds the relay connection and a copy of the room's state,
// so a page's Content Security Policy can't block the socket, and every page
// the synced tab navigates to gets the room replayed on arrival. The page
// itself only runs the applier (content.js), fed through a port.
//
// Written against an injected `chrome` (and transport factory) so it can be
// tested without a browser.

import { createRoomState, isRoom, validateMessage } from '../../protocol/src/index.js';
import { createRemoteTransport } from '../../client/src/transports.js';
import { allow, disallow, isAllowed, permissionFor, siteOf } from './allowlist.js';
import { PORT_NAME } from './constants.js';

export { PORT_NAME } from './constants.js';
const SESSION_KEY = 'token-sync:session';
const LISTS_KEY = 'token-sync:allowlists';

/** The room socket on a relay, from the relay's base URL. */
export function socketUrl(relay, room) {
  const url = new URL(relay);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('the relay must be an http(s) URL');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/rooms/${encodeURIComponent(room)}/socket`;
  url.search = '';
  url.hash = '';

  return url.href;
}

/**
 * @param {{
 *   chrome: any,
 *   createTransport?: (options: { url: string, onStatus: Function, onRelayError: Function }) => { subscribe(fn: Function): Function, close(): void },
 *   contentScript?: string,
 * }} options
 */
export function createHub({ chrome, createTransport = createRemoteTransport, contentScript = 'content.js' }) {
  /** @type {{ tabId: number, room: string, relay: string } | null} */
  let session = null;
  let transport = null;
  let state = createRoomState();
  let status = { state: 'idle', error: null };
  /** Ports from the synced tab's pages. */
  const ports = new Set();

  const lists = async () => (await chrome.storage.local.get(LISTS_KEY))[LISTS_KEY] ?? {};
  const saveLists = (value) => chrome.storage.local.set({ [LISTS_KEY]: value });

  function broadcast(frame) {
    for (const port of ports) {
      try {
        port.postMessage(frame);
      } catch {
        ports.delete(port);
      }
    }
  }

  function connectRelay() {
    transport?.close();
    state = createRoomState();
    status = { state: 'connecting', error: null };
    transport = createTransport({
      url: socketUrl(session.relay, session.room),
      onStatus: ({ state: s }) => (status = { ...status, state: s }),
      onRelayError: (error) => (status = { ...status, error }),
    });
    transport.subscribe((msg) => {
      if (!validateMessage(msg).ok || msg.room !== session?.room) return;
      if (state.apply(msg).applied) broadcast({ kind: 'msg', msg });
    });
  }

  async function inject(tabId) {
    await chrome.scripting.executeScript({ target: { tabId }, files: [contentScript] });
  }

  async function stop() {
    broadcast({ kind: 'stop' });
    ports.clear();
    transport?.close();
    transport = null;
    session = null;
    status = { state: 'idle', error: null };
    await chrome.storage.session.set({ [SESSION_KEY]: null });
  }

  /** Start previewing `room` in `tab`. The popup has already been granted the site's permission. */
  async function sync({ tabId, url, room, relay }) {
    const site = siteOf(url);
    if (!site) throw new Error("this page can't be previewed (only http and https pages can)");
    if (!isRoom(room)) throw new Error('room codes are letters, digits and hyphens');
    socketUrl(relay, room); // throws on a bad relay before anything changes
    if (!(await chrome.permissions.contains({ origins: [permissionFor(site)] }))) throw new Error(`no permission for ${site}`);
    if (session) await stop(); // one tab at a time
    session = { tabId, room, relay };
    await chrome.storage.session.set({ [SESSION_KEY]: session });
    await saveLists(allow(await lists(), room, site));
    connectRelay();
    await inject(tabId);
  }

  async function onPortConnect(port) {
    if (port.name !== PORT_NAME) return;
    if (!session || port.sender?.tab?.id !== session.tabId) {
      port.postMessage({ kind: 'stop' });
      port.disconnect();

      return;
    }
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));
    port.postMessage({ kind: 'config', room: session.room });
    for (const msg of state.snapshotMessages(session.room)) port.postMessage({ kind: 'msg', msg });
  }

  /** The synced tab finished loading a page: bring the room back, if the site is allowed. */
  async function onTabUpdated(tabId, info, tab) {
    if (!session || tabId !== session.tabId || info.status !== 'complete') return;
    const site = siteOf(tab?.url ?? '');
    if (!site || !isAllowed(await lists(), session.room, tab.url)) return;
    if (!(await chrome.permissions.contains({ origins: [permissionFor(site)] }))) return;
    await inject(tabId);
  }

  async function onTabRemoved(tabId) {
    if (session && tabId === session.tabId) await stop();
  }

  /** After the browser restarted the background, pick the session back up. */
  async function restore() {
    const saved = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY];
    if (saved && !session) {
      session = saved;
      connectRelay();
    }
  }

  /** Requests from the popup. */
  async function onMessage(request) {
    switch (request?.type) {
      case 'status':
        return { session, status, lists: await lists() };
      case 'sync':
        await sync(request);

        return { ok: true };
      case 'stop':
        await stop();

        return { ok: true };
      case 'forget-site': {
        await saveLists(disallow(await lists(), request.room, request.site));
        await chrome.permissions.remove({ origins: [permissionFor(request.site)] }).catch(() => {});

        return { ok: true };
      }
      default:
        throw new Error(`unknown request ${request?.type}`);
    }
  }

  return { sync, stop, restore, onMessage, onPortConnect, onTabUpdated, onTabRemoved, get session() {
    return session;
  } };
}
