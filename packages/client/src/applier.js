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
 *   transition?: (update: () => void, info: { cause: 'render' | 'hold' }) => void,
 *   resolve?: (props: Record<string, string>) => { props: Record<string, string>, notices?: string[], refused?: { name: string, value: string, reason: string }[] },
 *   onNotice?: (message: string) => void,
 * }} [options] `transition` wraps each batch of writes, e.g. in a View
 *   Transition (see wipe.js). It must call `update` exactly once, now or
 *   later; the writes are worked out when `update` runs, so a late callback
 *   writes the newest state, and one that runs after destroy() writes nothing.
 *   `resolve` is a design system's adapter (adapter-eddie): it turns the
 *   room's props into the custom properties to apply, before any check runs.
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
  transition = (update) => update(),
  resolve = null,
  onNotice = () => {},
} = {}) {
  if (!root?.style) throw new Error('token-sync: the applier needs an element to apply to');
  // A hair over 1000 / max, so a timer firing a millisecond early can never
  // squeeze a fourth change into one second.
  const interval = 1000 / maxChangesPerSecond + 5;

  /** Values this applier has written. */
  const applied = new Map();
  /** The page's own inline value before we touched it ('' = none). */
  const originalInline = new Map();
  /** The type each property had on this page before we touched it. */
  const types = new Map();

  let desired = {};
  /** While held, the page shows its own values: "before", for comparing. */
  let held = false;
  /** What asked for the next flush: a room change, or the compare key. */
  let cause = 'render';
  let alive = true;
  /** `name value` pairs already reported, so a refusal warns once, not on every message. */
  const reported = new Set();
  let lastFlush = -Infinity;
  let timer = null;

  function typeOf(name) {
    if (!types.has(name)) types.set(name, inferType(readComputed(name)));

    return types.get(name);
  }

  /**
   * Work out the writes that make the page show `target`, record them as
   * applied, and return them. Nothing touches the page yet.
   */
  function plan(target) {
    const writes = [];
    for (const [name, value] of Object.entries(target)) {
      if (applied.get(name) === value) continue;
      if (!originalInline.has(name)) originalInline.set(name, root.style.getPropertyValue(name));
      writes.push([name, value]);
      applied.set(name, value);
    }
    for (const name of [...applied.keys()]) {
      if (name in target) continue;
      writes.push([name, originalInline.get(name) ?? '']);
      applied.delete(name);
    }

    return writes;
  }

  function write(writes) {
    for (const [name, value] of writes) {
      if (value) root.style.setProperty(name, value);
      else root.style.removeProperty(name);
    }
  }

  /** Would flushing now change anything on screen? */
  function pending() {
    const target = held ? {} : desired;

    return Object.entries(target).some(([name, value]) => applied.get(name) !== value) || [...applied.keys()].some((name) => !(name in target));
  }

  function flush() {
    timer = null;
    // Only a visible change opens a new damping window. A lock, a repeat of
    // the current value, or a refused value changes nothing on screen, and
    // must not delay the next real edit.
    if (!pending()) return;
    lastFlush = timers.now();
    const info = { cause };
    cause = 'render';
    transition(() => {
      // Planned here, not before: a View Transition runs this a frame or
      // more later, and by then the state may have moved on or the tab may
      // have left the room.
      if (!alive) return;
      const writes = plan(held ? {} : desired);
      if (!writes.length) return;
      write(writes);
      onApply({ changed: writes.map(([name]) => name), at: timers.now(), cause: info.cause });
    }, info);
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
     * what the page had. A refused value is reported once and the key keeps
     * its last good value.
     * @param {Record<string, string>} props
     */
    render(roomProps) {
      let props = roomProps;
      if (resolve) {
        const resolved = resolve(roomProps);
        props = resolved.props;
        for (const message of resolved.notices ?? []) onNotice(message);
        for (const refusal of resolved.refused ?? []) {
          if (!reported.has(`${refusal.name} ${refusal.value}`)) {
            reported.add(`${refusal.name} ${refusal.value}`);
            onRefuse(refusal);
          }
        }
      }
      const next = {};
      for (const [name, value] of Object.entries(props)) {
        if (name.startsWith(CONTRACT_PREFIX)) {
          if (!reported.has(name)) {
            reported.add(name);
            onRefuse({ name, value, reason: 'contract knobs need the Eddie contract adapter, which is not installed' });
          }
          continue;
        }
        const check = checkValue(value, typeOf(name));
        if (!check.ok) {
          if (!reported.has(`${name} ${value}`)) {
            reported.add(`${name} ${value}`);
            onRefuse({ name, value, reason: check.reason });
          }
          // Keep the last good value rather than snapping back — taken from
          // the state, not the page, which is empty while held.
          if (name in desired) next[name] = desired[name];
          continue;
        }
        next[name] = value;
      }
      desired = next;
      schedule();
    },
    /**
     * Put the page back exactly as it was, now. Deliberately skips damping: it
     * is the one exit, run when a tab leaves the room. connect().close()
     * unsubscribes before calling it, so nothing renders afterwards.
     */
    destroy() {
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      alive = false;
      desired = {};
      write(plan({}));
    },
    /**
     * Hold the page on its own values ("before") while `on`, then let go back
     * to the room's state ("after"). The room's state is kept throughout.
     * Changes still go through damping, so tapping the key can't flash.
     * @param {boolean} on
     */
    hold(on) {
      if (held === Boolean(on)) return;
      held = Boolean(on);
      cause = 'hold';
      schedule();
    },
  };
}
