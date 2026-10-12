// Keep your video speed, Hold a reel for 2x, Keep video controls on screen and the
// picture-in-picture button, against Facebook's players as read live on 2026-10-11
// (captures/2026-10-11-run6 playback-anatomy): each reel and video gets its own video element at
// normal speed, reels keep their controls on screen, and a feed or Watch video's controls fade
// to 1% opacity a moment after the pointer leaves.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { createMemoryStorage } from '../src/core/storage.js';
import keepSpeed, { HOLDING, SPEED_KEY, createSpeedKeeper, speedLabel } from '../src/features/playback/keep-speed.js';
import holdForSpeed, { FAST, HOLD_MS, createHold, reelAt } from '../src/features/playback/hold-for-speed.js';
import keepControls, { KEEP, KEEP_CONTROLS_CSS, createControlsKeeper, positionSlider } from '../src/features/playback/keep-controls.js';
import pictureInPicture, { createPopOut } from '../src/features/playback/picture-in-picture.js';
import { createDownloadButton, mediaAt } from '../src/features/downloads/button.js';

const FB = 'https://www.facebook.com';
const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

function page(href = `${FB}/watch/?v=1234567890`, html = '') {
  const win = new Window({ url: href });
  windows.push(win);
  win.document.body.innerHTML = html;
  return win;
}

// A video whose speed and clock the test controls. Changing the speed fires ratechange, as a
// browser does.
function fakeVideo(win, { time = 5, duration = 40, paused = false, parent } = {}) {
  const video = win.document.createElement('video');
  let rate = 1;
  let clock = time;
  let still = paused;
  Object.defineProperties(video, {
    playbackRate: {
      get: () => rate,
      set: (value) => {
        if (value === rate) return;
        rate = value;
        video.dispatchEvent(new win.Event('ratechange'));
      },
      configurable: true,
    },
    currentTime: { get: () => clock, set: (value) => { clock = value; }, configurable: true },
    duration: { get: () => duration, configurable: true },
    paused: { get: () => still, configurable: true },
  });
  video.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 900, width: 600, height: 900 });
  (parent ?? win.document.body).append(video);
  return {
    video,
    start() { video.dispatchEvent(new win.Event('play')); },
    at(seconds) { clock = seconds; },
    pause() { still = true; },
    // The length arriving after play, as when Facebook plays a video before its metadata loads.
    meta(seconds) {
      duration = seconds;
      video.dispatchEvent(new win.Event('durationchange'));
      video.dispatchEvent(new win.Event('loadedmetadata'));
    },
    // Only the length changing, as a live stream's can while it plays.
    length(seconds) {
      duration = seconds;
      video.dispatchEvent(new win.Event('durationchange'));
    },
  };
}

// ---- Keep your video speed ----

function speedKeeper(win, storage, { on = () => true } = {}) {
  let time = 10000;
  const keeper = createSpeedKeeper({ doc: win.document, win, storage, enabled: on, now: () => time, trusted: () => true });
  keeper.start();
  return {
    keeper,
    // A click somewhere, like picking from Facebook's Settings menu.
    input() { win.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true })); },
    later(ms) { time += ms; },
  };
}

test("a speed picked while a video plays is kept, and every new video and reel starts at it", () => {
  const storage = createMemoryStorage();
  const win = page();
  const { keeper, input } = speedKeeper(win, storage);
  const first = fakeVideo(win);
  first.start();
  input();
  first.video.playbackRate = 1.5;
  assert.equal(storage.get(SPEED_KEY), 1.5);
  assert.equal(keeper.kept(), 1.5);
  const next = fakeVideo(win, { time: 0 });
  next.start();
  assert.equal(next.video.playbackRate, 1.5);
  // Normal again, the same way.
  input();
  first.video.playbackRate = 1;
  assert.equal(keeper.kept(), 1);
});

test('Facebook setting its own speed back is undone, a few times at most', () => {
  const storage = createMemoryStorage({ [SPEED_KEY]: 1.75 });
  const win = page();
  const { later } = speedKeeper(win, storage);
  const card = fakeVideo(win);
  card.start();
  assert.equal(card.video.playbackRate, 1.75);
  later(5000);
  for (let i = 0; i < 3; i++) {
    card.video.playbackRate = 1;
    assert.equal(card.video.playbackRate, 1.75, `put back ${i + 1}`);
  }
  card.video.playbackRate = 1;
  assert.equal(card.video.playbackRate, 1, 'then left alone rather than fighting');
  assert.equal(storage.get(SPEED_KEY), 1.75, 'and none of that counts as a pick');
});

