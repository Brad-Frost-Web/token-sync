import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startContent } from '../src/content.js';

function fakePage() {
  const props = new Map();
  const listeners = { message: [], disconnect: [] };
  const posted = [];
  const port = {
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
    disconnect: () => posted.push('disconnected'),
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
    chrome: { runtime: { connect: () => port } },
    window: { addEventListener() {}, removeEventListener() {} },
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

test('when the background stops or goes away, the page is put back', (t) => {
  for (const end of ['stop', 'drop']) {
    const page = fakePage();
    t.after(() => globalThis.tokenSyncExtension?.leave());
    startContent(page);
    page.send({ kind: 'config', room: 'detach' });
    page.send({ kind: 'msg', msg: { v: 1, room: 'detach', op: 'set', from: 'controller', props: { '--brand': '#0a7f5a' }, ts: 1 } });
    if (end === 'stop') page.send({ kind: 'stop' });
    else page.drop();
    assert.equal(page.props.get('--brand'), undefined, end);
    assert.equal(page.document.documentElement.dataset.tokenSync, undefined, end);
  }
});

test('injecting twice into one page starts it once', (t) => {
  const page = fakePage();
  t.after(() => globalThis.tokenSyncExtension?.leave());
  const first = startContent(page);
  assert.equal(startContent(page), first);
});
