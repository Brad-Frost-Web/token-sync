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
  const interval = 1000 / maxPerSecond;
  let pending = {};
  let last = -Infinity;
  let timer = null;

  function flush() {
    timer = null;
    const props = pending;
    pending = {};
    if (!Object.keys(props).length) return;
    last = timers.now();
    send(props);
  }

  return {
    /** Queue these values; they go out in the next free slot, merged with anything else queued. */
    push(props) {
      Object.assign(pending, props);
      if (timer !== null) return;
      const wait = last + interval - timers.now();
      if (wait <= 0) flush();
      else timer = timers.setTimeout(flush, wait);
    },
    /** Send anything queued now (on a committed change, or before leaving). */
    flush() {
      if (timer !== null) timers.clearTimeout(timer);
      flush();
    },
  };
}