test('a change in the first second of a video is Facebook starting it, not a pick', () => {
  const storage = createMemoryStorage({ [SPEED_KEY]: 1.5 });
  const win = page();
  const { input } = speedKeeper(win, storage);
  const card = fakeVideo(win, { time: 0.2 });
  card.start();
  input();
  card.video.playbackRate = 1;
  assert.equal(card.video.playbackRate, 1.5);
  assert.equal(storage.get(SPEED_KEY), 1.5);
});

test('stories, a reel held for 2x, odd speeds and the switch off are left alone', () => {
  const storage = createMemoryStorage({ [SPEED_KEY]: 1.5 });
  const story = page(`${FB}/stories/1/UzpfSVNDOjE=/`);
  speedKeeper(story, storage);
  const card = fakeVideo(story);
  card.start();
  assert.equal(card.video.playbackRate, 1);

  const win = page();
  let on = true;
  const { input } = speedKeeper(win, storage, { on: () => on });
  const held = fakeVideo(win);
  held.start();
  held.video[HOLDING] = true;
  input();
  held.video.playbackRate = 2;
  assert.equal(storage.get(SPEED_KEY), 1.5, 'the hold is not a pick');
  delete held.video[HOLDING];
  input();
  held.video.playbackRate = 16;
  assert.equal(storage.get(SPEED_KEY), 1.5, 'out of range');
  on = false;
  const off = fakeVideo(win);
  off.start();
  assert.equal(off.video.playbackRate, 1);
});

test('a live broadcast keeps the speed it is sent at', () => {
  const storage = createMemoryStorage({ [SPEED_KEY]: 1.5 });
  const win = page(`${FB}/watch/live/?v=1234567890`);
  const { input } = speedKeeper(win, storage);
  const live = fakeVideo(win, { duration: Number.POSITIVE_INFINITY });
  live.start();
  assert.equal(live.video.playbackRate, 1);
  input();
  live.video.playbackRate = 1.25;
  assert.equal(storage.get(SPEED_KEY), 1.5, 'not a pick either');
});

test('a broadcast played before its length is known goes back to normal speed when it turns out live', () => {
  const storage = createMemoryStorage({ [SPEED_KEY]: 1.5 });
  const win = page(`${FB}/watch/live/?v=1234567890`);
  const { input } = speedKeeper(win, storage);
  const live = fakeVideo(win, { duration: Number.NaN });
  live.start();
  assert.equal(live.video.playbackRate, 1.5, 'nothing says it is live yet');
  live.meta(Number.POSITIVE_INFINITY);
  assert.equal(live.video.playbackRate, 1);
  input();
  live.video.playbackRate = 1.25;
  assert.equal(storage.get(SPEED_KEY), 1.5);
  // A video that turns out to have a length keeps the speed.
  const clip = fakeVideo(win, { duration: Number.NaN });
  clip.start();
  clip.meta(40);
  assert.equal(clip.video.playbackRate, 1.5);
  // A live broadcast you sped up by hand is left as you set it.
  const other = fakeVideo(win, { duration: Number.POSITIVE_INFINITY });
  other.start();
  other.video.playbackRate = 2;
  other.meta(Number.POSITIVE_INFINITY);
  assert.equal(other.video.playbackRate, 2);
});

test("a broadcast whose length flickers stays at normal speed, and a new length doesn't restart the fight", () => {
  const storage = createMemoryStorage({ [SPEED_KEY]: 1.5 });
  const win = page(`${FB}/watch/live/?v=1234567890`);
  const { later } = speedKeeper(win, storage);
  const live = fakeVideo(win, { duration: Number.NaN });
  live.start();
  live.length(Number.POSITIVE_INFINITY);
  assert.equal(live.video.playbackRate, 1);
  live.length(3600);
  live.start();
  assert.equal(live.video.playbackRate, 1, 'still the live broadcast');
  // An ordinary video Facebook keeps setting back: given up after three tries, and a length
  // change after that doesn't start it again.
  const card = fakeVideo(win, { duration: 40 });
  card.start();
  later(5000);
  for (let i = 0; i < 4; i++) card.video.playbackRate = 1;
  assert.equal(card.video.playbackRate, 1);
  card.length(41);
  assert.equal(card.video.playbackRate, 1);
});

