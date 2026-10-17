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

import { createEddieAdapter, isEddiePage } from '../../adapter-eddie/src/adapter.js';
import { start as startCore } from './core.js';

export { PARAM, RELAY_META, STORAGE_KEY, WIPE_META, relaySocketUrl, resolveRoom } from './core.js';

const IDLE = { moved: [], problems: [], unchecked: 0 };

/**
 * Eddie's adapter for this page, made as soon as the page shows Eddie's
 * tokens — at start, or later for a page whose stylesheet arrives after the
 * script (a bundler injecting CSS, for one).
 */
export function lazyEddieAdapter({ readComputed }) {
  let adapter = null;

  return {
    resolve(props) {
      if (!adapter && isEddiePage(readComputed)) adapter = createEddieAdapter({ readComputed });
      if (adapter) return adapter.resolve(props);
      const refused = Object.entries(props)
        .filter(([name]) => name.startsWith('contract:'))
        .map(([name, value]) => ({ name, value, reason: "contract knobs need Eddie's tokens on the page, and this page doesn't have them (yet)" }));
      const rest = Object.fromEntries(Object.entries(props).filter(([name]) => !name.startsWith('contract:')));

      return { props: rest, refused, status: IDLE };
    },
  };
}

/**
 * Show the adapter's status on the page with one ed-toast: what was nudged
 * appears for a few seconds; what couldn't be fixed or checked stays until it
 * clears. Everything also goes to the console, which is all a page without
 * ed-toast gets.
 */
export function createNotifier(document, { setTimeout: later = setTimeout, clearTimeout: cancel = clearTimeout } = {}) {
  let toast = null;
  let timer = null;
  let last = { moved: '', problems: '', unchecked: 0 };

  function show(lines, lasting) {
    for (const line of lines) console.info(`token-sync: ${line}`);
    if (!globalThis.customElements?.get?.('ed-toast') || !document.body) return;
    if (!toast) {
      toast = document.createElement('ed-toast');
      document.body.append(toast);
    }
    // ed-toast wraps its slot in a text passage itself: slot plain paragraphs.
    toast.replaceChildren(...lines.map((line) => Object.assign(document.createElement('p'), { textContent: line })));
    cancel(timer);
    if (!lasting) timer = later(hide, 6000);
  }

  function hide() {
    toast?.remove();
    toast = null;
  }

  return (status) => {
    const moved = status.moved.join('\n');
    const problems = status.problems.join('\n');
    if (problems && problems !== last.problems) show(status.problems, true);
    else if (!problems && last.problems) hide();
    if (moved && moved !== last.moved && !problems) show(status.moved, false);
    if (status.unchecked > last.unchecked && !problems) {
      show([`${status.unchecked} value${status.unchecked === 1 ? '' : 's'} outside Eddie's contract applied as sent, without a contrast check.`], false);
    }
    last = { moved, problems, unchecked: status.unchecked };
  };
}

/** The drop-in's start: the core, with Eddie's adapter and the notifier. */
export function start(context = {}) {
  const document = context.document ?? globalThis.document;

  return startCore({ createAdapter: lazyEddieAdapter, onResolved: document ? createNotifier(document) : () => {}, ...context });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && !globalThis.TOKEN_SYNC_MANUAL_START) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => start(), { once: true });
  else start();
}
