// Remember your volume, against players shaped like Facebook's (2026-10-12): each video and reel
// is a new element with its own player state. The player writes its mute and volume to the video
// whenever it re-renders, and its mute button's label says what a click does. A feed player also
// has a volume slider (top 1) and a seek bar (top = the length) beside the video.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { createMemoryStorage } from '../src/core/storage.js';
import keepVolume, { VOLUME_KEY, createVolumeKeeper, inPlayer, muteToggle, readVolume, volumeLabel, volumeSlider } from '../src/features/playback/keep-volume.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

function page() {
  const win = new Window({ url: 'https://www.facebook.com/reel/1234567890' });
  windows.push(win);
  win.document.body.innerHTML = '<div id="elsewhere"><div role="button" aria-label="Like">Like</div></div>';
  return win;
}

// A player, inside a page as deep as Facebook's. Changing the video's volume or mute fires
// volumechange, as a browser does. `render()` is Facebook writing its own state again.
// With `proto`, the video uses the accessors on HTMLMediaElement.prototype (see guarded()).
function player(win, { time = 5, muted = true, volume = 1, feed = false, proto = false } = {}) {
  const outer = win.document.createElement('div');
  outer.innerHTML = '<div><div><div><div><div><div class="box"></div></div></div></div></div></div>';
  const box = outer.querySelector('.box');
  box.innerHTML = `<div><div class="frame"><video></video><div class="surface"></div></div><div class="overlay">
    <div role="button" class="toggle" tabindex="0"></div><div role="button" aria-label="Next items"></div>
    ${feed ? '<div role="slider" aria-label="Change volume" aria-valuemin="0" aria-valuemax="1" tabindex="0"></div><div role="slider" aria-label="Change Position" aria-valuemax="436"></div>' : ''}
  </div></div>`;
  win.document.body.append(outer);
  const video = box.querySelector('video');
  const toggle = box.querySelector('.toggle');
  let level = volume;
  let silent = muted;
  let clock = time;
  let paused = false;
  const fb = { muted, volume };
  if (proto) {
    video.volume = volume;
    video.muted = muted;
  } else {
    Object.defineProperties(video, {
      volume: { get: () => level, set: (value) => { if (value === level) return; level = value; video.dispatchEvent(new win.Event('volumechange')); }, configurable: true },
      muted: { get: () => silent, set: (value) => { if (value === silent) return; silent = value; video.dispatchEvent(new win.Event('volumechange')); }, configurable: true },
    });
  }
  Object.defineProperties(video, {
    currentTime: { get: () => clock, configurable: true },
    paused: { get: () => paused, configurable: true },
  });
  const render = () => {
    toggle.setAttribute('aria-label', fb.muted ? 'Unmute' : 'Mute');
    video.muted = fb.muted;
    video.volume = fb.volume;
  };
  toggle.setAttribute('aria-label', fb.muted ? 'Unmute' : 'Mute');
  toggle.addEventListener('click', () => {
    fb.muted = !fb.muted;
    render();
  });
  return {
    video, toggle, fb, render,
    slider: box.querySelector('[aria-label="Change volume"]'),
    seek: box.querySelector('[aria-label="Change Position"]'),
    surface: box.querySelector('.surface'),
    next: box.querySelector('[aria-label="Next items"]'),
    start() { paused = false; video.dispatchEvent(new win.Event('play')); },
    pause() { paused = true; },
    at(seconds) { clock = seconds; video.dispatchEvent(new win.Event('timeupdate')); },
    // Dragging Facebook's slider: its state and the video move together.
    slide(value) { fb.volume = value; render(); },
  };
}

// Page mode's setters: plain volume and muted accessors on the prototype, as a browser's, for the
// keeper to wrap. Changing either fires volumechange.
function guarded(win) {
  const values = new WeakMap();
  const read = (video) => values.get(video) ?? values.set(video, { volume: 1, muted: false }).get(video);
  for (const name of ['volume', 'muted']) {
    Object.defineProperty(win.HTMLMediaElement.prototype, name, {
      configurable: true,
      get() { return read(this)[name]; },
      set(value) {
        const now = read(this);
        if (now[name] === value) return;
        now[name] = value;
        this.dispatchEvent(new win.Event('volumechange'));
      },
    });
  }
}

