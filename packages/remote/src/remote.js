// The phone remote's logic, kept out of the page so it can be tested.

import { isRoom } from '../../protocol/src/index.js';

/**
 * Read the room and relay from the remote's URL:
 * remote/?room=<code>&relay=<https url>
 *
 * A link chooses the relay here, unlike the drop-in, because the remote only
 * ever sends: whoever opens a link joins the room that link names, on purpose.
 * @param {string} search
 * @param {string} [pageProtocol] the remote page's own protocol: an https page can't reach an http relay
 * @returns {{ ok: true, room: string, socket: string } | { ok: false, error: string }}
 */
export function remoteSettings(search, pageProtocol = 'http:') {
  const params = new URLSearchParams(search);
  const room = params.get('room');
  const relay = params.get('relay');
  if (!room || !isRoom(room)) return { ok: false, error: 'This link is missing its room code. Ask the presenter for the remote link again.' };
  if (!relay) return { ok: false, error: 'This link is missing its relay. Ask the presenter for the remote link again.' };
  let url;
  try {
    url = new URL(relay);
  } catch {
    return { ok: false, error: "This link's relay address isn't valid. Ask the presenter for the remote link again." };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: "This link's relay address isn't valid. Ask the presenter for the remote link again." };
  if (pageProtocol === 'https:' && url.protocol === 'http:') {
    return { ok: false, error: "This link points at a relay that isn't secure (http), which a secure page can't reach. Ask the presenter for an https relay link." };
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/rooms/${encodeURIComponent(room)}/socket`;
  url.search = '';
  url.hash = '';

  return { ok: true, room, socket: url.href };
}

/**
 * The one line the remote announces (politely) about where things stand.
 * Says why the controls stopped working, never just that they did.
 * @param {{ room: string, connection: 'connecting' | 'open' | 'closed', locked: boolean, everConnected?: boolean, failed?: boolean }} state
 *   `everConnected: false, failed: true` once an attempt has failed before
 *   the first successful join: a relay that's down at load reads as "can't
 *   reach", not as a lost connection.
 */
export function statusMessage({ room, connection, locked, everConnected = true, failed = false }) {
  if (!everConnected && failed && connection !== 'open') return `Can't reach room “${room}” yet. Still trying. If this keeps up, check the link with the presenter.`;
  if (connection === 'connecting') return `Joining room “${room}”…`;
  if (connection === 'closed') return 'Lost the connection. Trying again…';
  if (locked) return `The presenter has paused room “${room}”. Your controls will come back when they unpause it.`;

  return `You're in room “${room}”. Your changes show on the big screen.`;
}

/**
 * The link a presenter hands out for a room.
 * @param {{ base: string, room: string, relay: string }} options `base` is where the remote page lives
 */
export function remoteLink({ base, room, relay }) {
  const url = new URL(base);
  url.searchParams.set('room', room);
  url.searchParams.set('relay', relay);

  return url.href;
}

/** What a reset means to someone holding the remote. */
export const RESET_MESSAGE = 'The presenter reset the page on the big screen. The controls are back to the start.';

/** The relay base a room's HTTP endpoints hang off, keeping any path the relay lives under. */
export function relayEndpoint(relay, path) {
  const base = new URL(relay);
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/${path}`;

  return base;
}
