import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBroadcastTransport, createClock, createLocalTransport } from '../src/transports.js';

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 20));
const msg = (props) => ({ v: 1, room: 'r', op: 'set', from: 'source', props });

test('the clock never runs backwards and stamps after anything it has seen', () => {
  let now = 100;
  const clock = createClock(() => now);
  assert.equal(clock.stamp(), 100);
  assert.equal(clock.stamp(), 101); // same millisecond: still strictly later
  clock.observe(500); // a peer's write from "the future"
  now = 200;
  assert.equal(clock.stamp(), 501);
});

test('local: every peer, the sender included, hears the stamped message', () => {
  const hub = new Map();
  const a = createLocalTransport({ room: 'r', hub });
  const b = createLocalTransport({ room: 'r', hub });
  const heardA = [];
  const heardB = [];
  a.subscribe((m) => heardA.push(m));
  b.subscribe((m) => heardB.push(m));
  const sent = a.publish(msg({ '--x': '1px' }));
  assert.equal(typeof sent.ts, 'number');
  assert.deepEqual(heardA, [sent]);
  assert.deepEqual(heardB, [sent]);
});

test('broadcast: a real BroadcastChannel carries the message between peers', async () => {
  const a = createBroadcastTransport({ room: 'bc-test' });
  const b = createBroadcastTransport({ room: 'bc-test' });
  const heard = [];
  b.subscribe((m) => heard.push(m));
  const sent = a.publish(msg({ '--brand': '#000000' }));
  await nextTick();
  assert.deepEqual(heard, [sent]);
  a.close();
  b.close();
});

test('broadcast: the sender hears its own message too', () => {
  const a = createBroadcastTransport({ room: 'bc-self' });
  const heard = [];
  a.subscribe((m) => heard.push(m));
  a.publish(msg({ '--brand': '#000000' }));
  assert.equal(heard.length, 1);
  a.close();
});

test('broadcast: a late joiner is answered with a snapshot', async () => {
  const host = createBroadcastTransport({
    room: 'bc-join',
    getSnapshot: () => [{ v: 1, room: 'bc-join', op: 'snapshot', from: 'source', props: { '--brand': '#123456' }, ts: 42 }],
  });
  const joiner = createBroadcastTransport({ room: 'bc-join' });
  const heard = [];
  joiner.subscribe((m) => heard.push(m));
  await nextTick();
  assert.equal(heard.length, 1);
  assert.equal(heard[0].op, 'snapshot');
  assert.deepEqual(heard[0].props, { '--brand': '#123456' });
  assert.equal(heard[0].ts, 42); // the write's own time, not the time of the reply
  host.close();
  joiner.close();
});

test('broadcast: rooms do not hear each other', async () => {
  const a = createBroadcastTransport({ room: 'bc-one' });
  const b = createBroadcastTransport({ room: 'bc-two' });
  const heard = [];
  b.subscribe((m) => heard.push(m));
  a.publish(msg({ '--brand': '#000000' }));
  await nextTick();
  assert.deepEqual(heard, []);
  a.close();
  b.close();
});

test('a stamp far in the future is dropped, so it cannot push every later write behind it', async (t) => {
  const forger = new BroadcastChannel('token-sync:bc-future');
  const peer = createBroadcastTransport({ room: 'bc-future' });
  t.after(() => {
    forger.close();
    peer.close();
  });
  const heard = [];
  peer.subscribe((m) => heard.push(m));
  forger.postMessage({ v: 1, room: 'bc-future', op: 'reset', from: 'presenter', ts: Number.MAX_VALUE });
  await nextTick();
  assert.deepEqual(heard, []);
  // And the peer's own clock was not dragged forward.
  const next = peer.publish(msg({ '--x': '1px' }));
  assert.ok(next.ts < Date.now() + 1000);
});

test('broadcast: junk on the channel is ignored, not thrown on', async (t) => {
  const stranger = new BroadcastChannel('token-sync:bc-junk');
  const peer = createBroadcastTransport({ room: 'bc-junk' });
  t.after(() => {
    stranger.close();
    peer.close();
  });
  const heard = [];
  peer.subscribe((m) => heard.push(m));
  for (const junk of [null, 'hello', 42, [1, 2], { kind: 'msg' }]) stranger.postMessage(junk);
  await nextTick();
  // An object reaches connect(), which validates and reports it; nothing threw.
  assert.equal(heard.length, 1);
  assert.equal(typeof heard[0].ts, 'number');
});

test('broadcast: joining asks the room with an empty snapshot, and the answer leaves the reset out', async (t) => {
  const watcher = new BroadcastChannel('token-sync:bc-ask');
  const seen = [];
  watcher.onmessage = (event) => seen.push(event.data);
  const host = createBroadcastTransport({
    room: 'bc-ask',
    getSnapshot: (options) => [
      ...(options?.withReset === false ? [] : [{ v: 1, room: 'bc-ask', op: 'reset', from: 'presenter', ts: 5 }]),
      { v: 1, room: 'bc-ask', op: 'snapshot', from: 'source', props: { '--brand': '#123456' }, ts: 42 },
    ],
  });
  t.after(() => {
    watcher.close();
    host.close();
  });
  const joiner = createBroadcastTransport({ room: 'bc-ask' });
  t.after(() => joiner.close());
  await nextTick();
  const isRequest = (m) => m.op === 'snapshot' && Object.keys(m.props).length === 0;
  // The host asked when it joined; so did the joiner.
  assert.equal(seen.filter(isRequest).length, 2);
  assert.ok(seen.filter(isRequest).every((m) => m.room === 'bc-ask'));
  // The host answers each request with its writes, never the reset.
  const answers = seen.filter((m) => !isRequest(m));
  assert.ok(answers.length >= 1);
  assert.ok(answers.every((m) => m.op === 'snapshot' && m.ts === 42));
});
