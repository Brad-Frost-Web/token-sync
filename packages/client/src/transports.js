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

const defaultHubs = new Map();

/**
 * An in-memory channel. Every transport made from the same hub and room hears
 * every other, including itself.
 * @param {{ room: string, hub?: Map<string, Set<Function>>, clock?: ReturnType<typeof createClock>, getSnapshot?: () => object[] }} options
 */
export function createLocalTransport({ room, hub = defaultHubs, clock = createClock(), getSnapshot } = /** @type {any} */ ({})) {
  if (!hub.has(room)) hub.set(room, new Set());
  const peers = hub.get(room);
  const listeners = new Set();
  const peer = {
    deliver(msg) {
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
export function createBroadcastTransport({ room, clock = createClock(), getSnapshot, BroadcastChannelImpl = globalThis.BroadcastChannel }) {
  if (typeof BroadcastChannelImpl !== 'function') {
    throw new Error('token-sync: BroadcastChannel is not available here; use the local or remote transport');
  }
  const channel = new BroadcastChannelImpl(`token-sync/1:${room}`);
  const listeners = new Set();
  const deliver = (msg) => {
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
