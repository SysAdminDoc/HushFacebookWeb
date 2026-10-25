// Resume long videos: positions kept by video id, picked up a few seconds early, dropped once a
// video is watched to the end. Videos are named the way the Download button names them.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { createSettings } from '../src/core/settings.js';
import { startFeatures } from '../src/core/start-features.js';
import { createMemoryStorage } from '../src/core/storage.js';
import resumeVideos, { DONE_WITHIN, JOIN_WITHIN, POSITIONS_KEY, START_AFTER, STEP_BACK, clock, createResumer, videoId } from '../src/features/playback/resume-videos.js';

const FB = 'https://www.facebook.com';
const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

function page(href = `${FB}/`, html = '') {
  const win = testWindow(href);
  windows.push(win);
  win.document.body.innerHTML = html;
  return win;
}

// A post with a video and its timestamp link, as feed posts carry them.
const POST = (id) => `<div aria-posinset="1"><a href="${FB}/examplepage/videos/${id}/">3h</a><div class="player"></div></div>`;

function longVideo(win, parent, { duration = 1800 } = {}) {
  const video = win.document.createElement('video');
  let time = 0;
  let length = duration;
  let stopped = true;
  Object.defineProperties(video, {
    duration: { get: () => length, configurable: true },
    currentTime: { get: () => time, set: (value) => { time = value; }, configurable: true },
    paused: { get: () => stopped, configurable: true },
  });
  (parent ?? win.document.body).append(video);
  const fire = (type) => video.dispatchEvent(new win.Event(type));
  return {
    video,
    play() { stopped = false; fire('playing'); },
    at(seconds) { time = seconds; fire('timeupdate'); },
    pause() { stopped = true; fire('pause'); },
    load(newLength) { length = newLength; time = 0; },
  };
}

function resumer(win, storage, { on = () => true, minutes = 5, href } = {}) {
  const resumed = [];
  let clockNow = 1000;
  const keeper = createResumer({
    doc: win.document, storage, enabled: on, minSeconds: () => minutes * 60,
    href: href ?? (() => win.location.href), now: () => clockNow++, onResume: (seconds) => resumed.push(seconds),
  });
  keeper.start();
  return { keeper, resumed };
}

test('forgetting every spot reports success only after the storage removal is confirmed', async () => {
  const win = page();
  let run;
  let resolve;
  let reject;
  let removal;
  const toasts = [];
  resumeVideos.setup({
    doc: win.document,
    storage: { get: () => ({}), remove: () => removal },
    enabled: () => true,
    option: () => 5,
    actions: { add(_label, action) { run = action; } },
    toast: (message) => toasts.push(message),
  });
  removal = new Promise((yes) => { resolve = yes; });
  const clearing = run();
  assert.deepEqual(toasts, []);
  resolve();
  await clearing;
  assert.deepEqual(toasts, ['Forgot every video spot']);
  removal = new Promise((_yes, no) => { reject = no; });
  const failed = run();
  const rejected = assert.rejects(failed, /storage unavailable/);
  reject(new Error('storage unavailable'));
  await rejected;
  assert.deepEqual(toasts, ['Forgot every video spot'], 'a failed deletion never claims success');
});

test('a video is named by its link in the post or by its own page, and reels and stories are not', () => {
  const win = page(`${FB}/`, POST('1234567890'));
  const video = longVideo(win, win.document.querySelector('.player')).video;
  assert.equal(videoId(video, win.location.href), '1234567890');
  const own = page(`${FB}/watch/?v=2234567890`);
  assert.equal(videoId(longVideo(own).video, own.location.href), '2234567890');
  // A past live video, as a Page's Videos tab opened one live.
  const live = page(`${FB}/watch/live/?ref=watch_permalink&v=1408202287429345`);
  assert.equal(videoId(longVideo(live).video, live.location.href), '1408202287429345');
  const reel = page(`${FB}/reel/3234567890`);
  assert.equal(videoId(longVideo(reel).video, reel.location.href), null);
  const story = page(`${FB}/stories/1/UzpfSVNDOjE=/`);
  assert.equal(videoId(longVideo(story).video, story.location.href), null);
  const bare = page(`${FB}/`);
  assert.equal(videoId(longVideo(bare).video, bare.location.href), null);
});

