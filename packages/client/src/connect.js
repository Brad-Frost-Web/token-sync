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
 * }} options `keyFor` names the room-state key for a prop key; a design
 *   system's adapter uses it to make two spellings of one token one key. `presenter` grants reset and lock. Over `broadcast` every tab is a
 *   presenter (spec §8). Over the relay the relay decides, by presenter key,
 *   and a transport exposing `isPresenter` (the remote one) answers for it.
 */
export function connect({ room, transport = 'broadcast', role = 'source', presenter = typeof transport === 'string', applier, onChange = () => {}, onError = () => {}, keyFor = null }) {
  if (!isRoom(room)) throw new Error(`token-sync: "${room}" is not a valid room code`);
  const state = createRoomState();
  const getSnapshot = (options) => state.snapshotMessages(room, options);

  const channel =
    transport === 'broadcast'
      ? createBroadcastTransport({ room, getSnapshot })
      : transport === 'local'
        ? createLocalTransport({ room, getSnapshot })
        : transport;

  const unsubscribe = channel.subscribe((incoming) => {
    const message = keyFor && incoming?.props && typeof incoming.props === 'object'
      ? { ...incoming, props: Object.fromEntries(Object.entries(incoming.props).map(([key, value]) => [keyFor(key), value])) }
      : incoming;
    const result = validateMessage(message);
    if (!result.ok) {
      onError({ errors: result.errors, message });

      return;
    }
    if (message.room !== room) return;
    // A request for the room's state: the transport or the relay answers it.
    if (isSnapshotRequest(message)) return;
    const outcome = state.apply(message);
    if (!outcome.applied) return;
    applier?.render(state.props());
    onChange({ props: state.props(), changed: outcome.changed, message, locked: state.locked });
  });

  function send(op, from, props) {
    const message = createMessage({ room, op, from, props });
    const result = validateMessage(message, { requireTs: false });
    if (!result.ok) throw new Error(`token-sync: refused to send — ${result.errors.join('; ')}`);

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
    set: (props) => send('set', role, props),
    reset: () => presenterOnly('reset'),
    lock: () => presenterOnly('lock'),
    unlock: () => presenterOnly('unlock'),
    props: () => state.props(),
    get locked() {
      return state.locked;
    },
    /** Leave the room and put the page back the way it was. */
    close() {
      unsubscribe();
      channel.close();
      applier?.destroy();
    },
  };
}
