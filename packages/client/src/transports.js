// Transports move token-sync/1 messages between pages. They share one seam
// with Eddie's customizer (FEATURE-SPEC §8):
//
//   { publish(msg), subscribe(fn) → unsubscribe, close() }
//
// A transport also stands in for the relay's two jobs when there is no relay:
// it stamps `ts` (the channel's clock, never the sender's), and it answers a
// late joiner with a snapshot (stamped with when each write happened).
//
// - local:     one page, in memory. Tests, and a source and applier that share a page.
// - broadcast: every same-origin tab and frame on this machine, via BroadcastChannel.
//              No network: the mode that survives the venue wifi (Q19).
// The remote (WebSocket) transport arrives with the relay.

/**
 * A clock that never runs backwards and never stamps a write before one it
 * has already seen — so a peer's next write is always ordered after
 * everything that peer was looking at when it made it.
 * @param {() => number} [now]
 */
export function createClock(now = () => Date.now()) {
  let last = 0;

  return {
    stamp() {
      last = Math.max(now(), last + 1);

      return last;
    },
    observe(ts) {
      if (typeof ts === 'number' && ts > last) last = ts;
    },
  };
}

/**
 * How far ahead of this machine's clock a stamp on a same-machine channel may
 * be. Every peer on `local` or `broadcast` shares one clock, so a stamp well
 * in the future is forged or broken — and adopting it would push every later
 * write behind it (a reset stamped at Number.MAX_VALUE would refuse every
 * write after it, in every tab, until they all reloaded).
 */
export const MAX_FUTURE_MS = 5000;

/** @param {{ ts?: unknown }} msg @param {() => number} now */
function fromTheFuture(msg, now) {
  return typeof msg?.ts === 'number' && msg.ts > now() + MAX_FUTURE_MS;
}

const defaultHubs = new Map();

/**
 * An in-memory channel. Every transport made from the same hub and room hears
 * every other, including itself.
 * @param {{ room: string, hub?: Map<string, Set<Function>>, clock?: ReturnType<typeof createClock>, getSnapshot?: () => object[] }} options
 */
export function createLocalTransport({ room, hub = defaultHubs, clock = createClock(), getSnapshot, now = () => Date.now() } = /** @type {any} */ ({})) {
  if (!hub.has(room)) hub.set(room, new Set());
  const peers = hub.get(room);
  const listeners = new Set();
  const peer = {
    deliver(msg) {
      if (fromTheFuture(msg, now)) return;
      clock.observe(msg.ts);
      for (const fn of listeners) fn(msg);
    },
  };
  peers.add(peer);

  // A joiner on a local hub is brought up to date by any peer already there.
  queueMicrotask(() => {
    for (const other of peers) {
      if (other === peer || !other.snapshot) continue;
      // Snapshot messages keep the times their writes really happened.
      for (const msg of other.snapshot()) peer.deliver(msg);
      break;
    }
  });
  if (getSnapshot) peer.snapshot = getSnapshot;

  return {
    publish(msg) {
      const stamped = { ...msg, ts: clock.stamp() };
      for (const other of peers) other.deliver(stamped);

      return stamped;
    },
    subscribe(fn) {
      listeners.add(fn);

      return () => listeners.delete(fn);
    },
    close() {
      listeners.clear();
      peers.delete(peer);
    },
  };
}

/**
 * Same-origin tabs and frames on one machine. BroadcastChannel never echoes
 * to the sender, so the transport delivers its own messages to itself — every
 * peer, the sender included, folds the same stamped message into its state.
 *
 * @param {{ room: string, clock?: ReturnType<typeof createClock>, getSnapshot?: () => object[], BroadcastChannelImpl?: typeof BroadcastChannel }} options
 */
