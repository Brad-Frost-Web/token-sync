// Per-key last-write-wins room state (FEATURE-SPEC §8, grilling Q17).
//
// Each key remembers the timestamp of the write that set it. A write wins if
// its `ts` is newer than the key's and newer than the last reset. `ts` comes
// from the relay or the local channel, so the ordering is the channel's, not
// any client's clock.
//
// Ties: two writes stamped with the same `ts` by different senders would leave
// two peers disagreeing about which landed last. The larger value (string
// order) wins a tie, which is arbitrary but identical on every peer — so every
// peer that saw the same messages converges on the same state, in any order.

import { createMessage } from './message.js';

/**
 * @typedef {{ value: string, ts: number }} Entry
 * @typedef {{ applied: boolean, reason?: string, changed: string[] }} ApplyResult
 */

export function createRoomState() {
  /** @type {Map<string, Entry>} */
  const entries = new Map();
  let resetTs = -Infinity;
  let lock = { locked: false, ts: -Infinity };

  /** Last-write-wins merge of `props` written at `ts`. Returns the keys whose value changed. */
  function merge(props, ts) {
    const changed = [];
    for (const [key, value] of Object.entries(props)) {
      const current = entries.get(key);
      if (!current || ts > current.ts || (ts === current.ts && value > current.value)) {
        if (!current || current.value !== value) changed.push(key);
        entries.set(key, { value, ts });
      }
    }

    return changed;
  }

  /**
   * Fold one validated, stamped message into the state.
   * @param {{ op: string, from: string, props?: Record<string, string>, ts: number }} msg
   * @returns {ApplyResult}
   */
  function apply(msg) {
    const { op, ts } = msg;

    if (op === 'set') {
      if (lock.locked && msg.from === 'controller') {
        return { applied: false, reason: 'room is locked', changed: [] };
      }
      if (ts <= resetTs) return { applied: false, reason: 'older than the last reset', changed: [] };

      return { applied: true, changed: merge(msg.props ?? {}, ts) };
    }

    if (op === 'reset') {
      if (ts <= resetTs) return { applied: false, reason: 'older than the last reset', changed: [] };
      resetTs = ts;
      const changed = [];
      for (const [key, entry] of entries) {
        if (entry.ts <= ts) {
          entries.delete(key);
          changed.push(key);
        }
      }

      return { applied: true, changed };
    }

    if (op === 'lock' || op === 'unlock') {
      // Lock beats unlock on a tie: when in doubt, keep the presenter in control.
      const wantLocked = op === 'lock';
      if (ts < lock.ts || (ts === lock.ts && !wantLocked)) {
        return { applied: false, reason: 'older than the current lock state', changed: [] };
      }
      lock = { locked: wantLocked, ts };

      return { applied: true, changed: [] };
    }

    if (op === 'snapshot') {
      // A snapshot is this room's state as the sender knew it at `ts` — the
      // newest write it had seen, not the moment it replied. It merges key by
      // key under the same last-write-wins rule as a set, and never clears:
      // a late joiner fills in, and a peer that already has a newer write to
      // a key keeps it. (Replacing the state instead let one tab's reply to
      // another tab's "hello" wipe a write made in the same moment.)
      if (ts <= resetTs) return { applied: false, reason: 'older than the last reset', changed: [] };

      return { applied: true, changed: merge(msg.props ?? {}, ts) };
    }

    return { applied: false, reason: `unknown op ${op}`, changed: [] };
  }

  /** The current value of every key, as a plain object. */
  function props() {
    return Object.fromEntries([...entries].map(([key, entry]) => [key, entry.value]));
  }

  /**
   * The messages that bring a late joiner up to date, already stamped with the
   * times this state learned them. Nothing, if this state has seen nothing.
   */
  function snapshotMessages(room) {
    // One message per distinct write time, so every key keeps the timestamp
    // it was really written at. Promoting an old key to a newer ts would let
    // it beat a write the joiner made a moment after joining.
    const byTs = new Map();
    for (const [key, entry] of entries) {
      if (!byTs.has(entry.ts)) byTs.set(entry.ts, {});
      byTs.get(entry.ts)[key] = entry.value;
    }
    const messages = [...byTs]
      .sort(([a], [b]) => a - b)
      .map(([ts, group]) => ({ ...createMessage({ room, op: 'snapshot', from: 'source', props: group }), ts }));
    if (lock.locked) messages.push({ ...createMessage({ room, op: 'lock', from: 'presenter' }), ts: lock.ts });

    return messages;
  }

  return {
    apply,
    props,
    snapshotMessages,
    get locked() {
      return lock.locked;
    },
  };
}
