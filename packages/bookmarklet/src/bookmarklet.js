// What the bookmarklet runs, once bundled into a javascript: URL.
//
// Asks for a room code and joins it in this tab. "off" leaves. It bundles the
// drop-in's core, which has no autostart (this prompt is the only way in) and
// no Eddie adapter (to keep the bookmarklet's URL short).
//
// A bare room code joins over BroadcastChannel, which reaches only tabs on
// this same site. `room@relay` (detach@http://127.0.0.1:8787) joins the room on
// a relay, so a source anywhere — the demo page, a phone, the CLI — reaches
// this tab. The relay is typed by the person running the bookmarklet, never
// read from the page or its URL.

import { start, STORAGE_KEY } from '../../script/src/core.js';

export const RELAY_STORAGE_KEY = `${STORAGE_KEY}:relay`;

/** "room" or "room@relay" → { room, relay? }. */
export function parseAnswer(answer) {
  const text = answer.trim();
  const at = text.indexOf('@');
  if (at < 0) return { room: text };

  return { room: text.slice(0, at).trim(), relay: text.slice(at + 1).trim() };
}

export function run({ prompt = globalThis.prompt, storage = globalThis.sessionStorage } = {}) {
  let current = '';
  try {
    const room = storage?.getItem(STORAGE_KEY) ?? '';
    const relay = storage?.getItem(RELAY_STORAGE_KEY) ?? '';
    current = room && relay ? `${room}@${relay}` : room;
  } catch {
    // Storage can be unavailable; the prompt just starts empty.
  }
  const answer = prompt?.('Token Sync: room code to preview in this tab, or room@relay-url for a relay ("off" to leave)', current);
  if (answer === null || answer === undefined) return null;
  const { room, relay } = parseAnswer(answer);
  try {
    if (relay) storage?.setItem(RELAY_STORAGE_KEY, relay);
    else storage?.removeItem(RELAY_STORAGE_KEY);
  } catch {
    // Remembering is a convenience.
  }

  return start({ room: room === '' ? 'off' : room, relay });
}
