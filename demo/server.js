// The local demo server: `npm start`, then open http://127.0.0.1:4321/.
//
// Serves the demo pages and the packages' source as plain ES modules — no
// build step. Binds 127.0.0.1 by default, so nothing else can reach it.
// HOST=0.0.0.0 npm start opts in to the local network, to try the phone
// remote on a real phone; it prints the addresses to open.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { bookmarkletUrl } from '../packages/bookmarklet/build.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 4321);
// Only these trees are served. Nothing else in the repo is reachable. (Eddie's
// contract module is served so the unbundled drop-in can import it.)
const SERVED = [
  `demo${sep}`,
  `packages${sep}`,
  ['node_modules', '@brad-frost-web', 'eddie-design-tokens', 'contract', ''].join(sep),
  // Eddie's unreleased develop build, from npm run eddie:develop (only its dist/).
  ['.eddie-develop', 'dist', ''].join(sep),
];
const EDDIE_DEVELOP = join(ROOT, '.eddie-develop', 'COMMIT');
const escapeAttribute = (value) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// Built from source on every request, so the demo can never serve a stale build.
const GENERATED = {
  // The customizer needs Eddie develop; without the build, say how to make it.
  '/demo/customizer.html': async () => {
    try {
      await readFile(EDDIE_DEVELOP, 'utf8');
    } catch {
      return {
        type: 'text/plain; charset=utf-8',
        body: [
          "Eddie's customizer joins rooms from eddie-design-system#2447, which isn't in a release yet.",
          '',
          'Build Eddie develop for the demo (a few minutes; your Eddie checkout is not touched):',
          '',
          '  npm run eddie:develop',
          '',
          'Then reload this page. See TESTING.md.',
        ].join('\n'),
      };
    }

    return { type: 'text/html; charset=utf-8', body: await readFile(join(ROOT, 'demo/customizer.html'), 'utf8') };
  },
  '/demo/bookmarklet.html': async () => ({
    type: 'text/html; charset=utf-8',
    body: (await readFile(join(ROOT, 'demo/bookmarklet.html'), 'utf8')).replace('{{BOOKMARKLET_URL}}', escapeAttribute(bookmarkletUrl())),
  }),
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  // A fixed base: HOST may be an IPv6 address (::), which isn't a valid URL host as written.
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (pathname === '/') {
    res.writeHead(302, { location: '/demo/source.html' }).end();

    return;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape (%E0) throws; answer it rather than crash the server.
    res.writeHead(400, { 'content-type': 'text/plain' }).end('Bad request');

    return;
  }
  // Matched without case: macOS serves /demo/Customizer.html from the same
  // file, and that must not skip the generated route.
  const generated = Object.keys(GENERATED).find((path) => path.toLowerCase() === decoded.toLowerCase());
  if (generated) {
    try {
      const { type, body } = await GENERATED[generated]();
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(`Build failed: ${error.message}`);
    }

    return;
  }
  const relative = normalize(decoded).replace(/^[/\\]+/, '');
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

/** This machine's addresses on the local network, for a phone to open. */
function lanAddresses(interfaces = networkInterfaces()) {
  return Object.values(interfaces)
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

server.listen(PORT, HOST, () => {
  const everywhere = HOST === '0.0.0.0' || HOST === '::';
  const open = everywhere ? '127.0.0.1' : HOST.includes(':') ? `[${HOST}]` : HOST;
  console.log(`Token Sync demo: http://${open}:${PORT}/`);
  console.log(`  source: http://${open}:${PORT}/demo/source.html`);
  console.log(`  target: http://${open}:${PORT}/demo/target.html?token-sync=demo`);
  console.log(`  bookmarklet: http://${open}:${PORT}/demo/bookmarklet.html`);
  console.log(`  customizer: http://${open}:${PORT}/demo/customizer.html (needs a local Eddie build, see TESTING.md)`);
  if (everywhere) {
    console.log('  Reachable from your local network. On a phone on the same wifi, open:');
    for (const address of lanAddresses()) console.log(`    http://${address}:${PORT}/`);
  }
});
