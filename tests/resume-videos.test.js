// Resume long videos: positions kept by video id, picked up a few seconds early, dropped once a
// video is watched to the end. Videos are named the way the Download button names them.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { createMemoryStorage } from '../src/core/storage.js';
import resumeVideos, { DONE_WITHIN, POSITIONS_KEY, START_AFTER, STEP_BACK, clock, createResumer, videoId } from '../src/features/playback/resume-videos.js';

const FB = 'https://www.facebook.com';
const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

function page(href = `${FB}/`, html = '') {
  const win = new Window({ url: href });
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
  Object.defineProperties(video, {
    duration: { get: () => length, configurable: true },
    currentTime: { get: () => time, set: (value) => { time = value; }, configurable: true },
  });
  (parent ?? win.document.body).append(video);
  const fire = (type) => video.dispatchEvent(new win.Event(type));
  return {
    video,
    play() { fire('playing'); },
    at(seconds) { time = seconds; fire('timeupdate'); },
    pause() { fire('pause'); },
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
