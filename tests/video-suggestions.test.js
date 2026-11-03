// Hide suggested videos under a video against /watch/?v= as drawn live on 2026-11-03, signed in on
// a NASA video: #watch_feed's one child holds the chosen video's section (player, then the post
// and its comments beside it), then the section of suggested videos, a div[data-virtualized] post
// each, after an empty div.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import hideVideoSuggestions, { SUGGESTIONS } from '../src/features/playback/hide-video-suggestions.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const FB = 'https://www.facebook.com';
const suggestion = (n) => `<div><div data-virtualized="false"><div><a href="${FB}/watch/?v=10000000000000${n}"></a><video></video></div></div></div>`;

const CHOSEN = `<div id="chosen"><div><div>
  <div id="player"><div><div><video></video></div></div><div id="title">Firing up the Rocket</div></div>
  <div id="beside">
    <div><a href="${FB}/NASA">NASA</a></div>
    <div><div id="comments"><div data-virtualized="false"><div role="article" aria-label="Comment by Someone"></div></div><div data-virtualized="false"><div role="article" aria-label="Comment by Someone else"></div></div></div></div>
  </div>
</div></div></div>`;

function load(body) {
  const win = testWindow(`${FB}/watch/?v=452499129200583`);
  windows.push(win);
  win.document.body.innerHTML = body;
  return win.document;
}

const hidden = (doc) => [...doc.querySelectorAll(SUGGESTIONS)].map((el) => el.id || `<${el.tagName.toLowerCase()}>`);

test('the suggested videos under a chosen video hide, and the video, its post and comments stay', () => {
  const doc = load(`<div role="main"><div id="watch_feed"><div>${CHOSEN}<div id="suggestions"><div></div><div><div><div>${[1, 2, 3].map(suggestion).join('')}<div><div>Loading</div></div></div></div></div></div></div></div></div>`);
  assert.deepEqual(hidden(doc), ['suggestions']);
  for (const id of ['chosen', 'player', 'beside', 'comments']) assert.ok(!doc.getElementById(id).closest(SUGGESTIONS), id);
});

test('nothing hides while only the chosen video is drawn, on a section of another shape, or outside the watch page', () => {
  assert.deepEqual(hidden(load(`<div id="watch_feed"><div>${CHOSEN}</div></div>`)), [], 'the chosen video alone');
  assert.deepEqual(hidden(load(`<div id="watch_feed"><div>${CHOSEN}<div id="other"><div><video></video></div></div></div></div>`)), [], 'a later section with no list');
  assert.deepEqual(hidden(load(`<div role="main"><div><div>${CHOSEN}<div>${suggestion(1)}</div></div></div></div>`)), [], 'the same shape without #watch_feed');
});

test('Hide suggested videos is an off-by-default playback switch with nothing but its rule', () => {
  assert.equal(hideVideoSuggestions.id, 'hideVideoSuggestions');
  assert.equal(hideVideoSuggestions.section, 'playback');
  assert.equal(hideVideoSuggestions.default, false);
  assert.equal(hideVideoSuggestions.webOnly, true);
  assert.equal(hideVideoSuggestions.setup, undefined);
  assert.equal(hideVideoSuggestions.css, `${SUGGESTIONS} { display: none !important; }`);
});