export function createBroadcastTransport({ room, clock = createClock(), getSnapshot, BroadcastChannelImpl = globalThis.BroadcastChannel, now = () => Date.now() }) {
  if (typeof BroadcastChannelImpl !== 'function') {
    throw new Error('token-sync: BroadcastChannel is not available here; use the local or remote transport');
  }
  const channel = new BroadcastChannelImpl(`token-sync/1:${room}`);
  const listeners = new Set();
  const deliver = (msg) => {
    if (fromTheFuture(msg, now)) return;
    clock.observe(msg.ts);
    for (const fn of listeners) fn(msg);
  };

  channel.onmessage = (event) => {
    const frame = event.data;
    if (!frame || typeof frame !== 'object') return;
    if (frame.kind === 'msg') deliver(frame.msg);
    if (frame.kind === 'hello' && getSnapshot) {
      // Snapshot messages keep the times their writes really happened —
      // restamping them "now" would let old state beat a newer write.
      for (const msg of getSnapshot()) channel.postMessage({ kind: 'msg', msg });
    }
  };
  // Ask whoever is already in the room for the state.
  channel.postMessage({ kind: 'hello' });

  return {
    publish(msg) {
      const stamped = { ...msg, ts: clock.stamp() };
      channel.postMessage({ kind: 'msg', msg: stamped });
      deliver(stamped);

      return stamped;
    },
    subscribe(fn) {
      listeners.add(fn);

      return () => listeners.delete(fn);
    },
    close() {
      listeners.clear();
      channel.close();
    },
  };
}

/**
 * A room on a relay, over WebSocket. The relay does what a local channel does
 * for itself — stamps `ts`, answers joiners with snapshots — and also holds
 * the presenter key and the lock, so this transport stamps nothing and
 * enforces nothing: it carries frames.
 *
 * Sends made before the relay says welcome are queued, and the socket
 * reconnects with backoff (rejoining picks the state back up from the
 * relay's snapshot).
 *
 * @param {{
 *   url: string,
 *   presenterKey?: string,
 *   WebSocketImpl?: typeof WebSocket,
 *   onStatus?: (status: { state: 'connecting' | 'open' | 'closed', presenter: boolean }) => void,
 *   onRelayError?: (message: string) => void,
 *   maxQueue?: number,
 * }} options `url` is the room's socket, e.g. wss://relay.example/rooms/detach/socket
 */
export function createRemoteTransport({ url, presenterKey, WebSocketImpl = globalThis.WebSocket, onStatus = () => {}, onRelayError = () => {}, maxQueue = 100 }) {
  if (typeof WebSocketImpl !== 'function') throw new Error('token-sync: WebSocket is not available here');
  const listeners = new Set();
  let queue = [];
  let socket = null;
  let welcomed = false;
  let presenter = false;
  let closedByUs = false;
  let retry = 0;
  let timer = null;

  const status = (state) => onStatus({ state, presenter });

  function open() {
    welcomed = false;
    status('connecting');
    socket = new WebSocketImpl(url);
    socket.addEventListener('open', () => {
      retry = 0;
      socket.send(JSON.stringify(presenterKey ? { kind: 'hello', key: presenterKey } : { kind: 'hello' }));
    });
    socket.addEventListener('message', (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (frame?.kind === 'welcome') {
        welcomed = true;
        presenter = frame.presenter === true;
        status('open');
        const pending = queue;
        queue = [];
        for (const msg of pending) socket.send(JSON.stringify({ kind: 'msg', msg }));
      } else if (frame?.kind === 'msg') {
        for (const fn of listeners) fn(frame.msg);
      } else if (frame?.kind === 'error') {
        onRelayError(String(frame.error));
      }
    });
    socket.addEventListener('close', () => {
      welcomed = false;
      status('closed');
      if (closedByUs) return;
      // 0.5 s, 1 s, 2 s … capped at 10 s.
      const delay = Math.min(10000, 500 * 2 ** retry);
      retry += 1;
      timer = setTimeout(open, delay);
    });
  }
  open();

  return {
    publish(msg) {
      if (welcomed) socket.send(JSON.stringify({ kind: 'msg', msg }));
      else {
        queue.push(msg);
        if (queue.length > maxQueue) queue.shift();
      }

      return msg;
    },
    subscribe(fn) {
      listeners.add(fn);

      return () => listeners.delete(fn);
    },
    close() {
      closedByUs = true;
      clearTimeout(timer);
      listeners.clear();
      socket?.close();
    },
    /** Whether the relay accepted this connection's presenter key. */
    get isPresenter() {
      return presenter;
    },
  };
}
