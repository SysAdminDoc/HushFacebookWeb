// Activity kept for each account (src/core/activity.js): seen posts, video spots and the kept
// speed and volume go under the account's own keys, a page that ends up signed in to someone
// else stops writing, and the shared lists from before stay put until you add or delete them.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { ACCOUNT_CHANGED, ACTIVITY_KEYS, activityKeyFor, createActivityStorage, mergePositions, mergeSeen } from '../src/core/activity.js';
import { CLEARED_KEY, createSeenStore, MAX_ENTRIES, SEEN_KEY } from '../src/core/seen-store.js';
import { accountTag } from '../src/core/settings.js';
import { createMemoryStorage } from '../src/core/storage.js';
import { SPEED_KEY, createSpeedKeeper } from '../src/features/playback/keep-speed.js';
import { VOLUME_KEY, createVolumeKeeper } from '../src/features/playback/keep-volume.js';
import { MAX_KEPT, POSITIONS_KEY, createResumer } from '../src/features/playback/resume-videos.js';

const FB = 'https://www.facebook.com';
const DAY = 24 * 60 * 60 * 1000;
const A = '615000000000041';
const B = '615000000000042';
const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

// Storage that reports writes from "another tab" the way GM_addValueChangeListener does.
function sharedStorage(initial = {}) {
  const storage = createMemoryStorage(initial);
  const listeners = new Map();
  storage.onChange = (key, fn) => {
    if (!listeners.has(key)) listeners.set(key, []);
    listeners.get(key).push(fn);
  };
  storage.remote = (key, value) => {
    storage.set(key, value);
    listeners.get(key)?.forEach((fn) => fn(value));
  };
  return storage;
}

function manualTimers() {
  const queue = [];
  return {
    queue,
    schedule: (fn) => queue.push(fn),
    cancel: () => queue.splice(0),
    run: () => queue.splice(0).forEach((fn) => fn()),
  };
}

const quietLog = () => {
  const warned = [];
  return { warned, warn: (message) => warned.push(message), error: (message, error) => { throw error ?? new Error(message); } };
};

test('the activity keys are the stores own, and housekeeping and settings keys stay as they are', () => {
  assert.deepEqual([...ACTIVITY_KEYS], [SEEN_KEY, CLEARED_KEY, SPEED_KEY, VOLUME_KEY, POSITIONS_KEY]);
  const storage = createMemoryStorage();
  const { storage: scoped } = createActivityStorage({ storage, account: A });
  const global = ['tasks', 'storageCheck', 'extensionUpdate', 'extensionUpdate.told', 'instantGamesAds.enabled', 'hidePostsByWords.cssWarned', 'settings', 'settings.migrated'];
  for (const key of global) scoped.set(key, 1);
  for (const key of ACTIVITY_KEYS) scoped.set(key, 1);
  assert.deepEqual(Object.keys(storage.dump()).sort(), [...global, ...ACTIVITY_KEYS.map((key) => activityKeyFor(key, A))].sort());
  const reached = [];
  const record = (key) => {
    reached.push(key);
    return Promise.resolve();
  };
  const withMutations = { ...createMemoryStorage(), mutate: record, mutateDetailed: record, migrate: record, migrateDetailed: record };
  const mutations = createActivityStorage({ storage: withMutations, account: A }).storage;
  for (const name of ['mutate', 'mutateDetailed', 'migrate', 'migrateDetailed']) mutations[name](SPEED_KEY, {});
  mutations.mutate('settings', {});
  assert.deepEqual(reached, [...Array(4).fill(activityKeyFor(SPEED_KEY, A)), 'settings'], 'every way in is scoped');

  const spots = Object.fromEntries(Array.from({ length: MAX_KEPT + 50 }, (_, i) => [String(1000 + i), { t: 60, d: 900, at: i + 1 }]));
  assert.equal(Object.keys(mergePositions(spots, {})).length, MAX_KEPT, 'an import keeps as many spots as Resume long videos does');
});

