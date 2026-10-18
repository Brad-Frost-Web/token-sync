// The drop-in's core: everything but the autostart and the Eddie adapter.
// The bookmarklet bundles this alone, to keep its URL short; token-sync.js
// adds the adapter and starts it.
//
// The ?token-sync=<room> drop-in.
//
//   <script type="module" src=".../token-sync.js"></script>
//
// Does nothing on an ordinary page view. Visit the page with
// ?token-sync=<room> and it joins that room and applies the room's tokens to
// this tab — and keeps doing so for the rest of the tab's session, so you can
// click around the site. ?token-sync=off leaves.
//
// While it's on, holding \ shows the page as it was before the room touched
// it, with a sweep each way.
//
// Preview only: it changes this tab's custom properties and nothing else.
// Real visitors never carry the parameter, so they never see a change.

import { connect, createApplier, createFontLoader, createRemoteTransport, createWipe, holdToCompare } from '../../client/src/index.js';
import { isRoom } from '../../protocol/src/index.js';

export const PARAM = 'token-sync';
export const STORAGE_KEY = 'token-sync:room';
/** `<meta name="token-sync-wipe" content="changes">` sweeps every change in, not only the compare toggle. */
export const WIPE_META = 'token-sync-wipe';
/** `<meta name="token-sync-relay" content="https://relay.example">` points the page at a relay. */
export const RELAY_META = 'token-sync-relay';

/**
 * The socket URL for a room on a relay, or null when `base` isn't an
 * http(s)/ws(s) URL. The relay comes from the page's own markup, never from
 * the address bar: a crafted link must not be able to point a visitor's tab
 * at someone else's relay.
 * @param {string | null | undefined} base
 * @param {string} room
 */
