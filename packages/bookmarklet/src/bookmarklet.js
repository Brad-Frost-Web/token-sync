// What the bookmarklet runs, once bundled into a javascript: URL.
//
// Asks for a room code and joins it in this tab. "off" leaves. The bundle sets
// TOKEN_SYNC_MANUAL_START first, so the drop-in's own URL-driven autostart
// stays out of the way and this prompt is the only way in.

import { start, STORAGE_KEY } from '../../script/src/token-sync.js';

export function run({ prompt = globalThis.prompt, storage = globalThis.sessionStorage } = {}) {
  let current = '';
  try {
    current = storage?.getItem(STORAGE_KEY) ?? '';
  } catch {
    // Storage can be unavailable; the prompt just starts empty.
  }
  const answer = prompt?.('Token Sync: room code to preview in this tab ("off" to leave)', current);
  if (answer === null || answer === undefined) return null;
  const room = answer.trim();

  return start({ room: room === '' ? 'off' : room });
}