test('the feature shows the kept speed and can go back to normal', () => {
  const storage = createMemoryStorage({ [SPEED_KEY]: 1.25 });
  const win = page();
  const rows = [];
  const buttons = [];
  keepSpeed.setup({
    doc: win.document, win, storage, enabled: () => true, toast() {},
    diagnostics: { add: (label, read) => rows.push([label, read]) },
    actions: { add: (label, run) => buttons.push([label, run]) },
  });
  assert.deepEqual(rows.map(([label, read]) => [label, read()]), [['Video speed kept', '1.25x']]);
  buttons[0][1]();
  assert.equal(rows[0][1](), 'Normal');
  assert.equal(speedLabel(2), '2x');
  assert.equal(keepSpeed.default, false);
});

// ---- Hold a reel for 2x ----

function holder(win, { on = () => true } = {}) {
  const timers = [];
  let time = 0;
  const hold = createHold({
    doc: win.document, win, enabled: on, trusted: () => true,
    setTimer: (fn) => timers.push(fn), clearTimer: () => timers.splice(0), now: () => time,
  });
  hold.start();
  const press = (target, init = {}) => target.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 300, clientY: 400, ...init }));
  const lift = (target) => {
    target.dispatchEvent(new win.PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 300, clientY: 400 }));
    const click = new win.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    target.dispatchEvent(click);
    return click;
  };
  return { hold, timers, press, lift, wait: () => timers.splice(0).forEach((fn) => fn()), tick: (ms) => { time += ms; } };
}

test('holding the mouse on a reel plays it at 2x until you let go, and that click never reaches Facebook', () => {
  const win = page(`${FB}/reel/1234567890`, '<div class="reel"><div class="cover"></div></div>');
  const reel = fakeVideo(win, { parent: win.document.querySelector('.reel') });
  const cover = win.document.querySelector('.cover');
  reel.video.playbackRate = 1.25;
  const reached = [];
  win.document.addEventListener('click', () => reached.push('click'));
  const { hold, press, lift, wait } = holder(win);
  press(cover);
  assert.equal(reel.video.playbackRate, 1.25, 'not before the hold time');
  wait();
  assert.equal(reel.video.playbackRate, FAST);
  assert.equal(reel.video[HOLDING], true);
  const click = lift(cover);
  assert.equal(reel.video.playbackRate, 1.25, 'back to the speed it had');
  assert.equal(reel.video[HOLDING], undefined);
  assert.equal(click.defaultPrevented, true);
  assert.deepEqual(reached, []);
  assert.deepEqual(hold.state(), { holding: false, holds: 1 });
});

test('a quick click on a reel is just a click', () => {
  const win = page(`${FB}/reel/1234567890`);
  const reel = fakeVideo(win);
  const reached = [];
  win.document.addEventListener('click', () => reached.push('click'));
  const { press, lift, timers } = holder(win);
  press(reel.video);
  assert.equal(timers.length, 1);
  const click = lift(reel.video);
  assert.equal(timers.length, 0, 'the hold was called off');
  assert.equal(reel.video.playbackRate, 1);
  assert.equal(click.defaultPrevented, false);
  assert.deepEqual(reached, ['click']);
});

test("a press on a reel's buttons, a paused reel, other pages and the switch off don't hold", () => {
  const win = page(`${FB}/reel/1234567890`, '<div role="button" aria-label="Like" class="like"></div>');
  const reel = fakeVideo(win);
  const { press, wait, timers } = holder(win);
  press(win.document.querySelector('.like'));
  assert.equal(timers.length, 0, 'a button');
  assert.equal(reelAt(win.document, reel.video, 900, 400), null, 'outside the picture');
  reel.pause();
  press(reel.video);
  wait();
  assert.equal(reel.video.playbackRate, 1, 'paused');

  const feed = page(`${FB}/`);
  const video = fakeVideo(feed);
  const other = holder(feed);
  other.press(video.video);
  assert.equal(other.timers.length, 0, 'a feed video');

  const off = page(`${FB}/reel/1234567890`);
  const offReel = fakeVideo(off);
  const switched = holder(off, { on: () => false });
  switched.press(offReel.video);
  assert.equal(switched.timers.length, 0);
  assert.equal(HOLD_MS > 200, true);
  assert.equal(holdForSpeed.section, 'reels');
});

