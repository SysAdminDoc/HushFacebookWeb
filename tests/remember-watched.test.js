// Remember what you watch: reels, videos and stories listed once they've played or stayed open a
// few seconds, newest first, one entry each, kept for each account.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { activityKeyFor, createActivityStorage } from '../src/core/activity.js';
import { createMemoryStorage } from '../src/core/storage.js';
import {
  COUNTS_AFTER, MAX_WATCHED, WATCHED_KEY, addWatched, ago, createWatchList, describe, entriesOf, entryOf, linkOf, storyOf,
} from '../src/features/playback/remember-watched.js';

const FB = 'https://www.facebook.com';
const REEL = '1088226293914076';
const CARD = 'UzpfSVNDOjE5MjM0NTY3ODkwMTIzNDU2%3D%3D';
const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

function page(html = '') {
  const win = testWindow(`${FB}/`);
  windows.push(win);
  win.document.body.innerHTML = html;
  return win;
}

// A video whose time moves a quarter second per timeupdate while it plays, as players fire it.
function player(win, parent, { duration = 40, muted = false, volume = 1 } = {}) {
  const video = win.document.createElement('video');
  let time = 0;
  let stopped = true;
  let mute = muted;
  Object.defineProperties(video, {
    duration: { get: () => duration, configurable: true },
    currentTime: { get: () => time, set: (value) => { time = value; }, configurable: true },
    paused: { get: () => stopped, configurable: true },
    muted: { get: () => mute, configurable: true },
    volume: { get: () => volume, configurable: true },
  });
  (parent ?? win.document.body).append(video);
  const fire = () => video.dispatchEvent(new win.Event('timeupdate'));
  return {
    video,
    playTo(seconds) {
      stopped = false;
      while (time < seconds) {
        time = Math.min(seconds, time + 0.25);
        fire();
      }
    },
    seek(seconds) {
      time = seconds;
      fire();
    },
    pause() {
      stopped = true;
      fire();
    },
    unmute() {
      mute = false;
    },
  };
}

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    set: (run, ms) => {
      pending.set(next, { run, ms });
      return next++;
    },
    clear: (id) => pending.delete(id),
    runAll() {
      const due = [...pending.values()];
      pending.clear();
      for (const { run } of due) run();
    },
    delays: () => [...pending.values()].map(({ ms }) => ms),
  };
}

function watcher(win, { storage = createMemoryStorage(), on = () => true, at = `${FB}/` } = {}) {
  let address = at;
  let clock = 1_000_000;
  const listeners = [];
  const timers = fakeTimers();
  const list = createWatchList({
    doc: win.document, storage, enabled: () => on(), href: () => address, now: () => clock++,
    setTimer: timers.set, clearTimer: timers.clear,
  });
  list.start({ subscribe: (listener) => listeners.push(listener) });
  return {
    list,
    storage,
    timers,
    go(href) {
      address = href;
      for (const listener of listeners) listener();
    },
    // A content script's router only sees a new address on its next look, half a second later.
    moveUnheard(href) {
      address = href;
    },
    ids: () => list.entries().map((entry) => `${entry.kind}:${entry.id}`),
  };
}

