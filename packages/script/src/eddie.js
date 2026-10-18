// Eddie's adapter and the notifier, for anything that applies a room on a
// page: the Eddie drop-in, and the browser extension's content script. No
// autostart here — importing this module starts nothing.

import { contractPathProperty, createEddieAdapter, isEddiePage } from '../../adapter-eddie/src/adapter.js';

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
    /**
     * The room-state key for a prop key. A contract path is its custom
     * property, as in Eddie's applier, so `contract:color.background.brand`
     * and `--ed-theme-color-background-brand` are one token: last write wins
     * between them, and a null to either clears it. The path list is fixed,
     * so this needs no page.
     */
    keyFor: (key) => (key.startsWith('contract:') && contractPathProperty(key)) || key,
  };
}

/**
 * Show the adapter's status on the page with one ed-toast: what was nudged
 * appears for a few seconds; what couldn't be fixed or checked stays until it
 * clears. Everything also goes to the console, which is all a page without
 * ed-toast gets.
 */
export function createNotifier(document, { setTimeout: later = setTimeout, clearTimeout: cancel = clearTimeout } = {}) {
  // Kept inside: the extension smoke test runs this function's own source in
  // an isolated world, where nothing outside it exists.
  const MAX_TOAST_LINES = 3;
  let toast = null;
  let timer = null;
  let last = { moved: '', problems: '', unchecked: 0 };

  function show(all, lasting) {
    for (const line of all) console.info(`token-sync: ${line}`);
    // On the page, three and a count, as Eddie's notice does: a toast reading
    // out every token on a stage display covers the thing being judged.
    const lines = all.length > MAX_TOAST_LINES ? [...all.slice(0, MAX_TOAST_LINES), `And ${all.length - MAX_TOAST_LINES} more; the console has them all.`] : all;
    if (!document.body) return;
    if (!toast) {
      toast = document.createElement('ed-toast');
      document.body.append(toast);
      // Whether the page defines ed-toast is read from the element, not from
      // window.customElements: an extension's content script runs in an
      // isolated world whose customElements is null, while the element it
      // creates in the shared DOM still upgrades with the page's definition.
      if (!toast.matches?.(':defined')) {
        toast.remove();
        toast = null;

        return;
      }
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
