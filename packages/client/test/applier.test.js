import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createApplier } from '../src/applier.js';

/** A stand-in for document.documentElement that records every write. */
function fakeRoot(computed = {}, inline = {}) {
  const props = new Map(Object.entries(inline));
  const writes = [];

  return {
    writes,
    computed: (name) => props.get(name) ?? computed[name] ?? '',
    style: {
      setProperty(name, value) {
        props.set(name, value);
        writes.push([name, value]);
      },
      getPropertyValue: (name) => props.get(name) ?? '',
      removeProperty(name) {
        props.delete(name);
        writes.push([name, null]);
      },
    },
    get: (name) => props.get(name),
  };
}

function setup(computed, inline) {
  const root = fakeRoot(computed, inline);
  const flushes = [];
  const refused = [];
  const applier = createApplier({
    root,
    readComputed: root.computed,
    timers: { now: () => Date.now(), setTimeout, clearTimeout },
    onApply: (info) => flushes.push(info),
    onRefuse: (info) => refused.push(info),
  });

  return { root, applier, flushes, refused };
}

test('writes values with setProperty, one property at a time', () => {
  const { root, applier } = setup({ '--brand': '#be6700', '--radius': '4px' });
  applier.render({ '--brand': '#123456', '--radius': '8px' });
  assert.deepEqual(root.writes, [
    ['--brand', '#123456'],
    ['--radius', '8px'],
  ]);
});

test('the first change lands immediately, without waiting for a timer', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { root, applier } = setup({ '--brand': '#be6700' });
    applier.render({ '--brand': '#000000' });
    assert.equal(root.get('--brand'), '#000000');
  } finally {
    mock.timers.reset();
  }
});

test('damping: a flood of changes lands at most 3 times a second (WCAG 2.3.1)', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { root, applier, flushes } = setup({ '--brand': '#be6700' });
    // Someone strobes the hue slider: 100 changes a second for two seconds.
    for (let i = 0; i < 200; i += 1) {
      applier.render({ '--brand': i % 2 ? '#ffffff' : '#000000' });
      mock.timers.tick(10);
    }
    mock.timers.tick(1000);
    // No 1-second window holds more than 3 visible changes.
    const times = flushes.map((f) => f.at);
    for (const start of times) {
      assert.ok(times.filter((t) => t >= start && t < start + 1000).length <= 3, `window at ${start}`);
    }
    // And the page ends on the latest value, not a stale one.
    assert.equal(root.get('--brand'), '#ffffff');
  } finally {
    mock.timers.reset();
  }
});

test('refuses a value that does not match the type the page already uses', () => {
  const { root, applier, refused } = setup({ '--brand': '#be6700', '--radius': '4px' });
  applier.render({ '--brand': '12px', '--radius': 'red' });
  assert.deepEqual(root.writes, []);
  assert.deepEqual(
    refused.map((r) => r.name),
    ['--brand', '--radius'],
  );
});

test('refuses unsafe values even for properties with no known type', () => {
  const { root, applier, refused } = setup({});
  applier.render({ '--new-thing': 'url(https://example.com/a.png)' });
  assert.deepEqual(root.writes, []);
  assert.match(refused[0].reason, /url\(/);
});

test('reports contract knobs as needing the adapter rather than guessing', () => {
  const { root, applier, refused } = setup({});
  applier.render({ 'contract:color.background-brand': '#f05735' });
  assert.deepEqual(root.writes, []);
  assert.match(refused[0].reason, /page that uses Eddie/);
});

test('keys that leave the state go back to what the page had, inline values included', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { root, applier } = setup({ '--brand': '#be6700', '--radius': '4px' }, { '--radius': '2px' });
    applier.render({ '--brand': '#000000', '--radius': '9px' });
    mock.timers.tick(1000);
    applier.render({});
    assert.equal(root.get('--brand'), undefined); // had no inline value: removed
    assert.equal(root.get('--radius'), '2px'); // had its own inline value: restored
  } finally {
    mock.timers.reset();
  }
});

test('destroy puts the page back immediately, even mid-window', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { root, applier } = setup({ '--brand': '#be6700' });
    applier.render({ '--brand': '#000000' });
    applier.render({ '--brand': '#111111' }); // pending in the damping window
    applier.destroy();
    assert.equal(root.get('--brand'), undefined);
    mock.timers.tick(1000);
    assert.equal(root.get('--brand'), undefined);
  } finally {
    mock.timers.reset();
  }
});

test('a flush that changes nothing does not delay the next real edit', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { root, applier } = setup({ '--brand': '#be6700' });
    applier.render({ '--brand': '#000000' });
    mock.timers.tick(400);
    applier.render({ '--brand': '#000000' }); // a lock, or a repeat: nothing visible
    mock.timers.tick(50);
    applier.render({ '--brand': '#ffffff' }); // a real edit 50 ms later lands now
    assert.equal(root.get('--brand'), '#ffffff');
  } finally {
    mock.timers.reset();
  }
});

test('a refused value keeps the last good one on screen and is reported once', () => {
  const { root, applier, refused } = setup({ '--brand': '#be6700' });
  applier.render({ '--brand': '#000000' });
  applier.render({ '--brand': '12px' });
  applier.render({ '--brand': '12px' });
  assert.equal(root.get('--brand'), '#000000');
  assert.equal(refused.length, 1);
});

test('an adapter runs inside damping: a burst of messages resolves a few times, not once per message', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const root = fakeRoot({ '--brand': '#be6700' });
    let calls = 0;
    const statuses = [];
    const applier = createApplier({
      root,
      readComputed: root.computed,
      timers: { now: () => Date.now(), setTimeout, clearTimeout },
      resolve: (props) => {
        calls += 1;

        return { props: { '--brand': props['contract:brand'] }, status: { moved: [], problems: [], unchecked: 0 } };
      },
      onResolved: (status) => statuses.push(status),
    });
    for (let i = 0; i < 60; i += 1) {
      applier.render({ 'contract:brand': `#00000${i % 10}` });
      mock.timers.tick(16);
    }
    mock.timers.tick(1000);
    assert.ok(calls <= 5, `resolved ${calls} times for 60 messages`);
    assert.equal(statuses.length, calls);
    assert.equal(root.get('--brand'), '#000009');
  } finally {
    mock.timers.reset();
  }
});

test('what an adapter refuses is reported once, and what it resolves is still type-checked', () => {
  const root = fakeRoot({ '--brand': '#be6700' });
  const refused = [];
  const applier = createApplier({
    root,
    readComputed: root.computed,
    resolve: () => ({ props: { '--brand': '12px' }, refused: [{ name: 'contract:x', value: '1', reason: 'unknown knob' }] }),
    onRefuse: (r) => refused.push(r.name),
  });
  applier.render({ 'contract:x': '1' });
  applier.render({ 'contract:x': '1' });
  assert.deepEqual(refused, ['contract:x', '--brand']);
  assert.equal(root.get('--brand'), undefined);
});
