// The controls window: Eddie's theme customizer as a source for the room.
//
// It joins the room on the relay directly, as a controller, and every change
// it makes goes to every tab previewing that room, on this machine or any
// other. Opened from the popup with the room and relay in its URL; it's an
// extension page, so no web page can open it or choose its relay.

import { isRoom } from '../../protocol/src/index.js';
import { createRemoteTransport } from '../../client/src/transports.js';
import { socketUrl } from './hub.js';

/**
 * The room and socket from the controls window's URL.
 * @param {string} search
 * @returns {{ ok: true, room: string, relay: string, socket: string } | { ok: false, error: string }}
 */
export function controlsSettings(search) {
  const params = new URLSearchParams(search);
  const room = params.get('room') ?? '';
  const relay = params.get('relay') ?? '';
  if (!isRoom(room)) return { ok: false, error: 'No room yet. Open this from the Token Sync popup after choosing a room.' };
  try {
    return { ok: true, room, relay, socket: socketUrl(relay, room) };
  } catch {
    return { ok: false, error: "The relay address isn't valid. Open this again from the Token Sync popup." };
  }
}

/**
 * Wrap a transport so what it publishes reaches every page in the room.
 *
 * The customizer scopes each edit to the theme it's editing (`bfw`), and a
 * page wearing another theme ignores it. Showing several products side by
 * side, each in its own theme, means sending to every theme (`*`) instead.
 * @param {{ publish(msg: object): void }} transport
 * @param {() => boolean} everyTheme
 */
export function scopeTo(transport, everyTheme) {
  return new Proxy(transport, {
    get(target, key) {
      if (key === 'publish') return (msg) => target.publish(everyTheme() && msg?.op !== 'snapshot' ? { ...msg, scope: '*' } : msg);
      const value = Reflect.get(target, key);

      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** What the status line says. */
export function controlsStatus({ room, state, error, tabs }) {
  if (state === 'open') {
    const listening = tabs === 0 ? 'No tab in this browser is previewing it yet' : `${tabs} tab${tabs === 1 ? '' : 's'} in this browser ${tabs === 1 ? 'is' : 'are'} previewing it`;

    return `Sending to room “${room}”. ${listening}; tabs on other machines in the room follow too.`;
  }
  if (state === 'connecting') return `Joining room “${room}”…`;

  return `Lost the relay${error ? ` (${error})` : ''}. Trying again…`;
}

export async function startControls({ chrome = globalThis.chrome, document = globalThis.document, location = globalThis.location } = {}) {
  const $ = (id) => document.getElementById(id);
  const settings = controlsSettings(location.search);
  if (!settings.ok) {
    $('status').textContent = settings.error;

    return;
  }
  let everyTheme = true;
  let connection = { state: 'connecting', error: null };
  let tabs = 0;
  const render = () => {
    const text = controlsStatus({ room: settings.room, ...connection, tabs });
    if ($('status').textContent !== text) $('status').textContent = text;
  };
  const transport = createRemoteTransport({
    url: settings.socket,
    onStatus: ({ state }) => ((connection = { ...connection, state }), render()),
    onRelayError: (error) => ((connection = { ...connection, error }), render()),
  });
  $('every-theme').addEventListener('change', (event) => (everyTheme = event.detail?.checked ?? $('every-theme').checked));

  await customElements.whenDefined('ed-r-theme-customizer');
  const customizer = $('customizer');
  customizer.remoteTransport = scopeTo(transport, () => everyTheme);
  customizer.room = settings.room;

  // How many tabs here are listening, from the background.
  const count = () =>
    chrome.runtime
      .sendMessage({ type: 'status' })
      .then(({ session } = {}) => {
        tabs = session?.room === settings.room ? (session.tabIds?.length ?? 0) : 0;
        render();
      })
      .catch(() => {});
  await count();
  setInterval(count, 1500);
}
