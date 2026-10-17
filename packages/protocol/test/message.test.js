import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMessage, createMessage, isSnapshotRequest } from '../src/message.js';

const base = { v: 1, room: 'detach', op: 'set', from: 'controller', props: { '--brand': '#f05735' }, ts: 1 };

test('accepts a well-formed set', () => {
  assert.equal(validateMessage(base).ok, true);
});

test('accepts contract knobs and a scope', () => {
  const msg = { ...base, props: { 'contract:color.background-brand': '#f05735' }, scope: '*' };
  assert.equal(validateMessage(msg).ok, true);
});

test('a refused value is dropped on its own, as Eddie does; a set with nothing left is refused', () => {
  const result = validateMessage({ ...base, props: { '--brand': '#f05735', '--bg': 'url(x)' } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.message.props, { '--brand': '#f05735' });
  assert.equal(result.refused.length, 1);
  assert.match(`${result.refused[0].name}: ${result.refused[0].reason}`, /--bg: url\( is refused/);
  const none = validateMessage({ ...base, props: { '--bg': 'url(x)' } });
  assert.equal(none.ok, false);
  assert.match(none.errors.join('\n'), /--bg: url\( is refused/);
  // A snapshot answer with one value the lab can't read still fills the rest.
  const answer = validateMessage({ ...base, op: 'snapshot', props: { '--brand': '#f05735', '--bg': 'url(x)' } });
  assert.deepEqual(answer.message.props, { '--brand': '#f05735' });
});

test('refuses keys that are not custom properties or contract paths', () => {
  for (const key of ['color', 'background-color', '-x', 'contract:', '--a b']) {
    assert.equal(validateMessage({ ...base, props: { [key]: 'red' } }).ok, false, key);
  }
});

test('refuses reset, lock and unlock from anyone but a presenter', () => {
  for (const op of ['reset', 'lock', 'unlock']) {
    assert.equal(validateMessage({ v: 1, room: 'r', op, from: 'controller', ts: 1 }).ok, false, op);
    assert.equal(validateMessage({ v: 1, room: 'r', op, from: 'presenter', ts: 1 }).ok, true, op);
  }
});

test('refuses wrong versions, rooms, ops, roles and unknown fields', () => {
  assert.equal(validateMessage({ ...base, v: 2 }).ok, false);
  assert.equal(validateMessage({ ...base, room: 'has space' }).ok, false);
  assert.equal(validateMessage({ ...base, op: 'delete' }).ok, false);
  assert.equal(validateMessage({ ...base, from: 'admin' }).ok, false);
  assert.equal(validateMessage({ ...base, extra: true }).ok, false);
  assert.equal(validateMessage({ ...base, props: {} }).ok, false);
  assert.equal(validateMessage(null).ok, false);
  assert.equal(validateMessage([]).ok, false);
});

test('ts is required on the wire but not before the channel stamps it', () => {
  const unstamped = createMessage({ room: 'detach', op: 'set', from: 'source', props: { '--brand': 'red' } });
  assert.equal(validateMessage(unstamped).ok, false);
  assert.equal(validateMessage(unstamped, { requireTs: false }).ok, true);
  assert.equal(validateMessage({ ...unstamped, ts: 'soon' }, { requireTs: false }).ok, false);
});

test("Eddie's amendments: null clears, fonts name families, an empty snapshot asks", () => {
  const base = { v: 1, room: 'r', from: 'controller', ts: 1 };
  assert.equal(validateMessage({ ...base, op: 'set', props: { '--ed-x': null } }).ok, true);
  assert.equal(validateMessage({ ...base, op: 'set', props: { '--ed-x': '1px' }, fonts: ['Fraunces', 'Space Grotesk'] }).ok, true);
  assert.equal(validateMessage({ ...base, op: 'set', props: { '--ed-x': '1px' }, fonts: ['x); @import url(evil'] }).ok, false);
  assert.equal(validateMessage({ ...base, op: 'set', props: { '--ed-x': '1px' }, fonts: 'Fraunces' }).ok, false);
  assert.equal(validateMessage({ ...base, op: 'set', props: { '--ed-x': '1px' }, fonts: Array(9).fill('Inter') }).ok, false);
  assert.equal(validateMessage({ ...base, op: 'set', props: { 'contract:color.background.brand': '#1b4dd8' } }).ok, true);
  const ask = { ...base, op: 'snapshot', props: {} };
  assert.equal(validateMessage(ask).ok, true);
  assert.equal(isSnapshotRequest(ask), true);
  assert.equal(isSnapshotRequest({ ...ask, props: { '--ed-x': '1px' } }), false);
  assert.equal(isSnapshotRequest({ ...base, op: 'set', props: {} }), false);
});