test("on a video's own page a video in a comment never takes that video's spot", () => {
  const storage = createMemoryStorage();
  const win = page(`${FB}/watch/?v=2234567890`, '<div class="main"></div><div role="article" aria-label="Comment by Bob">'
    + `<a href="${FB}/watch/?v=2234567890&amp;comment_id=5555555">2h</a><div class="clip"></div></div>`);
  resumer(win, storage);
  const main = longVideo(win, win.document.querySelector('.main'));
  const clip = longVideo(win, win.document.querySelector('.clip'), { duration: 1700 });
  assert.equal(videoId(clip.video, win.location.href), null);
  main.play();
  main.at(400);
  main.pause();
  clip.play();
  clip.at(900);
  clip.pause();
  assert.deepEqual(Object.keys(storage.get(POSITIONS_KEY)), ['2234567890']);
  assert.equal(storage.get(POSITIONS_KEY)['2234567890'].t, 400);

  // Facebook draws the player again, and the new one still picks up the spot.
  main.video.remove();
  const redrawn = longVideo(win, win.document.querySelector('.main'));
  redrawn.play();
  assert.equal(redrawn.video.currentTime, 400 - STEP_BACK);
});

test('a long video picks up where it was left, a few seconds early, after a reload', () => {
  const storage = createMemoryStorage();
  const first = page(`${FB}/watch/?v=2234567890`);
  resumer(first, storage);
  const watched = longVideo(first);
  watched.play();
  watched.at(100);
  watched.at(412.6);
  watched.pause();
  assert.equal(storage.get(POSITIONS_KEY)['2234567890'].t, 412);

  const again = page(`${FB}/watch/?v=2234567890`);
  const { keeper, resumed } = resumer(again, storage);
  const video = longVideo(again);
  video.play();
  assert.equal(video.video.currentTime, 412 - STEP_BACK);
  assert.deepEqual(resumed, [412]);
  // Only the first play of a load jumps.
  video.at(500);
  video.play();
  assert.equal(video.video.currentTime, 500);
  assert.equal(keeper.resumes(), 1);
});

test('saves come every few seconds of playback, and nothing is kept for the first half minute', () => {
  const storage = createMemoryStorage();
  const win = page(`${FB}/watch/?v=2234567890`);
  resumer(win, storage);
  const video = longVideo(win);
  video.play();
  video.at(START_AFTER - 1);
  video.pause();
  assert.equal(storage.get(POSITIONS_KEY), undefined);
  video.at(60);
  video.at(62);
  assert.equal(storage.get(POSITIONS_KEY)['2234567890'].t, 60);
  video.at(66);
  assert.equal(storage.get(POSITIONS_KEY)['2234567890'].t, 66);
});

test('a feed video playing muted on its own keeps no spot until it plays with sound', () => {
  const storage = createMemoryStorage({ [POSITIONS_KEY]: { 3234567890: { t: 600, d: 1800, at: 1 } } });
  const win = page(`${FB}/`, POST('2234567890'));
  resumer(win, storage);
  const muted = longVideo(win, win.document.querySelector('.player'));
  muted.video.muted = true;
  muted.play();
  muted.at(100);
  muted.at(140);
  muted.pause();
  assert.equal(storage.get(POSITIONS_KEY)['2234567890'], undefined, 'nothing kept while muted');
  muted.video.muted = false;
  muted.at(150);
  assert.equal(storage.get(POSITIONS_KEY)['2234567890'].t, 150, 'kept once it has sound');
  // Muting again later doesn't stop the saves, it's still being watched.
  muted.video.muted = true;
  muted.at(160);
  assert.equal(storage.get(POSITIONS_KEY)['2234567890'].t, 160);

  // A muted preview of a video with a spot still picks it up, but scrolling past it at the
  // start doesn't forget it.
  const other = page(`${FB}/`, POST('3234567890'));
  resumer(other, storage);
  const preview = longVideo(other, other.document.querySelector('.player'));
  preview.video.muted = true;
  preview.play();
  assert.equal(preview.video.currentTime, 600 - STEP_BACK);
  preview.at(5);
  preview.pause();
  assert.equal(storage.get(POSITIONS_KEY)['3234567890'].t, 600);
});

