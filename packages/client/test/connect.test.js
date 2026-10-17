import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../src/connect.js';

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 20));

/** Join a room, and leave it when the test ends — pass or fail — so no channel keeps the run alive. */
function join(t, options) {
  const session = connect(options);
  t.after(() => session.close());

  return session;
}

/** An applier double that records what it was asked to render. */
function recordingApplier() {
  const renders = [];

  return { renders, render: (props) => renders.push(props), destroy: () => renders.push('destroyed') };
}

/** A transport double: a test can push any raw message through it. */
function rawTransport() {
  let listener = () => {};

  return {
    push: (m) => listener(m),
    publish: (m) => m,
    subscribe: (fn) => {
      listener = fn;

      return () => {};
    },
    close() {},
  };
}

test('a change from a source tab reaches an applier tab over broadcast', async (t) => {
  const applier = recordingApplier();
  const target = join(t, { room: 'connect-a', role: 'controller', applier });
  const source = join(t, { room: 'connect-a' });
  source.set({ '--ed-theme-color-background-brand': '#0a5' });
  await nextTick();
  assert.deepEqual(applier.renders.at(-1), { '--ed-theme-color-background-brand': '#0a5' });
});

test('a tab that joins late gets the current state', async (t) => {
  const source = join(t, { room: 'connect-b' });
  source.set({ '--radius': '12px' });
  await nextTick();
  const applier = recordingApplier();
  const late = join(t, { room: 'connect-b', applier });
  await nextTick();
  assert.deepEqual(applier.renders.at(-1), { '--radius': '12px' });
});

test('reset and lock work across tabs; a locked room ignores controllers', async (t) => {
  const applier = recordingApplier();
  const display = join(t, { room: 'connect-c', applier });
  const presenter = join(t, { room: 'connect-c' });
  const controller = join(t, { room: 'connect-c', role: 'controller' });
  controller.set({ '--brand': '#111111' });
  await nextTick();
  presenter.lock();
  await nextTick();
  controller.set({ '--brand': '#222222' });
  await nextTick();
  assert.deepEqual(display.props(), { '--brand': '#111111' });
  assert.equal(display.locked, true);
  presenter.reset();
  await nextTick();
  assert.deepEqual(applier.renders.at(-1), {});
});

test('refuses to send an unsafe value', (t) => {
  const session = join(t, { room: 'connect-d', transport: 'local' });
  assert.throws(() => session.set({ '--brand': 'red; background: url(x)' }), /refused to send/);
});

test('never trusts the wire: an invalid incoming message is reported, not applied', (t) => {
  const transport = rawTransport();
  const applier = recordingApplier();
  const errors = [];
  const session = join(t, { room: 'connect-e', transport, applier, onError: (e) => errors.push(e) });
  transport.push({ v: 1, room: 'connect-e', op: 'set', from: 'controller', props: { '--brand': 'url(x)' }, ts: 1 });
  assert.equal(applier.renders.length, 0);
  assert.equal(errors.length, 1);
});

test('an injected transport is not a presenter unless told so', (t) => {
  const session = join(t, { room: 'connect-f', transport: rawTransport() });
  assert.throws(() => session.reset(), /presenter key/);
});

test('close leaves the room and restores the page', (t) => {
  const applier = recordingApplier();
  const session = join(t, { room: 'connect-g', transport: 'local', applier });
  session.close();
  assert.equal(applier.renders.at(-1), 'destroyed');
});
