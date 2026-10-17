// What the extension runs in the synced tab: the applier, and nothing else.
//
// Messages come from the background over a port; the same client code as the
// drop-in validates them, keeps last-write-wins state and applies them with
// every guardrail (setProperty only, refusals, damping, hold \ to compare).
// Injected again after each navigation; a second injection into the same
// page is a no-op.

import { connect, createApplier, createWipe, holdToCompare } from '../../client/src/index.js';
import { PORT_NAME } from './constants.js';

export function startContent({ chrome = globalThis.chrome, document = globalThis.document, window = globalThis.window } = {}) {
  if (globalThis.tokenSyncExtension) return globalThis.tokenSyncExtension;
  const port = chrome.runtime.connect({ name: PORT_NAME });
  const listeners = new Set();
  let session = null;
  let stopComparing = () => {};

  const wipe = createWipe({ document });
  const applier = createApplier({
    root: document.documentElement,
    transition: (update, { cause }) => (cause === 'hold' ? wipe(update) : update()),
    onRefuse: ({ name, value, reason }) => console.warn(`token-sync: refused ${name}: ${value} — ${reason}`),
  });

  function leave() {
    stopComparing();
    session?.close();
    session = null;
    delete document.documentElement.dataset.tokenSync;
    globalThis.tokenSyncExtension = null;
  }

  port.onMessage.addListener((frame) => {
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
  });
  // The background stopped or went away: put the page back as it was.
  port.onDisconnect.addListener(leave);

  globalThis.tokenSyncExtension = { leave };

  return globalThis.tokenSyncExtension;
}
