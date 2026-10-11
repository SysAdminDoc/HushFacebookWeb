// Stop stories moving on, against the story viewer's behavior live on 2026-10-11
// (captures/2026-10-11-run4): a video card's progress follows the video, so pausing it just
// before the end holds the card and rewinding it plays the card again.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import stopStoryAdvance, { END_MARGIN, createStoryHold, inStoryViewer } from '../src/features/stories/stop-advance.js';

const STORY = 'https://www.facebook.com/stories/100000000000001/UzpfSVNDOjE1NzUzNTE3ODcyMTk0NDg=/';
const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

function page(href = STORY) {
  const win = new Window({ url: href });
  windows.push(win);
  return win;
}

// A story video whose clock the test moves; Facebook's own timeupdate and play events included.
function storyVideo(win, { duration = 18.5, src = 'blob:https://www.facebook.com/card-1', loop = false } = {}) {
  const video = win.document.createElement('video');
  let time = 0;
  let paused = false;
  let length = duration;
  let source = src;
  Object.defineProperties(video, {
    duration: { get: () => length, configurable: true },
    currentSrc: { get: () => source, configurable: true },
    currentTime: { get: () => time, set: (value) => { time = value; }, configurable: true },
    paused: { get: () => paused, configurable: true },
    loop: { get: () => loop, configurable: true },
  });
  video.pause = () => { paused = true; };
  video.play = () => {
    paused = false;
    video.dispatchEvent(new win.Event('play'));
  };
  win.document.body.append(video);
  return {
    video,
    at(seconds) {
      time = seconds;
      if (!paused) video.dispatchEvent(new win.Event('timeupdate'));
    },
    nextCard(nextSrc, nextDuration) {
      source = nextSrc;
      length = nextDuration;
      time = 0;
      paused = false;
    },
  };
}

function hold(win, { on = () => true, mode = () => 'hold', viewer = () => inStoryViewer(win.document) } = {}) {
  const keeper = createStoryHold({ doc: win.document, enabled: on, mode, inViewer: viewer });
  keeper.start();
  return keeper;
}

test('a video story is paused just before it ends, once', () => {
  const win = page();
  const keeper = hold(win);
  const card = storyVideo(win);
  card.at(5);
  assert.equal(card.video.paused, false);
  card.at(18.5 - END_MARGIN - 0.1);
  assert.equal(card.video.paused, false, 'not yet');
  card.at(18.1);
  assert.equal(card.video.paused, true);
  card.at(18.2);
  assert.deepEqual(keeper.state(), { holds: 1, replays: 0 });
});

test('playing a held story lets it finish, and the next card is held again', () => {
  const win = page();
  const keeper = hold(win);
  const card = storyVideo(win);
  card.at(18.1);
  assert.equal(card.video.paused, true);
  card.video.play();
  card.at(18.3);
  assert.equal(card.video.paused, false, 'the viewer chose to go on');
  // Facebook reuses the element for the next card.
  card.nextCard('blob:https://www.facebook.com/card-2', 5.1);
  card.at(2);
  assert.equal(card.video.paused, false);
  card.at(4.8);
  assert.equal(card.video.paused, true);
  assert.equal(keeper.state().holds, 2);
});

test("Facebook's own play at the start of a card doesn't count as going on", () => {
  const win = page();
  hold(win);
  const card = storyVideo(win);
  card.video.play();
  card.at(1);
  card.at(18.2);
  assert.equal(card.video.paused, true);
});

test('Play it again sends the story back to the start instead', () => {
  const win = page();
  const keeper = hold(win, { mode: () => 'replay' });
  const card = storyVideo(win);
  card.at(18.2);
  assert.equal(card.video.currentTime, 0);
  assert.equal(card.video.paused, false);
  card.at(18.3);
  assert.deepEqual(keeper.state(), { holds: 0, replays: 2 });
});

test('videos outside the story viewer, short clips, loops and the switch off are left alone', () => {
  const feed = page('https://www.facebook.com/');
  hold(feed);
  const feedVideo = storyVideo(feed);
  feedVideo.at(18.2);
  assert.equal(feedVideo.video.paused, false, 'a feed video');

  const win = page();
  let on = false;
  hold(win, { on: () => on });
  const card = storyVideo(win);
  card.at(18.2);
  assert.equal(card.video.paused, false, 'switch off');
  on = true;
  const clip = storyVideo(win, { duration: 0.8 });
  clip.at(0.6);
  assert.equal(clip.video.paused, false, 'a clip under a second');
  const looping = storyVideo(win, { loop: true });
  looping.at(18.2);
  assert.equal(looping.video.paused, false, 'a looping video');
  const live = storyVideo(win, { duration: Number.POSITIVE_INFINITY });
  live.at(100);
  assert.equal(live.video.paused, false, 'no end to wait for');
});

test('stopping takes the listeners off', () => {
  const win = page();
  const keeper = hold(win);
  keeper.stop();
  const card = storyVideo(win);
  card.at(18.2);
  assert.equal(card.video.paused, false);
});

test('the feature starts off, offers both endings and reports to Diagnostics', () => {
  const win = page();
  const rows = [];
  let changed = 0;
  let atEnd = 'hold';
  stopStoryAdvance.setup({
    doc: win.document,
    enabled: () => true,
    option: (key) => (key === 'atEnd' ? atEnd : undefined),
    diagnostics: { add: (label, read) => rows.push([label, read]), changed: () => changed++ },
  });
  const card = storyVideo(win);
  card.at(18.2);
  atEnd = 'replay';
  const other = storyVideo(win, { src: 'blob:https://www.facebook.com/card-3' });
  other.at(18.2);
  assert.deepEqual(rows.map(([label, read]) => [label, read()]), [['Stories held at the end', '1'], ['Stories played again', '1']]);
  assert.equal(changed, 2);
  assert.equal(stopStoryAdvance.default, false);
  assert.deepEqual(stopStoryAdvance.options[0].choices.map((choice) => choice.value), ['hold', 'replay']);
});
