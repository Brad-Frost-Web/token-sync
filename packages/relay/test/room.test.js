import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelayRoom, generatePresenterKey, generateRoomCode } from '../src/room.js';

const KEY = 'presenter-secret';

function setup(options = {}) {
  let now = 1000;
  const room = createRelayRoom({ room: 'r', presenterKey: KEY, now: () => now, ...options });
  const hello = (key) => {
    const client = room.connect();
    room.receive(client, JSON.stringify({ kind: 'hello', key }));

    return client;
  };

  return { room, hello, tick: (ms) => (now += ms), at: () => now };
}

const send = (room, client, msg) => room.receive(client, JSON.stringify({ kind: 'msg', msg: { v: 1, room: 'r', ...msg } }));

test('hello answers with welcome and whether the key made you presenter', () => {
  const { room } = setup();
  const anyone = room.connect();
  assert.deepEqual(room.receive(anyone, JSON.stringify({ kind: 'hello' }))[0].frame, { kind: 'welcome', presenter: false });
  const presenter = room.connect();
  assert.deepEqual(room.receive(presenter, JSON.stringify({ kind: 'hello', key: KEY }))[0].frame, { kind: 'welcome', presenter: true });
  const guesser = room.connect();
  assert.equal(room.receive(guesser, JSON.stringify({ kind: 'hello', key: 'wrong' }))[0].frame.presenter, false);
});

test('nothing is accepted before hello', () => {
  const { room } = setup();
  const out = send(room, room.connect(), { op: 'set', from: 'controller', props: { '--a': '1px' } });
  assert.equal(out[0].frame.error, 'say hello first');
});

test('the relay stamps ts and ignores whatever the client sent', () => {
  const { room, hello, at } = setup();
  const client = hello();
  const [out] = send(room, client, { op: 'set', from: 'controller', props: { '--a': '1px' }, ts: 9e15 });
  assert.equal(out.to, 'all');
  assert.equal(out.frame.msg.ts, at());
});

test('only the presenter can reset, lock, unlock or speak as presenter', () => {
  const { room, hello } = setup();
  const controller = hello();
  const presenter = hello(KEY);
  assert.match(send(room, controller, { op: 'reset', from: 'presenter' })[0].frame.error, /only the presenter/);
  assert.match(send(room, controller, { op: 'set', from: 'presenter', props: { '--a': '1px' } })[0].frame.error, /only the presenter/);
  assert.equal(send(room, presenter, { op: 'lock', from: 'presenter' })[0].to, 'all');
});

test('a lock holds against anyone without the key, whatever role they claim', () => {
  const { room, hello } = setup();
  const presenter = hello(KEY);
  const sneaky = hello();
  send(room, presenter, { op: 'lock', from: 'presenter' });
  assert.match(send(room, sneaky, { op: 'set', from: 'source', props: { '--a': '1px' } })[0].frame.error, /locked/);
  assert.match(send(room, sneaky, { op: 'set', from: 'controller', props: { '--a': '1px' } })[0].frame.error, /locked/);
  assert.equal(send(room, presenter, { op: 'set', from: 'presenter', props: { '--a': '2px' } })[0].to, 'all');
});

test('refuses unsafe values, other rooms, client snapshots and junk frames', () => {
  const { room, hello } = setup();
  const client = hello();
  assert.match(send(room, client, { op: 'set', from: 'controller', props: { '--a': 'url(x)' } })[0].frame.error, /url\(/);
  assert.match(room.receive(client, JSON.stringify({ kind: 'msg', msg: { v: 1, room: 'other', op: 'set', from: 'controller', props: { '--a': '1px' } } }))[0].frame.error, /wrong room/);
  assert.match(send(room, client, { op: 'snapshot', from: 'source', props: { '--a': '1px' } })[0].frame.error, /from the relay/);
  assert.match(room.receive(client, 'not json')[0].frame.error, /JSON/);
  assert.match(room.receive(client, 'x'.repeat(17 * 1024))[0].frame.error, /at most/);
});

test('each connection is held to its message rate', () => {
  const { room, hello, tick } = setup({ maxMessagesPerSecond: 5 });
  const client = hello();
  const results = [];
  for (let i = 0; i < 8; i += 1) results.push(send(room, client, { op: 'set', from: 'controller', props: { '--a': `${i}px` } })[0]);
  assert.equal(results.filter((r) => r.to === 'all').length, 5);
  assert.match(results[7].frame.error, /slow down/);
  tick(1000);
  assert.equal(send(room, client, { op: 'set', from: 'controller', props: { '--a': '9px' } })[0].to, 'all');
});

test('a joiner gets the room as it stands, at each write\'s real time', () => {
  const { room, hello, tick } = setup();
  const presenter = hello(KEY);
  const first = send(room, presenter, { op: 'set', from: 'presenter', props: { '--a': '1px' } })[0].frame.msg.ts;
  tick(10);
  send(room, presenter, { op: 'lock', from: 'presenter' });
  const late = room.connect();
  const frames = room.receive(late, JSON.stringify({ kind: 'hello' })).map((o) => o.frame);
  assert.equal(frames[0].kind, 'welcome');
  assert.deepEqual(
    frames.slice(1).map((f) => [f.msg.op, f.msg.ts]),
    [['snapshot', first], ['lock', first + 10]],
  );
});

test('restore brings a room back after its host restarts', () => {
  const { room, hello } = setup();
  send(room, hello(KEY), { op: 'set', from: 'presenter', props: { '--a': '1px' } });
  const revived = createRelayRoom({ room: 'r', presenterKey: KEY, restore: room.snapshot() });
  const frames = revived.receive(revived.connect(), JSON.stringify({ kind: 'hello' }));
  assert.deepEqual(frames[1].frame.msg.props, { '--a': '1px' });
});

test('room codes and keys are well formed', () => {
  assert.match(generateRoomCode(), /^[a-z2-9]{6}$/);
  assert.match(generatePresenterKey(), /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(generatePresenterKey(), generatePresenterKey());
});