test('starting a video over forgets its old spot, and the step back never lands in the first half minute', () => {
  const storage = createMemoryStorage({ [POSITIONS_KEY]: { 2234567890: { t: 600, d: 1800, at: 1 }, 4234567890: { t: START_AFTER + 1, d: 1800, at: 2 } } });
  const win = page(`${FB}/watch/?v=2234567890`);
  resumer(win, storage);
  const video = longVideo(win);
  video.play();
  assert.equal(video.video.currentTime, 600 - STEP_BACK);
  video.at(10);
  assert.equal(storage.get(POSITIONS_KEY)['2234567890'], undefined, 'back at the start, the old spot is gone');
  video.at(45);
  assert.equal(storage.get(POSITIONS_KEY)['2234567890'].t, 45, 'and a new one is kept from there');

  const early = page(`${FB}/watch/?v=4234567890`);
  resumer(early, storage);
  const short = longVideo(early);
  short.play();
  assert.equal(short.video.currentTime, START_AFTER);
  short.at(START_AFTER + 0.5);
  short.pause();
  assert.equal(storage.get(POSITIONS_KEY)['4234567890'].t, START_AFTER);
});

test('a video watched to the end is forgotten, so it starts at the beginning next time', () => {
  const storage = createMemoryStorage({ [POSITIONS_KEY]: { 2234567890: { t: 900, d: 1800, at: 1 } } });
  const win = page(`${FB}/watch/?v=2234567890`);
  resumer(win, storage);
  const video = longVideo(win);
  video.play();
  assert.equal(video.video.currentTime, 900 - STEP_BACK);
  video.at(1800 - DONE_WITHIN + 1);
  assert.deepEqual(storage.get(POSITIONS_KEY), {});
});

test('short videos, a different video under the same id, and the switch off are left alone', () => {
  const storage = createMemoryStorage({ [POSITIONS_KEY]: { 2234567890: { t: 900, d: 1800, at: 1 } } });
  const short = page(`${FB}/watch/?v=2234567890`);
  resumer(short, storage);
  const clip = longVideo(short, null, { duration: 200 });
  clip.play();
  assert.equal(clip.video.currentTime, 0, 'under five minutes');

  const other = page(`${FB}/watch/?v=2234567890`);
  resumer(other, storage);
  const changed = longVideo(other, null, { duration: 2400 });
  changed.play();
  assert.equal(changed.video.currentTime, 0, 'a different length means a different video');

  const off = page(`${FB}/watch/?v=2234567890`);
  resumer(off, storage, { on: () => false });
  const video = longVideo(off);
  video.play();
  video.at(1000);
  video.pause();
  assert.equal(video.video.currentTime, 1000);
  assert.equal(storage.get(POSITIONS_KEY)['2234567890'].t, 900, 'nothing saved while off');
});

test('a video element reused for another video follows the new one', () => {
  const storage = createMemoryStorage({ [POSITIONS_KEY]: { 3334567890: { t: 600, d: 1200, at: 1 } } });
  const win = page(`${FB}/watch/?v=2234567890`);
  let href = `${FB}/watch/?v=2234567890`;
  resumer(win, storage, { href: () => href });
  const video = longVideo(win);
  video.play();
  video.at(300);
  video.pause();
  href = `${FB}/watch/?v=3334567890`;
  video.load(1200);
  video.play();
  assert.equal(video.video.currentTime, 600 - STEP_BACK);
  assert.deepEqual(Object.keys(storage.get(POSITIONS_KEY)).sort(), ['2234567890', '3334567890']);
});

// Settings and the feature started the way main.js starts them, so the switch, Pause and the
// length come from the real settings store.
function startLikeMain(win, positions, settings) {
  startFeatures({
    features: [resumeVideos], settings, log: { error() {} }, unavailable: new Map(),
    context: () => ({ win, doc: win.document, storage: positions, toast() {} }),
  });
}

