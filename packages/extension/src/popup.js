// The popup: choose a room and relay, add this tab to it, manage allowed sites.

import { isRoom } from '../../protocol/src/index.js';
import { permissionFor, siteOf } from './allowlist.js';

const $ = (id) => document.getElementById(id);
const ask = (request) =>
  chrome.runtime.sendMessage(request).then((reply) => {
    if (reply?.error) throw new Error(reply.error);

    return reply;
  });
const LAST_KEY = 'token-sync:last';

/** The tab the popup was opened on, read once up front so the click handler can ask for permission straight away. */
let tab = null;
let listedKey = '';

function say(text) {
  if ($('status').textContent !== text) $('status').textContent = text;
}

function renderSites(room, listed) {
  // Rebuilding the list would throw away keyboard focus on a Remove button;
  // only rebuild when the list itself changed.
  const key = `${room}|${listed.join(',')}`;
  if (key === listedKey) return;
  listedKey = key;
  const sites = $('sites');
  sites.replaceChildren();
  if (!listed.length) {
    const none = document.createElement('ed-text-passage');
    none.append(Object.assign(document.createElement('p'), { textContent: 'None yet.' }));
    sites.append(none);
  }
  for (const allowed of listed) {
    const row = document.createElement('ed-cluster');
    row.setAttribute('justify', 'between');
    const label = document.createElement('ed-text-passage');
    label.append(Object.assign(document.createElement('p'), { textContent: allowed }));
    const remove = document.createElement('ed-button');
    remove.setAttribute('size', 'sm');
    remove.setAttribute('text', `Remove ${allowed}`);
    remove.addEventListener('click', () => ask({ type: 'forget-site', room, site: allowed }).then(render, (error) => say(`Couldn't remove ${allowed}: ${error.message}`)));
    row.append(label, remove);
    sites.append(row);
  }
}

/** “1 tab”, “3 other tabs”. */
function tabsLabel(count, adjective = '') {
  return `${count} ${adjective ? `${adjective} ` : ''}tab${count === 1 ? '' : 's'}`;
}

async function render() {
  try {
    const { session, status, lists } = await ask({ type: 'status' });
    const tabIds = session?.tabIds ?? [];
    const here = Boolean(tab && tabIds.includes(tab.id));
    const others = tabIds.length - (here ? 1 : 0);
    const site = siteOf(tab?.url ?? '');
    const typed = String($('room').value).trim();
    const switching = Boolean(session && typed && typed !== session.room);
    const connection = `${status.state}${status.error ? `: ${status.error}` : ''}`;
    $('sync').disabled = !site || (here && !switching);
    $('sync').setAttribute('text', session && !switching ? 'Add this tab to the room' : 'Preview this tab in the room');
    $('stop').disabled = !here;
    $('stop-all').disabled = !session;
    $('controls').disabled = !(session?.room || isRoom(typed));
    $('stop-all').setAttribute('text', tabIds.length > 1 ? `Stop all ${tabIds.length} tabs` : 'Stop every tab');
    if (!site) say("This page can't be previewed. Token Sync works on http and https pages.");
    else if (switching) say(`Switching to room “${typed}” stops the ${tabsLabel(tabIds.length)} in room “${session.room}”.`);
    else if (here) say(`Previewing room “${session.room}” on this tab${others ? ` and ${tabsLabel(others, 'other')}, all updating together` : ''} (${connection}). Hold \\ on a page to compare.`);
    else if (session) say(`Room “${session.room}” is live on ${tabsLabel(tabIds.length)} (${connection}). Add this one and it updates with them.`);
    else if (status.error) say(status.error);
    else say(`Not previewing. ${site} will be added to the room's allowed sites.`);
    const room = typed || session?.room;
    renderSites(room, (room && lists[room]) || []);
  } catch (error) {
    say(`The extension's background isn't answering (${error.message}). Close and reopen this popup.`);
  }
}

function startPreview(event) {
  event.preventDefault();
  const site = siteOf(tab?.url ?? '');
  const room = String($('room').value).trim();
  const relay = String($('relay').value).trim();
  if (!site) return;
  // Ask for this one site first, synchronously inside the click: Firefox only
  // honours the request there. The prompt may close this popup, so the
  // background is told what to do once the permission arrives.
  const granted = chrome.permissions.request({ origins: [permissionFor(site)] });
  ask({ type: 'sync', tabId: tab.id, url: tab.url, room, relay }).catch((error) => say(`Couldn't start: ${error.message}`));
  chrome.storage.local.set({ [LAST_KEY]: { room, relay } });
  granted.then(
    (yes) => (yes ? render() : say(`Token Sync needs permission for ${site} to preview it. Nothing changed.`)),
    (error) => say(`Couldn't ask for permission: ${error.message}`),
  );
}

/** The controls window, for the room being previewed (or the one typed in). */
async function openControls() {
  const { session } = await ask({ type: 'status' }).catch(() => ({}));
  const typed = String($('room').value).trim();
  const room = typed || session?.room;
  const relay = typed && typed !== session?.room ? String($('relay').value).trim() : (session?.relay ?? String($('relay').value).trim());
  const url = chrome.runtime.getURL(`controls.html?${new URLSearchParams({ room, relay })}`);
  await chrome.windows.create({ url, type: 'popup', width: 480, height: 900 }).catch(() => chrome.tabs.create({ url }));
}

async function start() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const saved = (await chrome.storage.local.get(LAST_KEY))[LAST_KEY];
  const { session } = await ask({ type: 'status' }).catch(() => ({}));
  $('room').value = session?.room ?? saved?.room ?? '';
  $('relay').value = session?.relay ?? saved?.relay ?? $('relay').value;

  $('form').addEventListener('submit', startPreview);
  $('stop').addEventListener('click', () => ask({ type: 'stop', tabId: tab.id }).then(render, (error) => say(`Couldn't stop: ${error.message}`)));
  $('controls').addEventListener('click', openControls);
  $('stop-all').addEventListener('click', () => ask({ type: 'stop' }).then(render, (error) => say(`Couldn't stop: ${error.message}`)));
  $('room').addEventListener('input', render);
  await render();
  setInterval(render, 1500); // connection state changes while the popup is open
}

start();
