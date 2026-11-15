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
  // hold: the next sends wait in held for the test to answer them.
  const state = { count: 0, on, fail: false, hold: false, held: [] };
  const badge = toolbarCount({
    win,
    doc,
    send: (value) => {
      sent.push(value);
      if (state.hold) return new Promise((resolve, reject) => state.held.push({ resolve, reject }));
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
  state.count = 7;
  badge.changed();
  mock.timers.tick(TOOLBAR_COUNT_EVERY * 3);
  assert.deepEqual(sent, [5, 0], 'nor does a change on the hidden page go');
  state.count = 6;
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
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  await settle();
  mock.timers.tick(TOOLBAR_COUNT_EVERY * 10);
  await settle();
  assert.deepEqual(sent, [3, 3], 'its one try by itself is lost too, then it waits');
  badge.changed();
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  await settle();
  assert.deepEqual(sent, [3, 3, 3], 'the same count again with the next change, since the button never showed it');
  assert.equal(warnings.length, 1);
  state.fail = false;
  badge.changed();
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  await settle();
  badge.changed();
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  assert.deepEqual(sent, [3, 3, 3, 3], 'and once it went, not again');
  assert.equal(warnings.length, 1);
});

test("only the newest send's answer spends the extra try or gives it back, whatever order answers come in", async (t) => {
  clock(t);
  // An old send lost after a newer one went through: the button has the newer count, and the
  // next loss still gets its try.
  const late = start();
  late.state.hold = true;
  late.state.count = 1;
  mock.timers.tick(0);
  const [first] = late.state.held;
  late.state.hold = false;
  late.state.count = 2;
  late.badge.changed();
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  await settle();
  first.reject(new Error('no answer in time'));
  await settle();
  mock.timers.tick(TOOLBAR_COUNT_EVERY * 5);
  await settle();
  assert.deepEqual(late.sent, [1, 2], 'the button shows 2, so nothing goes again');
  late.state.fail = true;
  late.state.count = 3;
  late.badge.changed();
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  await settle();
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  await settle();
  assert.deepEqual(late.sent, [1, 2, 3, 3], 'the lost 3 still gets its one try');

  // An old send that went through after a newer one was lost doesn't give the newer one a
  // second try.
  const early = start();
  early.state.hold = true;
  early.state.count = 1;
  mock.timers.tick(0);
  const [slow] = early.state.held;
  early.state.hold = false;
  early.state.fail = true;
  early.state.count = 2;
  early.badge.changed();
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  await settle();
  slow.resolve(true);
  await settle();
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  await settle();
  mock.timers.tick(TOOLBAR_COUNT_EVERY * 5);
  await settle();
  assert.deepEqual(early.sent, [1, 2, 2], 'one try for the lost 2, not two');
});

test("a page back from the cache gets its own try, whatever the 0 it sent on its way into the cache hears late", async (t) => {
  clock(t);
  // It left with its one try already spent on a lost 5.
  const { win, sent, warnings, state } = start();
  state.fail = true;
  state.count = 5;
  mock.timers.tick(0);
  await settle();
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  await settle();
  state.fail = false;
  state.hold = true;
  win.dispatchEvent(new Event('pagehide'));
  const [leaving] = state.held;
  state.hold = false;
  const shown = new Event('pageshow');
  shown.persisted = true;
  win.dispatchEvent(shown);
  leaving.reject(new Error('the port closed'));
  await settle();
  state.fail = true;
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  await settle();
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  await settle();
  mock.timers.tick(TOOLBAR_COUNT_EVERY * 10);
  await settle();
  assert.deepEqual(sent, [5, 5, 0, 5, 5], 'the lost 5 still goes once more by itself, and only once');
  assert.equal(warnings.length, 1);
});

test('a count the worker lost goes once more by itself a second later, as the count is then, and never from a hidden page', async (t) => {
  clock(t);
  const { sent, warnings, state, badge } = start();
  state.fail = true;
  state.count = 3;
  mock.timers.tick(0);
  await settle();
  state.fail = false;
  state.count = 4;
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  await settle();
  assert.deepEqual(sent, [3, 4], 'no change needed, and the newest count, not the lost one');
  assert.equal(warnings.length, 1);

  // Lost twice in a row (an updated extension): one more try, then it waits for the next change.
  state.fail = true;
  state.count = 5;
  badge.changed();
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  await settle();
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  await settle();
  mock.timers.tick(TOOLBAR_COUNT_EVERY * 10);
  await settle();
  assert.deepEqual(sent, [3, 4, 5, 5]);
  // A send that went through gives the next loss its own try again.
  state.fail = false;
  state.count = 6;
  badge.changed();
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  await settle();
  state.fail = true;
  state.count = 7;
  badge.changed();
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  await settle();
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  await settle();
  assert.deepEqual(sent, [3, 4, 5, 5, 6, 7, 7]);

  // The 0 a page sends on its way into the back/forward cache isn't tried again while it's away.
  const away = start();
  away.state.count = 5;
  mock.timers.tick(0);
  await settle();
  away.state.fail = true;
  away.win.dispatchEvent(new Event('pagehide'));
  await settle();
  mock.timers.tick(TOOLBAR_COUNT_EVERY * 5);
  await settle();
  assert.deepEqual(away.sent, [5, 0]);
  away.state.fail = false;
  const shown = new Event('pageshow');
  shown.persisted = true;
  away.win.dispatchEvent(shown);
  mock.timers.tick(TOOLBAR_COUNT_EVERY);
  assert.deepEqual(away.sent, [5, 0, 5], 'back, it sends its count');
});