test("a long press on the script's own buttons is a click on them, and the running flag on the page's root doesn't get in the way", () => {
  const win = page(`${FB}/reel/1234567890`, '<div class="reel"></div>');
  const doc = win.document;
  // The flag main.js puts on <html> while the script runs.
  doc.documentElement.setAttribute('data-hushfacebook-web', '0.0.1');
  const reel = fakeVideo(win, { parent: doc.querySelector('.reel') });
  const { press, lift, wait, timers } = holder(win);
  press(reel.video);
  wait();
  assert.equal(reel.video.playbackRate, FAST, 'the reel itself still holds');
  lift(reel.video);

  // The Download or Pop out button floats over the reel, in a box of its own on the page.
  const host = doc.createElement('div');
  host.setAttribute('data-hushfacebook-web', 'download');
  doc.body.append(host);
  press(host);
  assert.equal(timers.length, 0, 'no hold starts');
  const click = lift(host);
  assert.equal(click.defaultPrevented, false, 'and the click reaches the button');
});

test('a hold cut short by the window losing focus keeps no click', () => {
  const win = page(`${FB}/reel/1234567890`);
  const reel = fakeVideo(win);
  const { hold, press, wait } = holder(win);
  press(reel.video);
  wait();
  assert.equal(hold.state().holding, true);
  win.dispatchEvent(new win.Event('blur'));
  assert.equal(reel.video.playbackRate, 1, 'the hold ends');
  const click = new win.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  reel.video.dispatchEvent(click);
  assert.equal(click.defaultPrevented, false, 'the next click is an ordinary one');
});

// ---- Keep video controls on screen ----

// A Watch player: the video, its controls layer that fades, and the volume pop-up.
const PLAYER = `
<div class="player">
  <div class="frame"><div class="slot"></div></div>
  <div class="overlay" style="opacity: 0.01">
    <div class="bar">
      <div role="button" aria-label="Pause"></div>
      <div class="track"><div role="slider" aria-label="Change Position" aria-valuemax="40" aria-valuenow="8"></div></div>
    </div>
  </div>
  <div class="volume" style="opacity: 0"><div role="slider" aria-label="Change volume" aria-valuemax="1"></div></div>
</div>`;

// Each element's own opacity, as a browser computes it (happy-dom passes a parent's down).
const ownStyle = (node) => ({ opacity: node.style.opacity || '1', visibility: node.style.visibility || 'visible' });

test("a video's position slider is the one whose largest value is the video's length", () => {
  const win = page(undefined, PLAYER);
  const { video } = fakeVideo(win, { duration: 40.2, parent: win.document.querySelector('.slot') });
  assert.equal(positionSlider(video).getAttribute('aria-label'), 'Change Position');
  const other = fakeVideo(win, { duration: 300 });
  assert.equal(positionSlider(other.video), null, 'a video without a player around it');
});

test('a video about as long as the volume scale goes takes the slider that follows its time', () => {
  const player = (volumeNow) => `
<div class="player">
  <div class="frame"><div class="slot"></div></div>
  <div class="volume"><div role="slider" aria-label="Change volume" aria-valuemax="100" aria-valuenow="${volumeNow}"></div></div>
  <div class="track"><div role="slider" aria-label="Change Position" aria-valuemax="100" aria-valuenow="31"></div></div>
</div>`;
  const win = page(undefined, player(80));
  const { video } = fakeVideo(win, { time: 31.4, duration: 100.3, parent: win.document.querySelector('.slot') });
  assert.equal(positionSlider(video).getAttribute('aria-label'), 'Change Position');
  // Neither follows the video: better no slider than the wrong one.
  const lost = page(undefined, player(80).replace('aria-valuenow="31"', 'aria-valuenow="70"'));
  const other = fakeVideo(lost, { time: 31.4, duration: 100.3, parent: lost.document.querySelector('.slot') });
  assert.equal(positionSlider(other.video), null);
  // A muted video just starting: the volume slider at 0 and the position at 0 both follow it,
  // so neither is taken until the position moves on.
  const start = page(undefined, player(0).replace('aria-valuenow="31"', 'aria-valuenow="0"'));
  const muted = fakeVideo(start, { time: 0.4, duration: 100.3, parent: start.document.querySelector('.slot') });
  assert.equal(positionSlider(muted.video), null);
  start.document.querySelector('[aria-label="Change Position"]').setAttribute('aria-valuenow', '5');
  muted.at(5.2);
  assert.equal(positionSlider(muted.video).getAttribute('aria-label'), 'Change Position');
  // The volume at 50 while the video passes second 50: both follow it for a moment, and only
  // the one that moves is the position. The volume's pop-up is never taken for the bar.
  const half = page(undefined, player(50).replace('aria-valuenow="31"', 'aria-valuenow="50"'));
  const mid = fakeVideo(half, { time: 50.3, duration: 100.3, parent: half.document.querySelector('.slot') });
  const looks = new WeakMap();
  assert.equal(positionSlider(mid.video, looks), null, 'not before one has moved');
  half.document.querySelector('[aria-label="Change Position"]').setAttribute('aria-valuenow', '51');
  mid.at(51.3);
  assert.equal(positionSlider(mid.video, looks).getAttribute('aria-label'), 'Change Position');
  // A thin progress bar beside the scrubber: both follow the video and both move, so either
  // will do once they've moved.
  const twin = page(undefined, player(80).replace('<div class="volume">', '<div class="thin"><div role="slider" aria-label="Progress" aria-valuemax="100" aria-valuenow="31"></div></div><div class="volume">'));
  const both = fakeVideo(twin, { time: 31.4, duration: 100.3, parent: twin.document.querySelector('.slot') });
  const seen = new WeakMap();
  assert.equal(positionSlider(both.video, seen), null);
  for (const label of ['Progress', 'Change Position']) twin.document.querySelector(`[aria-label="${label}"]`).setAttribute('aria-valuenow', '32');
  both.at(32.4);
  assert.equal(positionSlider(both.video, seen).getAttribute('aria-label'), 'Progress');
});

