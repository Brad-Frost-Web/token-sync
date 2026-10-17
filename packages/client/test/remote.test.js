// The remote transport against the real Node relay over real WebSockets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../src/connect.js';
import { createRemoteTransport } from '../src/transports.js';
import { createRelayServer } from '../../relay/node/server.js';

async function until(check, ms = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function relayWithRoom(t) {
  const relay = createRelayServer();
  await new Promise((resolve) => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(() => relay.close());
  const { port } = relay.server.address();
  const { room, presenterKey } = relay.createRoom().body;

  return { relay, room, presenterKey, url: `ws://127.0.0.1:${port}/rooms/${room}/socket` };
}

/** Join over the relay; resolves once the relay has said welcome. */
async function join(t, url, room, { presenterKey, applier } = {}) {
  let state = 'connecting';
  const errors = [];
  const transport = createRemoteTransport({ url, presenterKey, onStatus: (s) => (state = s.state), onRelayError: (e) => errors.push(e) });
  const session = connect({ room, transport, role: 'controller', applier });
  t.after(() => session.close());
  await until(() => state === 'open');

  return { session, transport, errors, state: () => state };
}

test('a change travels source → relay → applier', async (t) => {
  const { room, url } = await relayWithRoom(t);
  const renders = [];
  await join(t, url, room, { applier: { render: (p) => renders.push(p), destroy() {} } });
  const source = await join(t, url, room);
  source.session.set({ '--brand': '#0a7f5a' });
  await until(() => renders.length > 0);
  assert.deepEqual(renders.at(-1), { '--brand': '#0a7f5a' });
});

test('the relay decides who is presenter: the key holder can reset, others cannot', async (t) => {
  const { room, presenterKey, url } = await relayWithRoom(t);
  const presenter = await join(t, url, room, { presenterKey });
  const controller = await join(t, url, room);
  assert.equal(presenter.transport.isPresenter, true);
  assert.equal(controller.transport.isPresenter, false);
  assert.throws(() => controller.session.reset(), /presenter key/);
  controller.session.set({ '--a': '1px' });
  await until(() => Object.keys(presenter.session.props()).length === 1);
  presenter.session.reset();
  await until(() => Object.keys(controller.session.props()).length === 0);
});

test('a lock enforced by the relay refuses a controller, and says why', async (t) => {
  const { room, presenterKey, url } = await relayWithRoom(t);
  const presenter = await join(t, url, room, { presenterKey });
  const controller = await join(t, url, room);
  presenter.session.lock();
  await until(() => controller.session.locked);
  controller.session.set({ '--a': '9px' });
  await until(() => controller.errors.length > 0);
  assert.match(controller.errors[0], /locked/);
  assert.deepEqual(presenter.session.props(), {});
});

test('sends made before the relay says welcome are queued, not lost', async (t) => {
  const { room, url } = await relayWithRoom(t);
  const watcher = await join(t, url, room);
  const transport = createRemoteTransport({ url });
  const early = connect({ room, transport });
  t.after(() => early.close());
  early.set({ '--early': '1px' }); // the socket is still connecting
  await until(() => watcher.session.props()['--early'] === '1px');
});

test('after the relay drops the connection, the transport reconnects and catches up', async (t) => {
  const { relay, room, url } = await relayWithRoom(t);
  const viewer = await join(t, url, room);
  const writer = await join(t, url, room);
  // Drop every socket the relay holds.
  for (const entry of relay.rooms.values()) for (const member of entry.sockets) member.drop();
  await until(() => viewer.state() === 'closed' || viewer.state() === 'connecting');
  await until(() => viewer.state() === 'open' && writer.state() === 'open', 5000);
  writer.session.set({ '--after': '2px' });
  await until(() => viewer.session.props()['--after'] === '2px');
});

test('a display that drops while the room is locked catches up on the reset and unlock it missed', async (t) => {
  const { relay, room, presenterKey, url } = await relayWithRoom(t);
  const presenter = await join(t, url, room, { presenterKey });
  const display = await join(t, url, room);
  presenter.session.set({ '--a': '1px' });
  presenter.session.lock();
  await until(() => display.session.locked && display.session.props()['--a'] === '1px');
  // The display's connection drops; while it's gone the presenter resets and unlocks.
  const [entry] = relay.rooms.values();
  const displayMember = [...entry.sockets].find((m) => !m.client.presenter);
  displayMember.drop();
  await until(() => display.state() !== 'open');
  presenter.session.reset();
  presenter.session.unlock();
  await until(() => display.state() === 'open', 5000);
  await until(() => !display.session.locked && Object.keys(display.session.props()).length === 0);
});

test('a presenter can reset straight after connecting, before the relay has answered', async (t) => {
  const { room, presenterKey, url } = await relayWithRoom(t);
  const watcher = await join(t, url, room);
  watcher.session.set({ '--a': '1px' });
  await until(() => watcher.session.props()['--a'] === '1px');
  const transport = createRemoteTransport({ url, presenterKey });
  const presenter = connect({ room, transport });
  t.after(() => presenter.close());
  assert.doesNotThrow(() => presenter.reset());
  await until(() => Object.keys(watcher.session.props()).length === 0);
});
