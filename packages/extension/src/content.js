// What the extension runs in the synced tab: the applier, and nothing else.
//
// Messages come from the background over a port; the same client code as the
// drop-in validates them, keeps last-write-wins state and applies them with
// every guardrail (setProperty only, refusals, damping, hold \ to compare).
// Injected again after each navigation; a second injection into the same
// page is a no-op.

import { connect, createApplier, createWipe, holdToCompare } from '../../client/src/index.js';
import { PORT_NAME } from './constants.js';

const HEARTBEAT_MS = 20000;
const RECONNECT_ATTEMPTS = 5;

export function startContent({ chrome = globalThis.chrome, document = globalThis.document, window = globalThis.window, timers = globalThis } = {}) {
  if (globalThis.tokenSyncExtension) return globalThis.tokenSyncExtension;
  const listeners = new Set();
  let session = null;
  let stopComparing = () => {};
  let port = null;
  let heartbeat = null;
  let stopped = false;
  let attempts = 0;

  const wipe = createWipe({ document });
  const applier = createApplier({
    root: document.documentElement,
    transition: (update, { cause }) => (cause === 'hold' ? wipe(update) : update()),
    onRefuse: ({ name, value, reason }) => console.warn(`token-sync: refused ${name}: ${value} — ${reason}`),
  });

  function leave() {
    stopped = true;
    timers.clearInterval(heartbeat);
    stopComparing();
    session?.close();
    session = null;
    delete document.documentElement.dataset.tokenSync;
    globalThis.tokenSyncExtension = null;
  }

  function open() {
    port = chrome.runtime.connect({ name: PORT_NAME });
    port.onMessage.addListener(onFrame);
    // The background went away. If it was stopped for being idle it comes
    // back on the next connect, and replays the room: try a few times before
    // putting the page back.
    port.onDisconnect.addListener(() => {
      timers.clearInterval(heartbeat);
      if (stopped) return;
      attempts += 1;
      if (attempts > RECONNECT_ATTEMPTS) leave();
      else timers.setTimeout(open, 250 * attempts);
    });
    // Messages on the port keep the background alive while this tab is synced.
    heartbeat = timers.setInterval(() => {
      try {
        port.postMessage({ kind: 'beat' });
      } catch {
        // The disconnect handler deals with it.
      }
    }, HEARTBEAT_MS);
  }

  function onFrame(frame) {
    attempts = 0;
    if (frame?.kind === 'config' && !session) {
      session = connect({
        room: frame.room,
        role: 'controller',
        applier,
        transport: {
          publish: (msg) => msg, // this page only applies
          subscribe: (fn) => {
            listeners.add(fn);

            return () => listeners.delete(fn);
          },
          close: () => listeners.clear(),
        },
        onError: ({ errors }) => console.warn(`token-sync: dropped a message — ${errors.join('; ')}`),
      });
      stopComparing = holdToCompare(applier, { target: window });
      document.documentElement.dataset.tokenSync = frame.room;
    } else if (frame?.kind === 'msg') {
      for (const fn of listeners) fn(frame.msg);
    } else if (frame?.kind === 'stop') {
      leave();
      port.disconnect();
    }
  }

  open();
  globalThis.tokenSyncExtension = { leave };

  return globalThis.tokenSyncExtension;
}
