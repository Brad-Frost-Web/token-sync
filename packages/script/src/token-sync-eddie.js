// The drop-in for Eddie sites: everything token-sync.js does, plus Eddie's
// theme contract (adapter-eddie).
//
//   <script type="module" src=".../token-sync-eddie.js"></script>
//
// - contract:<path> knobs expand into every token derived from them.
// - Every contract pair is kept at WCAG AA; what was nudged shows briefly, and
//   what couldn't be fixed or checked stays on screen until it clears.
//
// It's a separate file because the contract adds about 70 KB that a site not
// built on Eddie has no use for.

import { createNotifier, lazyEddieAdapter } from './eddie.js';
import { start as startCore } from './core.js';

export { PARAM, RELAY_META, STORAGE_KEY, WIPE_META, relaySocketUrl, resolveRoom } from './core.js';
export { createNotifier, lazyEddieAdapter } from './eddie.js';

/** The drop-in's start: the core, with Eddie's adapter and the notifier. */
export function start(context = {}) {
  const document = context.document ?? globalThis.document;

  return startCore({ createAdapter: lazyEddieAdapter, onResolved: document ? createNotifier(document) : () => {}, ...context });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && !globalThis.TOKEN_SYNC_MANUAL_START) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => start(), { once: true });
  else start();
}