test('entries are checked and linked, kept newest first, one for each and 50 at most', () => {
  assert.deepEqual(entryOf({ kind: 'reel', id: REEL, at: 5, owner: 'Example Page', length: 41.6 }), { kind: 'reel', id: REEL, at: 5, owner: 'Example Page', length: 42 });
  assert.deepEqual(entryOf({ kind: 'video', id: '2234567890', at: 5, owner: ' ', length: Infinity, bucket: 'x' }), { kind: 'video', id: '2234567890', at: 5 }, 'a blank name, an endless length and a stray bucket are dropped');
  assert.deepEqual(entryOf({ kind: 'story', id: CARD, bucket: '108123456789', at: 5, owner: 'x'.repeat(81) }), { kind: 'story', id: CARD, bucket: '108123456789', at: 5 });
  for (const bad of [
    null, [], 'reel', { kind: 'photo', id: '2234567890', at: 5 }, { kind: 'reel', id: 'javascript:alert(1)', at: 5 }, { kind: 'reel', id: '12345', at: 5 },
    { kind: 'reel', id: 2234567890, at: 5 }, { kind: 'reel', id: REEL, at: 0 }, { kind: 'story', id: CARD, at: 5 }, { kind: 'story', id: 'a/b', bucket: '1', at: 5 },
    { kind: 'story', id: CARD, bucket: '../settings', at: 5 },
  ]) assert.equal(entryOf(bad), null, JSON.stringify(bad));

  assert.equal(linkOf({ kind: 'reel', id: REEL }), `/reel/${REEL}/`);
  assert.equal(linkOf({ kind: 'video', id: '2234567890' }), '/watch/?v=2234567890');
  assert.equal(linkOf({ kind: 'story', id: CARD, bucket: '108123456789' }), `/stories/108123456789/${CARD}/`);
  assert.deepEqual(storyOf(`${FB}/stories/108123456789/${CARD}/?view_single=false`), { kind: 'story', bucket: '108123456789', id: CARD });
  assert.equal(storyOf(`${FB}/stories/108123456789/`), null, 'the tray of one person, no card yet');
  assert.equal(storyOf(`${FB}/reel/${REEL}`), null);
  assert.equal(storyOf('not an address'), null);

  const a = { kind: 'reel', id: REEL, at: 1 };
  const b = { kind: 'video', id: '2234567890', at: 2 };
  assert.deepEqual(addWatched([b, a], { ...a, at: 3 }), [{ ...a, at: 3 }, b], 'watching it again moves it up');
  assert.deepEqual(addWatched([{ ...b, kind: 'reel' }], b).map((e) => e.kind), ['video', 'reel'], 'a reel and a video with one id are two entries');
  let list = [];
  for (let i = 0; i < MAX_WATCHED + 10; i++) list = addWatched(list, { kind: 'video', id: String(3000000000 + i), at: i + 1 });
  assert.equal(list.length, MAX_WATCHED);
  assert.equal(list[0].id, String(3000000000 + MAX_WATCHED + 9), 'newest first');
  assert.equal(list.at(-1).id, '3000000010', 'the oldest went');
  assert.deepEqual(entriesOf([a, { kind: 'reel', id: 'x', at: 1 }, null, b]), [a, b], 'a damaged entry is left out, the rest stay');
  assert.deepEqual(entriesOf({ 0: a }), []);
});

test("a reel on its own page counts after three seconds of playback, muted or not, and only once", () => {
  const win = page();
  const w = watcher(win, { at: `${FB}/reel/${REEL}` });
  const reel = player(win, null, { muted: true });
  reel.playTo(COUNTS_AFTER);
  assert.deepEqual(w.ids(), [], 'the first update only marks where it started');
  reel.playTo(COUNTS_AFTER + 0.25);
  assert.deepEqual(w.ids(), [`reel:${REEL}`]);
  assert.equal(w.list.entries()[0].length, 40);
  const first = w.list.entries()[0].at;
  reel.playTo(20);
  assert.equal(w.list.entries()[0].at, first, 'counted once while it plays on');

  // A muted video in a post on the reel's page is a feed video, not the reel.
  const post = win.document.createElement('div');
  post.innerHTML = `<div aria-posinset="1"><a href="${FB}/examplepage/videos/4234567890/">3h</a><div class="player"></div></div>`;
  win.document.body.append(post);
  player(win, post.querySelector('.player'), { muted: true }).playTo(10);
  assert.deepEqual(w.ids(), [`reel:${REEL}`]);

  // Facebook plays the next reel in the same element, and the count starts over for it.
  w.go(`${FB}/reel/2234567890123`);
  reel.playTo(23);
  assert.deepEqual(w.ids(), [`reel:${REEL}`], 'under three seconds of the new one');
  reel.playTo(23.25);
  assert.deepEqual(w.ids(), ['reel:2234567890123', `reel:${REEL}`]);

  // Seeking and paused updates don't add to the count.
  w.go(`${FB}/reel/3234567890123`);
  reel.seek(0);
  reel.seek(30);
  reel.pause();
  reel.seek(30.5);
  reel.seek(31);
  reel.playTo(33.75);
  assert.equal(w.ids().length, 2, 'a jump, then paused steps, then 2.75 seconds played');
  reel.playTo(34);
  assert.equal(w.ids()[0], 'reel:3234567890123');
});

test("a video in the feed counts once it's played three seconds with sound, with the poster's name", () => {
  const post = (id, name) => `<div aria-posinset="1"><h3><a href="/example">${name}</a></h3><a href="${FB}/examplepage/videos/${id}/">3h</a><div class="player"></div></div>`;
  const win = page(`${post('2234567890', 'Example Page')}${post('3234567890', 'Other Page')}<div class="gif"></div>`);
  let on = true;
  const w = watcher(win, { on: () => on });
  const [first, second] = win.document.querySelectorAll('.player');
  const video = player(win, first, { muted: true });
  video.playTo(10);
  assert.deepEqual(w.ids(), [], 'playing by itself, muted');
  video.unmute();
  video.playTo(12.75);
  assert.deepEqual(w.ids(), []);
  video.playTo(13);
  assert.deepEqual(w.list.entries(), [{ kind: 'video', id: '2234567890', at: w.list.entries()[0].at, owner: 'Example Page', length: 40 }]);

  player(win, second, { volume: 0 }).playTo(10);
  assert.equal(w.ids().length, 1, 'turned all the way down is no sound either');
  player(win, win.document.querySelector('.gif')).playTo(10);
  assert.equal(w.ids().length, 1, 'a video with no link to name it');

  on = false;
  const third = win.document.createElement('div');
  third.innerHTML = post('4234567890', 'Third Page');
  win.document.body.append(third);
  player(win, third.querySelector('.player')).playTo(10);
  assert.equal(w.ids().length, 1, 'nothing while the switch is off');
});