test('accounts A and B and signed out each keep their own lists and hear only their own tabs', () => {
  const storage = sharedStorage();
  const a = createActivityStorage({ storage, account: A }).storage;
  const b = createActivityStorage({ storage, account: B }).storage;
  const out = createActivityStorage({ storage, account: null }).storage;
  const keys = [A, B, null].map((account) => activityKeyFor(SPEED_KEY, account));
  assert.equal(new Set(keys).size, 3);
  assert.equal(keys[2], `${SPEED_KEY}@signed-out`);
  assert.match(accountTag(A), /^[0-9a-z]+$/, "an account's tag can't be the signed-out one");

  a.set(SPEED_KEY, 1.5);
  b.set(SPEED_KEY, 2);
  out.set(SPEED_KEY, 0.5);
  assert.deepEqual([a.get(SPEED_KEY, 1), b.get(SPEED_KEY, 1), out.get(SPEED_KEY, 1)], [1.5, 2, 0.5]);
  assert.equal(storage.get(SPEED_KEY), undefined, 'nothing goes under the shared key');

  const timers = manualTimers();
  const options = { now: () => 10 * DAY, schedule: timers.schedule, cancel: timers.cancel, every: null };
  const seenA = createSeenStore({ storage: a, ...options });
  const seenB = createSeenStore({ storage: b, ...options });
  const seenOut = createSeenStore({ storage: out, ...options });
  seenA.add('t:a');
  timers.run();
  assert.deepEqual(storage.get(activityKeyFor(SEEN_KEY, A)), { 't:a': 10 * DAY });
  assert.equal(createSeenStore({ storage: b, ...options }).has('t:a'), false, "a fresh page for B doesn't see A's posts");

  // Another tab writes B's list, then signed out's.
  storage.remote(activityKeyFor(SEEN_KEY, B), { 't:b': 10 * DAY });
  storage.remote(activityKeyFor(SEEN_KEY, null), { 't:out': 10 * DAY });
  assert.deepEqual([seenA.has('t:b'), seenB.has('t:b'), seenOut.has('t:b')], [false, true, false]);
  assert.deepEqual([seenA.has('t:out'), seenB.has('t:out'), seenOut.has('t:out')], [false, false, true]);
});

// A page shaped enough like Facebook's for the three playback keepers.
function playbackPage() {
  const win = testWindow(`${FB}/watch/?v=2234567890`);
  windows.push(win);
  win.document.body.innerHTML = '<div class="player"><div><video class="feed"></video></div><div role="slider" aria-label="Change volume" aria-valuemax="1"></div></div>';
  return win;
}

function mediaVideo(win, video, { duration = 1800, muted = false } = {}) {
  let level = 1;
  let silent = muted;
  let time = 0;
  let rate = 1;
  const fire = (type) => video.dispatchEvent(new win.Event(type));
  Object.defineProperties(video, {
    volume: { get: () => level, set: (value) => { if (value === level) return; level = value; fire('volumechange'); }, configurable: true },
    muted: { get: () => silent, set: (value) => { if (value === silent) return; silent = value; fire('volumechange'); }, configurable: true },
    currentTime: { get: () => time, set: (value) => { time = value; }, configurable: true },
    duration: { get: () => duration, configurable: true },
    paused: { get: () => false, configurable: true },
    playbackRate: { get: () => rate, set: (value) => { if (value === rate) return; rate = value; fire('ratechange'); }, configurable: true },
  });
  return {
    video,
    play() { fire('play'); fire('playing'); },
    at(seconds) { time = seconds; fire('timeupdate'); },
    pause() { fire('pause'); },
  };
}

