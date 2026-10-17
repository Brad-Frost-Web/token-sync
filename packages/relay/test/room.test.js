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
  for (let i = 0; i < 8; i += 1) results.push(...send(room, client, { op: 'set', from: 'controller', props: { '--a': `${i}px` } }));
  // hello spent one of the 5, so 4 sets get through; the flood gets one warning.
  assert.equal(results.filter((r) => r.to === 'all').length, 4);
  assert.equal(results.filter((r) => /slow down/.test(r.frame.error ?? '')).length, 1);
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
    [['set', first], ['lock', first + 10]],
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

test('a room holds a bounded number of properties', () => {
  const { room, hello } = setup({ maxMessagesPerSecond: 1000 });
  const client = hello();
  for (let batch = 0; batch < 5; batch += 1) {
    const props = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`--k-${batch}-${i}`, '1px']));
    assert.equal(send(room, client, { op: 'set', from: 'controller', props })[0].to, 'all');
  }
  assert.match(send(room, client, { op: 'set', from: 'controller', props: { '--one-too-many': '1px' } })[0].frame.error, /at most 2000/);
  // A cleared key still holds its place, so it can come back in a full room.
  assert.equal(send(room, client, { op: 'set', from: 'controller', props: { '--k-0-0': null } })[0].to, 'all');
  assert.equal(send(room, client, { op: 'set', from: 'controller', props: { '--k-0-0': '2px' } })[0].to, 'all');
});

test('junk frames spend from the same bucket, and a flood gets one warning, not one per frame', () => {
  const { room, hello } = setup({ maxMessagesPerSecond: 5 });
  const client = hello();
  const replies = [];
  for (let i = 0; i < 20; i += 1) replies.push(...room.receive(client, 'not json'));
  assert.equal(replies.filter((r) => /slow down/.test(r.frame.error)).length, 1);
  assert.ok(replies.length <= 6);
});

test("an empty snapshot is Eddie's request: the relay answers that client alone, with real writes as sets", () => {
  const { room, hello } = setup();
  const presenter = hello(KEY);
  const written = send(room, presenter, { op: 'set', from: 'presenter', props: { '--a': '1px' } })[0].frame.msg.ts;
  send(room, presenter, { op: 'set', from: 'presenter', props: { '--b': null } });
  const asker = hello();
  const out = send(room, asker, { op: 'snapshot', from: 'source', props: {} });
  assert.ok(out.every((o) => o.to === 'sender'));
  assert.deepEqual(out[0].frame.msg, { v: 1, room: 'r', op: 'set', from: 'source', props: { '--a': '1px' }, ts: written });
  assert.equal(out[1].frame.msg.props['--b'], null);
  // An answer is still refused: the relay holds the state.
  assert.equal(send(room, asker, { op: 'snapshot', from: 'source', props: { '--a': '2px' } })[0].frame.kind, 'error');
});

test('fonts travel through the relay with the props', () => {
  const { room, hello } = setup();
  const out = send(room, hello(), { op: 'set', from: 'source', props: { '--ed-font': '"Fraunces", serif' }, fonts: ['Fraunces'] });
  assert.deepEqual(out[0].frame.msg.fonts, ['Fraunces']);
});

test('requests answer without the reset, and one connection may ask once every couple of seconds', () => {
  const { room, hello, tick } = setup();
  const presenter = hello(KEY);
  send(room, presenter, { op: 'set', from: 'presenter', props: { '--a': '1px' } });
  send(room, presenter, { op: 'reset', from: 'presenter' });
  send(room, presenter, { op: 'set', from: 'presenter', props: { '--a': '2px' } });
  const asker = hello();
  const ask = () => send(room, asker, { op: 'snapshot', from: 'source', props: {} }).map((o) => o.frame.msg?.op);
  assert.deepEqual(ask(), ['set']);
  assert.deepEqual(ask(), []);
  tick(2000);
  assert.deepEqual(ask(), ['set']);
});

test('a bad prop is dropped and the sender told; the rest goes to the room', () => {
  const { room, hello } = setup();
  const out = send(room, hello(), { op: 'set', from: 'source', props: { '--a': '1px', '--b': 'url(x)' } });
  assert.match(out[0].frame.error, /--b/);
  assert.deepEqual(out[1].frame.msg.props, { '--a': '1px' });
});