test('a volume turned earlier is not taken for moving when the video later passes it', () => {
  const win = page(undefined, `
<div class="player">
  <div class="frame"><div class="slot"></div></div>
  <div class="volume"><div role="slider" aria-label="Change volume" aria-valuemax="100" aria-valuenow="30"></div></div>
  <div class="track"><div role="slider" aria-label="Change Position" aria-valuemax="100" aria-valuenow="30"></div></div>
</div>`);
  const position = win.document.querySelector('[aria-label="Change Position"]');
  const volume = win.document.querySelector('[aria-label="Change volume"]');
  const { video, at } = fakeVideo(win, { time: 30.3, duration: 100.3, parent: win.document.querySelector('.slot') });
  const looks = new WeakMap();
  const look = (second) => {
    position.setAttribute('aria-valuenow', String(second));
    at(second + 0.3);
    return positionSlider(video, looks)?.getAttribute('aria-label') ?? null;
  };
  assert.equal(look(30), null, 'both at 30, neither has moved yet');
  assert.equal(look(31), 'Change Position');
  // Ten seconds on, the volume goes up to 70, and the looks go on every second.
  for (let second = 32; second < 68; second++) {
    if (second === 40) volume.setAttribute('aria-valuenow', '70');
    look(second);
  }
  // At 68 both follow the video again. Only the position moved since the last look.
  assert.equal(look(68), 'Change Position');
  assert.equal(look(69), 'Change Position');
});

test('the faded controls are kept on screen, and only them', () => {
  const win = page(undefined, PLAYER);
  const { video } = fakeVideo(win, { duration: 40.2, parent: win.document.querySelector('.slot') });
  let on = true;
  const keeper = createControlsKeeper({ doc: win.document, enabled: () => on, styleOf: ownStyle });
  keeper.check(video);
  const marked = [...win.document.querySelectorAll(`[${KEEP}]`)].map((node) => node.className);
  assert.deepEqual(marked, ['overlay']);
  assert.equal(keeper.kept(), 1);
  assert.ok(KEEP_CONTROLS_CSS.includes(`[${KEEP}]`) && KEEP_CONTROLS_CSS.includes('opacity: 1 !important'));
  on = false;
  keeper.clear();
  assert.equal(win.document.querySelectorAll(`[${KEEP}]`).length, 0);
});

test('reels and stories keep their own controls, and checks come once a second per video', () => {
  const reel = page(`${FB}/reel/1234567890`, PLAYER);
  const one = fakeVideo(reel, { duration: 40, parent: reel.document.querySelector('.slot') });
  createControlsKeeper({ doc: reel.document, enabled: () => true, styleOf: ownStyle }).check(one.video);
  assert.equal(reel.document.querySelectorAll(`[${KEEP}]`).length, 0);

  const win = page(undefined, PLAYER);
  const { video } = fakeVideo(win, { duration: 40, parent: win.document.querySelector('.slot') });
  let time = 0;
  const keeper = createControlsKeeper({ doc: win.document, enabled: () => true, now: () => time, styleOf: ownStyle });
  keeper.start();
  win.document.querySelector('.overlay').style.opacity = '1';
  video.dispatchEvent(new win.Event('timeupdate'));
  win.document.querySelector('.overlay').style.opacity = '0.01';
  time += 400;
  video.dispatchEvent(new win.Event('timeupdate'));
  assert.equal(win.document.querySelectorAll(`[${KEEP}]`).length, 0, 'too soon for another look');
  time += 700;
  video.dispatchEvent(new win.Event('timeupdate'));
  assert.equal(win.document.querySelectorAll(`[${KEEP}]`).length, 1);
  assert.equal(keepControls.default, false);
});

