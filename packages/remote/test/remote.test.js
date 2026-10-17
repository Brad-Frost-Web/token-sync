import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteLink, remoteSettings, statusMessage } from '../src/remote.js';

test('a remote link carries the room and relay, and turns into the room socket', () => {
  const link = remoteLink({ base: 'http://127.0.0.1:4321/packages/remote/index.html', room: 'detach', relay: 'https://relay.example' });
  const settings = remoteSettings(new URL(link).search);
  assert.deepEqual(settings, { ok: true, room: 'detach', socket: 'wss://relay.example/rooms/detach/socket' });
  assert.equal(remoteSettings('?room=r&relay=http://127.0.0.1:8787').socket, 'ws://127.0.0.1:8787/rooms/r/socket');
});

test('a broken link says what is wrong, in words someone holding a phone can act on', () => {
  for (const search of ['', '?relay=https://x.example', '?room=bad room&relay=https://x.example', '?room=r', '?room=r&relay=not-a-url', '?room=r&relay=javascript:alert(1)']) {
    const settings = remoteSettings(search);
    assert.equal(settings.ok, false, search);
    assert.match(settings.error, /Ask the presenter/);
  }
});

test('the status line says why the controls stopped, never just that they did', () => {
  assert.match(statusMessage({ room: 'r', connection: 'connecting', locked: false }), /Joining/);
  assert.match(statusMessage({ room: 'r', connection: 'open', locked: false }), /big screen/);
  assert.match(statusMessage({ room: 'r', connection: 'open', locked: true }), /paused/);
  assert.match(statusMessage({ room: 'r', connection: 'closed', locked: false }), /Trying again/);
});
