// The extension's background: one room, as many synced tabs as you like.
//
// The background holds one relay connection and a copy of the room's state,
// so a page's Content Security Policy can't block the socket, and every page
// a synced tab navigates to gets the room replayed on arrival. Every synced
// tab hears every change at once: a message from the relay goes to all of
// their ports in the same turn, so three, five or seven sites side by side
// repaint together. Each page only runs the applier (content.js), fed
// through a port.
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
  /** @type {{ room: string, relay: string, tabIds: number[] } | null} */
  let session = null;
  let transport = null;
  let state = createRoomState();
  let status = { state: 'idle', error: null };
  /** Ports from the synced tabs' pages, each with the tab it came from. */
  const ports = new Map();
  const isSynced = (tabId) => Boolean(session?.tabIds.includes(tabId));
  const saveSession = () => chrome.storage.session.set({ [SESSION_KEY]: session });

  const lists = async () => (await chrome.storage.local.get(LISTS_KEY))[LISTS_KEY] ?? {};
  const saveLists = (value) => chrome.storage.local.set({ [LISTS_KEY]: value });

  /** Send a frame to every synced page, or only to one tab's pages. */
  function broadcast(frame, onlyTab) {
    for (const [port, tabId] of ports) {
      if (onlyTab !== undefined && tabId !== onlyTab) continue;
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
    transport.subscribe((incoming) => {
      const check = validateMessage(incoming);
      if (!check.ok || check.message.room !== session?.room) return;
      // Only the props that passed travel on to the tabs.
      const msg = check.message;
      if (state.apply(msg).applied) broadcast({ kind: 'msg', msg });
    });
  }

  async function inject(tabId) {
    await chrome.scripting.executeScript({ target: { tabId }, files: [contentScript] });
  }

  /** Re-apply after navigation or a background restart; a refusal here just means this page can't be previewed. */
  async function reinject(tabId) {
    await inject(tabId).catch(() => {});
  }

  /** Stop every synced tab and leave the room. */
  async function stop() {
    broadcast({ kind: 'stop' });
    ports.clear();
    transport?.close();
    transport = null;
    session = null;
    status = { state: 'idle', error: null };
    await chrome.storage.session.set({ [SESSION_KEY]: null });
  }

  /**
   * Stop one tab; the others carry on. The last tab out leaves the room.
   * `tell: false` when the tab is already gone and there's no page to tell.
   */
  async function stopTab(tabId, { tell = true } = {}) {
    if (!isSynced(tabId)) return;
    if (session.tabIds.length === 1) return stop();
    if (tell) broadcast({ kind: 'stop' }, tabId);
    for (const [port, id] of ports) if (id === tabId) ports.delete(port);
    session = { ...session, tabIds: session.tabIds.filter((id) => id !== tabId) };
    await saveSession();
  }

  /**
   * Add `tab` to the room. The first tab joins the room; every tab after it
   * joins the same one, and all of them update together. Choosing a
   * different room or relay moves the preview there: the tabs in the old
   * room stop first. The popup has already been granted the site's permission.
   */
  async function sync({ tabId, url, room, relay }) {
    const site = siteOf(url);
    if (!site) throw new Error("this page can't be previewed (only http and https pages can)");
    if (!isRoom(room)) throw new Error('room codes are letters, digits and hyphens');
    socketUrl(relay, room); // throws on a bad relay before anything changes
    if (!(await chrome.permissions.contains({ origins: [permissionFor(site)] }))) throw new Error(`no permission for ${site}`);
    if (session && (session.room !== room || session.relay !== relay)) await stop();
    const fresh = !session;
    if (fresh) {
      session = { room, relay, tabIds: [] };
      connectRelay();
    }
    // In the room before the applier runs: its page connects straight away,
    // and a port from a tab that isn't synced is turned away.
    const added = !session.tabIds.includes(tabId);
    if (added) session = { ...session, tabIds: [...session.tabIds, tabId] };
    try {
      await inject(tabId);
    } catch (error) {
      // The browser refused (a store page, an error page, a PDF): leave no
      // half-started session or allowed site behind. Tabs already in the
      // room carry on.
      if (fresh) await stop();
      else if (added) await stopTab(tabId, { tell: false });
      throw new Error(`the browser won't let extensions run on this page (${error.message})`);
    }
    await saveSession();
    await saveLists(allow(await lists(), room, site));
  }

  /** A sync waiting on the permission prompt; finished by onPermissionsAdded even if the popup closed. */
  let pending = null;

  async function requestSync(request) {
    const site = siteOf(request.url);
    if (site && (await chrome.permissions.contains({ origins: [permissionFor(site)] }))) return sync(request);
    pending = { ...request, site };

    return { pending: true };
  }

  async function onPermissionsAdded({ origins = [] }) {
    if (pending && origins.includes(permissionFor(pending.site))) {
      const request = pending;
      pending = null;
      await sync(request).catch((error) => (status = { ...status, error: error.message }));
    }
  }

  async function onPortConnect(port) {
    if (port.name !== PORT_NAME) return;
    const tabId = port.sender?.tab?.id;
    if (!isSynced(tabId)) {
      port.postMessage({ kind: 'stop' });
      port.disconnect();

      return;
    }
    ports.set(port, tabId);
    port.onDisconnect.addListener(() => ports.delete(port));
    // Heartbeats from the page are what keep this background alive; nothing to do with them.
    port.onMessage?.addListener?.(() => {});
    port.postMessage({ kind: 'config', room: session.room });
    // As sets at their real times: a tab coming back holds stale values, and a
    // snapshot would only fill in what it has never heard of.
    for (const msg of state.snapshotMessages(session.room, { asSets: true })) port.postMessage({ kind: 'msg', msg });
  }

  /** A synced tab finished loading a page: bring the room back, if the site is allowed. */
  async function onTabUpdated(tabId, info, tab) {
    if (!isSynced(tabId) || info.status !== 'complete') return;
    const site = siteOf(tab?.url ?? '');
    if (!site || !isAllowed(await lists(), session.room, tab.url)) return;
    if (!(await chrome.permissions.contains({ origins: [permissionFor(site)] }))) return;
    await reinject(tabId);
  }

  async function onTabRemoved(tabId) {
    await stopTab(tabId, { tell: false });
  }

  /**
   * After the browser restarted the background, pick the session back up and
   * bring the room back to every synced tab (their pages reverted when the
   * old background went away, unless they reconnected by themselves).
   */
  async function restore() {
    const saved = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY];
    if (saved && !session) {
      // A session saved by the one-tab version carries `tabId`, not `tabIds`.
      const tabIds = Array.isArray(saved.tabIds) ? saved.tabIds : Number.isInteger(saved.tabId) ? [saved.tabId] : [];
      if (!tabIds.length) return;
      session = { room: saved.room, relay: saved.relay, tabIds };
      connectRelay();
      for (const tabId of tabIds) {
        const tab = await chrome.tabs?.get?.(tabId).catch(() => null);
        if (tab?.url && isAllowed(await lists(), session.room, tab.url) && (await chrome.permissions.contains({ origins: [permissionFor(siteOf(tab.url))] }))) {
          await reinject(tabId);
        }
      }
    }
  }

  /**
   * Requests from the popup. Only the extension's own popup page may make
   * them, not a content script running in some page (opened as a tab, the
   * popup also has a tab, so the page URL is what tells them apart).
   */
  async function onMessage(request, sender = {}) {
    const popup = chrome.runtime?.getURL?.('popup.html');
    if (sender.tab && !(popup && sender.url?.startsWith(popup))) throw new Error('requests come from the popup');
    switch (request?.type) {
      case 'status':
        return { session, status, lists: await lists() };
      case 'sync':
        return (await requestSync(request)) ?? { ok: true };
      case 'stop':
        // With a tab, stop that tab; without one, stop them all.
        if (Number.isInteger(request.tabId)) await stopTab(request.tabId);
        else await stop();

        return { ok: true };
      case 'forget-site': {
        const next = disallow(await lists(), request.room, request.site);
        await saveLists(next);
        // The browser's permission is per site, not per room: give it back
        // only when no other room still lists the site.
        if (!Object.values(next).some((sites) => sites.includes(request.site))) {
          await chrome.permissions.remove({ origins: [permissionFor(request.site)] }).catch(() => {});
        }
        // Forgetting a site stops the preview in every tab that's on it.
        if (session?.room === request.room) {
          for (const tabId of [...session.tabIds]) {
            const tab = await chrome.tabs?.get?.(tabId).catch(() => null);
            if (tab?.url && siteOf(tab.url) === request.site) await stopTab(tabId);
          }
        }

        return { ok: true };
      }
      default:
        throw new Error(`unknown request ${request?.type}`);
    }
  }

  return {
    sync,
    stop,
    stopTab,
    restore,
    onMessage,
    onPortConnect,
    onTabUpdated,
    onTabRemoved,
    onPermissionsAdded,
    get session() {
      return session;
    },
  };
}
