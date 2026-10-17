#!/usr/bin/env node
// token-sync — send token changes from your files (or a stylesheet URL) to a room.
//
//   token-sync relay [--port 8787]
//       Run the Node relay locally (rooms across tabs, browsers and machines).
//
//   token-sync watch <built.css> [--build "<command>" --src <dir>[,<dir>…]] [options]
//       Watch a built stylesheet and send the custom properties that change.
//       With --build and --src, saving a file under a source folder runs
//       <command> first (your Style Dictionary build, or anything else that
//       writes <built.css>). Changes inside the stylesheet's own folder and
//       inside build/, dist/, node_modules/ and .git/ never start a build, so
//       a build that writes output under a source folder can't loop.
//
//   token-sync poll <css-url> [--interval 2000] [--header "Name: value"] [options]
//       Fetch a stylesheet on an interval and send what changes. For a
//       CodePen (https://codepen.io/<user>/pen/<id>.css), a deploy preview,
//       anything you can't run a build for. --header for a protected preview.
//
// Options for watch and poll (--name value or --name=value):
//   --relay <url>      the relay (default http://127.0.0.1:8787)
//   --room <code>      the room to send to (default: create one on the relay)
//   --key <key>        that room's presenter key (not needed to send changes)
//   --selector <sel>   only properties declared under this selector, e.g. ":root"
//   --send-initial     send every property once at start, not only changes

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, createRemoteTransport } from '../../client/src/index.js';
import { checkSafety, isPropKey } from '../../protocol/src/index.js';
import { MAX_FRAME_LENGTH } from '../../relay/src/room.js';
import { createRelayServer } from '../../relay/node/server.js';
import { diffTokens, tokensFrom } from '../src/css.js';

const DEFAULT_RELAY = 'http://127.0.0.1:8787';
const FLAGS = new Set(['send-initial']);
const IGNORED_DIRS = new Set(['build', 'dist', 'node_modules', '.git']);
/** Room for the frame's envelope (kind, room, op, from) around the props. */
const FRAME_BUDGET = MAX_FRAME_LENGTH - 512;
const MAX_PROPS_PER_MESSAGE = 500;

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { _: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      options._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > -1) {
      options[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const name = arg.slice(2);
    if (FLAGS.has(name)) options[name] = true;
    else if (rest[i + 1] === undefined) options[name] = true;
    else {
      options[name] = rest[i + 1];
      i += 1;
    }
  }

  return { command, options };
}

const log = (message) => console.log(`token-sync: ${message}`);
const fail = (message) => {
  console.error(`token-sync: ${message}`);
  process.exit(1);
};
const text = (value, name) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(`--${name} needs a value`);

  return value;
};