function keeper(win, storage, { on = () => true, page = false } = {}) {
  let time = 10000;
  const woken = [];
  const waiting = [];
  const k = createVolumeKeeper({
    doc: win.document, win, storage, enabled: on, page, now: () => time, trusted: () => true,
    defer: (run) => woken.push(run), later: (run, ms) => waiting.push({ run, at: time + ms }),
  });
  k.start();
  return {
    keeper: k,
    waiting,
    // Runs the writes that are due by now.
    due() {
      for (const entry of waiting.filter(({ at }) => at <= time)) {
        waiting.splice(waiting.indexOf(entry), 1);
        entry.run();
      }
    },
    // A real click: pointerdown, then the click Facebook's buttons act on.
    click(target) {
      target.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true }));
      target.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    },
    key(name = 'm', target = win.document.body) { target.dispatchEvent(new win.KeyboardEvent('keydown', { bubbles: true, key: name })); },
    later(ms) { time += ms; },
    wake() { for (const run of woken.splice(0)) run(); },
  };
}

test('sound you turn on with the mute button is kept, and the next reel starts with it through its own button', () => {
  const storage = createMemoryStorage();
  const win = page();
  const { keeper: k, click } = keeper(win, storage);
  const first = player(win);
  first.start();
  click(first.toggle);
  assert.equal(first.video.muted, false);
  assert.deepEqual(storage.get(VOLUME_KEY), { volume: 1, muted: false });
  assert.deepEqual(k.kept(), { volume: 1, muted: false });
  const next = player(win, { time: 0 });
  next.start();
  assert.equal(next.video.muted, false, 'sound on, since you have clicked on the page');
  assert.equal(next.fb.muted, false, "through Facebook's button, so its player agrees");
  assert.equal(next.toggle.getAttribute('aria-label'), 'Mute');
});

test("the level comes only from a volume slider, and goes to reels, which Facebook sets to 100%", () => {
  const storage = createMemoryStorage();
  const win = page();
  const { click, later } = keeper(win, storage);
  const feed = player(win, { feed: true, muted: false });
  feed.start();
  click(feed.slider);
  feed.slide(0.6);
  later(1500); // a drag goes on past the window
  feed.slide(0.5);
  later(1500);
  feed.slide(0.4);
  assert.deepEqual(storage.get(VOLUME_KEY), { volume: 0.4, muted: false });
  click(feed.seek);
  feed.fb.volume = 1;
  feed.render();
  assert.equal(feed.video.volume, 0.4, 'a click on the seek bar is not a level');
  assert.deepEqual(storage.get(VOLUME_KEY), { volume: 0.4, muted: false });
  const reel = player(win, { time: 0, muted: false });
  reel.start();
  assert.equal(reel.video.volume, 0.4);
  reel.at(3);
  click(reel.toggle);
  assert.equal(reel.video.muted, true);
  assert.equal(reel.video.volume, 0.4, "the mute button's 100% is put back");
  assert.deepEqual(storage.get(VOLUME_KEY), { volume: 0.4, muted: true }, 'and only the mute is kept');
});

test('a long slider drag writes at most ten times a second and saves where it stops', () => {
  const storage = createMemoryStorage();
  const saved = [];
  const set = storage.set;
  storage.set = (key, value) => {
    saved.push(value.volume);
    set(key, value);
  };
  const win = page();
  const { keeper: k, click, later, due, waiting } = keeper(win, storage);
  const feed = player(win, { feed: true, muted: false });
  feed.start();
  click(feed.slider);
  // Three seconds at 60 steps a second, down from 100%.
  for (let step = 1; step <= 180; step++) {
    later(1000 / 60);
    due();
    feed.slide(1 - step / 200);
    assert.equal(feed.video.volume, 1 - step / 200, `step ${step} stays where you dragged it`);
  }
  assert.ok(saved.length <= 40, `${saved.length} writes`);
  const last = 1 - 180 / 200;
  assert.deepEqual(k.kept(), { volume: last, muted: false }, 'the newest pick counts before it is written');
  later(1000);
  due();
  assert.equal(waiting.length, 0);
  assert.deepEqual(storage.get(VOLUME_KEY), { volume: last, muted: false });
  const writes = saved.length;
  feed.slide(0.2);
  assert.equal(saved.length, writes + 1, 'after a pause the next pick is written at once');
});

test('a pick still waiting to be written is saved when the page goes away', () => {
  const storage = createMemoryStorage();
  const win = page();
  const { click } = keeper(win, storage);
  const feed = player(win, { feed: true, muted: false });
  feed.start();
  click(feed.slider);
  for (let step = 1; step <= 12; step++) feed.slide(1 - step / 20);
  assert.deepEqual(storage.get(VOLUME_KEY), { volume: 0.5, muted: false }, 'the first ten were written');
  win.dispatchEvent(new win.Event('pagehide'));
  assert.deepEqual(storage.get(VOLUME_KEY), { volume: 0.4, muted: false });
});

