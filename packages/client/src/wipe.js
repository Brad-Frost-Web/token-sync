// Before and after, one page at a time (FEATURE-SPEC, grilling Q14).
//
// - The wipe: each batch of token writes runs inside a View Transition. The
//   browser snapshots the page, the writes land, and the new look sweeps in
//   from the inline-start edge (right-to-left pages sweep from the right).
//   Under prefers-reduced-motion, or where View Transitions don't exist, the
//   writes simply land.
// - The toggle: hold a key to see the page as it was before the room touched
//   it; let go to see it again with the room's tokens.
//
// The sweep is scoped by a class on <html> that exists only during our own
// transition, so a page's own view transitions are never restyled.

export const WIPE_CLASS = 'token-sync-wiping';
const STYLE_ID = 'token-sync-wipe-styles';
const DURATION_MS = 300; // inside the applier's 333 ms damping window, so sweeps never pile up

const CSS = `
html.${WIPE_CLASS}::view-transition-old(root),
html.${WIPE_CLASS}::view-transition-new(root) { animation: none; mix-blend-mode: normal; }
html.${WIPE_CLASS}::view-transition-new(root) { animation: token-sync-wipe ${DURATION_MS}ms ease-in-out both; }
html.${WIPE_CLASS}:dir(rtl)::view-transition-new(root) { animation-name: token-sync-wipe-rtl; }
@keyframes token-sync-wipe { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0); } }
@keyframes token-sync-wipe-rtl { from { clip-path: inset(0 0 0 100%); } to { clip-path: inset(0); } }
`;

/**
 * A `transition` for createApplier() that sweeps each change in.
 * @param {{ document?: Document, matchMedia?: (query: string) => { matches: boolean } }} [options]
 * @returns {(update: () => void) => void}
 */
export function createWipe({ document = globalThis.document, matchMedia = globalThis.matchMedia?.bind(globalThis) } = {}) {
  return (update) => {
    const reduced = matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (!document?.startViewTransition || reduced) {
      update();

      return;
    }
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.append(style);
    }
    const root = document.documentElement;
    root.classList.add(WIPE_CLASS);
    const done = () => root.classList.remove(WIPE_CLASS);
    try {
      const transition = document.startViewTransition(update);
      transition.finished.then(done, done);
    } catch {
      done();
      update();
    }
  };
}

/** Is focus somewhere a person is typing? Then a key press is text, not a command. */
function typingIn(target) {
  const el = /** @type {HTMLElement | null} */ (target);
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toLowerCase();

  return tag === 'input' || tag === 'textarea' || tag === 'select' || (el.shadowRoot != null && typingIn(el.shadowRoot.activeElement));
}

/**
 * Hold `key` to see the page before the room's tokens; release to see after.
 * @param {{ hold(on: boolean): void }} applier
 * @param {{ target?: EventTarget, key?: string }} [options] `key` is a
 *   KeyboardEvent.key value. The default, backslash, is rarely bound and easy
 *   to find blind.
 * @returns {() => void} removes the listeners
 */
export function holdToCompare(applier, { target = globalThis.window, key = '\\' } = {}) {
  const down = (event) => {
    if (event.key !== key || event.repeat || typingIn(event.target)) return;
    applier.hold(true);
  };
  const up = (event) => {
    if (event.key === key) applier.hold(false);
  };
  // Letting go of the key outside the window must not leave the page stuck on "before".
  const blur = () => applier.hold(false);
  if (typeof target?.addEventListener !== 'function') return () => {};
  target.addEventListener('keydown', down);
  target.addEventListener('keyup', up);
  target.addEventListener('blur', blur);

  return () => {
    target.removeEventListener('keydown', down);
    target.removeEventListener('keyup', up);
    target.removeEventListener('blur', blur);
  };
}
