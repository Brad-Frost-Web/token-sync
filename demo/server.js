// The local demo server: `npm start`, then open http://127.0.0.1:4321/.
//
// Serves the demo pages and the packages' source as plain ES modules — no
// build step. Binds 127.0.0.1 only (AGENTS.md §3).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 4321);
// Only these trees are served. Nothing else in the repo is reachable.
const SERVED = [`demo${sep}`, `packages${sep}`];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', `http://${HOST}`);
  if (pathname === '/') {
    res.writeHead(302, { location: '/demo/source.html' }).end();

    return;
  }
  const relative = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, '');
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
});
