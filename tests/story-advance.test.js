// Stop stories moving on, against the story viewer's behavior live on 2026-10-11
// (captures/2026-10-11-run4): a video card's progress follows the video, so pausing it just
// before the end holds the card and rewinding it plays the card again.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import stopStoryAdvance, { END_MARGIN, asksToPlay, createStoryHold, inStoryViewer } from '../src/features/stories/stop-advance.js';

const STORY = 'https://www.facebook.com/stories/100000000000001/UzpfSVNDOjE1NzUzNTE3ODcyMTk0NDg=/';
const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

function page(href = STORY) {
  const win = testWindow(href);
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
  const keeper = createStoryHold({ doc: win.document, win, enabled: on, mode, inViewer: viewer, trusted: () => true });
  keeper.start();
  return keeper;
}

// The viewer clicking the card's Play button (on its icon, as a real click lands), or another
// element when one is given.
function press(win, target) {
  const doc = win.document;
  let button = doc.querySelector('[data-test-play]');
  if (!button) {
    button = doc.createElement('div');
    button.setAttribute('role', 'button');
    button.setAttribute('aria-label', 'Play');
    button.setAttribute('data-test-play', '');
    button.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4 2v12l10-6z"></path></svg>';
    doc.body.append(button);
  }
  (target ?? button.querySelector('path')).dispatchEvent(new win.Event('pointerdown', { bubbles: true }));
}
const key = (win, name, target = win.document.body) => target.dispatchEvent(new win.KeyboardEvent('keydown', { key: name, bubbles: true }));

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
  press(win);
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

test("Facebook playing a held story by itself doesn't let it go, a click does", () => {
  const win = page();
  const keeper = hold(win);
  const card = storyVideo(win);
  card.at(18.1);
  assert.equal(card.video.paused, true);
  card.video.play();
  card.at(18.2);
  assert.equal(card.video.paused, true, 'held again');
  assert.equal(keeper.state().holds, 1, 'still the one hold');
  press(win);
  card.video.play();
  card.at(18.3);
  assert.equal(card.video.paused, false);
});

// Facebook pauses a story while you write a reply or have a menu open, and plays it again when
// you leave, with your click just before that play.
test("leaving the reply box or a menu doesn't let a held story go, the Play button and Space do", () => {
  const win = page();
  const doc = win.document;
  hold(win);
  const card = storyVideo(win);
  card.at(18.1);
  assert.equal(card.video.paused, true);
  const reply = doc.createElement('div');
  reply.innerHTML = '<div role="textbox" contenteditable="true"><p>hi</p></div><div role="menu"><div role="menuitem"><span>Mute</span></div></div><div class="outside"></div>';
  doc.body.append(reply);
  for (const target of [reply.querySelector('p'), reply.querySelector('span'), reply.querySelector('.outside')]) {
    press(win, target);
    card.video.play();
    card.at(18.2);
    assert.equal(card.video.paused, true, `held after a click on ${target.tagName}`);
  }
  key(win, ' ', reply.querySelector('p'));
  card.video.play();
  card.at(18.2);
  assert.equal(card.video.paused, true, 'a space typed in the reply');
  key(win, 'Escape');
  card.video.play();
  card.at(18.2);
  assert.equal(card.video.paused, true, 'closing a menu with Escape');
  key(win, ' ');
  card.video.play();
  card.at(18.3);
  assert.equal(card.video.paused, false, 'Space on the story plays it');
});

test("sending a reply or a quick reaction doesn't let a held story go", () => {
  const win = page();
  const doc = win.document;
  hold(win);
  const card = storyVideo(win);
  card.at(18.1);
  const bar = doc.createElement('div');
  bar.innerHTML = `<div class="bar"><div><div role="textbox" contenteditable="true"></div></div>
    <div><div role="button" aria-label="Send"><svg><path d="M1 1"></path></svg></div></div>
    <div><div><div role="button" aria-label="Like"><span>x</span></div></div></div></div>`;
  doc.body.append(bar);
  // Laid out as on screen: the reply bar along the bottom of the card.
  const at = (element, top, height) => { element.getBoundingClientRect = () => ({ top, bottom: top + height, height, left: 0, right: 40, width: 40 }); };
  at(bar.querySelector('[role="textbox"]'), 800, 40);
  at(bar.querySelector('[aria-label="Send"]'), 805, 30);
  at(bar.querySelector('[aria-label="Like"]'), 802, 36);
  press(win);
  at(doc.querySelector('[data-test-play]'), 60, 24);
  for (const target of [bar.querySelector('path'), bar.querySelector('[aria-label="Like"] span')]) {
    press(win, target);
    card.video.play();
    card.at(18.2);
    assert.equal(card.video.paused, true, `held after ${target.closest('[role="button"]').getAttribute('aria-label')}`);
  }
  press(win);
  card.video.play();
  card.at(18.3);
  assert.equal(card.video.paused, false, 'the Play button, away from the reply bar, still lets it go');
});

test('a play key or button click followed by another click no longer counts', () => {
  const win = page();
  hold(win);
  const card = storyVideo(win);
  card.at(18.1);
  press(win);
  press(win, win.document.body);
  card.video.play();
  card.at(18.2);
  assert.equal(card.video.paused, true);
  assert.equal(asksToPlay({ type: 'keydown', key: 'k', target: win.document.body }), true);
  assert.equal(asksToPlay({ type: 'pointerdown', target: null }), false);
});

test('a story paused by hand right at its end goes on with one Play', () => {
  const win = page();
  const keeper = hold(win);
  const card = storyVideo(win);
  card.at(17.9);
  card.video.pause();
  card.at(18.1);
  press(win);
  card.video.play();
  card.at(18.3);
  assert.equal(card.video.paused, false);
  assert.equal(keeper.state().holds, 0);
});

test('the same card seen again from the start is held again', () => {
  const win = page();
  const keeper = hold(win);
  const card = storyVideo(win);
  card.at(18.1);
  press(win);
  card.video.play();
  card.at(18.4);
  // Back to that card later, on the same element.
  card.nextCard('blob:https://www.facebook.com/card-1', 18.5);
  card.video.play();
  card.at(18.2);
  assert.equal(card.video.paused, true);
  assert.equal(keeper.state().holds, 2);
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
