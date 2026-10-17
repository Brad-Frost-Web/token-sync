import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createApplier } from '../src/applier.js';
import { createWipe, holdToCompare, WIPE_CLASS } from '../src/wipe.js';

/** Enough of a document for the wipe: a head, a root with classes, and View Transitions. */
function fakeDocument({ viewTransitions = true } = {}) {
  const classes = new Set();
  const styles = [];
  const transitions = [];
  const doc = {
    head: { append: (el) => styles.push(el) },
    getElementById: (id) => styles.find((el) => el.id === id) ?? null,
    createElement: () => ({}),
    documentElement: { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) } },
  };
  if (viewTransitions) {
    doc.startViewTransition = (update) => {
      let finish;
      const finished = new Promise((resolve) => (finish = resolve));
      transitions.push({ update, finish });

      return { finished };
    };
  }

  return { doc, classes, styles, transitions };
}

const motion = (reduce) => (query) => ({ matches: reduce && query === '(prefers-reduced-motion: reduce)' });

test('a change runs inside a View Transition, with the sweep scoped by a class on <html>', async () => {
  const { doc, classes, styles, transitions } = fakeDocument();
  const wipe = createWipe({ document: doc, matchMedia: motion(false) });
  let ran = false;
  wipe(() => (ran = true));
  assert.equal(transitions.length, 1);
  assert.equal(classes.has(WIPE_CLASS), true);
  assert.equal(styles.length, 1);
  transitions[0].update();
  assert.equal(ran, true);
  transitions[0].finish();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(classes.has(WIPE_CLASS), false);
  wipe(() => {});
  assert.equal(styles.length, 1); // the styles go in once
});

test('prefers-reduced-motion: the change lands at once, with no transition', () => {
  const { doc, transitions } = fakeDocument();
  let ran = false;
  createWipe({ document: doc, matchMedia: motion(true) })(() => (ran = true));
  assert.equal(ran, true);
  assert.equal(transitions.length, 0);
});

test('without View Transitions the change still lands', () => {
  const { doc } = fakeDocument({ viewTransitions: false });
  let ran = false;
  createWipe({ document: doc, matchMedia: motion(false) })(() => (ran = true));
  assert.equal(ran, true);
});

function fakeRoot(computed = {}) {
  const props = new Map();

  return {
    get: (n) => props.get(n),
    readComputed: (n) => props.get(n) ?? computed[n] ?? '',
    style: {
      setProperty: (n, v) => props.set(n, v),
      getPropertyValue: (n) => props.get(n) ?? '',
      removeProperty: (n) => props.delete(n),
    },
  };
}

test('hold() shows the page as it was, and letting go brings the room back', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const root = fakeRoot({ '--brand': '#be6700' });
    const applier = createApplier({ root, readComputed: root.readComputed, timers: { now: Date.now, setTimeout, clearTimeout } });
    applier.render({ '--brand': '#000000' });
    assert.equal(root.get('--brand'), '#000000');
    mock.timers.tick(400);
    applier.hold(true);
    assert.equal(root.get('--brand'), undefined); // before: the page's own value
    mock.timers.tick(400);
    applier.render({ '--brand': '#111111' }); // a change arrives while held
    assert.equal(root.get('--brand'), undefined);
    applier.hold(false);
    mock.timers.tick(400);
    assert.equal(root.get('--brand'), '#111111'); // after: the room's latest
  } finally {
    mock.timers.reset();
  }
});

test('tapping the compare key fast is still damped to 3 changes a second', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const root = fakeRoot({ '--brand': '#be6700' });
    const applied = [];
    const applier = createApplier({ root, readComputed: root.readComputed, timers: { now: Date.now, setTimeout, clearTimeout }, onApply: (i) => applied.push(i.at) });
    applier.render({ '--brand': '#000000' });
    for (let i = 0; i < 20; i += 1) {
      applier.hold(i % 2 === 0);
      mock.timers.tick(50);
    }
    mock.timers.tick(1000);
    for (const start of applied) assert.ok(applied.filter((t) => t >= start && t < start + 1000).length <= 3);
  } finally {
    mock.timers.reset();
  }
});

test('the compare key: hold for before, release for after, and never while typing', () => {
  const listeners = new Map();
  const target = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  };
  const calls = [];
  const stop = holdToCompare({ hold: (on) => calls.push(on) }, { target });
  const key = (type, init = {}) => listeners.get(type)?.({ target: null, repeat: false, ...init });
  key('keydown', { key: '\\' });
  key('keydown', { key: '\\', repeat: true }); // auto-repeat is ignored
  key('keyup', { key: '\\' });
  key('keydown', { key: '\\', target: { tagName: 'INPUT' } }); // typing a backslash
  key('keydown', { key: 'a' });
  assert.deepEqual(calls, [true, false]);
  key('keydown', { key: '\\' });
  key('blur'); // released outside the window
  assert.deepEqual(calls, [true, false, true, false]);
  stop();
  key('keydown', { key: '\\' });
  assert.equal(calls.length, 4);
});

