// The page's half of the extension's toolbar count (src/core/toolbar-count.js): what it sends the
// worker, and when.

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { TOOLBAR_COUNT_EVERY, toolbarCount } from '../src/core/toolbar-count.js';

// sent: every count the worker was asked to show. state.fail makes the next sends reject.
function start({ prerendering = false, on = true } = {}) {
  const win = new EventTarget();
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  const doc = new EventTarget();
  doc.prerendering = prerendering;
  const sent = [];
  const warnings = [];
  const state = { count: 0, on, fail: false };
  const badge = toolbarCount({
    win,
    doc,
    send: (value) => {
      sent.push(value);
      return state.fail ? Promise.reject(new Error('the extension was updated')) : Promise.resolve(true);
    },
    count: () => state.count,
    enabled: () => state.on,
    log: { warn: (message) => warnings.push(message) },
  });
  return { win, doc, sent, warnings, state, badge };
}
// Every test runs on a clock it moves itself.
function clock(t) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  t.after(() => mock.timers.reset());
}
const settle = async () => {
  for (let index = 0; index < 5; index++) await Promise.resolve();
};

test('the count goes to the worker at most once a second, and only when it changed', async (t) => {
  clock(t);
  const { sent, state, badge } = start();
  mock.timers.tick(0);
  assert.deepEqual(sent, [0], 'a new page starts the tab at nothing');
  state.count = 1;
  badge.changed();
  state.count = 2;
  badge.changed();
  mock.timers.tick(TOOLBAR_COUNT_EVERY - 1);
  assert.deepEqual(sent, [0], 'not within the second');
  state.count = 3;
  badge.changed();
  mock.timers.tick(1);
  assert.deepEqual(sent, [0, 3], 'one send with the latest count');
  badge.changed();
  mock.timers.tick(TOOLBAR_COUNT_EVERY * 5);
  assert.deepEqual(sent, [0, 3], 'nothing new, nothing sent');
  state.count = 4;
  badge.changed();
  mock.timers.tick(0);
  assert.deepEqual(sent, [0, 3, 4], 'after a quiet second it goes at once');
});

test('the switch off or a pause sends 0, and back on sends the count again', async (t) => {
  clock(t);
  const { sent, state, badge } = start();
  state.count = 7;
  mock.timers.tick(0);
  assert.deepEqual(sent, [7]);
  state.on = false;
  badge.changed();
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  state.count = 9;
  badge.changed();
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  assert.deepEqual(sent, [7, 0], 'hides while off change nothing on the button');
  state.on = true;
  badge.changed();
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  assert.deepEqual(sent, [7, 0, 9]);
});

test('a page being left takes its count off the button, and one back from the cache puts it back', async (t) => {
  clock(t);
  const { win, sent, state, badge } = start();
  state.count = 5;
  mock.timers.tick(0);
  state.count = 6;
  badge.changed();
  win.dispatchEvent(new Event('pagehide'));
  assert.deepEqual(sent, [5, 0], 'at once, before the page is gone');
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  assert.deepEqual(sent, [5, 0], 'the change waiting to go was dropped');
  const shown = new Event('pageshow');
  shown.persisted = true;
  win.dispatchEvent(shown);
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  assert.deepEqual(sent, [5, 0, 6]);
  win.dispatchEvent(new Event('pageshow'));
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  assert.deepEqual(sent, [5, 0, 6], 'a first showing sends nothing more');

  // Nothing to take off.
  const quiet = start();
  mock.timers.tick(0);
  quiet.win.dispatchEvent(new Event('pagehide'));
  assert.deepEqual(quiet.sent, [0]);
});

test("a page Chrome is prerendering sends nothing until it's shown", async (t) => {
  clock(t);
  const { doc, sent, state, badge } = start({ prerendering: true });
  state.count = 2;
  mock.timers.tick(0);
  badge.changed();
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  assert.deepEqual(sent, []);
  doc.prerendering = false;
  doc.dispatchEvent(new Event('prerenderingchange'));
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  assert.deepEqual(sent, [2]);
});

test('a count the worker never took goes again with the next change, and the log hears once', async (t) => {
  clock(t);
  const { sent, warnings, state, badge } = start();
  state.fail = true;
  state.count = 3;
  mock.timers.tick(0);
  await settle();
  badge.changed();
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  await settle();
  assert.deepEqual(sent, [3, 3], 'the same count again, since the button never showed it');
  assert.equal(warnings.length, 1);
  state.fail = false;
  badge.changed();
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  await settle();
  badge.changed();
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  assert.deepEqual(sent, [3, 3, 3], 'and once it went, not again');
  assert.equal(warnings.length, 1);
});
