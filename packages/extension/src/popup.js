// The popup: choose a room and relay, preview this tab, manage allowed sites.

import { permissionFor, siteOf } from './allowlist.js';

const $ = (id) => document.getElementById(id);
const ask = (request) =>
  chrome.runtime.sendMessage(request).then((reply) => {
    if (reply?.error) throw new Error(reply.error);

    return reply;
  });
const LAST_KEY = 'token-sync:last';

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  return tab;
}

function say(text) {
  if ($('status').textContent !== text) $('status').textContent = text;
}

async function render() {
  const tab = await activeTab();
  const { session, status, lists } = await ask({ type: 'status' });
  const here = session && tab && session.tabId === tab.id;
  const site = siteOf(tab?.url ?? '');
  $('sync').disabled = !site;
  $('stop').disabled = !session;
  if (!site) say("This page can't be previewed. Token Sync works on http and https pages.");
  else if (here) say(`Previewing room “${session.room}” on this tab (${status.state}${status.error ? `: ${status.error}` : ''}). Hold \\ on the page to compare.`);
  else if (session) say(`Another tab is previewing room “${session.room}”. Previewing this one stops that.`);
  else say(`Not previewing. ${site} will be added to the room's allowed sites.`);

  const room = $('room').value || session?.room;
  const sites = $('sites');
  sites.replaceChildren();
  const listed = (room && lists[room]) || [];
  if (!listed.length) {
    const none = document.createElement('ed-text-passage');
    none.innerHTML = '<p>None yet.</p>';
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
    remove.addEventListener('click', async () => {
      await ask({ type: 'forget-site', room, site: allowed });
      render();
    });
    row.append(label, remove);
    sites.append(row);
  }
}

async function start() {
  const saved = (await chrome.storage.local.get(LAST_KEY))[LAST_KEY];
  const { session } = await ask({ type: 'status' });
  $('room').value = session?.room ?? saved?.room ?? '';
  $('relay').value = session?.relay ?? saved?.relay ?? $('relay').value;

  $('sync').addEventListener('click', async () => {
    const tab = await activeTab();
    const site = siteOf(tab?.url ?? '');
    const room = String($('room').value).trim();
    const relay = String($('relay').value).trim();
    if (!site) return;
    try {
      // Ask for this one site, now, while the click still counts as the person's choice.
      const granted = await chrome.permissions.request({ origins: [permissionFor(site)] });
      if (!granted) {
        say(`Token Sync needs permission for ${site} to preview it. Nothing changed.`);

        return;
      }
      await chrome.storage.local.set({ [LAST_KEY]: { room, relay } });
      await ask({ type: 'sync', tabId: tab.id, url: tab.url, room, relay });
    } catch (error) {
      say(`Couldn't start: ${error.message}`);

      return;
    }
    render();
  });
  $('stop').addEventListener('click', async () => {
    await ask({ type: 'stop' });
    render();
  });
  $('room').addEventListener('input', () => render());
  await render();
  setInterval(render, 1500); // connection state changes while the popup is open
}

start();
