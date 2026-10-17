import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMessage, createMessage } from '../src/message.js';

const base = { v: 1, room: 'detach', op: 'set', from: 'controller', props: { '--brand': '#f05735' }, ts: 1 };

test('accepts a well-formed set', () => {
  assert.equal(validateMessage(base).ok, true);
});

test('accepts contract knobs and a scope', () => {
  const msg = { ...base, props: { 'contract:color.background-brand': '#f05735' }, scope: '*' };
  assert.equal(validateMessage(msg).ok, true);
});

test('refuses the whole message when one value is refused', () => {
  const result = validateMessage({ ...base, props: { '--brand': '#f05735', '--bg': 'url(x)' } });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /--bg: url\( is refused/);
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