// ---- Picture-in-picture ----

const frame = () => new Promise((resolve) => setTimeout(resolve, 30));

test('the Pop out button asks for picture-in-picture, and offers the way back once it is out', async () => {
  const win = page(`${FB}/watch/?v=1234567890`, '<div class="wrap"></div>');
  const doc = win.document;
  const { video } = fakeVideo(win, { parent: doc.querySelector('.wrap') });
  video.getBoundingClientRect = () => ({ left: 100, top: 50, right: 700, bottom: 450, width: 600, height: 400 });
  doc.elementsFromPoint = () => [video];
  let inPicture = null;
  Object.defineProperty(doc, 'pictureInPictureElement', { get: () => inPicture, configurable: true });
  doc.exitPictureInPicture = async () => { inPicture = null; };
  video.requestPictureInPicture = async () => { inPicture = video; };
  let popped = 0;
  const button = createPopOut({ doc, win, enabled: () => true, onPopOut: () => popped++ });
  doc.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 200, clientY: 100 }));
  await frame();
  assert.deepEqual([button.state().shown, button.state().text], [true, 'Pop out']);
  assert.equal(button.state().top, '100px', 'one row below the Download button');
  assert.ok(doc.querySelector('[data-hushfacebook-web="picture-in-picture"]'));
  button.click();
  await frame();
  assert.equal(inPicture, video);
  assert.equal(button.state().text, 'Back to the page');
  button.click();
  await frame();
  assert.equal(inPicture, null);
  assert.equal(popped, 1);
  // Out again, then closed from the small window's own X.
  button.click();
  await frame();
  assert.equal(button.state().text, 'Back to the page');
  inPicture = null;
  video.dispatchEvent(new win.Event('leavepictureinpicture', { bubbles: true }));
  assert.equal(button.state().text, 'Pop out');
  button.stop();
});

test('the Download and Pop out buttons over one video see through each other', async () => {
  // Facebook's video sits many boxes deep, far from the buttons on the page's body.
  const win = page(`${FB}/watch/?v=1234567890`, `${'<div>'.repeat(14)}<div class="wrap"></div>${'</div>'.repeat(14)}`);
  const doc = win.document;
  const { video } = fakeVideo(win, { parent: doc.querySelector('.wrap') });
  const download = createDownloadButton({ doc, win, find: () => ({ video }), run: async () => {}, active: () => true });
  const popOut = createPopOut({ doc, win, enabled: () => true });
  doc.elementsFromPoint = () => [video];
  doc.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 200, clientY: 100 }));
  await frame();
  const [downloadHost, popOutHost] = ['download', 'picture-in-picture'].map((name) => doc.querySelector(`[data-hushfacebook-web="${name}"]`));
  assert.ok(downloadHost && popOutHost);
  // The pointer moves onto the Download button: Pop out still knows the video under it, and
  // the Download button knows it's on itself.
  doc.elementsFromPoint = () => [downloadHost, video];
  assert.equal(mediaAt(doc, popOutHost, 550, 60), video);
  assert.equal(mediaAt(doc, downloadHost, 550, 60), 'button');
  download.stop();
  popOut.stop();
});

test('photos get no Pop out button, and without picture-in-picture the switch is unavailable', async () => {
  const win = page(`${FB}/`, '<img class="photo">');
  const doc = win.document;
  const photo = doc.querySelector('img');
  photo.getBoundingClientRect = () => ({ left: 0, top: 0, right: 500, bottom: 500, width: 500, height: 500 });
  doc.elementsFromPoint = () => [photo];
  const button = createPopOut({ doc, win, enabled: () => true });
  doc.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 200, clientY: 100 }));
  await frame();
  assert.equal(button.state().shown, false);
  button.stop();

  let unavailable = 0;
  Object.defineProperty(doc, 'pictureInPictureEnabled', { get: () => false, configurable: true });
  pictureInPicture.setup({ doc, win, enabled: () => true, markUnavailable: () => unavailable++ });
  assert.equal(unavailable, 1);
  assert.equal(pictureInPicture.default, false);
});
