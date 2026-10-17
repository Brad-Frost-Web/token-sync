import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sep } from 'node:path';
import { chunk, parseArgs, startsBuild } from '../bin/token-sync.js';
import { MAX_FRAME_LENGTH } from '../../relay/src/room.js';

test('--name=value works, and a flag never swallows the argument after it', () => {
  assert.deepEqual(parseArgs(['watch', '--send-initial', 'tokens.css', '--relay=http://r', '--build', '--x']).options, {
    _: ['tokens.css'],
    'send-initial': true,
    relay: 'http://r',
    build: '--x',
  });
});

test('changes are split into frames the relay accepts, not only by count', () => {
  const entries = Array.from({ length: 700 }, (_, i) => [`--ed-theme-color-background-default-${i}`, '#ffffff']);
  const chunks = chunk('room1', entries);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.reduce((n, c) => n + Object.keys(c).length, 0), 700);
  for (const props of chunks) {
    const frame = JSON.stringify({ kind: 'msg', msg: { v: 1, room: 'room1', op: 'set', from: 'source', props } });
    assert.ok(frame.length <= MAX_FRAME_LENGTH, `${frame.length} > ${MAX_FRAME_LENGTH}`);
    assert.ok(Object.keys(props).length <= 500);
  }
});

test('build output never starts a build (Eddie: sources and build/ under one theme folder)', () => {
  const root = `${sep}repo${sep}bfw`;
  const target = `${root}${sep}out${sep}tokens.css`; // output inside the source folder, under any name
  assert.equal(startsBuild(root, `${root}${sep}tier-1${sep}color.json`, target), true);
  assert.equal(startsBuild(root, `${root}${sep}build${sep}js${sep}tokens.js`, target), false);
  assert.equal(startsBuild(root, `${root}${sep}out${sep}tokens.json`, target), false);
  assert.equal(startsBuild(root, target, target), false);
  assert.equal(startsBuild(root, `${root}${sep}node_modules${sep}x.json`, target), false);
});

test('a source folder inside the stylesheet\'s folder still builds', () => {
  const target = `${sep}proj${sep}tokens.css`;
  assert.equal(startsBuild(`${sep}proj${sep}src`, `${sep}proj${sep}src${sep}brand.json`, target), true);
});
