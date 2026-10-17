// connect(): one page's membership of a room.
//
// Wires a transport to a room state and, when given one, an applier:
//
//   transport ──▶ validate ──▶ room state (LWW) ──▶ applier ──▶ the page
//
// Every incoming message is validated here, whatever transport it came on —
// an applier never trusts the wire.

import { createMessage, createRoomState, isRoom, isSnapshotRequest, validateMessage } from '../../protocol/src/index.js';
import { createBroadcastTransport, createLocalTransport } from './transports.js';

/**
 * @param {{
 *   room: string,
 *   transport?: 'broadcast' | 'local' | { publish(msg: object): object, subscribe(fn: (msg: object) => void): () => void, close(): void },
 *   role?: 'controller' | 'presenter' | 'source',
 *   presenter?: boolean,
 *   applier?: { render(props: Record<string, string>): void, destroy(): void },
 *   onChange?: (info: { props: Record<string, string>, changed: string[], message: object, locked: boolean }) => void,
 *   onError?: (info: { errors: string[], message: unknown }) => void,
 *   keyFor?: (key: string) => string,
 *   inScope?: (scope: string) => boolean,
 * }} options `inScope` says whether this page wears a theme; by default, a
 *   theme is worn when <html> carries its class (as Eddie applies themes).
 *   An edit scoped to another theme is kept, for answering others, but not
 *   shown here. `keyFor` names the room-state key for a prop key; a design
 *   system's adapter uses it to make two spellings of one token one key. `presenter` grants reset and lock. Over `broadcast` every tab is a
 *   presenter (spec §8). Over the relay the relay decides, by presenter key,
 *   and a transport exposing `isPresenter` (the remote one) answers for it.
 */
/** Whether this page wears a theme: <html class="bfw">. With no page, every theme. */
function pageWears(scope) {
  const classes = globalThis.document?.documentElement?.classList;

  return classes ? classes.contains(scope) : true;
}

export function connect({ room, transport = 'broadcast', role = 'source', presenter = typeof transport === 'string', applier, onChange = () => {}, onError = () => {}, keyFor = null, inScope = pageWears }) {
  if (!isRoom(room)) throw new Error(`token-sync: "${room}" is not a valid room code`);
  const state = createRoomState();
  const warnedScopes = new Set();
  const getSnapshot = (options) => state.snapshotMessages(room, options);

  const channel =
    transport === 'broadcast'
      ? createBroadcastTransport({ room, getSnapshot })
      : transport === 'local'
        ? createLocalTransport({ room, getSnapshot })
        : transport;

  const unsubscribe = channel.subscribe((incoming) => {
    const normalized = keyFor && incoming?.props && typeof incoming.props === 'object'
      ? { ...incoming, props: Object.fromEntries(Object.entries(incoming.props).map(([key, value]) => [keyFor(key), value])) }
      : incoming;
    const result = validateMessage(normalized);
    if (!result.ok) {
      onError({ errors: result.errors, message: normalized });

      return;
    }
    // The props that passed; the rest are reported and dropped one by one.
    const { message, refused } = result;
    if (refused.length) onError({ errors: refused.map((r) => `${r.name}: ${r.reason}`), message: normalized });
    if (message.room !== room) return;
    // A request for the room's state: the transport or the relay answers it.
    if (isSnapshotRequest(message)) return;
    const before = state.props(inScope);
    const outcome = state.apply(message);
    if (!outcome.applied) return;
    const shown = state.props(inScope);
    // Only what this page shows counts as changed here: an edit for another
    // theme is kept, for answering, but changes nothing on this page.
    const changed = outcome.changed.filter((key) => before[key] !== shown[key]);
    if (!changed.length && (message.op === 'set' || message.op === 'snapshot')) {
      if (message.scope && message.scope !== '*' && !inScope(message.scope.toLowerCase()) && !warnedScopes.has(message.scope)) {
        warnedScopes.add(message.scope);
        console.info(`token-sync: not showing edits for the "${message.scope}" theme; this page doesn't wear it (<html class="${message.scope}">).`);
      }

      return;
    }
    applier?.render(shown);
    onChange({ props: shown, changed, message, locked: state.locked });
  });

  // A page that switches theme mid-session shows that theme's edits at once,
  // not at the next message. This repaints only: onChange hears the next
  // message. A custom inScope has to re-render its own way.
  const html = inScope === pageWears ? globalThis.document?.documentElement : null;
  const themeWatch =
    applier && html && typeof globalThis.MutationObserver === 'function'
      ? new globalThis.MutationObserver(() => applier.render(state.props(inScope)))
      : null;
  themeWatch?.observe(html, { attributes: true, attributeFilter: ['class'] });

  function send(op, from, props, scope) {
    const message = createMessage({ room, op, from, props, scope });
    const result = validateMessage(message, { requireTs: false });
    if (!result.ok) throw new Error(`token-sync: refused to send — ${result.errors.join('; ')}`);
    if (result.refused.length) throw new Error(`token-sync: refused to send — ${result.refused.map((r) => `${r.name}: ${r.reason}`).join('; ')}`);

    return channel.publish(message);
  }

  function presenterOnly(op) {
    // A relay transport knows whether the relay accepted our key; ask it.
    const allowed = typeof channel.isPresenter === 'boolean' ? channel.isPresenter : presenter;
    if (!allowed) throw new Error(`token-sync: ${op} needs the presenter key`);

    return send(op, 'presenter');
  }

  return {
    room,
    /** Send one or more token changes. */
    /** `scope`: the theme this edit is for; leave it out for every theme. */
    set: (props, { scope } = {}) => send('set', role, props, scope),
    reset: () => presenterOnly('reset'),
    lock: () => presenterOnly('lock'),
    unlock: () => presenterOnly('unlock'),
    props: () => state.props(inScope),
    get locked() {
      return state.locked;
    },
    /** Leave the room and put the page back the way it was. */
    close() {
      themeWatch?.disconnect();
      unsubscribe();
      channel.close();
      applier?.destroy();
    },
  };
}
