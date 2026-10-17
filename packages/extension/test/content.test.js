import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { startContent } from '../src/content.js';

function fakePage() {
  const props = new Map();
  let listeners;
  const posted = [];
  let connects = 0;
  const makePort = () => {
    connects += 1;
    listeners = { message: [], disconnect: [] };

    return {
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
      postMessage: (m) => posted.push(m),
      disconnect: () => posted.push('disconnected'),
    };
  };
  const document = {
    documentElement: {
      dataset: {},
      style: { setProperty: (n, v) => props.set(n, v), getPropertyValue: (n) => props.get(n) ?? '', removeProperty: (n) => props.delete(n) },
    },
  };

  return {
    props,
    posted,
    document,
    chrome: { runtime: { connect: makePort } },
    window: { addEventListener() {}, removeEventListener() {} },
    connects: () => connects,
    send: (frame) => listeners.message.forEach((fn) => fn(frame)),
    drop: () => listeners.disconnect.forEach((fn) => fn()),
  };
}

test('the page applies what the background sends, with the same guardrails as the drop-in', (t) => {
  const page = fakePage();
  t.after(() => globalThis.tokenSyncExtension?.leave());
  startContent(page);
  page.send({ kind: 'config', room: 'detach' });
  page.send({ kind: 'msg', msg: { v: 1, room: 'detach', op: 'set', from: 'controller', props: { '--brand': '#0a7f5a', '--bg': 'url(x)' }, ts: 1 } });
  assert.equal(page.document.documentElement.dataset.tokenSync, 'detach');
  assert.equal(page.props.get('--brand'), undefined); // the whole message was refused for its url(
  page.send({ kind: 'msg', msg: { v: 1, room: 'detach', op: 'set', from: 'controller', props: { '--brand': '#0a7f5a' }, ts: 2 } });
  assert.equal(page.props.get('--brand'), '#0a7f5a');
});

test('when the background says stop, the page is put back', (t) => {
  const page = fakePage();
  t.after(() => globalThis.tokenSyncExtension?.leave());
  startContent(page);
  page.send({ kind: 'config', room: 'detach' });
  page.send({ kind: 'msg', msg: { v: 1, room: 'detach', op: 'set', from: 'controller', props: { '--brand': '#0a7f5a' }, ts: 1 } });
  page.send({ kind: 'stop' });
  assert.equal(page.props.get('--brand'), undefined);
  assert.equal(page.document.documentElement.dataset.tokenSync, undefined);
});

test('when the background restarts, the page reconnects instead of reverting; it gives up after a few tries', (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());
  const page = fakePage();
  t.after(() => globalThis.tokenSyncExtension?.leave());
  startContent({ ...page, timers: globalThis });
  page.send({ kind: 'config', room: 'detach' });
  page.send({ kind: 'msg', msg: { v: 1, room: 'detach', op: 'set', from: 'controller', props: { '--brand': '#0a7f5a' }, ts: 1 } });
  page.drop(); // the background was stopped for being idle
  mock.timers.tick(300);
  assert.equal(page.connects(), 2);
  assert.equal(page.props.get('--brand'), '#0a7f5a'); // still showing the room
  for (let i = 0; i < 6; i += 1) {
    page.drop();
    mock.timers.tick(2000);
  }
  assert.equal(page.props.get('--brand'), undefined); // gave up: page put back
});

test('the page sends a heartbeat that keeps the background alive', (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => mock.timers.reset());
  const page = fakePage();
  t.after(() => globalThis.tokenSyncExtension?.leave());
  startContent({ ...page, timers: globalThis });
  mock.timers.tick(20000);
  assert.ok(page.posted.some((m) => m.kind === 'beat'));
});

test('injecting twice into one page starts it once', (t) => {
  const page = fakePage();
  t.after(() => globalThis.tokenSyncExtension?.leave());
  const first = startContent(page);
  assert.equal(startContent(page), first);
});
