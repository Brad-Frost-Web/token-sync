// Builds the two single-file artifacts from the packages' source:
//
//   tokenSyncScript()  — the ?token-sync=<room> drop-in as one classic script
//                        (window.TokenSync exposes start / resolveRoom)
//   bookmarkletUrl()   — a javascript: URL that prompts for a room and joins it
//
// `npm run build` writes both to dist/. The demo server calls these directly,
// so what it serves is always built from the source on disk.

import { bundle, REPO_ROOT } from '../../tools/bundle.js';
import { join } from 'node:path';

const SCRIPT_ENTRY = join(REPO_ROOT, 'packages/script/src/token-sync.js');
const BOOKMARKLET_ENTRY = join(REPO_ROOT, 'packages/bookmarklet/src/bookmarklet.js');

export function tokenSyncScript() {
  return `/* Token Sync drop-in — https://github.com/Brad-Frost-Web/token-sync */\n${bundle(SCRIPT_ENTRY, { globalName: 'TokenSync' })}`;
}

export function bookmarkletSource() {
  const expression = bundle(BOOKMARKLET_ENTRY, { stripComments: true }).trim().replace(/;$/, '');

  // void(): a javascript: URL whose result is a string replaces the page.
  // TOKEN_SYNC_MANUAL_START keeps the bundled drop-in's own autostart quiet
  // while the bundle evaluates, then goes, so a drop-in loaded later behaves normally.
  return `void((()=>{globalThis.TOKEN_SYNC_MANUAL_START=true;const m=(${expression});delete globalThis.TOKEN_SYNC_MANUAL_START;m.run();})())`;
}

export function bookmarkletUrl() {
  return `javascript:${encodeURIComponent(bookmarkletSource())}`;
}
