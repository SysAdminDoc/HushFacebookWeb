import assert from 'node:assert/strict';
import { test } from 'node:test';
import tapToPlay, { shouldAllowPlay } from '../src/features/playback/tap-to-play.js';

test('shouldAllowPlay needs a gesture or an element the user already started', () => {
  assert.equal(shouldAllowPlay({ activationActive: false, userStarted: false }), false);
  assert.equal(shouldAllowPlay({ activationActive: true, userStarted: false }), true);
  assert.equal(shouldAllowPlay({ activationActive: false, userStarted: true }), true);
});

test('play() is refused without a gesture, then allowed for that element', async () => {
  class FakeMedia {}
  FakeMedia.prototype.play = function () {
    this.plays = (this.plays ?? 0) + 1;
    return Promise.resolve();
  };
  const activation = { isActive: false };
  const win = { HTMLMediaElement: FakeMedia, navigator: { userActivation: activation }, Promise, DOMException };
  let on = true;
  tapToPlay.setup({ win, enabled: () => on, log: { debug() {} } });

  const video = new FakeMedia();
  await assert.rejects(video.play(), { name: 'NotAllowedError' });
  assert.equal(video.plays, undefined);

  activation.isActive = true;
  await video.play();
  activation.isActive = false;
  await video.play();
  assert.equal(video.plays, 2);

  on = false;
  const other = new FakeMedia();
  await other.play();
  assert.equal(other.plays, 1);
});