const freshSettings = () => createSettings({ storage: createMemoryStorage(), features: [resumeVideos], migrations: [] });

test('switched on partway through a video, the rest of it is kept from there and picked up after a reload', async () => {
  const positions = createMemoryStorage({ [POSITIONS_KEY]: {
    2234567890: { t: 600, d: 1800, at: 1 }, 3234567890: { t: 600, d: 1800, at: 1 }, 4234567890: { t: 900, d: 1800, at: 1 },
  } });
  const settings = freshSettings();
  const win = page(`${FB}/`, POST('2234567890') + POST('3234567890') + POST('4234567890'));
  startLikeMain(win, positions, settings);
  const [playing, stopped, starting] = [...win.document.querySelectorAll('.player')].map((player) => longVideo(win, player));
  playing.play();
  playing.at(100);
  stopped.play();
  stopped.at(120);
  stopped.pause();
  starting.play();
  starting.at(1);

  await settings.set('resumeVideos', true);
  assert.equal(settings.enabled('resumeVideos'), true);
  playing.at(150);
  assert.equal(playing.video.currentTime, 150, 'not sent forward to the old spot');
  assert.equal(positions.get(POSITIONS_KEY)['2234567890'].t, 150);
  playing.at(203.4);
  playing.pause();
  assert.equal(positions.get(POSITIONS_KEY)['2234567890'].t, 203);
  stopped.at(130);
  assert.equal(positions.get(POSITIONS_KEY)['3234567890'].t, 600, 'a seek while paused is not watching');
  stopped.play();
  assert.equal(stopped.video.currentTime, 130, 'playing on from a pause stays put');
  stopped.at(140);
  assert.equal(positions.get(POSITIONS_KEY)['3234567890'].t, 140);
  starting.at(JOIN_WITHIN - 1);
  assert.equal(starting.video.currentTime, 900 - STEP_BACK, 'still at its start, it picks up its spot');

  const again = page(`${FB}/watch/?v=2234567890`);
  startLikeMain(again, positions, settings);
  const reloaded = longVideo(again);
  reloaded.play();
  assert.equal(reloaded.video.currentTime, 203 - STEP_BACK);
});

test('turning Pause off or picking a shorter length partway through counts the same as switching it on', async () => {
  for (const [name, before, change] of [
    ['Pause off', { resumeVideos: true, paused: true }, ['paused', false]],
    ['a shorter length', { resumeVideos: true, 'resumeVideos.minutes': 20 }, ['resumeVideos.minutes', 5]],
  ]) {
    const positions = createMemoryStorage({ [POSITIONS_KEY]: { 2234567890: { t: 600, d: 900, at: 1 } } });
    const settings = freshSettings();
    await settings.setMany(before);
    const win = page(`${FB}/watch/?v=2234567890`);
    startLikeMain(win, positions, settings);
    const video = longVideo(win, null, { duration: 900 });
    video.play();
    video.at(120);
    assert.equal(positions.get(POSITIONS_KEY)['2234567890'].t, 600, `${name}: nothing kept before`);
    await settings.set(...change);
    video.at(125);
    assert.equal(video.video.currentTime, 125, name);
    assert.equal(positions.get(POSITIONS_KEY)['2234567890'].t, 125, name);
  }
});

test('a feed video named only once it is playing is kept from there, and near its start still picks up its spot', () => {
  const storage = createMemoryStorage({ [POSITIONS_KEY]: { 2234567890: { t: 600, d: 1800, at: 1 }, 3234567890: { t: 900, d: 1800, at: 1 } } });
  const win = page(`${FB}/`, '<div aria-posinset="1"><div class="player"></div></div><div aria-posinset="2"><div class="player"></div></div>');
  const { keeper, resumed } = resumer(win, storage);
  const posts = [...win.document.querySelectorAll('[aria-posinset]')];
  const [early, late] = [...win.document.querySelectorAll('.player')].map((player) => longVideo(win, player));
  early.play();
  early.at(1);
  late.play();
  late.at(100);
  assert.deepEqual(resumed, [], 'nothing to go on before the links');

  const link = (id) => Object.assign(win.document.createElement('a'), { href: `${FB}/examplepage/videos/${id}/`, textContent: '3h' });
  posts[0].prepend(link('2234567890'));
  posts[1].prepend(link('3234567890'));
  early.at(2);
  assert.equal(early.video.currentTime, 600 - STEP_BACK);
  late.at(101);
  assert.equal(late.video.currentTime, 101, 'an older spot never takes over a video being watched');
  assert.equal(storage.get(POSITIONS_KEY)['3234567890'].t, 101);
  late.at(140);
  assert.equal(storage.get(POSITIONS_KEY)['3234567890'].t, 140);
  assert.deepEqual(resumed, [600]);
  assert.equal(keeper.resumes(), 1);
});