/** A transition hook like the real one: `update` runs later, not now. */
function deferredTransition() {
  const queue = [];

  return { queue, transition: (update, info) => queue.push({ update, info }), runAll: () => queue.splice(0).forEach((t) => t.update()) };
}

test('leaving the room while a sweep is pending writes nothing afterwards', () => {
  const root = fakeRoot({ '--brand': '#be6700' });
  const later = deferredTransition();
  const applier = createApplier({ root, readComputed: root.readComputed, transition: later.transition });
  applier.render({ '--brand': '#000000' }); // planned, not yet written
  applier.destroy(); // the tab leaves the room
  later.runAll(); // the View Transition's callback finally runs
  assert.equal(root.get('--brand'), undefined);
});

test('a late transition callback writes the newest state, not the state when it was scheduled', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const root = fakeRoot({ '--brand': '#be6700' });
    const later = deferredTransition();
    const applier = createApplier({ root, readComputed: root.readComputed, timers: { now: Date.now, setTimeout, clearTimeout }, transition: later.transition });
    applier.render({ '--brand': '#000000' });
    mock.timers.tick(400);
    applier.render({ '--brand': '#111111' });
    later.runAll();
    assert.equal(root.get('--brand'), '#111111');
  } finally {
    mock.timers.reset();
  }
});

test('the transition is told whether the compare key or the room asked for it', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const root = fakeRoot({ '--brand': '#be6700' });
    const later = deferredTransition();
    const applies = [];
    const applier = createApplier({ root, readComputed: root.readComputed, timers: { now: Date.now, setTimeout, clearTimeout }, transition: later.transition, onApply: (i) => applies.push(i.cause) });
    applier.render({ '--brand': '#000000' });
    assert.deepEqual(later.queue.map((t) => t.info.cause), ['render']);
    later.runAll();
    mock.timers.tick(400);
    applier.hold(true);
    assert.deepEqual(later.queue.map((t) => t.info.cause), ['hold']);
    later.runAll();
    assert.deepEqual(applies, ['render', 'hold']);
  } finally {
    mock.timers.reset();
  }
});

test('a refused value while held keeps its last good value for when the hold ends', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const root = fakeRoot({ '--brand': '#be6700' });
    const applier = createApplier({ root, readComputed: root.readComputed, timers: { now: Date.now, setTimeout, clearTimeout } });
    applier.render({ '--brand': '#000000' });
    mock.timers.tick(400);
    applier.hold(true);
    applier.render({ '--brand': '12px' }); // refused: not a colour
    mock.timers.tick(400);
    applier.hold(false);
    mock.timers.tick(400);
    assert.equal(root.get('--brand'), '#000000');
  } finally {
    mock.timers.reset();
  }
});

test('overlapping sweeps keep the class until the last one ends', async () => {
  const { doc, classes, transitions } = fakeDocument();
  const wipe = createWipe({ document: doc, matchMedia: motion(false) });
  wipe(() => {});
  wipe(() => {});
  transitions[0].finish();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(classes.has(WIPE_CLASS), true);
  transitions[1].finish();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(classes.has(WIPE_CLASS), false);
});

test("the page's own view transition is never cancelled by ours", () => {
  const { doc, transitions } = fakeDocument();
  doc.activeViewTransition = {}; // the page is mid-transition
  let ran = false;
  createWipe({ document: doc, matchMedia: motion(false) })(() => (ran = true));
  assert.equal(ran, true);
  assert.equal(transitions.length, 0);
});

test('the hold is released by the same physical key, whatever it types by then', () => {
  const listeners = new Map();
  const target = { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: () => {} };
  const calls = [];
  holdToCompare({ hold: (on) => calls.push(on) }, { target });
  listeners.get('keydown')({ key: '\\', code: 'Backslash' });
  listeners.get('keyup')({ key: '|', code: 'Backslash' }); // Shift went down meanwhile
  listeners.get('keydown')({ key: '\\', code: 'Backslash', ctrlKey: true }); // a shortcut, not a hold
  listeners.get('keydown')({ key: '\\', code: 'Backslash', composedPath: () => [{ tagName: 'INPUT' }] }); // typing inside a shadow root
  assert.deepEqual(calls, [true, false]);
});
