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
 * @typedef {{ key: string, scope: string, value: string | null, ts: number }} Entry  null: cleared at ts
 * @typedef {{ applied: boolean, reason?: string, changed: string[] }} ApplyResult
 */

/** Absent and `*` both mean every theme. */
const ALL = '*';
const scopeOf = (scope) => (typeof scope === 'string' && scope ? scope : ALL);
const idOf = (scope, key) => `${scope}\n${key}`;

/**
 * Scope (FEATURE-SPEC §6, Eddie's docs/TOKEN-SYNC.md): an edit made for one
 * theme applies only on a page wearing that theme. The state keeps every
 * theme's edits — a page answers joiners wearing any theme — keyed by
 * (scope, key), and a page reads the newest write among its own theme's
 * edits and the unscoped ones. That is exactly what an Eddie display sees,
 * since it merges only the messages in its scope.
 */
export function createRoomState() {
  /** @type {Map<string, Entry>} */
  const entries = new Map();
  let resetTs = -Infinity;
  let lock = { locked: false, ts: -Infinity };

  /**
   * Last-write-wins merge of `props` written at `ts`. Returns the keys whose
   * value changed. A null value is a clear: it is kept, with its time, so an
   * older write that arrives late can't bring the token back.
   * `fillOnly` merges only keys this state has never heard of.
   */
  function merge(props, ts, { fillOnly = false, scope = ALL } = {}) {
    const changed = [];
    for (const [key, value] of Object.entries(props)) {
      const id = idOf(scope, key);
      const current = entries.get(id);
      if (fillOnly && current) continue;
      if (!current || ts > current.ts || (ts === current.ts && String(value) > String(current.value))) {
        if (!current || current.value !== value) changed.push(key);
        entries.set(id, { key, scope, value, ts });
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

      return { applied: true, changed: merge(msg.props ?? {}, ts, { scope: scopeOf(msg.scope) }) };
    }

    if (op === 'reset') {
      if (ts <= resetTs) return { applied: false, reason: 'older than the last reset', changed: [] };
      resetTs = ts;
      const changed = [];
      for (const [id, entry] of entries) {
        if (entry.ts <= ts) {
          entries.delete(id);
          changed.push(entry.key);
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
      // An empty snapshot is a request; the transport or the relay answers it.
      // An answer only fills keys this state has never heard of (Eddie's rule):
      // an Eddie customizer answers with what it published, stamped when it
      // answers, so letting that stamp win would put back a value someone has
      // since changed. It never clears either. A peer that comes back with
      // stale state is brought up to date by the relay's catch-up, which
      // replays real writes as sets (snapshotMessages with asSets).
      if (ts <= resetTs) return { applied: false, reason: 'older than the last reset', changed: [] };

      return { applied: true, changed: merge(msg.props ?? {}, ts, { fillOnly: true, scope: scopeOf(msg.scope) }) };
    }

    return { applied: false, reason: `unknown op ${op}`, changed: [] };
  }

  /**
   * The current value of every key still set, as a plain object. Cleared keys
   * are left out. `inScope(scope)` says which themes' edits this page wears;
   * unscoped edits always count. Without it, every theme's edits count.
   * @param {(scope: string) => boolean} [inScope]
   */
  function props(inScope = () => true) {
    const newest = new Map();
    for (const entry of entries.values()) {
      if (entry.scope !== ALL && !inScope(entry.scope)) continue;
      const best = newest.get(entry.key);
      if (!best || entry.ts > best.ts || (entry.ts === best.ts && String(entry.value) > String(best.value))) newest.set(entry.key, entry);
    }

    return Object.fromEntries([...newest].filter(([, entry]) => entry.value !== null).map(([key, entry]) => [key, entry.value]));
  }

  /**
   * The messages that bring a joiner up to date, already stamped with the
   * times this state learned them. Nothing, if this state has seen nothing.
   *
   * "A joiner" includes a peer that dropped off and is rejoining with stale
   * state — so the snapshot also carries the last reset and the lock state
   * (unlocked included). Without them, a display that missed a reset or an
   * unlock while it was away would keep the cleared tokens and stay locked.
   *
   * `asSets` (the relay's catch-up) replays the writes as sets, so they win
   * over a returning peer's stale values by their real times; snapshots only
   * fill. `withReset: false` (a broadcast answer) leaves the reset out: an
   * Eddie display clears everything it wrote on any reset, however old, so a
   * replayed one would wipe newer writes on every Eddie page in the room.
   *
   * @param {string} room
   * @param {{ asSets?: boolean, withReset?: boolean }} [options]
   */
  function snapshotMessages(room, { asSets = false, withReset = true } = {}) {
    const messages = [];
    if (withReset && resetTs > -Infinity) messages.push({ ...createMessage({ room, op: 'reset', from: 'presenter' }), ts: resetTs });
    // One snapshot per distinct write time, so every key keeps the timestamp
    // it was really written at. Promoting an old key to a newer ts would let
    // it beat a write the joiner made a moment after joining.
    // Grouped by theme too, so every answer keeps the scope it was written for.
    const groups = new Map();
    for (const entry of entries.values()) {
      const id = `${entry.ts}\n${entry.scope}`;
      if (!groups.has(id)) groups.set(id, { ts: entry.ts, scope: entry.scope, props: {} });
      groups.get(id).props[entry.key] = entry.value;
    }
    for (const { ts, scope, props: group } of [...groups.values()].sort((a, b) => a.ts - b.ts)) {
      const scoped = scope === ALL ? undefined : scope;
      messages.push({ ...createMessage({ room, op: asSets ? 'set' : 'snapshot', from: 'source', props: group, scope: scoped }), ts });
    }
    if (lock.ts > -Infinity) messages.push({ ...createMessage({ room, op: lock.locked ? 'lock' : 'unlock', from: 'presenter' }), ts: lock.ts });

    return messages;
  }

  /** How many (theme, key) entries the room holds, cleared ones included. */
  const size = () => entries.size;
  /** Whether the room has heard of this key for this theme, cleared or not. */
  const has = (key, scope) => entries.has(idOf(scopeOf(scope), key));

  return {
    apply,
    props,
    snapshotMessages,
    size,
    has,
    get locked() {
      return lock.locked;
    },
  };
}
