// The applier: puts a room's state onto the open page.
//
// Three rules (FEATURE-SPEC §6, §8, §9):
//
// 1. Values go in through `style.setProperty`, one property at a time, never
//    by joining strings into CSS — so no value can become a rule of its own.
// 2. Each value must parse as the kind of value the property already holds on
//    this page (a colour stays a colour). The applier needs no schema: the
//    page's own current value is the type.
// 3. Damping. The page changes at most `maxChangesPerSecond` times a second,
//    however fast messages arrive (WCAG 2.3.1, three flashes). The first change
//    lands immediately, so a single edit is never delayed; a burst is
//    coalesced, and the latest state lands at the end of each window.
//
// Reset restores whatever inline value the page had before the applier
// touched it, so a page that set its own inline tokens gets them back.

import { checkValue, inferType } from '../../protocol/src/index.js';

const CONTRACT_PREFIX = 'contract:';

/**
 * @param {{
 *   root?: { style: { setProperty(n: string, v: string): void, getPropertyValue(n: string): string, removeProperty(n: string): void } },
 *   readComputed?: (name: string) => string,
 *   maxChangesPerSecond?: number,
 *   timers?: { now(): number, setTimeout(fn: () => void, ms: number): unknown, clearTimeout(id: unknown): void },
 *   onApply?: (info: { changed: string[], at: number }) => void,
 *   onRefuse?: (info: { name: string, value: string, reason: string }) => void,
 * }} [options]
 */
export function createApplier({
  root = globalThis.document?.documentElement,
  readComputed = (name) => globalThis.getComputedStyle?.(root)?.getPropertyValue(name) ?? '',
  maxChangesPerSecond = 3,
  timers = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(/** @type {any} */ (id)),
  },
  onApply = () => {},
  onRefuse = () => {},
} = {}) {
  if (!root?.style) throw new Error('token-sync: the applier needs an element to apply to');
  const interval = 1000 / maxChangesPerSecond;

  /** Values this applier has written. */
  const applied = new Map();
  /** The page's own inline value before we touched it ('' = none). */
  const originalInline = new Map();
  /** The type each property had on this page before we touched it. */
  const types = new Map();

  let desired = {};
  let lastFlush = -Infinity;
  let timer = null;

  function typeOf(name) {
    if (!types.has(name)) types.set(name, inferType(readComputed(name)));

    return types.get(name);
  }

  function flush() {
    timer = null;
    lastFlush = timers.now();
    const changed = [];

    for (const [name, value] of Object.entries(desired)) {
      if (applied.get(name) === value) continue;
      if (!originalInline.has(name)) originalInline.set(name, root.style.getPropertyValue(name));
      root.style.setProperty(name, value);
      applied.set(name, value);
      changed.push(name);
    }
    for (const name of [...applied.keys()]) {
      if (name in desired) continue;
      const original = originalInline.get(name) ?? '';
      if (original) root.style.setProperty(name, original);
      else root.style.removeProperty(name);
      applied.delete(name);
      changed.push(name);
    }
    if (changed.length) onApply({ changed, at: lastFlush });
  }

  function schedule() {
    if (timer !== null) return;
    const wait = lastFlush + interval - timers.now();
    if (wait <= 0) flush();
    else timer = timers.setTimeout(flush, wait);
  }

  return {
    /**
     * Make the page show this state. Keys that aren't in `props` go back to
     * what the page had. Refused values are reported and skipped.
     * @param {Record<string, string>} props
     */
    render(props) {
      const next = {};
      for (const [name, value] of Object.entries(props)) {
        if (name.startsWith(CONTRACT_PREFIX)) {
          onRefuse({ name, value, reason: 'contract knobs need the Eddie contract adapter, which is not installed' });
          continue;
        }
        const check = checkValue(value, typeOf(name));
        if (!check.ok) {
          onRefuse({ name, value, reason: check.reason });
          continue;
        }
        next[name] = value;
      }
      desired = next;
      schedule();
    },
    /** Put the page back exactly as it was, now, and stop. */
    destroy() {
      if (timer !== null) timers.clearTimeout(timer);
      desired = {};
      flush();
    },
  };
}
