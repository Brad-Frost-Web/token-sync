// npm run extension:smoke — load the built extension into real Chrome and check it.
//
// Uses the DevTools protocol over a pipe (Extensions.loadUnpacked needs
// --remote-debugging-pipe and --enable-unsafe-extension-debugging), because
// branded Chrome no longer honours --load-extension. Checks the extension
// loads, its background service worker starts, and the popup renders Eddie.
// Then, on a page that loads Eddie, it runs the content script's notifier in
// an isolated world — where a content script runs, and customElements is
// null — and checks the toast it makes upgrades with the page's ed-toast (#26).
// Set CHROME to point at a different browser binary, and SMOKE_SCREENSHOT=<file.png>
// to save a picture of the popup.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { buildExtension } from './build.js';
import { createNotifier } from '../script/src/eddie.js';

/** A page wearing Eddie, as a site the extension would preview. */
const EDDIE_PAGE = `<!doctype html><html lang="en" class="bfw"><head><meta charset="utf-8"><title>Eddie page</title>
<script type="module" src="https://unpkg.com/@brad-frost-web/eddie-web-components@0.70.0/cdn/eddie.js"></script></head>
<body><main><p>An Eddie page.</p></main></body></html>`;

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function smoke() {
  const path = buildExtension();
  const profile = mkdtempSync(join(tmpdir(), 'token-sync-chrome-'));
  const chrome = spawn(
    CHROME,
    ['--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check'],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  );
  const toChrome = chrome.stdio[3];
  const fromChrome = chrome.stdio[4];
  let nextId = 0;
  const waiting = new Map();
  let buffer = '';
  fromChrome.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let end;
    while ((end = buffer.indexOf('\0')) > -1) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.id !== undefined && waiting.has(message.id)) {
        const { resolve, reject } = waiting.get(message.id);
        waiting.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      waiting.set(id, { resolve, reject });
      toChrome.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
    });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  try {
    const { id } = await send('Extensions.loadUnpacked', { path });
    let worker;
    for (let i = 0; i < 50 && !worker; i += 1) {
      const { targetInfos } = await send('Target.getTargets');
      worker = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${id}/`));
      if (!worker) await sleep(100);
    }
    const { targetId } = await send('Target.createTarget', { url: `chrome-extension://${id}/popup.html` });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    let popup;
    for (let i = 0; i < 50; i += 1) {
      const { result } = await send(
        'Runtime.evaluate',
        {
          expression: `JSON.stringify({ eddie: !!customElements.get('ed-button') && !!customElements.get('ed-text-field'), h1: document.querySelector('h1')?.textContent, status: document.getElementById('status')?.textContent, font: getComputedStyle(document.body).fontFamily })`,
          returnByValue: true,
        },
        sessionId,
      );
      popup = JSON.parse(result.value);
      if (popup.eddie && popup.status && !popup.status.startsWith('Checking')) break;
      await sleep(100);
    }

    if (process.env.SMOKE_SCREENSHOT) {
      await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 720, deviceScaleFactor: 1, mobile: false }, sessionId);
      await sleep(200);
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
      const { writeFileSync } = await import('node:fs');
      writeFileSync(process.env.SMOKE_SCREENSHOT, Buffer.from(data, 'base64'));
    }

    const toast = await toastInIsolatedWorld(send, sleep);

    return { id, workerStarted: Boolean(worker), popup, toast };
  } finally {
    // Chrome keeps writing to its profile until it has really exited.
    const exited = new Promise((resolve) => chrome.once('exit', resolve));
    chrome.kill();
    await exited;
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
}

/**
 * The notifier, run where a content script runs. Chrome's isolated world shares
 * the DOM with the page but not its JavaScript, so window.customElements is
 * null there; an <ed-toast> created there must still upgrade.
 */
async function toastInIsolatedWorld(send, sleep) {
  const server = createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(EDDIE_PAGE));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { targetId } = await send('Target.createTarget', { url: `http://127.0.0.1:${server.address().port}/` });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    let defined = false;
    for (let i = 0; i < 100 && !defined; i += 1) {
      const { result } = await send('Runtime.evaluate', { expression: `!!customElements.get('ed-toast')`, returnByValue: true }, sessionId);
      defined = result.value === true;
      if (!defined) await sleep(100);
    }
    if (!defined) return { pageDefinesToast: false };
    const { frameTree } = await send('Page.getFrameTree', {}, sessionId);
    const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'token-sync-smoke' }, sessionId);
    const notify = `(${createNotifier.toString()})(document)`;
    const { result } = await send(
      'Runtime.evaluate',
      {
        contextId: executionContextId,
        expression: `(() => {
          const isolated = globalThis.customElements == null;
          ${notify}({ moved: ['Nudged content brand 36% darker to stay readable.'], problems: [], unchecked: 0 });
          const toast = document.querySelector('ed-toast');
          return JSON.stringify({ isolated, shown: !!toast, upgraded: !!toast?.shadowRoot, text: toast?.textContent.trim() ?? null });
        })()`,
        returnByValue: true,
      },
      sessionId,
    );

    return { pageDefinesToast: true, ...JSON.parse(result.value) };
  } finally {
    server.close();
  }
}

if (process.argv[1]?.endsWith('smoke.js')) {
  const result = await smoke();
  console.log(JSON.stringify(result, null, 2));
  const toastOk = result.toast?.shown && result.toast?.upgraded;
  const ok = result.workerStarted && result.popup?.eddie && toastOk;
  if (!result.workerStarted) console.error('The background service worker never started.');
  else if (!result.popup?.eddie) console.error('The popup did not render Eddie.');
  else if (!result.toast?.pageDefinesToast) console.error('The Eddie test page never defined ed-toast (is unpkg reachable?).');
  else if (!toastOk) console.error('The notifier, run in an isolated world, did not show an upgraded ed-toast.');
  process.exit(ok ? 0 : 1);
}
