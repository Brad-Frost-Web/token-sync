// The relay's room: the one place the rules are enforced for real.
//
// Both relays — the Cloudflare Durable Object and the Node reference server —
// wrap this same core, so self-hosting changes nothing about the guarantees.
// It sends nothing itself: every call returns the frames to send and who gets
// them, and the host does the I/O. That keeps it testable without a socket.
//
// What the relay owns that a browser tab can't:
//
// - `ts`. Every message is stamped here; whatever a client sent is discarded.
// - Presenter powers. Only a connection that said hello with the room's
//   presenter key may reset, lock or unlock, or claim `from: 'presenter'`.
// - The lock. While locked, every non-presenter write is refused, whatever
//   role it claims to be.
// - Pace. Each connection may send at most `maxMessagesPerSecond`.
//
// Frames on the socket (JSON):
//   client → relay  { kind: 'hello', key? }  then  { kind: 'msg', msg }
//   relay → client  { kind: 'welcome', presenter }  { kind: 'msg', msg }  { kind: 'error', error }
//
// Catching up: after welcome, and whenever a client sends an empty snapshot
// (Eddie's request), the relay replies to that client alone with the room's
// writes, replayed as sets at the times they were made, then the lock state.
// A snapshot with props is refused: the relay holds the state, so nobody
// needs to answer for it.

import { createClock } from '../../client/src/transports.js';
import { createRoomState, isSnapshotRequest, validateMessage } from '../../protocol/src/index.js';

/** Longest frame accepted, in UTF-16 code units (what `string.length` counts). */
export const MAX_FRAME_LENGTH = 16 * 1024;
/** Most distinct custom properties one room may hold, so a room's state (and its stored snapshot) stays bounded. */
export const MAX_ROOM_KEYS = 2000;

/**
 * @typedef {{ presenter: boolean, ready: boolean, tokens: number, refilled: number, warned?: boolean }} Client
 * @typedef {{ to: 'sender' | 'all', frame: object }} Outbound
 */

/**
 * @param {{
 *   room: string,
 *   presenterKey: string,
 *   now?: () => number,
 *   maxMessagesPerSecond?: number,
 *   restore?: object[],
 * }} options `restore`: snapshot messages saved earlier (see `snapshot()`),
 *   for a host that was evicted and woke up again.
 */
export function createRelayRoom({ room, presenterKey, now = () => Date.now(), maxMessagesPerSecond = 20, restore = [] }) {
  const clock = createClock(now);
  const state = createRoomState();
  for (const msg of restore) {
    clock.observe(msg.ts);
    state.apply(msg);
  }

  /** A fresh connection. Hosts keep one of these per socket. */
  function connect() {
    return /** @type {Client} */ ({ presenter: false, ready: false, tokens: maxMessagesPerSecond, refilled: now() });
  }

  /** The room so far, for one client: real writes as sets, so they win over stale values by their times. */
  const catchUp = () => state.snapshotMessages(room, { asSets: true }).map((msg) => ({ to: 'sender', frame: { kind: 'msg', msg } }));

  const error = (message) => [{ to: 'sender', frame: { kind: 'error', error: message } }];

  /** Token bucket: refill at the allowed rate, spend one per message. */
  function allow(client) {
    const t = now();
    client.tokens = Math.min(maxMessagesPerSecond, client.tokens + ((t - client.refilled) / 1000) * maxMessagesPerSecond);
    client.refilled = t;
    if (client.tokens < 1) return false;
    client.tokens -= 1;

    return true;
  }

  /**
   * Handle one frame from a connection.
   * @param {Client} client
   * @param {string} raw
   * @returns {Outbound[]}
   */
  function receive(client, raw) {
    // Every frame spends from the bucket, junk included, so even error
    // replies go out at a bounded rate.
    if (!allow(client)) return client.warned ? [] : ((client.warned = true), error(`slow down: at most ${maxMessagesPerSecond} messages a second`));
    client.warned = false;
    if (typeof raw !== 'string') return error('frames must be text');
    if (raw.length > MAX_FRAME_LENGTH) return error(`frames may be at most ${MAX_FRAME_LENGTH} characters`);
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return error('frames must be JSON');
    }

    if (frame?.kind === 'hello') {
      if (client.ready) return error('already said hello');
      client.ready = true;
      client.presenter = typeof frame.key === 'string' && frame.key.length > 0 && frame.key === presenterKey;

      return [{ to: 'sender', frame: { kind: 'welcome', presenter: client.presenter } }, ...catchUp()];
    }
    if (!client.ready) return error('say hello first');
    if (frame?.kind !== 'msg') return error('unknown frame kind');

    const { ts: _clientTs, ...unstamped } = frame.msg ?? {};
    const check = validateMessage(unstamped, { requireTs: false });
    if (!check.ok) return error(check.errors.join('; '));
    if (unstamped.room !== room) return error('wrong room');
    if (isSnapshotRequest(unstamped)) return catchUp();
    if (unstamped.op === 'snapshot') return error('snapshots come from the relay');
    if (unstamped.from === 'presenter' && !client.presenter) return error('only the presenter may speak as presenter');
    if (state.locked && unstamped.op === 'set' && !client.presenter) return error('the room is locked');

    if (unstamped.op === 'set') {
      const current = state.props();
      const added = Object.keys(unstamped.props).filter((key) => !(key in current)).length;
      if (state.size() + added > MAX_ROOM_KEYS) return error(`a room may hold at most ${MAX_ROOM_KEYS} properties`);
    }

    const msg = { ...unstamped, ts: clock.stamp() };
    // The room state also refuses a controller's set while locked; the check
    // above covers sources and anyone else claiming a role they can't prove.
    const outcome = state.apply(msg);
    if (!outcome.applied) return error(outcome.reason ?? 'not applied');

    return [{ to: 'all', frame: { kind: 'msg', msg } }];
  }

  return {
    room,
    connect,
    receive,
    /** Messages a host can store, and pass back as `restore` after a restart. */
    snapshot: () => state.snapshotMessages(room, { asSets: true }),
    get locked() {
      return state.locked;
    },
  };
}

/** A short, unambiguous room code: no 0/O, 1/l/I. */
export function generateRoomCode(random = () => crypto.getRandomValues(new Uint8Array(6))) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';

  return [...random()].map((byte) => alphabet[byte % alphabet.length]).join('');
}

/** A presenter key: 128 random bits, URL-safe. */
export function generatePresenterKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));

  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
