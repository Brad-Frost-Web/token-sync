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
