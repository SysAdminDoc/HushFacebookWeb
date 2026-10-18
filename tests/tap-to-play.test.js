import assert from 'node:assert/strict';
import { test } from 'node:test';
import tapToPlay, { VIEWER_INPUT_MS, VIEWER_OPEN_MS, isViewer, pointInside, sameResource, shouldAllowPlay } from '../src/features/playback/tap-to-play.js';

const REFUSED = { name: 'NotAllowedError' };

test('shouldAllowPlay needs a fresh press on the media, or an element the user already started', () => {
  assert.equal(shouldAllowPlay({ activationActive: false, aimedAtMedia: false, userStarted: false }), false);
  assert.equal(shouldAllowPlay({ activationActive: true, aimedAtMedia: false, userStarted: false }), false);
  assert.equal(shouldAllowPlay({ activationActive: false, aimedAtMedia: true, userStarted: false }), false);
  assert.equal(shouldAllowPlay({ activationActive: true, aimedAtMedia: true, userStarted: false }), true);
  assert.equal(shouldAllowPlay({ activationActive: false, aimedAtMedia: false, userStarted: true }), true);
});

test('in Reels and stories a start goes ahead soon after input, or as the viewer opens', () => {
  const base = { activationActive: false, aimedAtMedia: false, userStarted: false };
  assert.equal(shouldAllowPlay({ ...base, inViewer: true, sinceInput: VIEWER_INPUT_MS }), true);
  assert.equal(shouldAllowPlay({ ...base, inViewer: true, sinceInput: VIEWER_INPUT_MS + 1 }), false);
  assert.equal(shouldAllowPlay({ ...base, inViewer: true, openedHere: true }), true);
  // Outside a viewer neither counts: the feed still waits for a press on the video.
  assert.equal(shouldAllowPlay({ ...base, inViewer: false, sinceInput: 0, openedHere: true }), false);
  assert.equal(isViewer({ type: 'reel' }), true);
  assert.equal(isViewer({ type: 'stories' }), true);
  assert.equal(isViewer({ type: 'watch' }), false);
  assert.equal(isViewer(undefined), false);
});

test('pointInside counts the edges of the box', () => {
  const rect = { left: 10, top: 10, right: 20, bottom: 20 };
  assert.equal(pointInside(rect, { x: 10, y: 20 }), true);
  assert.equal(pointInside(rect, { x: 21, y: 15 }), false);
});

function harness({ route = { type: 'home', path: '/' } } = {}) {
  class FakeMedia {
    constructor(src = null) {
      this.parentElement = null;
      this.attributes = { src };
      this.children = [];
      this.srcObject = null;
    }
    getAttribute(name) {
      return this.attributes[name] ?? null;
    }
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 100, bottom: 100 };
    }
    contains(node) {
      return node === this;
    }
  }
  FakeMedia.prototype.play = function () {
    this.plays = (this.plays ?? 0) + 1;
    // An element Facebook pauses or swaps out before it starts: the browser's AbortError.
    return this.interrupted ? Promise.reject(new DOMException('interrupted', 'AbortError')) : Promise.resolve();
  };
  const listeners = {};
  const activation = { isActive: false };
  const state = { on: true };
  const win = {
    HTMLMediaElement: FakeMedia, navigator: { userActivation: activation }, Promise, DOMException,
    addEventListener: (type, listener) => { listeners[type] = listener; },
  };
  const clock = { now: 1000 };
  const nav = { current: route, listeners: [] };
  const router = { current: () => nav.current, subscribe: (fn) => nav.listeners.push(fn) };
  const go = (next) => {
    nav.current = next;
    for (const fn of nav.listeners) fn(next);
  };
  tapToPlay.setup({ win, router, enabled: () => state.on, log: { debug() {} }, now: () => clock.now });
  return { FakeMedia, listeners, activation, state, clock, go };
}

const REEL = (id) => ({ type: 'reel', path: `/reel/${id}` });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the Next arrow, a key or the wheel in Reels starts the reel it moves to', async () => {
  const { FakeMedia, listeners, clock, go } = harness({ route: REEL(1) });
  clock.now += VIEWER_OPEN_MS + 1;
  const reel = new FakeMedia();
  // Facebook resuming a reel with nobody touching anything still waits.
  await assert.rejects(reel.play(), REFUSED);

  // The arrow sits outside the video's box.
  listeners.pointerdown({ isTrusted: true, clientX: 1563, clientY: 560 });
  go(REEL(2));
  const next = new FakeMedia();
  await next.play();
  assert.equal(next.plays, 1);

  clock.now += VIEWER_INPUT_MS + 1;
  await assert.rejects(new FakeMedia().play(), REFUSED);
  listeners.keydown({ isTrusted: true, target: {} });
  await new FakeMedia().play();
  clock.now += VIEWER_INPUT_MS + 1;
  listeners.wheel({ isTrusted: true });
  await new FakeMedia().play();
  clock.now += VIEWER_INPUT_MS + 1;
  listeners.wheel({ isTrusted: false });
  await assert.rejects(new FakeMedia().play(), REFUSED);
});

test('opening Reels plays its first reel once, and a later start with no input waits', async () => {
  const { FakeMedia, clock, go } = harness();
  go({ type: 'reel', path: '/reel/' });
  // Facebook swaps /reel/?s=tab for the first reel's own address as it opens.
  go(REEL(1));
  clock.now += 3000;
  const first = new FakeMedia();
  await first.play();
  await settle();
  assert.equal(first.plays, 1);

  // A reel ending and moving on by itself, with no press, key or wheel.
  go(REEL(2));
  await assert.rejects(new FakeMedia().play(), REFUSED);

  // Leaving Reels and coming back opens it again.
  go({ type: 'profile', path: '/me/' });
  go(REEL(3));
  await new FakeMedia().play();
});

