// The local demo server: `npm start`, then open http://127.0.0.1:4321/.
//
// Serves the demo pages and the packages' source as plain ES modules — no
// build step. Binds 127.0.0.1 only (AGENTS.md §3).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bookmarkletUrl, tokenSyncScript } from '../packages/bookmarklet/build.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 4321);
// Only these trees are served. Nothing else in the repo is reachable.
const SERVED = [`demo${sep}`, `packages${sep}`];
const escapeAttribute = (value) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// Built from source on every request, so the demo can never serve a stale build.
const GENERATED = {
  '/dist/token-sync.js': () => ({ type: 'text/javascript; charset=utf-8', body: tokenSyncScript() }),
  '/demo/bookmarklet.html': async () => ({
    type: 'text/html; charset=utf-8',
    body: (await readFile(join(ROOT, 'demo/bookmarklet.html'), 'utf8')).replace('{{BOOKMARKLET_URL}}', escapeAttribute(bookmarkletUrl())),
  }),
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', `http://${HOST}`);
  if (pathname === '/') {
    res.writeHead(302, { location: '/demo/source.html' }).end();

    return;
  }
  if (pathname in GENERATED) {
    try {
      const { type, body } = await GENERATED[pathname]();
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(`Build failed: ${error.message}`);
    }

    return;
  }
  let relative;
  try {
    relative = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '');
  } catch {
    // A malformed escape (%E0) throws; answer it rather than crash the server.
    res.writeHead(400, { 'content-type': 'text/plain' }).end('Bad request');

    return;
  }
  const allowed = SERVED.some((prefix) => relative.startsWith(prefix)) && !relative.split(sep).includes('..');
  if (!allowed || !(extname(relative) in TYPES)) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');

    return;
  }
  try {
    const body = await readFile(join(ROOT, relative));
    res.writeHead(200, { 'content-type': TYPES[extname(relative)], 'cache-control': 'no-store' }).end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Token Sync demo: http://${HOST}:${PORT}/`);
  console.log(`  source: http://${HOST}:${PORT}/demo/source.html`);
  console.log(`  target: http://${HOST}:${PORT}/demo/target.html?token-sync=demo`);
  console.log(`  bookmarklet: http://${HOST}:${PORT}/demo/bookmarklet.html`);
});
