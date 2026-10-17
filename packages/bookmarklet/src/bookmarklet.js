// What the bookmarklet runs, once bundled into a javascript: URL.
//
// Asks for a room code and joins it in this tab. "off" leaves. It bundles the
// drop-in's core, which has no autostart (this prompt is the only way in) and
// no Eddie adapter (to keep the bookmarklet's URL short).

import { start, STORAGE_KEY } from '../../script/src/core.js';

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
