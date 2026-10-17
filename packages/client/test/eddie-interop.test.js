// A lab page and Eddie's customizer in one room, over broadcast (#25).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../src/connect.js';
import { createEddieBroadcastTransport } from './fixtures/eddie-broadcast.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/** A recording applier: the props the page would show. */
function fakeApplier() {
  const page = { props: {} };

  return { page, render: (props) => (page.props = { ...props }), destroy: () => (page.props = {}) };
}

test('what an Eddie customizer publishes reaches a lab page, fonts, scope and all', async (t) => {
  const applier = fakeApplier();
  const errors = [];
  const lab = connect({ room: 'ix-in', applier, onError: ({ errors: e }) => errors.push(...e) });
  const eddie = createEddieBroadcastTransport('ix-in');
  t.after(() => {
    lab.close();
    eddie.close();
  });
  // The shape sendToRoom() builds: scope is the base theme, from is presenter on broadcast.
  eddie.publish({ v: 1, room: 'ix-in', op: 'set', props: { '--ed-theme-font-family-display': '"Fraunces", serif', '--ed-theme-color-background-brand': '#1b4dd8' }, scope: 'bfw', from: 'presenter', fonts: ['Fraunces'] });
  await settle();
  assert.deepEqual(errors, []);
  assert.equal(applier.page.props['--ed-theme-color-background-brand'], '#1b4dd8');
  // null clears, as diffProps() sends when a knob is put back.
  eddie.publish({ v: 1, room: 'ix-in', op: 'set', props: { '--ed-theme-color-background-brand': null }, scope: 'bfw', from: 'presenter' });
  await settle();
  assert.deepEqual(errors, []);
  assert.equal('--ed-theme-color-background-brand' in applier.page.props, false);
  assert.equal(applier.page.props['--ed-theme-font-family-display'], '"Fraunces", serif');
});

test('what a lab page publishes reaches the customizer as a stamped token-sync/1 message', async (t) => {
  const lab = connect({ room: 'ix-out' });
  const eddie = createEddieBroadcastTransport('ix-out');
  const heard = [];
  eddie.subscribe((m) => heard.push(m));
  t.after(() => {
    lab.close();
    eddie.close();
  });
  lab.set({ '--ed-theme-color-background-brand': '#0a7f5a' });
  await settle();
  const set = heard.find((m) => m.op === 'set');
  assert.ok(set);
  assert.equal(set.v, 1);
  assert.equal(set.room, 'ix-out');
  assert.equal(typeof set.ts, 'number');
  assert.deepEqual(set.props, { '--ed-theme-color-background-brand': '#0a7f5a' });
});

test('a display customizer joining late is answered by the lab page, and no reset comes with it', async (t) => {
  const lab = connect({ room: 'ix-ask' });
  t.after(() => lab.close());
  lab.reset();
  lab.set({ '--ed-theme-color-background-brand': '#0a7f5a' });
  await settle();
  const eddie = createEddieBroadcastTransport('ix-ask');
  t.after(() => eddie.close());
  const heard = [];
  eddie.subscribe((m) => heard.push(m));
  // What connectRoom() sends for a display: an empty snapshot.
  eddie.publish({ v: 1, room: 'ix-ask', op: 'snapshot', props: {}, scope: 'bfw', from: 'source' });
  await settle();
  assert.deepEqual(heard.map((m) => m.op), ['snapshot']);
  assert.deepEqual(heard[0].props, { '--ed-theme-color-background-brand': '#0a7f5a' });
});

test("a customizer's answer, stamped when it answers, fills a lab page but never undoes a newer write", async (t) => {
  const applier = fakeApplier();
  const lab = connect({ room: 'ix-fill', applier });
  const eddie = createEddieBroadcastTransport('ix-fill');
  t.after(() => {
    lab.close();
    eddie.close();
  });
  lab.set({ '--ed-theme-color-background-brand': '#0a7f5a' });
  await settle();
  // The customizer answers with what it published a while ago, stamped now.
  eddie.publish({ v: 1, room: 'ix-fill', op: 'snapshot', props: { '--ed-theme-color-background-brand': '#ff0000', '--ed-theme-border-radius-md': '12px' }, from: 'source' });
  await settle();
  assert.equal(applier.page.props['--ed-theme-color-background-brand'], '#0a7f5a');
  assert.equal(applier.page.props['--ed-theme-border-radius-md'], '12px');
});

test('with keyFor, a contract path and its property are one token: a null to either clears it', async (t) => {
  const { lazyEddieAdapter } = await import('../../script/src/eddie.js');
  const { keyFor } = lazyEddieAdapter({ readComputed: () => '' });
  const applier = fakeApplier();
  const lab = connect({ room: 'ix-key', applier, keyFor });
  const eddie = createEddieBroadcastTransport('ix-key');
  t.after(() => {
    lab.close();
    eddie.close();
  });
  eddie.publish({ v: 1, room: 'ix-key', op: 'set', props: { 'contract:color.background.brand': '#1b4dd8' }, from: 'presenter' });
  await settle();
  assert.equal(applier.page.props['--ed-theme-color-background-brand'], '#1b4dd8');
  lab.set({ '--ed-theme-color-background-brand': null });
  await settle();
  assert.deepEqual(applier.page.props, {});
});
