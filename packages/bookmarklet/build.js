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
const EDDIE_SCRIPT_ENTRY = join(REPO_ROOT, 'packages/script/src/token-sync-eddie.js');
const BOOKMARKLET_ENTRY = join(REPO_ROOT, 'packages/bookmarklet/src/bookmarklet.js');

export function tokenSyncScript() {
  return `/* Token Sync drop-in — https://github.com/Brad-Frost-Web/token-sync */\n${bundle(SCRIPT_ENTRY, { globalName: 'TokenSync' })}`;
}

/** The drop-in for Eddie sites, with the theme contract, as one classic script. */
export function tokenSyncEddieScript() {
  return `/* Token Sync drop-in for Eddie sites — https://github.com/Brad-Frost-Web/token-sync */\n${bundle(EDDIE_SCRIPT_ENTRY, { globalName: 'TokenSync' })}`;
}

export function bookmarkletSource() {
  const expression = bundle(BOOKMARKLET_ENTRY, { stripComments: true }).trim().replace(/;$/, '');

  // void(): a javascript: URL whose result is a string replaces the page.
  return `void((${expression}).run())`;
}

export function bookmarkletUrl() {
  return `javascript:${encodeURIComponent(bookmarkletSource())}`;
}
