import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createCoalescer } from '../src/coalesce.js';

const timers = () => ({ now: Date.now, setTimeout, clearTimeout });

test('a drag of 60 events a second goes out as at most 10 messages a second, ending on the latest value', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const sent = [];
    const c = createCoalescer((props) => sent.push({ at: Date.now(), props }), { timers: timers() });
    for (let i = 0; i < 60; i += 1) {
      c.push({ '--radius': `${i}px` });
      mock.timers.tick(1000 / 60);
    }
    mock.timers.tick(200);
    for (const { at } of sent) assert.ok(sent.filter((s) => s.at >= at && s.at < at + 1000).length <= 10);
    assert.equal(sent.at(-1).props['--radius'], '59px');
  } finally {
    mock.timers.reset();
  }
});

test('the first change goes at once, and keys changed together travel together', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const sent = [];
    const c = createCoalescer((props) => sent.push(props), { timers: timers() });
    c.push({ '--a': '1px' });
    assert.deepEqual(sent, [{ '--a': '1px' }]);
    c.push({ '--a': '2px' });
    c.push({ '--b': 'red' });
    mock.timers.tick(100);
    assert.deepEqual(sent[1], { '--a': '2px', '--b': 'red' });
  } finally {
    mock.timers.reset();
  }
});

test('flush() sends what is queued now', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const sent = [];
    const c = createCoalescer((props) => sent.push(props), { timers: timers() });
    c.push({ '--a': '1px' });
    c.push({ '--a': '2px' });
    c.flush();
    assert.deepEqual(sent, [{ '--a': '1px' }, { '--a': '2px' }]);
    mock.timers.tick(500);
    assert.equal(sent.length, 2);
  } finally {
    mock.timers.reset();
  }
});
