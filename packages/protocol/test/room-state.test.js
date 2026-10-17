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
  const joiner = createRoomState();
  let ts = 12;
  for (const msg of host.snapshotMessages('r')) joiner.apply({ ...msg, ts: ts++ });
  assert.deepEqual(joiner.props(), host.props());
  assert.equal(joiner.locked, true);
});

test('a stale snapshot does not roll back a peer that has seen newer writes', () => {
  const state = createRoomState();
  state.apply(set({ '--brand': 'blue' }, 30));
  const result = state.apply({ v: 1, room: 'r', op: 'snapshot', from: 'source', props: { '--brand': 'red' }, ts: 20 });
  assert.equal(result.applied, false);
  assert.deepEqual(state.props(), { '--brand': 'blue' });
});
