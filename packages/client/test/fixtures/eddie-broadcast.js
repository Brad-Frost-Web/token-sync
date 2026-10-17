// Eddie's broadcast transport, as merged in eddie-design-system#2447
// (packages/eddie-recipes/recipes/tools/theme-customizer/token-sync.ts,
// createBroadcastTransport), with its types taken out. Kept verbatim so the
// interop test runs against what the customizer really sends. If Eddie changes
// it, update this copy and see what breaks.
export function createEddieBroadcastTransport(room) {
  const channel = new BroadcastChannel(`token-sync:${room}`);
  const listeners = new Set();
  channel.onmessage = (event) => {
    for (const listener of listeners) {
      try {
        listener(event.data);
      } catch (error) {
        console.error('token-sync: a room listener threw', error);
      }
    }
  };

  return {
    publish(message) {
      channel.postMessage({ ...message, ts: Date.now() });
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    close() {
      listeners.clear();
      channel.close();
    },
    isPresenter: true,
  };
}
