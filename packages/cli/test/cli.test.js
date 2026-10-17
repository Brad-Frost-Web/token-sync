// Runs the real CLI as a child process against a real relay (AGENTS.md §2.13).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, createRemoteTransport } from '../../client/src/index.js';
import { createRelayServer } from '../../relay/node/server.js';

const BIN = fileURLToPath(new URL('../bin/token-sync.js', import.meta.url));

async function until(check, ms = 8000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function relayWithRoom(t) {
  const relay = createRelayServer();
  await new Promise((resolve) => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(() => relay.close());
  const { room } = relay.createRoom().body;

  return { room, http: `http://127.0.0.1:${relay.server.address().port}` };
}

/** A page in the room, as far as the room can tell. */
async function watcher(t, http, room) {
  const url = `${http.replace('http', 'ws')}/rooms/${room}/socket`;
  let open = false;
  const session = connect({ room, transport: createRemoteTransport({ url, onStatus: (s) => (open = s.state === 'open') }) });
  t.after(() => session.close());
  await until(() => open);

  return session;
}

function cli(t, args) {
  const child = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  t.after(() => child.kill());

  return { output: () => output };
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'token-sync-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  return dir;
}

test('watch: saving the built stylesheet sends only what changed', async (t) => {
  const { room, http } = await relayWithRoom(t);
  const dir = tempDir(t);
  const css = join(dir, 'tokens.css');
  writeFileSync(css, ':root { --brand: #be6700; --radius: 4px; }');
  const page = await watcher(t, http, room);
  const run = cli(t, ['watch', css, '--relay', http, '--room', room]);
  await until(() => run.output().includes('watching'));
  writeFileSync(css, ':root { --brand: #0a7f5a; --radius: 4px; }');
  await until(() => page.props()['--brand'] === '#0a7f5a');
  assert.equal(page.props()['--radius'], undefined); // unchanged, so not sent
});

test('watch --build: saving a source file runs the build, then sends its output', async (t) => {
  const { room, http } = await relayWithRoom(t);
  const dir = tempDir(t);
  const src = join(dir, 'src');
  const css = join(dir, 'tokens.css');
  writeFileSync(css, ':root { --brand: #be6700; }');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(src);
  writeFileSync(join(src, 'brand.json'), '{"brand":"#be6700"}');
  // A stand-in for a Style Dictionary build: read the JSON, write the CSS.
  const build = `"${process.execPath}" -e "const fs=require('fs');const b=JSON.parse(fs.readFileSync('${join(src, 'brand.json')}','utf8')).brand;fs.writeFileSync('${css}',':root{--brand:'+b+';}')"`;
  const page = await watcher(t, http, room);
  const run = cli(t, ['watch', css, '--build', build, '--src', src, '--relay', http, '--room', room]);
  await until(() => run.output().includes('watching'));
  writeFileSync(join(src, 'brand.json'), '{"brand":"#283593"}');
  await until(() => page.props()['--brand'] === '#283593');
});

test('watch refuses to send what the protocol refuses, and says why', async (t) => {
  const { room, http } = await relayWithRoom(t);
  const dir = tempDir(t);
  const css = join(dir, 'tokens.css');
  writeFileSync(css, ':root { --hero: none; --brand: #be6700; }');
  const page = await watcher(t, http, room);
  const run = cli(t, ['watch', css, '--relay', http, '--room', room]);
  await until(() => run.output().includes('watching'));
  writeFileSync(css, ':root { --hero: url(https://example.com/x.png); --brand: #111111; }');
  await until(() => page.props()['--brand'] === '#111111');
  assert.equal(page.props()['--hero'], undefined);
  assert.match(run.output(), /not sending --hero: url\( is refused/);
});

test('poll: a stylesheet that changes at its URL is followed', async (t) => {
  const { room, http } = await relayWithRoom(t);
  let sheet = ':root { --brand: #be6700; }';
  const server = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/css' }).end(sheet));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const page = await watcher(t, http, room);
  const run = cli(t, ['poll', `http://127.0.0.1:${server.address().port}/tokens.css`, '--interval', '250', '--relay', http, '--room', room]);
  await until(() => run.output().includes('polling'));
  sheet = ':root { --brand: #6a1b9a; }';
  await until(() => page.props()['--brand'] === '#6a1b9a');
});

test('with no --room, watch creates one and prints its presenter key', async (t) => {
  const { http } = await relayWithRoom(t);
  const dir = tempDir(t);
  const css = join(dir, 'tokens.css');
  writeFileSync(css, ':root { --brand: #be6700; }');
  const run = cli(t, ['watch', css, '--relay', http]);
  await until(() => run.output().includes('presenter key'));
  assert.match(run.output(), /created room "[a-z2-9]{6}"/);
});

test('a stylesheet the size of Eddie\'s arrives in full, split into frames the relay takes', async (t) => {
  const { room, http } = await relayWithRoom(t);
  const dir = tempDir(t);
  const css = join(dir, 'tokens.css');
  const decls = Array.from({ length: 700 }, (_, i) => `--ed-theme-color-background-default-${i}: #ffffff;`).join('\n');
  writeFileSync(css, `:root {\n${decls}\n}`);
  const page = await watcher(t, http, room);
  const run = cli(t, ['watch', css, '--send-initial', '--relay', http, '--room', room]);
  await until(() => Object.keys(page.props()).length === 700, 15000);
  assert.doesNotMatch(run.output(), /frames may be at most/);
});

test('a room that does not exist fails clearly instead of hanging', async (t) => {
  const { http } = await relayWithRoom(t);
  const dir = tempDir(t);
  const css = join(dir, 'tokens.css');
  writeFileSync(css, ':root { --a: 1px; }');
  const child = spawn(process.execPath, [BIN, 'watch', css, '--relay', http, '--room', 'nope'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let output = '';
  child.stderr.on('data', (d) => (output += d));
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 1);
  assert.match(output, /couldn't join room "nope"/);
});
