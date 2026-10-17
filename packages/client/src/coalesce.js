// Coalescing sends from a controller (FEATURE-SPEC §8): dragging a slider or
// scrubbing a colour fires dozens of events a second, and a room with 300
// phones in it can't take 300 × 60 messages a second. This sends at most
// `maxPerSecond` messages, each carrying the latest value of every key that
// changed since the last one. The first change goes at once; the rest wait
// for the next slot.

/**
 * @param {(props: Record<string, string>) => void} send
 * @param {{ maxPerSecond?: number, timers?: { now(): number, setTimeout(fn: () => void, ms: number): unknown, clearTimeout(id: unknown): void } }} [options]
 */
export function createCoalescer(send, {
  maxPerSecond = 10,
  timers = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(/** @type {any} */ (id)) },
} = {}) {
  if (!(maxPerSecond > 0)) throw new Error('token-sync: maxPerSecond must be a positive number');
  const interval = 1000 / maxPerSecond;
  let pending = {};
  /** The last value sent for each key, so a commit repeating it sends nothing. */
  const sent = {};
  let last = -Infinity;
  let timer = null;

  function flush() {
    timer = null;
    const props = pending;
    pending = {};
    if (!Object.keys(props).length) return;
    last = timers.now();
    try {
      send(props);
      Object.assign(sent, props);
    } catch (error) {
      // Keep the values for the next try rather than losing them.
      pending = { ...props, ...pending };
      console.warn(`token-sync: couldn't send — ${error.message}`);
    }
  }

  function schedule() {
    if (timer !== null) return;
    const wait = last + interval - timers.now();
    if (wait <= 0) flush();
    else timer = timers.setTimeout(flush, wait);
  }

  return {
    /** Queue these values; they go out in the next free slot, merged with anything else queued. */
    push(props) {
      for (const [key, value] of Object.entries(props)) {
        if (sent[key] === value && !(key in pending)) continue;
        pending[key] = value;
      }
      schedule();
    },
    /**
     * Send what's queued as soon as the rate allows: now if a slot is free,
     * otherwise at the next one. Never faster than `maxPerSecond`.
     */
    flush: schedule,
    /** Forget what was sent (after a reset, the room no longer holds those values). */
    forget() {
      for (const key of Object.keys(sent)) delete sent[key];
    },
  };
}
