import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomState } from '../src/room-state.js';

const set = (props, ts, from = 'controller') => ({ v: 1, room: 'r', op: 'set', from, props, ts });
const op = (name, ts) => ({ v: 1, room: 'r', op: name, from: 'presenter', ts });

test('last write wins per key, ordered by ts rather than arrival', () => {
  const state = createRoomState();
  state.apply(set({ '--brand': 'blue' }, 20));
  state.apply(set({ '--brand': 'red', '--radius': '4px' }, 10)); // arrives late, stamped earlier
  assert.deepEqual(state.props(), { '--brand': 'blue', '--radius': '4px' });
});

test('every arrival order converges on the same state', () => {
  const messages = [
    set({ '--a': '1px' }, 1),
    set({ '--a': '2px', '--b': 'red' }, 2),
    set({ '--b': 'blue' }, 3),
    op('reset', 4),
    set({ '--c': 'green' }, 5),
    set({ '--a': '9px' }, 5), // same ts as the line above, different key
    set({ '--c': 'navy' }, 5), // same ts AND same key as --c: green — the tie
  ];
  const orders = [messages, [...messages].reverse(), [messages[6], ...messages.slice(0, 6)]];
  const results = orders.map((order) => {
    const state = createRoomState();
    for (const msg of order) state.apply(msg);

    return state.props();
  });
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.deepEqual(results[0], { '--c': 'navy', '--a': '9px' });
});

test('reset clears everything written before it and drops stragglers', () => {
  const state = createRoomState();
  state.apply(set({ '--brand': 'blue' }, 10));
  const result = state.apply(op('reset', 20));
  assert.deepEqual(result.changed, ['--brand']);
  assert.deepEqual(state.props(), {});
  assert.equal(state.apply(set({ '--brand': 'red' }, 15)).applied, false);
  assert.deepEqual(state.props(), {});
  state.apply(set({ '--brand': 'green' }, 25));
  assert.deepEqual(state.props(), { '--brand': 'green' });
});

test('lock makes controllers read-only; presenters and sources still write', () => {
  const state = createRoomState();
  state.apply(op('lock', 10));
  assert.equal(state.locked, true);
  assert.equal(state.apply(set({ '--brand': 'red' }, 11, 'controller')).reason, 'room is locked');
  assert.equal(state.apply(set({ '--brand': 'blue' }, 12, 'presenter')).applied, true);
  assert.equal(state.apply(set({ '--radius': '2px' }, 13, 'source')).applied, true);
  state.apply(op('unlock', 14));
  assert.equal(state.apply(set({ '--brand': 'green' }, 15, 'controller')).applied, true);
  assert.deepEqual(state.props(), { '--brand': 'green', '--radius': '2px' });
});

test('an older unlock cannot undo a newer lock; lock wins a tie', () => {
  const state = createRoomState();
  state.apply(op('lock', 10));
  state.apply(op('unlock', 5));
  assert.equal(state.locked, true);
  state.apply(op('unlock', 10));
  assert.equal(state.locked, true);
});

test('a snapshot brings a late joiner up to date, including the lock', () => {
  const host = createRoomState();
  host.apply(set({ '--brand': 'blue', '--radius': '4px' }, 10));
  host.apply(op('lock', 11));
  host.apply(set({ '--radius': '8px' }, 12, 'presenter')); // presenters write through a lock
  const joiner = createRoomState();
  const messages = host.snapshotMessages('r');
  // One snapshot per write time, each carrying the time the write happened.
  assert.deepEqual(
    messages.map((m) => [m.op, m.ts]),
    [['snapshot', 10], ['snapshot', 12], ['lock', 11]],
  );
  for (const msg of messages) joiner.apply(msg);
  assert.deepEqual(joiner.props(), host.props());
  assert.equal(joiner.locked, true);
});

test('a snapshot merges and never wipes a newer write (the hello-reply race)', () => {
  // Tab A writes at 50. Tab B, answering some other tab's hello, replies with
  // what it knew — written at 40. The reply lands on A after A's own write.
  const a = createRoomState();
  a.apply(set({ '--brand': 'blue', '--radius': '4px' }, 40));
  a.apply(set({ '--brand': 'green' }, 50));
  a.apply({ v: 1, room: 'r', op: 'snapshot', from: 'source', props: { '--brand': 'blue', '--radius': '4px' }, ts: 40 });
  assert.deepEqual(a.props(), { '--brand': 'green', '--radius': '4px' });
});

test('an empty room sends no snapshot', () => {
  assert.deepEqual(createRoomState().snapshotMessages('r'), []);
});

test('a snapshot older than the last reset is dropped', () => {
  const state = createRoomState();
  state.apply(op('reset', 30));
  const result = state.apply({ v: 1, room: 'r', op: 'snapshot', from: 'source', props: { '--brand': 'red' }, ts: 20 });
  assert.equal(result.applied, false);
  assert.deepEqual(state.props(), {});
});

