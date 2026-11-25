import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlsSettings, controlsStatus, scopeTo } from '../src/controls.js';

test('the controls window reads its room and relay, and refuses a bad one', () => {
  assert.deepEqual(controlsSettings('?room=detach&relay=http%3A%2F%2F127.0.0.1%3A8787'), {
    ok: true,
    room: 'detach',
    relay: 'http://127.0.0.1:8787',
    socket: 'ws://127.0.0.1:8787/rooms/detach/socket',
  });
  assert.equal(controlsSettings('?room=bad room&relay=http://r.example').ok, false);
  assert.equal(controlsSettings('?room=detach&relay=javascript:alert(1)').ok, false);
  assert.equal(controlsSettings('').ok, false);
});

test('with every theme on, a set reaches every theme; off, it keeps the customizer\'s scope', () => {
  const sent = [];
  let every = true;
  const transport = scopeTo({ publish: (msg) => sent.push(msg), isPresenter: false, close() {} }, () => every);
  transport.publish({ op: 'set', scope: 'bfw', props: { '--ed-a': '1px' } });
  every = false;
  transport.publish({ op: 'set', scope: 'bfw', props: { '--ed-a': '2px' } });
  assert.equal(sent[0].scope, '*');
  assert.equal(sent[1].scope, 'bfw');
  assert.equal(transport.isPresenter, false);
});

test('a snapshot request keeps its own shape', () => {
  const sent = [];
  scopeTo({ publish: (msg) => sent.push(msg) }, () => true).publish({ op: 'snapshot', props: {} });
  assert.equal(sent[0].scope, undefined);
});

test('the status line says where changes go and who is listening', () => {
  assert.match(controlsStatus({ room: 'detach', state: 'open', tabs: 5 }), /room “detach”\. 5 tabs in this browser are previewing it/);
  assert.match(controlsStatus({ room: 'detach', state: 'open', tabs: 0 }), /No tab in this browser/);
  assert.match(controlsStatus({ room: 'detach', state: 'closed', error: 'refused' }), /Lost the relay \(refused\)/);
});
