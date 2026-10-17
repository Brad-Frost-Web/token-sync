// The extension's service worker (Chromium) / background script (Firefox).
// Wires the hub to the browser's events; the logic lives in hub.js.
//
// The background can be stopped when idle and started again by the next
// event. Every listener waits for restore() first, so an event that wakes it
// is handled with the session it had, not as if there were none.

import { createHub } from './hub.js';

const hub = createHub({ chrome: globalThis.chrome });
const ready = hub.restore().catch(() => {});
const after = (fn) => (...args) => ready.then(() => fn(...args));

chrome.runtime.onConnect.addListener(after((port) => hub.onPortConnect(port)));
chrome.tabs.onUpdated.addListener(after((tabId, info, tab) => hub.onTabUpdated(tabId, info, tab)));
chrome.tabs.onRemoved.addListener(after((tabId) => hub.onTabRemoved(tabId)));
chrome.permissions.onAdded.addListener(after((permissions) => hub.onPermissionsAdded(permissions)));
chrome.runtime.onMessage.addListener((request, sender, reply) => {
  ready.then(() => hub.onMessage(request, sender)).then(reply, (error) => reply({ error: error.message }));

  return true; // reply asynchronously
});
