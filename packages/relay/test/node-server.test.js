// Runs the real Node relay on a random port and talks to it with Node's own
// WebSocket client — the handshake and framing are tested against a real
// implementation, not against our idea of one (AGENTS.md §2.13).
//
// TOKEN_SYNC_RELAY_URL=http://127.0.0.1:8788 runs the same tests against
// another relay instead — `npm run relay:worker:test` points them at the
// Durable Object under `wrangler dev`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelayServer } from '../node/server.js';

async function startRelay(t) {
  const external = process.env.TOKEN_SYNC_RELAY_URL;
  if (external) return { http: external.replace(/\/$/, ''), ws: external.replace(/^http/, 'ws').replace(/\/$/, '') };
  const relay = createRelayServer();
  await new Promise((resolve) => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(() => relay.close());
  const { port } = relay.server.address();

  return { ...relay, http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}` };
}

/** Open a socket, say hello, and collect frames. */
async function join(t, url, key) {
  const socket = new WebSocket(url);
  const frames = [];
  socket.addEventListener('message', (event) => frames.push(JSON.parse(event.data)));
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });
  t.after(() => socket.close());
  socket.send(JSON.stringify({ kind: 'hello', key }));
  await until(() => frames.some((f) => f.kind === 'welcome'));

  return { socket, frames, send: (msg) => socket.send(JSON.stringify({ kind: 'msg', msg })) };
}

async function until(check, ms = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('POST /rooms creates a room and hands back its presenter key', async (t) => {
  const relay = await startRelay(t);
  const res = await fetch(`${relay.http}/rooms`, { method: 'POST' });
  assert.equal(res.status, 201);
  const { room, presenterKey } = await res.json();
  assert.match(room, /^[a-z2-9]{6}$/);
  assert.ok(presenterKey.length >= 22);
  assert.equal((await fetch(`${relay.http}/rooms/${room}`)).status, 200);
  assert.equal((await fetch(`${relay.http}/rooms/nope`)).status, 404);
});

test('a chosen room code works once, then conflicts', async (t) => {
  const relay = await startRelay(t);
  const name = `detach-${Date.now()}`; // unique, so the test can rerun against a long-lived relay
  const first = await fetch(`${relay.http}/rooms`, { method: 'POST', body: JSON.stringify({ room: name }) });
  assert.equal(first.status, 201);
  const again = await fetch(`${relay.http}/rooms`, { method: 'POST', body: JSON.stringify({ room: name }) });
  assert.equal(again.status, 409);
});

test('a change from one socket reaches every socket in the room, stamped by the relay', async (t) => {
  const relay = await startRelay(t);
  const { room } = await (await fetch(`${relay.http}/rooms`, { method: 'POST' })).json();
  const a = await join(t, `${relay.ws}/rooms/${room}/socket`);
  const b = await join(t, `${relay.ws}/rooms/${room}/socket`);
  a.send({ v: 1, room, op: 'set', from: 'controller', props: { '--brand': '#0a7f5a' }, ts: 1 });
  await until(() => b.frames.some((f) => f.kind === 'msg'));
  const msg = b.frames.find((f) => f.kind === 'msg').msg;
  assert.deepEqual(msg.props, { '--brand': '#0a7f5a' });
  assert.ok(msg.ts > 1);
});

test('the presenter key, and only the key, grants reset', async (t) => {
  const relay = await startRelay(t);
  const { room, presenterKey } = await (await fetch(`${relay.http}/rooms`, { method: 'POST' })).json();
  const controller = await join(t, `${relay.ws}/rooms/${room}/socket`);
  const presenter = await join(t, `${relay.ws}/rooms/${room}/socket`, presenterKey);
  assert.equal(presenter.frames[0].presenter, true);
  controller.send({ v: 1, room, op: 'reset', from: 'presenter' });
  await until(() => controller.frames.some((f) => f.kind === 'error'));
  presenter.send({ v: 1, room, op: 'reset', from: 'presenter' });
  await until(() => controller.frames.some((f) => f.kind === 'msg' && f.msg.op === 'reset'));
});

test('a late joiner gets the current state', async (t) => {
  const relay = await startRelay(t);
  const { room } = await (await fetch(`${relay.http}/rooms`, { method: 'POST' })).json();
  const early = await join(t, `${relay.ws}/rooms/${room}/socket`);
  early.send({ v: 1, room, op: 'set', from: 'controller', props: { '--radius': '4px' } });
  await until(() => early.frames.some((f) => f.kind === 'msg'));
  const late = await join(t, `${relay.ws}/rooms/${room}/socket`);
  await until(() => late.frames.some((f) => f.kind === 'msg'));
  assert.deepEqual(late.frames.find((f) => f.kind === 'msg').msg.props, { '--radius': '4px' });
});

test('a socket to a room that does not exist is turned away', async (t) => {
  const relay = await startRelay(t);
  const socket = new WebSocket(`${relay.ws}/rooms/missing/socket`);
  const outcome = await new Promise((resolve) => {
    socket.addEventListener('open', () => resolve('open'));
    socket.addEventListener('error', () => resolve('error'));
  });
  assert.equal(outcome, 'error');
});

test('a large frame (over 125 bytes, so a 16-bit length) round-trips', async (t) => {
  const relay = await startRelay(t);
  const { room } = await (await fetch(`${relay.http}/rooms`, { method: 'POST' })).json();
  const a = await join(t, `${relay.ws}/rooms/${room}/socket`);
  const props = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`--token-number-${i}`, `${i}px`]));
  a.send({ v: 1, room, op: 'set', from: 'controller', props });
  await until(() => a.frames.some((f) => f.kind === 'msg'));
  assert.equal(Object.keys(a.frames.find((f) => f.kind === 'msg').msg.props).length, 40);
});

import net from 'node:net';
import { createHash } from 'node:crypto';

/** Speak raw TCP to the relay, for the frames a well-behaved client never sends. */
function rawSocket(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => resolve(socket));
  });
}

const upgradeRequest = (room, key = 'dGhlIHNhbXBsZSBub25jZQ==') =>
  `GET /rooms/${room}/socket HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;

/** A masked client text frame. */
function clientFrame(text, { opcode = 0x1, mask = true } = {}) {
  const payload = Buffer.isBuffer(text) ? text : Buffer.from(text);
  const key = Buffer.from([1, 2, 3, 4]);
  const header = Buffer.from([0x80 | opcode, (mask ? 0x80 : 0) | payload.length]);
  const body = mask ? Buffer.from(payload.map((b, i) => b ^ key[i % 4])) : payload;

  return Buffer.concat(mask ? [header, key, body] : [header, body]);
}

const localOnly = { skip: process.env.TOKEN_SYNC_RELAY_URL ? 'Node relay only' : false };

test('a malformed upgrade followed by a reset does not take the relay down', localOnly, async (t) => {
  const relay = await startRelay(t);
  const { room } = relay.createRoom().body;
  const port = relay.server.address().port;
  for (let i = 0; i < 20; i += 1) {
    const socket = await rawSocket(port);
    socket.write(`GET /rooms/${room}/socket HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
    socket.resetAndDestroy();
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await fetch(`${relay.http}/rooms/${room}`)).status, 200);
});

test('a half-closed connection (FIN, no close frame) leaves its room at once', localOnly, async (t) => {
  const relay = await startRelay(t);
  const { room } = relay.createRoom().body;
  const socket = await rawSocket(relay.server.address().port);
  socket.write(upgradeRequest(room));
  await until(() => relay.rooms.get(room).sockets.size === 1);
  socket.end();
  await until(() => relay.rooms.get(room).sockets.size === 0);
});

test('a connection that never says hello is dropped', localOnly, async (t) => {
  const relay = createRelayServer({ helloMs: 50 });
  await new Promise((resolve) => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(() => relay.close());
  const { room } = relay.createRoom().body;
  const socket = await rawSocket(relay.server.address().port);
  t.after(() => socket.destroy());
  socket.write(upgradeRequest(room));
  await until(() => relay.rooms.get(room).sockets.size === 1);
  await until(() => relay.rooms.get(room).sockets.size === 0);
});

test('the handshake answers with the RFC 6455 accept key, and a frame sent with the upgrade is not lost', localOnly, async (t) => {
  const relay = await startRelay(t);
  const { room } = relay.createRoom().body;
  const socket = await rawSocket(relay.server.address().port);
  t.after(() => socket.destroy());
  let received = '';
  socket.on('data', (chunk) => (received += chunk.toString('latin1')));
  socket.write(Buffer.concat([Buffer.from(upgradeRequest(room)), clientFrame(JSON.stringify({ kind: 'hello' }))]));
  const expected = createHash('sha1').update('dGhlIHNhbXBsZSBub25jZQ==258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  await until(() => received.includes('welcome'));
  assert.match(received, new RegExp(`Sec-WebSocket-Accept: ${expected.replace(/[+/=]/g, '\\$&')}`));
});

test('refuses unmasked frames and invalid UTF-8 with the right close codes', localOnly, async (t) => {
  const relay = await startRelay(t);
  const { room } = relay.createRoom().body;
  for (const [frame, code] of [
    [clientFrame('{"kind":"hello"}', { mask: false }), 1002],
    [clientFrame(Buffer.from([0xff, 0xfe, 0xfd])), 1007],
  ]) {
    const socket = await rawSocket(relay.server.address().port);
    t.after(() => socket.destroy());
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.write(upgradeRequest(room));
    await until(() => Buffer.concat(chunks).includes('101 Switching'));
    socket.write(frame);
    await until(() => {
      const all = Buffer.concat(chunks);
      const at = all.lastIndexOf(Buffer.from([0x88]));

      return at > -1 && all.length >= at + 4 && all.readUInt16BE(at + 2) === code;
    });
  }
});

test('an oversized POST gets a 413, as the Cloudflare relay answers', localOnly, async (t) => {
  const relay = await startRelay(t);
  const res = await fetch(`${relay.http}/rooms`, { method: 'POST', body: JSON.stringify({ room: 'x'.repeat(5000) }) });
  assert.equal(res.status, 413);
});
