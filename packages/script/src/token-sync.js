// The ?token-sync=<room> drop-in.
//
//   <script type="module" src=".../token-sync.js"></script>
//
// Does nothing on an ordinary page view. Visit the page with
// ?token-sync=<room> and it joins that room and applies the room's tokens to
// this tab — and keeps doing so for the rest of the tab's session, so you can
// click around the site. ?token-sync=off leaves. Holding \ shows the page as it
// was before the room touched it, with a sweep each way.
//
// Design-system-agnostic: tokens are applied exactly as sent. On an Eddie
// site, use token-sync-eddie.js instead, which adds Eddie's theme contract.
//
// Preview only: it changes this tab's custom properties and nothing else.
// Real visitors never carry the parameter, so they never see a change.

import { start } from './core.js';

export { PARAM, RELAY_META, STORAGE_KEY, WIPE_META, relaySocketUrl, resolveRoom, start } from './core.js';

if (typeof window !== 'undefined' && typeof document !== 'undefined' && !globalThis.TOKEN_SYNC_MANUAL_START) {
  // A classic script in <head> can run before the relay <meta> below it has
  // been parsed; wait for the document so the meta is always seen.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => start(), { once: true });
  else start();
}