/** Join a room on the relay as a source, creating the room if none was named. */
async function joinRoom(options) {
  const relay = text(options.relay, 'relay') ?? DEFAULT_RELAY;
  let room = text(options.room, 'room');
  let key = text(options.key, 'key');
  let created = false;
  if (!room) {
    let res;
    let body;
    try {
      res = await fetch(new URL('/rooms', relay), { method: 'POST' });
      body = await res.json();
    } catch {
      fail(`can't reach a relay at ${relay}. Start one with: token-sync relay`);
    }
    if (res.status !== 201) fail(`the relay wouldn't create a room: ${body?.error ?? res.status}`);
    ({ room, presenterKey: key } = body);
    created = true;
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
  const timeout = setTimeout(() => fail(`couldn't join room "${room}" on ${relay} within 10 s. Does the room exist?`), 10000);
  await ready;
  clearTimeout(timeout);
  if (created) {
    log(`created room "${room}" on ${relay}`);
    log(`presenter key: ${key}  (keep it to reset or lock the room)`);
  } else log(`joined room "${room}" on ${relay}`);

  return session;
}

/**
 * Split changes into messages the relay will take: at most 500 properties,
 * and a frame under the relay's size limit.
 * @param {string} room
 * @param {[string, string][]} entries
 */
export function chunk(room, entries) {
  const chunks = [];
  let current = {};
  const size = (props) => JSON.stringify({ kind: 'msg', msg: { v: 1, room, op: 'set', from: 'source', props } }).length;
  for (const [name, value] of entries) {
    const next = { ...current, [name]: value };
    if (Object.keys(current).length && (Object.keys(next).length > MAX_PROPS_PER_MESSAGE || size(next) > FRAME_BUDGET)) {
      chunks.push(current);
      current = { [name]: value };
    } else current = next;
  }
  if (Object.keys(current).length) chunks.push(current);

  return chunks;
}

/**
 * Send the changes, refusing (and saying so) what the protocol would refuse.
 * Returns false if a send failed, so the caller keeps its old baseline and
 * the change is tried again next time rather than lost.
 */
function sendChanges(session, changed, removed) {
  const entries = [];
  for (const [name, value] of Object.entries(changed)) {
    if (!isPropKey(name)) {
      log(`not sending ${name}: not a custom property name the protocol accepts (letters, digits, - and _, up to 120)`);
      continue;
    }
    const check = checkSafety(value);
    if (check.ok) entries.push([name, value]);
    else log(`not sending ${name}: ${check.reason}`);
  }
  for (const name of removed) log(`${name} was removed; tokens can't be un-set over the wire, so pages keep its last value`);
  if (!entries.length) return true;
  try {
    for (const props of chunk(session.room, entries)) session.set(props);
  } catch (error) {
    log(`couldn't send: ${error.message}`);

    return false;
  }
  const names = entries.map(([name]) => name);
  log(`sent ${names.length} change${names.length === 1 ? '' : 's'}: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}`);

  return true;
}

/** Run a shell command the user gave us (like an npm script); resolve with whether it succeeded. */
function run(command) {
  return new Promise((resolveRun) => {
    const child = spawn(command, { shell: true, stdio: 'inherit' });
    child.on('exit', (code) => resolveRun(code === 0));
    child.on('error', () => resolveRun(false));
  });
}

/** Run `task` now, or once more after the run in progress, never two at once and never dropping a request. */
function serial(task) {
  let running = false;
  let again = false;
  const go = async () => {
    if (running) {
      again = true;

      return;
    }
    running = true;
    try {
      do {
        again = false;
        await task();
      } while (again);
    } finally {
      running = false;
    }
  };

  return go;
}

/** Call `fn` once things have been quiet for `ms` (editors save in bursts). */
function debounce(fn, ms) {
  let timer;

  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

/**
 * Should a change at `path` (under the source folder `root`) start a build?
 * Not for the stylesheet itself, not for anything in a build/, dist/,
 * node_modules/ or .git/ folder, and — when the build writes into the source
 * folder — not for anything in the stylesheet's own folder.
 */
export function startsBuild(root, path, target) {
  if (path === target) return false;
  const targetDir = dirname(target);
  const outputInsideSource = targetDir.startsWith(root + sep);
  if (outputInsideSource && path.startsWith(targetDir + sep)) return false;

  return !relative(root, path).split(sep).some((part) => IGNORED_DIRS.has(part));
}

/** Follow a token source: compare each read with the last good one, and send what changed. */
function follower(session, read, describe) {
  let current = null;

  return {
    async start(sendInitial) {
      current = await read();
      if (sendInitial) sendChanges(session, current, []);
    },
    async update() {
      let next;
      try {
        next = await read();
      } catch (error) {
        log(`couldn't read ${describe}: ${error.message}`);

        return;
      }
      // A stylesheet caught half-written reads as nearly empty; don't treat that as every token being deleted.
      if (Object.keys(next).length === 0 && Object.keys(current ?? {}).length > 0) return;
      const { changed, removed } = diffTokens(current ?? {}, next);
      if (sendChanges(session, changed, removed)) current = next;
    },
  };
}

async function watchCommand(options) {
  const [file] = options._;
  if (!file) fail('usage: token-sync watch <built.css> [--build "<command>" --src <dir>]');
  const build = text(options.build, 'build');
  const sources = text(options.src, 'src')?.split(',').map((dir) => resolve(dir.trim()));
  if (Boolean(build) !== Boolean(sources)) fail('--build and --src go together');
  const selector = text(options.selector, 'selector');
  const target = resolve(file);
  const targetDir = dirname(target);
  const read = async () => tokensFrom(await readFile(target, 'utf8'), { selector });

  const session = await joinRoom(options);
  const follow = follower(session, read, file);
  await follow.start(options['send-initial']).catch((error) => fail(`couldn't read ${file}: ${error.message}`));
  log(`watching ${file}${build ? ` (building with "${build}" when ${sources.join(', ')} change)` : ''}`);

  const update = serial(() => follow.update());
  // Editors replace files rather than writing them in place, so watch the folder.
  watch(targetDir, debounce(update, 100)).on('error', (error) => log(error.message));
  if (build) {
    const rebuild = serial(async () => {
      log(`running "${build}"`);
      if (await run(build)) await update();
      else log('the build failed; nothing sent');
    });
    const later = debounce(rebuild, 150);
    for (const root of sources) {
      watch(root, { recursive: true }, (event, name) => {
        if (name && startsBuild(root, resolve(root, name), target)) later();
      }).on('error', (error) => log(error.message));
    }
  }
}

async function pollCommand(options) {
  const [url] = options._;
  if (!url) fail('usage: token-sync poll <css-url> [--interval 2000]');
  const interval = Number(text(options.interval, 'interval') ?? 2000);
  if (!(interval >= 250)) fail('--interval must be at least 250 ms');
  const selector = text(options.selector, 'selector');
  const headers = {};
  const header = text(options.header, 'header');
  if (header) {
    const at = header.indexOf(':');
    if (at < 1) fail('--header looks like "Name: value"');
    headers[header.slice(0, at).trim()] = header.slice(at + 1).trim();
  }
  const read = async () => {
    const res = await fetch(url, { cache: 'no-store', headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    return tokensFrom(await res.text(), { selector });
  };

  const session = await joinRoom(options);
  const follow = follower(session, read, url);
  await follow.start(options['send-initial']).catch((error) => fail(`couldn't fetch ${url}: ${error.message}`));
  log(`polling ${url} every ${interval} ms`);
  // One fetch at a time: the next starts only after this one is done, so an
  // older response can never land after a newer one.
  const tick = async () => {
    await follow.update();
    setTimeout(tick, interval);
  };
  setTimeout(tick, interval);
}

function relayCommand(options) {
  const port = Number(text(options.port, 'port') ?? 8787);
  const host = text(options.host, 'host') ?? '127.0.0.1';
  const { server } = createRelayServer();
  server.on('error', (error) => fail(`couldn't start the relay: ${error.message}`));
  server.listen(port, host, () => log(`relay on http://${host}:${port}`));
}

// Run as a command, not when a test imports the helpers above.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'watch') await watchCommand(options);
  else if (command === 'poll') await pollCommand(options);
  else if (command === 'relay') relayCommand(options);
  else {
    console.log('usage: token-sync <relay|watch|poll> …  (see the top of packages/cli/bin/token-sync.js)');
    process.exit(command ? 1 : 0);
  }
}
