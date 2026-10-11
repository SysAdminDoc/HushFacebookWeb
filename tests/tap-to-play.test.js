import assert from 'node:assert/strict';
import { test } from 'node:test';
import tapToPlay, { pointInside, shouldAllowPlay } from '../src/features/playback/tap-to-play.js';

const REFUSED = { name: 'NotAllowedError' };

test('shouldAllowPlay needs a fresh press on the media, or an element the user already started', () => {
  assert.equal(shouldAllowPlay({ activationActive: false, aimedAtMedia: false, userStarted: false }), false);
  assert.equal(shouldAllowPlay({ activationActive: true, aimedAtMedia: false, userStarted: false }), false);
  assert.equal(shouldAllowPlay({ activationActive: false, aimedAtMedia: true, userStarted: false }), false);
  assert.equal(shouldAllowPlay({ activationActive: true, aimedAtMedia: true, userStarted: false }), true);
  assert.equal(shouldAllowPlay({ activationActive: false, aimedAtMedia: false, userStarted: true }), true);
});

test('pointInside counts the edges of the box', () => {
  const rect = { left: 10, top: 10, right: 20, bottom: 20 };
  assert.equal(pointInside(rect, { x: 10, y: 20 }), true);
  assert.equal(pointInside(rect, { x: 21, y: 15 }), false);
});

function harness() {
  class FakeMedia {
    constructor() {
      this.parentElement = null;
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
    return Promise.resolve();
  };
  const listeners = {};
  const activation = { isActive: false };
  const state = { on: true };
  const win = {
    HTMLMediaElement: FakeMedia, navigator: { userActivation: activation }, Promise, DOMException,
    addEventListener: (type, listener) => { listeners[type] = listener; },
  };
  tapToPlay.setup({ win, enabled: () => state.on, log: { debug() {} } });
  return { FakeMedia, listeners, activation, state };
}

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