test('a same-page switch from A to B stops every write, and nothing A had reaches B', () => {
  const storage = sharedStorage({
    [activityKeyFor(SPEED_KEY, A)]: 1.5,
    [activityKeyFor(VOLUME_KEY, A)]: { volume: 0.8, muted: false },
  });
  let signedIn = A;
  let switches = 0;
  const log = quietLog();
  const activity = createActivityStorage({ storage, account: A, currentAccount: () => signedIn, onSwitch: () => switches++, log });
  const scoped = activity.storage;
  const win = playbackPage();
  const doc = win.document;
  let clock = 10_000;
  const now = () => clock;
  const enabled = () => true;
  const trusted = () => true;

  // Tracked posts, with a batch waiting to be written.
  const timers = manualTimers();
  const seen = createSeenStore({ storage: scoped, now: () => 10 * DAY, schedule: timers.schedule, cancel: timers.cancel, every: null });
  seen.add('t:a1');
  timers.run();
  seen.add('t:a2');
  assert.equal(timers.queue.length, 1, 'a write is waiting');

  // Playing videos with the three keepers on them.
  createSpeedKeeper({ doc, win, storage: scoped, enabled, now, trusted }).start();
  const waiting = [];
  const volume = createVolumeKeeper({ doc, win, storage: scoped, enabled, now, trusted, defer: () => {}, later: (run) => waiting.push(run) });
  volume.start();
  createResumer({ doc, storage: scoped, enabled, minSeconds: () => 300, href: () => win.location.href, now }).start();

  const feed = mediaVideo(win, doc.querySelector('video.feed'));
  feed.play();
  assert.equal(feed.video.playbackRate, 1.5, "A's speed");
  assert.equal(feed.video.volume, 0.8, "A's volume");
  feed.at(100);
  feed.pause();
  assert.equal(storage.get(activityKeyFor(POSITIONS_KEY, A))['2234567890'].t, 100);
  // A slider drag faster than the write allowance leaves a pick waiting.
  doc.querySelector('[role="slider"]').dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true }));
  for (let step = 1; step <= 12; step++) feed.video.volume = 0.8 - step / 50;
  assert.equal(waiting.length, 1, 'a volume write is waiting');
  const before = structuredClone(storage.dump());

  // Account B signs in, here or in another tab, without a reload.
  signedIn = B;
  timers.run();
  for (const run of waiting.splice(0)) run();
  assert.equal(switches, 1, 'the first write after the switch notices it');
  assert.deepEqual(log.warned, [ACCOUNT_CHANGED]);
  assert.equal(activity.switched(), true);

  feed.at(300);
  feed.pause();
  win.dispatchEvent(new win.Event('pagehide'));
  seen.add('t:b1');
  seen.flush();
  timers.run();
  const next = mediaVideo(win, doc.body.appendChild(doc.createElement('video')));
  next.play();
  assert.equal(next.video.playbackRate, 1, "B's next video doesn't get A's speed");
  next.video.currentTime = 5;
  doc.body.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true }));
  next.video.playbackRate = 2;
  assert.equal(scoped.get(SPEED_KEY, 1), 1, 'reads come back empty after the switch');
  assert.deepEqual(storage.dump(), before, "nothing after the switch reached A's lists");
  assert.deepEqual(Object.keys(storage.dump()).filter((key) => key.endsWith(`@${accountTag(B)}`)), [], "or B's");
  assert.equal(switches, 1, 'and the switch is told once');

  // Another tab still writing A's list isn't passed on either.
  storage.remote(activityKeyFor(SEEN_KEY, A), { 't:a1': 10 * DAY, 't:remote': 10 * DAY });
  assert.equal(seen.has('t:remote'), false);

  // The reload starts over for B with B's own, empty, lists.
  const reloaded = createActivityStorage({ storage, account: B, currentAccount: () => B }).storage;
  assert.equal(createSeenStore({ storage: reloaded, now: () => 10 * DAY, every: null }).size(), 0);
  assert.deepEqual([reloaded.get(SPEED_KEY, 1), reloaded.get(VOLUME_KEY, null), reloaded.get(POSITIONS_KEY, {})], [1, null, {}]);
});

test("what the page holds for A in memory never plays or hides anything for B", () => {
  const storage = sharedStorage({ [activityKeyFor(VOLUME_KEY, A)]: { volume: 0.8, muted: false } });
  let signedIn = A;
  const activity = createActivityStorage({ storage, account: A, currentAccount: () => signedIn, log: quietLog() });
  const scoped = activity.storage;
  const win = playbackPage();
  const doc = win.document;
  const timers = manualTimers();
  const seen = createSeenStore({ storage: scoped, now: () => 10 * DAY, schedule: timers.schedule, cancel: timers.cancel, every: null });
  seen.add('t:a1');
  const waiting = [];
  createVolumeKeeper({ doc, win, storage: scoped, enabled: () => true, now: () => 10_000, trusted: () => true, defer: () => {}, later: (run) => waiting.push(run) }).start();
  const feed = mediaVideo(win, doc.querySelector('video.feed'));
  feed.play();
  doc.querySelector('[role="slider"]').dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true }));
  for (let step = 1; step <= 12; step++) feed.video.volume = 0.8 - step / 50;
  assert.equal(waiting.length, 1, "A's newest pick waits in memory");
  const before = structuredClone(storage.dump());

  // B signs in, and B's first video starts before A's pick is written.
  signedIn = B;
  const next = mediaVideo(win, doc.body.appendChild(doc.createElement('video')));
  next.play();
  assert.equal(next.video.volume, 1, "B's video gets neither A's pick nor A's saved level");
  assert.equal(activity.switched(), true, 'the read noticed the switch');
  for (const run of waiting.splice(0)) run();
  win.dispatchEvent(new win.Event('pagehide'));
  assert.equal(seen.has('t:a1'), false, "B's page doesn't hide what A scrolled past");
  timers.run();
  assert.deepEqual(storage.dump(), before);
});