export function relaySocketUrl(base, room) {
  if (!base) return null;
  let url;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  const schemes = { 'http:': 'ws:', 'https:': 'wss:', 'ws:': 'ws:', 'wss:': 'wss:' };
  if (!(url.protocol in schemes)) return null;
  url.protocol = schemes[url.protocol];
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/rooms/${encodeURIComponent(room)}/socket`;
  url.search = '';
  url.hash = '';

  return url.href;
}

/**
 * Which room, if any, this tab should be in. The URL wins; otherwise the room
 * this tab joined earlier in its session.
 * @param {{ search: string, storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }} context
 * @returns {string | null}
 */
export function resolveRoom({ search, storage }) {
  const fromUrl = new URLSearchParams(search).get(PARAM);
  try {
    if (fromUrl === 'off') {
      storage?.removeItem(STORAGE_KEY);

      return null;
    }
    if (fromUrl !== null) {
      if (!isRoom(fromUrl)) return null;
      storage?.setItem(STORAGE_KEY, fromUrl);

      return fromUrl;
    }
    const remembered = storage?.getItem(STORAGE_KEY) ?? null;

    return remembered && isRoom(remembered) ? remembered : null;
  } catch {
    // Storage can throw (privacy modes, sandboxed frames). Fall back to the URL alone.
    return fromUrl && fromUrl !== 'off' && isRoom(fromUrl) ? fromUrl : null;
  }
}

/**
 * Join the room named by the URL or the session — or `room`, when a caller
 * such as the bookmarklet names one — and apply it to this page. A tab is in
 * one room at a time: starting again leaves the previous room first.
 * The page talks to a relay when it declares one with
 * `<meta name="token-sync-relay" content="…">`, and over BroadcastChannel
 * (this browser only) when it doesn't. A caller acting on the person's own
 * input (the bookmarklet's prompt) may name the relay instead, as `relay`;
 * it never comes from the URL, so a crafted link can't choose it.
 * @param {{ room?: string, relay?: string, location?: Location, storage?: Storage, document?: Document, transport?: 'broadcast' | 'local' | object, createAdapter?: Function, onResolved?: Function }} [context]
 *   `createAdapter({ readComputed, document })` returns a design system's
 *   adapter for this page (or null); `onResolved(status)` hears its status.
 */
export function start({
  room: requested,
  relay: named,
  location = globalThis.location,
  storage = safeSessionStorage(),
  document = globalThis.document,
  transport,
  createAdapter = null,
  onResolved = () => {},
} = {}) {
  if (requested !== undefined && requested !== 'off' && !isRoom(requested)) {
    // Refuse before touching anything: a typo must not silently drop the room
    // this tab is in (and leave sessionStorage pointing back at it).
    console.warn(`token-sync: "${requested}" is not a room code (letters, digits and hyphens). Nothing changed.`);

    return globalThis.tokenSync ?? null;
  }
  const search = requested === undefined ? (location?.search ?? '') : `?${PARAM}=${encodeURIComponent(requested)}`;
  const room = resolveRoom({ search, storage });
  globalThis.tokenSync?.close?.();
  globalThis.tokenSync = null;
  if (!room || !document) {
    if (document?.documentElement) delete document.documentElement.dataset.tokenSync;

    return null;
  }

  // The newest message folded in. A `set` is a live change, so its age when it
  // lands is the delivery time; a `snapshot` is a late joiner catching up, and
  // its age is just how long ago that write happened.
  let newest = { ts: 0, op: 'set' };
  const emit = (type, detail) => document.dispatchEvent(new CustomEvent(type, { detail: { room, ...detail } }));
  // The sweep plays when the compare key is pressed and let go. A page that
  // wants every live change to sweep in says so:
  // <meta name="token-sync-wipe" content="changes">. Never under reduced motion.
  const wipe = createWipe({ document });
  const sweepChanges = document.querySelector?.(`meta[name="${WIPE_META}"]`)?.content === 'changes';
  // A design system's adapter, when the caller has one for this page (the
  // drop-in passes Eddie's on Eddie pages); otherwise tokens apply as sent.
  const readComputed = (name) => globalThis.getComputedStyle?.(document.documentElement)?.getPropertyValue(name) ?? '';
  const adapter = createAdapter?.({ readComputed, document }) ?? null;
  const fonts = createFontLoader({ document });
  const applier = createApplier({
    root: document.documentElement,
    resolve: adapter?.resolve ?? null,
    onResolved,
    transition: (update, { cause }) => (sweepChanges || cause === 'hold' ? wipe(update) : update()),
    // Read after onChange below has recorded the newest message, whichever
    // order the two arrive in — so a damped change reports its real delay.
    onApply: ({ changed, at, cause }) => {
      // A font-family token now naming a family this page doesn't have: fetch
      // it from Google Fonts, for this preview only (spec §10 Q3). Read back
      // what was written, so a refused value never causes a request.
      for (const name of changed) if (/font-family/.test(name)) fonts.ensure(document.documentElement.style.getPropertyValue(name));
      queueMicrotask(() =>
        emit('token-sync:apply', {
          changed,
          // A compare toggle isn't a delivery, and a snapshot's age isn't one either.
          op: cause === 'hold' ? 'hold' : newest.op,
          latencyMs: cause === 'hold' || newest.op === 'snapshot' ? null : at - newest.ts,
        }),
      );
    },
    onRefuse: ({ name, value, reason }) => console.warn(`token-sync: refused ${name}: ${value} — ${reason}`),
  });
  const declared = named ?? document.querySelector?.(`meta[name="${RELAY_META}"]`)?.content;
  const relay = relaySocketUrl(declared, room);
  if (declared && !relay) console.warn(`token-sync: ignoring <meta name="${RELAY_META}" content="${declared}">: it must be an absolute http(s) or ws(s) URL. Using this browser only.`);
  const channel =
    transport ??
    (relay
      ? createRemoteTransport({ url: relay, onRelayError: (message) => console.warn(`token-sync: the relay said: ${message}`) })
      : 'broadcast');
  const session = connect({
    room,
    transport: channel,
    role: 'controller',
    applier,
    keyFor: adapter?.keyFor ?? null,
    onChange: ({ message }) => {
      if (message.ts >= newest.ts) newest = { ts: message.ts, op: message.op };
    },
    onError: ({ errors }) => console.warn(`token-sync: dropped a message — ${errors.join('; ')}`),
  });
  // Hold \ to see the page before the room's tokens; release for after.
  const stopComparing = holdToCompare(applier, { target: globalThis.window });
  const closeSession = session.close;
  session.close = () => {
    stopComparing();
    closeSession();
    fonts.remove();
  };
  document.documentElement.dataset.tokenSync = room;
  const leave = requested === undefined ? `Add ?${PARAM}=off to the URL to leave.` : 'Run the bookmarklet again and type "off" to leave.';
  console.info(`token-sync: previewing room "${room}" in this tab. Hold \\ to see the page without the room's tokens. ${leave}`);
  globalThis.tokenSync = session;

  return session;
}

function safeSessionStorage() {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}