test('a story counts once its card is still open three seconds later, in a tab you can see', () => {
  const win = page();
  let on = true;
  const w = watcher(win, { on: () => on });
  const story = (card) => `${FB}/stories/108123456789/${card}/`;

  w.go(story('AAAAAAAA'));
  assert.deepEqual(w.timers.delays(), [COUNTS_AFTER * 1000]);
  w.go(story(CARD));
  assert.deepEqual(w.timers.delays(), [COUNTS_AFTER * 1000], 'the card you skipped past is dropped');
  w.go(story(CARD));
  w.timers.runAll();
  assert.deepEqual(w.list.entries().map(({ kind, id, bucket }) => ({ kind, id, bucket })), [{ kind: 'story', id: CARD, bucket: '108123456789' }]);

  // A video in a story counts as the story, never as the reel it links to.
  const shared = win.document.createElement('div');
  shared.innerHTML = '<a href="/reel/2234567890123/">Watch reel</a><div class="player"></div>';
  win.document.body.append(shared);
  player(win, shared.querySelector('.player')).playTo(10);
  assert.equal(w.ids().length, 1);

  w.go(story('EEEEEEEE'));
  w.moveUnheard(story('FFFFFFFF'));
  w.timers.runAll();
  assert.equal(w.ids().length, 1, 'the card was left before the three seconds were up');

  w.go(story('BBBBBBBB'));
  Object.defineProperty(win.document, 'visibilityState', { value: 'hidden', configurable: true });
  w.timers.runAll();
  assert.equal(w.ids().length, 1, 'not while the tab is in the background');
  Object.defineProperty(win.document, 'visibilityState', { value: 'visible', configurable: true });

  w.go(story('CCCCCCCC'));
  on = false;
  w.timers.runAll();
  on = true;
  assert.equal(w.ids().length, 1, 'not with the switch off');

  w.go(story('DDDDDDDD'));
  w.go(`${FB}/`);
  assert.deepEqual(w.timers.delays(), [], 'leaving the story drops its count');
  w.timers.runAll();
  assert.deepEqual(w.ids(), [`story:${CARD}`]);
});

test("each Facebook account keeps its own list, and another account's page stops adding to it", () => {
  const win = page();
  const shared = createMemoryStorage();
  const A = '615000000000071';
  const B = '615000000000072';
  let current = A;
  const activity = createActivityStorage({ storage: shared, account: A, currentAccount: () => current, log: { warn() {}, error() {} } });
  const w = watcher(win, { storage: activity.storage, at: `${FB}/reel/${REEL}` });
  player(win).playTo(5);
  assert.equal(shared.get(WATCHED_KEY), undefined, 'never under the plain key');
  assert.equal(shared.get(activityKeyFor(WATCHED_KEY, A)).length, 1);
  assert.equal(createActivityStorage({ storage: shared, account: B, log: { warn() {}, error() {} } }).storage.get(WATCHED_KEY, []).length, 0);

  current = B;
  w.go(`${FB}/reel/2234567890123`);
  player(win).playTo(5);
  assert.deepEqual(w.list.entries(), [], "the page belongs to someone else now, so A's list isn't shown");
  assert.equal(shared.get(activityKeyFor(WATCHED_KEY, A)).length, 1, 'and nothing more is added to it');
  assert.equal(shared.get(activityKeyFor(WATCHED_KEY, B)), undefined);
});

test('an entry shows the poster when known, its kind, length and how long ago', () => {
  const now = 10_000_000_000;
  assert.deepEqual(describe({ kind: 'reel', id: REEL, at: now - 5 * 60e3, owner: 'Example Page', length: 42 }, now, 'en'), {
    label: 'Example Page', detail: 'Reel · 0:42 · 5 minutes ago', href: `/reel/${REEL}/`,
  });
  assert.deepEqual(describe({ kind: 'video', id: '2234567890', at: now - 30 * 3600e3, length: 3723 }, now, 'en'), {
    label: 'Video', detail: '1:02:03 · yesterday', href: '/watch/?v=2234567890',
  });
  assert.equal(describe({ kind: 'story', id: CARD, bucket: '1', at: now }, now, 'en').detail, 'now');
  assert.equal(ago(now - 3 * 7 * 86400e3, now, 'en'), '3 weeks ago');
  assert.equal(ago(now + 5000, now, 'en'), 'now', 'a clock that went back reads as now');
});