test('a page change or coming back to the tab notices the switch without any read or write', () => {
  const win = testWindow(`${FB}/`);
  windows.push(win);
  for (const way of ['page change', 'visible again']) {
    let signedIn = A;
    let route = null;
    const told = [];
    const activity = createActivityStorage({ storage: createMemoryStorage(), account: A, currentAccount: () => signedIn, onSwitch: () => told.push(way), log: quietLog() });
    let dropped = 0;
    activity.storage.onAccountChange(() => dropped++);
    activity.watch({ router: { subscribe: (fn) => { route = fn; } }, doc: win.document });
    signedIn = B;
    if (way === 'page change') route();
    else {
      Object.defineProperty(win.document, 'visibilityState', { get: () => 'hidden', configurable: true });
      win.document.dispatchEvent(new win.Event('visibilitychange'));
      assert.equal(activity.switched(), false, 'hiding the tab is no reason to look');
      Object.defineProperty(win.document, 'visibilityState', { get: () => 'visible', configurable: true });
      win.document.dispatchEvent(new win.Event('visibilitychange'));
    }
    assert.deepEqual(told, [way]);
    assert.equal(dropped, 1, 'stores holding a copy drop it');
    let late = 0;
    activity.storage.onAccountChange(() => late++);
    assert.equal(late, 1, 'a store that starts after the switch drops its copy at once');
  }
});

test('the account is checked again on request, and two c_user values count as a change', () => {
  let signedIn = A;
  const told = [];
  const activity = createActivityStorage({ storage: createMemoryStorage(), account: A, currentAccount: () => signedIn, onSwitch: () => told.push('switch'), log: quietLog() });
  assert.equal(activity.check(), true);
  assert.equal(activity.perAccount, true);
  signedIn = null; // what accountFromCookie gives for a duplicated or missing cookie
  assert.equal(activity.check(), false);
  signedIn = A;
  assert.equal(activity.check(), false, 'once stopped, it stays stopped until a reload');
  assert.deepEqual(told, ['switch']);
  const out = createActivityStorage({ storage: createMemoryStorage(), account: null, currentAccount: () => null });
  assert.equal(out.check(), true);
  assert.equal(out.perAccount, false);
});

