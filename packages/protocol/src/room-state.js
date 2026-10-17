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
  let lastTs = -Infinity;
  let lock = { locked: false, ts: -Infinity };

  /**
   * Fold one validated, stamped message into the state.
   * @param {{ op: string, from: string, props?: Record<string, string>, ts: number }} msg
   * @returns {ApplyResult}
   */
  function apply(msg) {
    const { op, ts } = msg;
    lastTs = Math.max(lastTs, ts);

    if (op === 'set') {
      if (lock.locked && msg.from === 'controller') {
        return { applied: false, reason: 'room is locked', changed: [] };
      }
      if (ts <= resetTs) return { applied: false, reason: 'older than the last reset', changed: [] };
      const changed = [];
      for (const [key, value] of Object.entries(msg.props ?? {})) {
        const current = entries.get(key);
        if (!current || ts > current.ts || (ts === current.ts && value > current.value)) {
          if (!current || current.value !== value) changed.push(key);
          entries.set(key, { value, ts });
        }
      }

      return { applied: true, changed };
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
      // A snapshot is the whole state as of `ts`. It only lands if it is at
      // least as new as everything this peer has seen — so a late joiner takes
      // it, and an up-to-date peer hearing a duplicate is unaffected.
      if (ts < lastTs) return { applied: false, reason: 'older than this state', changed: [] };
      const next = msg.props ?? {};
      const changed = [];
      for (const key of entries.keys()) if (!(key in next)) changed.push(key);
      for (const [key, value] of Object.entries(next)) {
        if (entries.get(key)?.value !== value) changed.push(key);
      }
      entries.clear();
      for (const [key, value] of Object.entries(next)) entries.set(key, { value, ts });
      resetTs = Math.max(resetTs, ts);

      return { applied: true, changed };
    }

    return { applied: false, reason: `unknown op ${op}`, changed: [] };
  }

  /** The current value of every key, as a plain object. */
  function props() {
    return Object.fromEntries([...entries].map(([key, entry]) => [key, entry.value]));
  }

  /** The messages that bring a late joiner up to date. */
  function snapshotMessages(room) {
    const messages = [createMessage({ room, op: 'snapshot', from: 'source', props: props() })];
    if (lock.locked) messages.push(createMessage({ room, op: 'lock', from: 'presenter' }));

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