test('a peer rejoining with stale state catches up on a reset and an unlock it missed', () => {
  const room = createRoomState();
  const stale = createRoomState();
  for (const msg of [set({ '--a': '1px' }, 10), op('lock', 11)]) {
    room.apply(msg);
    stale.apply(msg); // the display saw these, then dropped off
  }
  room.apply(op('reset', 12));
  room.apply(op('unlock', 13));
  room.apply(set({ '--b': '2px' }, 14, 'presenter'));
  for (const msg of room.snapshotMessages('r')) stale.apply(msg);
  assert.deepEqual(stale.props(), { '--b': '2px' });
  assert.equal(stale.locked, false);
});

test('null clears a token, and an older write that arrives late cannot bring it back', () => {
  const state = createRoomState();
  state.apply({ op: 'set', from: 'source', props: { '--a': '1px', '--b': '2px' }, ts: 10 });
  state.apply({ op: 'set', from: 'source', props: { '--a': null }, ts: 20 });
  assert.deepEqual(state.props(), { '--b': '2px' });
  state.apply({ op: 'set', from: 'source', props: { '--a': '9px' }, ts: 15 });
  assert.deepEqual(state.props(), { '--b': '2px' });
  state.apply({ op: 'set', from: 'source', props: { '--a': '3px' }, ts: 30 });
  assert.deepEqual(state.props(), { '--a': '3px', '--b': '2px' });
});

test('a snapshot answer only fills tokens this state has never heard of', () => {
  const state = createRoomState();
  state.apply({ op: 'set', from: 'source', props: { '--a': '1px' }, ts: 10 });
  state.apply({ op: 'set', from: 'source', props: { '--c': null }, ts: 11 });
  // Stamped later than the write, as a customizer's answer is; it still loses.
  const { changed } = state.apply({ op: 'snapshot', from: 'source', props: { '--a': '9px', '--b': '2px', '--c': '5px' }, ts: 99 });
  assert.deepEqual(changed, ['--b']);
  assert.deepEqual(state.props(), { '--a': '1px', '--b': '2px' });
});

test('catch-up as sets brings a stale peer up to date; a broadcast answer leaves the reset out', () => {
  const room = createRoomState();
  room.apply({ op: 'set', from: 'source', props: { '--a': '1px' }, ts: 10 });
  room.apply({ op: 'reset', from: 'presenter', ts: 20 });
  room.apply({ op: 'set', from: 'source', props: { '--a': '3px' }, ts: 30 });
  const stale = createRoomState();
  stale.apply({ op: 'set', from: 'source', props: { '--a': '2px' }, ts: 25 });
  for (const msg of room.snapshotMessages('r', { asSets: true })) stale.apply(msg);
  assert.deepEqual(stale.props(), { '--a': '3px' });
  assert.deepEqual(room.snapshotMessages('r', { asSets: true }).map((m) => m.op), ['reset', 'set']);
  assert.deepEqual(room.snapshotMessages('r', { withReset: false }).map((m) => m.op), ['snapshot']);
});

test('scope: each theme keeps its own edits, and a page sees its theme plus the unscoped ones', () => {
  const state = createRoomState();
  state.apply({ op: 'set', from: 'source', props: { '--brand': 'blue', '--radius': '4px' }, ts: 10 });
  state.apply({ op: 'set', from: 'source', scope: 'bfw', props: { '--brand': 'green' }, ts: 20 });
  state.apply({ op: 'set', from: 'source', scope: 'southleft', props: { '--brand': 'orange' }, ts: 30 });
  const wearing = (theme) => (scope) => scope === theme;
  assert.deepEqual(state.props(wearing('bfw')), { '--brand': 'green', '--radius': '4px' });
  assert.deepEqual(state.props(wearing('southleft')), { '--brand': 'orange', '--radius': '4px' });
  assert.deepEqual(state.props(wearing('altitude')), { '--brand': 'blue', '--radius': '4px' });
  // A later unscoped write wins on every theme; "*" is the same as absent.
  state.apply({ op: 'set', from: 'source', scope: '*', props: { '--brand': 'black' }, ts: 40 });
  assert.equal(state.props(wearing('bfw'))['--brand'], 'black');
  assert.equal(state.props(wearing('southleft'))['--brand'], 'black');
});

test('scope: answers keep the theme each write was for, and a reset clears every theme', () => {
  const state = createRoomState();
  state.apply({ op: 'set', from: 'source', props: { '--radius': '4px' }, ts: 10 });
  state.apply({ op: 'set', from: 'source', scope: 'bfw', props: { '--brand': 'green' }, ts: 10 });
  const answers = state.snapshotMessages('r', { withReset: false });
  assert.deepEqual(answers.map((m) => [m.scope, m.props]), [[undefined, { '--radius': '4px' }], ['bfw', { '--brand': 'green' }]]);
  const joiner = createRoomState();
  for (const m of answers) joiner.apply(m);
  assert.deepEqual(joiner.props((s) => s === 'southleft'), { '--radius': '4px' });
  state.apply({ op: 'reset', from: 'presenter', ts: 20 });
  assert.deepEqual(state.props(), {});
});