test('the opening allowance lasts a while, and loading a reel by its address counts', async () => {
  const late = harness();
  late.go(REEL(1));
  late.clock.now += VIEWER_OPEN_MS + 1;
  await assert.rejects(new late.FakeMedia().play(), REFUSED);

  const loaded = harness({ route: REEL(9) });
  await new loaded.FakeMedia().play();
});

test('a start Facebook drops leaves the opening allowance for the next one', async () => {
  const { FakeMedia, go } = harness();
  go(REEL(1));
  const swapped = new FakeMedia();
  swapped.interrupted = true;
  await assert.rejects(swapped.play(), { name: 'AbortError' });
  await settle();
  // Still the opening start: Facebook's real copy of the reel goes ahead.
  const kept = new FakeMedia();
  await kept.play();
  assert.equal(kept.plays, 1);
  await settle();
  // Now something played, so a start with no input waits again.
  await assert.rejects(new FakeMedia().play(), REFUSED);
});

test('play() waits for a press on that video, not a click somewhere else', async () => {
  const { FakeMedia, listeners, activation, state } = harness();
  const video = new FakeMedia();
  await assert.rejects(video.play(), REFUSED);

  // Clicking the Reels link leaves a fresh gesture, but not on this video.
  activation.isActive = true;
  listeners.pointerdown({ isTrusted: true, clientX: 500, clientY: 40 });
  await assert.rejects(video.play(), REFUSED);
  listeners.pointerdown({ isTrusted: false, clientX: 50, clientY: 50 });
  await assert.rejects(video.play(), REFUSED);

  listeners.pointerdown({ isTrusted: true, clientX: 50, clientY: 50 });
  await video.play();
  activation.isActive = false;
  await video.play();
  assert.equal(video.plays, 2);

  state.on = false;
  const other = new FakeMedia();
  await other.play();
  assert.equal(other.plays, 1);
});

test('a key pressed on a control next to the video starts it', async () => {
  const { FakeMedia, listeners, activation } = harness();
  const button = {};
  const video = new FakeMedia();
  video.parentElement = { contains: (node) => node === button, parentElement: null };
  activation.isActive = true;
  listeners.keydown({ isTrusted: true, target: {} });
  await assert.rejects(video.play(), REFUSED);
  listeners.keydown({ isTrusted: true, target: button });
  await video.play();
  assert.equal(video.plays, 1);
});

const pressOnVideo = (listeners, activation) => {
  activation.isActive = true;
  listeners.pointerdown({ isTrusted: true, clientX: 50, clientY: 50 });
};

test('a start counts for the file it played, so a reused video element waits for a new press', async () => {
  const { FakeMedia, listeners, activation } = harness();
  const video = new FakeMedia('blob:first');
  pressOnVideo(listeners, activation);
  await video.play();
  // The press is long gone. Trying again, seeking and looping keep the same file.
  activation.isActive = false;
  listeners.pointerdown({ isTrusted: true, clientX: 500, clientY: 500 });
  await video.play();
  video.currentTime = 90;
  await video.play();
  assert.equal(video.plays, 3);

  // Facebook puts another video in the same element, with no click anywhere.
  video.attributes.src = 'blob:second';
  await assert.rejects(video.play(), REFUSED);
  assert.equal(video.plays, 3);
  pressOnVideo(listeners, activation);
  await video.play();
  activation.isActive = false;
  await video.play();
  assert.equal(video.plays, 5);
});

test('a different <source> or stream on the element counts as another file too', async () => {
  const { FakeMedia, listeners, activation } = harness();
  const child = (tagName, src) => ({ tagName, getAttribute: (name) => (name === 'src' ? src : null) });
  const video = new FakeMedia();
  video.children = [child('SOURCE', 'first.mp4'), child('TRACK', 'captions.vtt')];
  pressOnVideo(listeners, activation);
  await video.play();
  activation.isActive = false;
  // Captions aren't the file.
  video.children = [child('SOURCE', 'first.mp4'), child('TRACK', 'other.vtt')];
  await video.play();
  video.children = [child('SOURCE', 'second.mp4')];
  await assert.rejects(video.play(), REFUSED);

  const live = new FakeMedia();
  const stream = {};
  live.srcObject = stream;
  pressOnVideo(listeners, activation);
  await live.play();
  activation.isActive = false;
  await live.play();
  live.srcObject = {};
  await assert.rejects(live.play(), REFUSED);
  assert.equal(live.plays, 2);
  assert.equal(sameResource(undefined, { src: null, sources: '[]', object: null }), false);
});

test('in Reels a reused element waits when the next reel starts by itself, and plays after the Next arrow', async () => {
  const { FakeMedia, listeners, clock, go } = harness();
  go(REEL(1));
  const player = new FakeMedia('blob:reel-1');
  await player.play();
  await settle();
  clock.now += VIEWER_INPUT_MS + 1;
  await player.play();

  // The reel ends and Facebook puts the next one in the same element.
  go(REEL(2));
  player.attributes.src = 'blob:reel-2';
  await assert.rejects(player.play(), REFUSED);

  listeners.pointerdown({ isTrusted: true, clientX: 1563, clientY: 560 });
  go(REEL(3));
  player.attributes.src = 'blob:reel-3';
  await player.play();
  assert.equal(player.plays, 3);
});
