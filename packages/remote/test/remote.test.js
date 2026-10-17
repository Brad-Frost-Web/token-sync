import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relayEndpoint, remoteLink, remoteSettings, statusMessage } from '../src/remote.js';

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

test('a relay that is down at load reads as "can\'t reach", not "lost", and the first connect is just joining', () => {
  assert.match(statusMessage({ room: 'r', connection: 'connecting', locked: false, everConnected: false, failed: false }), /Joining/);
  assert.match(statusMessage({ room: 'r', connection: 'closed', locked: false, everConnected: false, failed: true }), /Can't reach/);
  assert.match(statusMessage({ room: 'r', connection: 'closed', locked: false, everConnected: true, failed: true }), /Lost the connection/);
});

test('a secure page refuses an insecure relay with a reason', () => {
  const settings = remoteSettings('?room=r&relay=http://relay.example', 'https:');
  assert.equal(settings.ok, false);
  assert.match(settings.error, /isn't secure/);
});

test('a relay living under a path keeps it for every endpoint', () => {
  assert.equal(relayEndpoint('https://x.example/relay', 'rooms').href, 'https://x.example/relay/rooms');
  assert.equal(relayEndpoint('https://x.example/relay/', 'rooms/r/socket').href, 'https://x.example/relay/rooms/r/socket');
  assert.equal(relayEndpoint('http://127.0.0.1:8787', 'rooms').href, 'http://127.0.0.1:8787/rooms');
});
