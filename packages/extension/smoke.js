// npm run extension:smoke — load the built extension into real Chrome and check it.
//
// Uses the DevTools protocol over a pipe (Extensions.loadUnpacked needs
// --remote-debugging-pipe and --enable-unsafe-extension-debugging), because
// branded Chrome no longer honours --load-extension. Checks the extension
// loads, its background service worker starts, and the popup renders Eddie.
// Set CHROME to point at a different browser binary, and SMOKE_SCREENSHOT=<file.png>
// to save a picture of the popup.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExtension } from './build.js';

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

    return { id, workerStarted: Boolean(worker), popup };
  } finally {
    // Chrome keeps writing to its profile until it has really exited.
    const exited = new Promise((resolve) => chrome.once('exit', resolve));
    chrome.kill();
    await exited;
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
}

if (process.argv[1]?.endsWith('smoke.js')) {
  const result = await smoke();
  console.log(JSON.stringify(result, null, 2));
  const ok = result.workerStarted && result.popup?.eddie;
  if (!ok) console.error(result.workerStarted ? 'The popup did not render Eddie.' : 'The background service worker never started.');
  process.exit(ok ? 0 : 1);
}