test('reels, stories, short videos and muted ones are still left alone when tracking starts late', async () => {
  const before = { 2234567890: { t: 600, d: 1800, at: 1 }, 3234567890: { t: 600, d: 1800, at: 1 } };
  const positions = createMemoryStorage({ [POSITIONS_KEY]: before });
  const settings = freshSettings();
  const started = (href, { duration, muted = false, at = 1 } = {}) => {
    const win = page(href);
    startLikeMain(win, positions, settings);
    const video = longVideo(win, null, { duration });
    video.video.muted = muted;
    video.play();
    video.at(at);
    return video;
  };
  const left = [
    started(`${FB}/reel/2234567890`),
    started(`${FB}/stories/1/UzpfSVNDOjE=/`),
    started(`${FB}/watch/?v=2234567890`, { duration: 200 }),
  ];
  // A muted feed video playing on its own, well into it.
  const quiet = started(`${FB}/watch/?v=3234567890`, { muted: true, at: 100 });
  await settings.set('resumeVideos', true);
  for (const video of left) video.at(3);
  assert.deepEqual(left.map((video) => video.video.currentTime), [3, 3, 3]);
  for (const video of [...left, quiet]) {
    video.at(150);
    video.pause();
  }
  assert.equal(quiet.video.currentTime, 150);
  assert.deepEqual(positions.get(POSITIONS_KEY), before);
});

test('only the 200 most recent spots are kept', () => {
  const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`9${String(i).padStart(9, '0')}`, { t: 100, d: 1800, at: i }]));
  const storage = createMemoryStorage({ [POSITIONS_KEY]: many });
  const win = page(`${FB}/watch/?v=2234567890`);
  resumer(win, storage);
  const video = longVideo(win);
  video.play();
  video.at(120);
  const kept = storage.get(POSITIONS_KEY);
  assert.equal(Object.keys(kept).length, 200);
  assert.ok(!('9000000000' in kept), 'the oldest went');
  assert.ok('2234567890' in kept);
});

test('times read like a player shows them', () => {
  assert.equal(clock(5), '0:05');
  assert.equal(clock(412.6), '6:52');
  assert.equal(clock(3723), '1:02:03');
});

test('the feature starts off, says where it picked up, and can forget every spot', () => {
  const storage = createMemoryStorage({ [POSITIONS_KEY]: { 2234567890: { t: 754, d: 1800, at: 1 } } });
  const win = page(`${FB}/watch/?v=2234567890`);
  const toasts = [];
  const rows = [];
  const buttons = [];
  resumeVideos.setup({
    doc: win.document, storage, enabled: () => true, option: (key) => (key === 'minutes' ? 5 : undefined),
    toast: (message) => toasts.push(message),
    diagnostics: { add: (label, read) => rows.push([label, read]) },
    actions: { add: (label, run) => buttons.push([label, run]) },
  });
  longVideo(win).play();
  assert.deepEqual(toasts, ['Picked up where you left off, at 12:34']);
  assert.deepEqual(rows.map(([label, read]) => [label, read()]), [['Video spots kept', '1'], ['Videos picked up', '1']]);
  buttons[0][1]();
  assert.equal(storage.get(POSITIONS_KEY), undefined);
  assert.equal(resumeVideos.default, false);
  assert.deepEqual(resumeVideos.options[0].choices.map((choice) => choice.value), [2, 5, 10, 20]);
});