test('a mute you choose is kept too, and a new video stays muted', () => {
  const storage = createMemoryStorage({ [VOLUME_KEY]: { volume: 0.7, muted: false } });
  const win = page();
  const { click } = keeper(win, storage);
  const reel = player(win, { muted: false, volume: 0.7 });
  reel.start();
  click(reel.toggle);
  assert.deepEqual(storage.get(VOLUME_KEY), { volume: 0.7, muted: true });
  const next = player(win, { time: 0, muted: false });
  next.start();
  assert.equal(next.video.muted, true);
  assert.equal(next.toggle.getAttribute('aria-label'), 'Unmute');
});

test("before you've clicked or typed, a video keeps Facebook's mute and only gets the level; your first click gives the playing one sound", () => {
  const storage = createMemoryStorage({ [VOLUME_KEY]: { volume: 0.3, muted: false } });
  const win = page();
  const { click, wake } = keeper(win, storage);
  const reel = player(win, { time: 0 });
  reel.start();
  assert.equal(reel.video.muted, true, 'a browser would pause it if the script turned the sound on now');
  assert.equal(reel.video.volume, 0.3);
  const stopped = player(win, { time: 0 });
  stopped.start();
  stopped.pause();
  click(win.document.getElementById('elsewhere'));
  wake();
  assert.equal(reel.video.muted, false, 'the playing reel gets its sound');
  assert.equal(reel.fb.muted, false);
  assert.equal(stopped.video.muted, true, 'a paused one waits until it plays');
  const next = player(win, { time: 0 });
  next.start();
  assert.equal(next.video.muted, false);
});

test("Facebook writing its state after a click on the video or Next is put back, not taken as yours", () => {
  const storage = createMemoryStorage({ [VOLUME_KEY]: { volume: 0.5, muted: false } });
  const win = page();
  const { click, later } = keeper(win, storage);
  click(win.document.getElementById('elsewhere'));
  const reel = player(win);
  reel.start();
  assert.equal(reel.video.volume, 0.5);
  assert.equal(reel.fb.muted, false);
  click(reel.surface);
  reel.render();
  assert.equal(reel.video.volume, 0.5);
  later(3000);
  // A player whose button the script couldn't use: Facebook still thinks it's muted.
  reel.fb.muted = true;
  reel.toggle.removeAttribute('aria-label');
  click(win.document.getElementById('elsewhere'));
  reel.render();
  assert.equal(reel.video.muted, false, 'put back');
  assert.deepEqual(storage.get(VOLUME_KEY), { volume: 0.5, muted: false }, 'none of that counts as yours');
});

test('a player that keeps resetting gets three put-backs every two seconds, and yours again once it settles', () => {
  const storage = createMemoryStorage({ [VOLUME_KEY]: { volume: 0.5, muted: false } });
  const win = page();
  const { later } = keeper(win, storage);
  const reel = player(win, { time: 0, muted: false });
  reel.start();
  // Facebook writes its state several times as a reel starts.
  for (let i = 0; i < 3; i++) {
    reel.render();
    assert.equal(reel.video.volume, 0.5, `put back ${i + 1}`);
    later(100);
  }
  reel.render();
  assert.equal(reel.video.volume, 1, 'then left alone rather than fighting');
  reel.at(0.6);
  assert.equal(reel.video.volume, 0.5, 'until it has settled');
  later(2500);
  reel.render();
  assert.equal(reel.video.volume, 0.5, 'and at the next loop');
});

test('a click in a player without its button counts only after the first half second; keys count only on the button or the slider', () => {
  const storage = createMemoryStorage({ [VOLUME_KEY]: { volume: 0.5, muted: false } });
  const win = page();
  const { click, key, later } = keeper(win, storage);
  const feed = player(win, { time: 0.2, muted: false, volume: 0.5, feed: true });
  feed.start();
  const label = feed.toggle.getAttribute('aria-label');
  feed.toggle.removeAttribute('aria-label');
  click(feed.surface);
  feed.fb.muted = true;
  feed.video.muted = true;
  assert.equal(feed.video.muted, false, 'Facebook starting the video: put back');
  feed.at(3);
  click(feed.surface);
  feed.video.muted = true;
  assert.deepEqual(storage.get(VOLUME_KEY), { volume: 0.5, muted: true }, 'later, a click in a player without its button counts');
  storage.set(VOLUME_KEY, { volume: 0.5, muted: false });
  later(3000);
  feed.video.muted = false;
  feed.toggle.setAttribute('aria-label', label);
  feed.fb.muted = false;
  feed.render();
  key('ArrowDown');
  feed.fb.muted = true;
  feed.render();
  assert.equal(feed.video.muted, false, 'a key elsewhere, like the one for the next reel, is not a mute');
  key('m');
  feed.fb.muted = true;
  feed.render();
  assert.equal(feed.video.muted, false, 'nor is M');
  later(3000);
  feed.fb.muted = false;
  feed.render();
  feed.toggle.focus();
  key('Enter', feed.toggle);
  feed.fb.muted = true;
  feed.render();
  assert.deepEqual(storage.get(VOLUME_KEY), { volume: 0.5, muted: true }, 'Enter on the mute button counts');
  feed.slider.focus();
  key('ArrowDown', feed.slider);
  feed.slide(0.45);
  assert.deepEqual(storage.get(VOLUME_KEY), { volume: 0.45, muted: true });
});

