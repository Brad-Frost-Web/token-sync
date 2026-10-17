// The popup: choose a room and relay, preview this tab, manage allowed sites.

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

async function render() {
  try {
    const { session, status, lists } = await ask({ type: 'status' });
    const here = session && tab && session.tabId === tab.id;
    const site = siteOf(tab?.url ?? '');
    $('sync').disabled = !site;
    $('stop').disabled = !session;
    if (!site) say("This page can't be previewed. Token Sync works on http and https pages.");
    else if (here) say(`Previewing room “${session.room}” on this tab (${status.state}${status.error ? `: ${status.error}` : ''}). Hold \\ on the page to compare.`);
    else if (session) say(`Another tab is previewing room “${session.room}”. Previewing this one stops that.`);
    else if (status.error) say(status.error);
    else say(`Not previewing. ${site} will be added to the room's allowed sites.`);
    const room = String($('room').value).trim() || session?.room;
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

async function start() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const saved = (await chrome.storage.local.get(LAST_KEY))[LAST_KEY];
  const { session } = await ask({ type: 'status' }).catch(() => ({}));
  $('room').value = session?.room ?? saved?.room ?? '';
  $('relay').value = session?.relay ?? saved?.relay ?? $('relay').value;

  $('form').addEventListener('submit', startPreview);
  $('stop').addEventListener('click', () => ask({ type: 'stop' }).then(render, (error) => say(`Couldn't stop: ${error.message}`)));
  $('room').addEventListener('input', render);
  await render();
  setInterval(render, 1500); // connection state changes while the popup is open
}

start();
