// Eddie's adapter and the notifier, for anything that applies a room on a
// page: the Eddie drop-in, and the browser extension's content script. No
// autostart here — importing this module starts nothing.

import { createEddieAdapter, isEddiePage } from '../../adapter-eddie/src/adapter.js';

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
