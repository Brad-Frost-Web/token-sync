// The extension's service worker (Chromium) / background script (Firefox).
// Wires the hub to the browser's events; the logic lives in hub.js.

import { createHub } from './hub.js';

const hub = createHub({ chrome: globalThis.chrome });

chrome.runtime.onConnect.addListener((port) => hub.onPortConnect(port));
chrome.tabs.onUpdated.addListener((tabId, info, tab) => hub.onTabUpdated(tabId, info, tab));
chrome.tabs.onRemoved.addListener((tabId) => hub.onTabRemoved(tabId));
chrome.runtime.onMessage.addListener((request, _sender, reply) => {
  hub.onMessage(request).then(reply, (error) => reply({ error: error.message }));

  return true; // reply asynchronously
});
hub.restore();