test('the shared lists from before stay where they are until you add them to an account or delete them', () => {
  const now = 100 * DAY;
  const legacy = {
    [SEEN_KEY]: { 't:old': now - DAY, 't:both': now - 3 * DAY, 't:stale': now - 31 * DAY, 't:forgotten': now - 6 * DAY },
    [CLEARED_KEY]: now - 5 * DAY,
    [SPEED_KEY]: 1.25,
    [VOLUME_KEY]: { volume: 0.3, muted: true },
    [POSITIONS_KEY]: { 1111111111: { t: 50, d: 900, at: now - 10 }, 2222222222: { t: 70, d: 900, at: now - 5 } },
  };
  const storage = sharedStorage({
    ...legacy,
    [activityKeyFor(SEEN_KEY, A)]: { 't:mine': now - 1000, 't:both': now - 2 * DAY },
    [activityKeyFor(SPEED_KEY, A)]: 2,
    [activityKeyFor(POSITIONS_KEY, A)]: { 1111111111: { t: 40, d: 900, at: now - 20 }, 3333333333: { t: 90, d: 900, at: now - 1 } },
  });
  let signedIn = A;
  const activity = createActivityStorage({ storage, account: A, currentAccount: () => signedIn, now: () => now, log: quietLog() });
  const scoped = activity.storage;
  assert.deepEqual(Object.keys(scoped.get(SEEN_KEY)).sort(), ['t:both', 't:mine'], 'the account never reads the shared list by itself');
  assert.deepEqual(activity.legacy(), { seen: 2, spots: 2, speed: true, volume: true });

  // A store in this page with a write waiting, which mustn't write over what's added.
  const timers = manualTimers();
  const seen = createSeenStore({ storage: scoped, now: () => now, schedule: timers.schedule, cancel: timers.cancel, every: null });
  seen.add('t:new');
  assert.equal(activity.addLegacy(), 3, 'seen posts, spots and the volume; the account keeps its own speed');
  timers.run();
  assert.deepEqual(storage.get(activityKeyFor(SEEN_KEY, A)), {
    't:new': now, 't:mine': now - 1000, 't:old': now - DAY, 't:both': now - 3 * DAY,
  }, 'the earlier time wins, and stale or forgotten entries stay out');
  assert.equal(storage.get(activityKeyFor(SPEED_KEY, A)), 2, "the account's own speed stays");
  assert.deepEqual(storage.get(activityKeyFor(VOLUME_KEY, A)), { volume: 0.3, muted: true }, 'it had no volume, so it takes the shared one');
  assert.deepEqual(storage.get(activityKeyFor(POSITIONS_KEY, A)), {
    3333333333: { t: 90, d: 900, at: now - 1 }, 2222222222: { t: 70, d: 900, at: now - 5 }, 1111111111: { t: 50, d: 900, at: now - 10 },
  }, 'the newer spot wins');
  for (const [key, value] of Object.entries(legacy)) assert.deepEqual(storage.get(key), value, `${key} is still shared`);
  assert.deepEqual(Object.keys(storage.dump()).filter((key) => key.endsWith(`@${accountTag(B)}`)), [], 'B got nothing');

  const undo = activity.clearLegacy();
  for (const key of ACTIVITY_KEYS) assert.equal(storage.get(key), undefined, `${key} deleted`);
  assert.equal(activity.legacy(), null);
  assert.equal(storage.get(activityKeyFor(SPEED_KEY, A)), 2, "deleting leaves the account's own");
  undo();
  for (const [key, value] of Object.entries(legacy)) assert.deepEqual(storage.get(key), value, `${key} put back`);
  // A speed kept again under the plain key after the delete (an older copy of the script in
  // another tab) is newer than what Undo holds, so it stays.
  const again = activity.clearLegacy();
  storage.set(SPEED_KEY, 1.75);
  again();
  assert.equal(storage.get(SPEED_KEY), 1.75);
  assert.deepEqual(storage.get(SEEN_KEY), legacy[SEEN_KEY]);

  signedIn = B;
  const snapshot = structuredClone(storage.dump());
  assert.throws(() => activity.addLegacy(), new RegExp(ACCOUNT_CHANGED));
  assert.deepEqual(storage.dump(), snapshot, 'after a switch nothing is added');

  // The extension's copy before it loads: the account's own speed would read as missing.
  const loading = Object.assign(sharedStorage({ ...legacy, [activityKeyFor(SPEED_KEY, A)]: 2 }), { status: () => ({ state: 'loading' }) });
  const early = createActivityStorage({ storage: loading, account: A, now: () => now, log: quietLog() });
  const untouched = structuredClone(loading.dump());
  assert.throws(() => early.addLegacy(), /hasn't loaded yet/);
  assert.deepEqual(loading.dump(), untouched);
});

test('an import stays inside the seen-post store limits', () => {
  const now = 100 * DAY;
  const many = (prefix, offset) => Object.fromEntries(Array.from({ length: MAX_ENTRIES }, (_, i) => [`${prefix}${i}`, now - offset - i]));
  const merged = mergeSeen({ mine: many('m', 0), theirs: many('t', 0.5), now });
  assert.equal(Object.keys(merged).length, MAX_ENTRIES);
  assert.equal(merged.m0, now, 'the newest stay');
  assert.deepEqual(mergeSeen({ mine: null, theirs: { a: 'x', '': now, b: now - 31 * DAY }, now }), {}, 'junk and stale entries never come in');
  assert.deepEqual(
    mergeSeen({ mine: {}, mineCleared: now - 2 * DAY, theirs: { before: now - 3 * DAY, after: now - DAY }, theirsCleared: 0, now }),
    { after: now - DAY },
    'what the account forgot stays forgotten when the shared list still has it',
  );
});
