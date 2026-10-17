#!/usr/bin/env node
// token-sync — send token changes from your files (or a stylesheet URL) to a room.
//
//   token-sync relay [--port 8787]
//       Run the Node relay locally (rooms across tabs, browsers and machines).
//
//   token-sync watch <built.css> [--build "<command>" --src <dir>] [options]
//       Watch a built stylesheet and send the custom properties that change.
//       With --build and --src, saving a file under <dir> runs <command> first
//       (your Style Dictionary build, or anything else that writes <built.css>).
//
//   token-sync poll <css-url> [--interval 2000] [options]
//       Fetch a stylesheet on an interval and send what changes. For a CodePen,
//       a deploy preview, anything you can't run a build for.
//
// Options for watch and poll:
//   --relay <url>      the relay (default http://127.0.0.1:8787)
//   --room <code>      the room to send to (default: create one on the relay)
//   --key <key>        that room's presenter key (not needed to send changes)
//   --selector <sel>   only properties declared under this selector, e.g. ":root"
//   --send-initial     send every property once at start, not only changes

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { connect, createRemoteTransport } from '../../client/src/index.js';
import { checkSafety } from '../../protocol/src/index.js';
import { createRelayServer } from '../../relay/node/server.js';
import { diffTokens, tokensFrom } from '../src/css.js';

const DEFAULT_RELAY = 'http://127.0.0.1:8787';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { _: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) options[name] = true;
      else {
        options[name] = next;
        i += 1;
      }
    } else options._.push(arg);
  }

  return { command, options };
}

const log = (message) => console.log(`token-sync: ${message}`);
const fail = (message) => {
  console.error(`token-sync: ${message}`);
  process.exit(1);
};

/** Join a room on the relay as a source, creating the room if none was named. */
async function joinRoom({ relay = DEFAULT_RELAY, room, key }) {
  let created;
  if (!room) {
    const res = await fetch(new URL('/rooms', relay), { method: 'POST' }).catch(() => fail(`can't reach the relay at ${relay}. Start one with: token-sync relay`));
    created = await res.json();
    if (res.status !== 201) fail(`the relay wouldn't create a room: ${created.error}`);
    room = created.room;
    key = created.presenterKey;
  }
  const socket = new URL(`/rooms/${room}/socket`, relay);
  socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:';
  let open;
  const ready = new Promise((resolveReady) => (open = resolveReady));
  const transport = createRemoteTransport({
    url: socket.href,
    presenterKey: key,
    onStatus: ({ state }) => state === 'open' && open(),
    onRelayError: (message) => log(`the relay said: ${message}`),
  });
  const session = connect({ room, transport, role: 'source', onError: ({ errors }) => log(`dropped a message: ${errors.join('; ')}`) });
  await ready;
  if (created) {
    log(`created room "${room}" on ${relay}`);
    log(`presenter key: ${key}  (keep it to reset or lock the room)`);
  } else log(`joined room "${room}" on ${relay}`);

  return session;
}

/** Send the changes, refusing (and saying so) what the protocol would refuse. */
function sendChanges(session, changed, removed) {
  const safe = {};
  for (const [name, value] of Object.entries(changed)) {
    const check = checkSafety(value);
    if (check.ok) safe[name] = value;
    else log(`not sending ${name}: ${check.reason}`);
  }
  for (const name of removed) log(`${name} was removed; tokens can't be un-set over the wire, so pages keep its last value`);
  const names = Object.keys(safe);
  if (!names.length) return;
  // One message may carry at most 500 properties.
  for (let i = 0; i < names.length; i += 500) {
    session.set(Object.fromEntries(names.slice(i, i + 500).map((name) => [name, safe[name]])));
  }
  log(`sent ${names.length} change${names.length === 1 ? '' : 's'}: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}`);
}

/** Run a shell command the user gave us; resolve with whether it succeeded. */
function run(command) {
  return new Promise((resolveRun) => {
    const child = spawn(command, { shell: true, stdio: 'inherit' });
    child.on('exit', (code) => resolveRun(code === 0));
    child.on('error', () => resolveRun(false));
  });
}

/** Call `fn` once things have been quiet for `ms` (editors save in bursts). */
function debounce(fn, ms) {
  let timer;

  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

async function watchCommand(options) {
  const [file] = options._;
  if (!file) fail('usage: token-sync watch <built.css> [--build "<command>" --src <dir>]');
  if (Boolean(options.build) !== Boolean(options.src)) fail('--build and --src go together');
  const target = resolve(file);
  const read = async () => tokensFrom(await readFile(target, 'utf8'), { selector: typeof options.selector === 'string' ? options.selector : undefined });

  let current = await read().catch(() => ({}));
  const session = await joinRoom(options);
  if (options['send-initial']) sendChanges(session, current, []);
  log(`watching ${file}${options.build ? ` (building with "${options.build}" when ${options.src} changes)` : ''}`);

  let busy = false;
  const update = async () => {
    if (busy) return;
    busy = true;
    try {
      const next = await read();
      const { changed, removed } = diffTokens(current, next);
      current = next;
      sendChanges(session, changed, removed);
    } catch (error) {
      log(`couldn't read ${file}: ${error.message}`);
    } finally {
      busy = false;
    }
  };
  // Editors replace files rather than writing them in place, so watch the folder.
  watch(dirname(target), debounce(update, 100)).on('error', (error) => log(error.message));
  if (options.build) {
    const build = debounce(async () => {
      log(`running "${options.build}"`);
      if (await run(options.build)) await update();
      else log('the build failed; nothing sent');
    }, 150);
    watch(resolve(options.src), { recursive: true }, (event, name) => {
      if (name && resolve(options.src, name) !== target) build();
    }).on('error', (error) => log(error.message));
  }
}

async function pollCommand(options) {
  const [url] = options._;
  if (!url) fail('usage: token-sync poll <css-url> [--interval 2000]');
  const interval = Number(options.interval ?? 2000);
  if (!(interval >= 250)) fail('--interval must be at least 250 ms');
  const selector = typeof options.selector === 'string' ? options.selector : undefined;
  const read = async () => {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    return tokensFrom(await res.text(), { selector });
  };

  let current = await read().catch((error) => fail(`couldn't fetch ${url}: ${error.message}`));
  const session = await joinRoom(options);
  if (options['send-initial']) sendChanges(session, current, []);
  log(`polling ${url} every ${interval} ms`);
  setInterval(async () => {
    try {
      const next = await read();
      const { changed, removed } = diffTokens(current, next);
      current = next;
      sendChanges(session, changed, removed);
    } catch (error) {
      log(`couldn't fetch ${url}: ${error.message}`);
    }
  }, interval);
}

function relayCommand(options) {
  const port = Number(options.port ?? 8787);
  const host = typeof options.host === 'string' ? options.host : '127.0.0.1';
  createRelayServer().server.listen(port, host, () => log(`relay on http://${host}:${port}`));
}

const { command, options } = parseArgs(process.argv.slice(2));
if (command === 'watch') await watchCommand(options);
else if (command === 'poll') await pollCommand(options);
else if (command === 'relay') relayCommand(options);
else {
  console.log('usage: token-sync <relay|watch|poll> …  (see the top of packages/cli/bin/token-sync.js)');
  process.exit(command ? 1 : 0);
}