test("in page mode Facebook's writes land as your values, so nothing is heard in between", () => {
  const storage = createMemoryStorage({ [VOLUME_KEY]: { volume: 0.4, muted: false } });
  const win = page();
  guarded(win);
  let on = true;
  const { click } = keeper(win, storage, { page: true, on: () => on });
  click(win.document.getElementById('elsewhere'));
  const reel = player(win, { time: 0, proto: true });
  reel.start();
  assert.deepEqual([reel.video.volume, reel.video.muted], [0.4, false]);
  assert.equal(reel.toggle.getAttribute('aria-label'), 'Mute', "Facebook's button agrees");
  const heard = [];
  reel.video.addEventListener('volumechange', () => heard.push([reel.video.volume, reel.video.muted]));
  reel.render();
  reel.fb.muted = true;
  reel.render();
  assert.deepEqual(heard, [], 'its 100% and its mute never reach the video');
  reel.fb.muted = false;
  reel.render();
  click(reel.toggle);
  assert.deepEqual([reel.video.volume, reel.video.muted], [0.4, true]);
  assert.deepEqual(storage.get(VOLUME_KEY), { volume: 0.4, muted: true }, 'your mute button still counts');
  on = false;
  reel.video.volume = 0.9;
  assert.equal(reel.video.volume, 0.9, 'switched off, writes go through');
});

test('nothing is kept or given with the switch off, or before you have set anything', () => {
  const storage = createMemoryStorage();
  const win = page();
  let on = false;
  const { click, wake } = keeper(win, storage, { on: () => on });
  const reel = player(win);
  reel.start();
  click(reel.toggle);
  wake();
  assert.equal(storage.get(VOLUME_KEY), undefined);
  on = true;
  const next = player(win, { volume: 0.9 });
  next.start();
  assert.equal(next.video.volume, 0.9, 'nothing set yet: Facebook decides');
  next.video.volume = 0.6;
  assert.equal(next.video.volume, 0.6, "and Facebook's own changes are left alone");
});

test('saved values are checked, and only the right controls count', () => {
  assert.deepEqual(readVolume({ volume: 2, muted: 'yes' }), { volume: 1, muted: false });
  assert.equal(readVolume({ volume: 'loud' }), null);
  assert.equal(readVolume(null), null);
  const win = page();
  const reel = player(win, { feed: true });
  assert.equal(inPlayer(reel.video, reel.toggle), true);
  assert.equal(inPlayer(reel.video, win.document.getElementById('elsewhere')), false);
  assert.equal(inPlayer(reel.video, null), false);
  assert.equal(volumeSlider(reel.slider), reel.slider);
  assert.equal(volumeSlider(reel.seek), null);
  assert.equal(volumeSlider(reel.toggle), null);
  assert.equal(muteToggle(reel.video), reel.toggle);
  // The Reels page: the reel before this one sits earlier in the same boxes, with its own button.
  const box = reel.video.closest('.box');
  const before = win.document.createElement('div');
  before.innerHTML = '<div><div><video></video><div role="button" aria-label="Mute"></div></div></div>';
  box.parentElement.prepend(before);
  assert.equal(muteToggle(reel.video), reel.toggle, "this reel's own button, not the one before it");
  assert.equal(muteToggle(before.querySelector('video')), before.querySelector('[role="button"]'));
});

test('the switch starts off, shows the kept volume and can forget it', () => {
  const storage = createMemoryStorage({ [VOLUME_KEY]: { volume: 0.25, muted: false } });
  const win = page();
  const rows = [];
  const buttons = [];
  const toasts = [];
  keepVolume.setup({
    doc: win.document, win, storage, enabled: () => true,
    diagnostics: { add: (label, read) => rows.push([label, read]) },
    actions: { add: (label, run) => buttons.push([label, run]) },
    toast: (message) => toasts.push(message),
  });
  assert.deepEqual(rows.map(([label, read]) => [label, read()]), [['Volume kept', '25%']]);
  buttons[0][1]();
  assert.equal(storage.get(VOLUME_KEY), undefined);
  assert.equal(toasts.length, 1);
  assert.equal(volumeLabel({ volume: 0.5, muted: true }), 'Muted (50%)');
  assert.equal(volumeLabel(null), 'Not set yet');
  assert.equal(keepVolume.default, false);
  assert.equal(keepVolume.section, 'playback');
  assert.equal(keepVolume.needsPage, undefined, 'works in content mode');
});
