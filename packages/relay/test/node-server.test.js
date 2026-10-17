// Runs the real Node relay on a random port and talks to it with Node's own
// WebSocket client — the handshake and framing are tested against a real
// implementation, not against our idea of one (AGENTS.md §2.13).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelayServer } from '../node/server.js';

async function startRelay(t) {
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
  const first = await fetch(`${relay.http}/rooms`, { method: 'POST', body: JSON.stringify({ room: 'detach' }) });
  assert.equal(first.status, 201);
  const again = await fetch(`${relay.http}/rooms`, { method: 'POST', body: JSON.stringify({ room: 'detach' }) });
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
