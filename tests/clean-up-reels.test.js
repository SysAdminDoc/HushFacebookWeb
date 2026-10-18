// Clean up Reels, against the reel viewer as drawn live (runs 54 and 56). The author's name is
// made up.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import cleanUpReels, { CLEAN_REELS_CSS, createReelCleaner, MARK, markReels } from '../src/features/reels/clean-up-reels.js';

const REEL = (follow = 'Follow Pat Example Page') => `
  <div id="viewer">
    <div><video></video></div>
    <div><div id="player" role="group" aria-label="Video player" style="position:absolute">
      <div role="button" aria-label="Unmute"></div>
      <div role="button" aria-label="Search Reel"></div>
      <div><div id="overlay" style="position:absolute">
        <div style="position:static"><div>
          <h2><span><a href="/profile.php" role="link" aria-label="Pat Example Page, see owner profile">Pat Example Page</a></span></h2>
        </div>
        <div><span><span role="button" aria-label="Shared with Public"></span></span></div>
        <div id="follow-row"><div><span><span>&nbsp;</span><span aria-hidden="true"> · </span></span></div>
          <div><span><span><div id="follow" role="button" aria-label="${follow}" tabindex="0">Follow</div></span></span></div></div>
        </div>
        <div id="caption"><span>A made-up caption</span><div role="button">See more</div></div>
      </div></div>
      <div role="slider" aria-label="Change Position"></div>
    </div></div>
  </div>`;

const styleOf = (element) => ({ position: element.style?.position ?? '' });

function page(html) {
  const win = testWindow('https://www.facebook.com/reel/1');
  win.document.body.innerHTML = html;
  return win.document;
}

const marked = (doc) => Object.fromEntries([...doc.querySelectorAll(`[${MARK}]`)].map((el) => [el.getAttribute(MARK), el.id]));

test("the player, the block over the video and the Follow button with its dot are marked", () => {
  const doc = page(REEL());
  assert.equal(markReels(doc, styleOf), 3);
  assert.deepEqual(marked(doc), { player: 'player', overlay: 'overlay', follow: 'follow-row' });
  assert.equal(markReels(doc, styleOf), 0, 'marking again adds nothing');
});

test('the Follow button is found by the name in its label, whatever the language', () => {
  const doc = page(REEL('Seguir a Pat Example Page'));
  markReels(doc, styleOf);
  assert.equal(marked(doc).follow, 'follow-row');
});

test("the Follow button nearest the name wins over another button with the name in it, and its dot goes with it", () => {
  const doc = page(REEL());
  const other = doc.createElement('div');
  other.setAttribute('role', 'button');
  other.setAttribute('aria-label', 'More options for Pat Example Page');
  doc.querySelector('[aria-label="Search Reel"]').after(other);
  doc.getElementById('follow').innerHTML = '<span aria-hidden="true"><i></i></span>Follow';
  markReels(doc, styleOf);
  assert.equal(other.hasAttribute(MARK), false);
  assert.equal(marked(doc).follow, 'follow-row', "an icon inside the button isn't taken for the dot");
});

test('no Follow button, or one labeled with the name alone, leaves the row alone', () => {
  const doc = page(REEL('Pat Example Page'));
  markReels(doc, styleOf);
  assert.deepEqual(marked(doc), { player: 'player', overlay: 'overlay' });
});

test('a heading in a group with no video beside it is not a reel', () => {
  const doc = page('<div><div role="group"><div style="position:absolute"><h2><a href="/x">Pat Example Page</a></h2><div role="button" aria-label="Follow Pat Example Page">Follow</div></div></div></div>');
  assert.equal(markReels(doc, styleOf), 0);
});

test('headings in a box that holds a video and other headings are not a reel', () => {
  const card = '<div role="group"><div style="position:absolute"><h2><a href="/x">Pat Example Page</a></h2></div></div>';
  const doc = page(`<div><video></video>${card}${card}</div>`);
  assert.equal(markReels(doc, styleOf), 0);
  const far = page(`<div><video></video><div><div><div>${card}</div></div></div></div>`);
  assert.equal(markReels(far, styleOf), 0, 'a video more than three levels up is not the reel');
});

test('the CSS hides the Follow button and fades the block until the reel is pointed at, each by its own choice', () => {
  const both = CLEAN_REELS_CSS(() => true);
  assert.match(both, new RegExp(`\\[${MARK}="follow"\\] \\{ display: none !important; \\}`));
  assert.match(both, new RegExp(`\\[${MARK}="player"\\]:not\\(:hover\\) \\[${MARK}="overlay"\\] \\{ opacity: 0 !important; \\}`));
  assert.match(both, /^@media \(hover: hover\) \{\n[^@]*opacity: 0[^@]*\n\}$/m, 'only where something can hover, so a touch screen keeps the caption');
  assert.doesNotMatch(CLEAN_REELS_CSS((key) => key === 'cleanUpReels.follow'), /opacity/);
  assert.doesNotMatch(CLEAN_REELS_CSS((key) => key === 'cleanUpReels.caption'), /display: none/);
  assert.equal(CLEAN_REELS_CSS(() => false), '');
  const doc = page(REEL());
  markReels(doc, styleOf);
  assert.equal(doc.querySelectorAll(`[${MARK}="follow"]`)[0].contains(doc.getElementById('follow')), true);
  assert.equal(doc.querySelector(`[${MARK}="overlay"]`).contains(doc.getElementById('caption')), true);
});

test('a reel that comes in later is marked once the page settles, and nothing with the switch off', async () => {
  const doc = page('<div id="host"></div>');
  const timers = [];
  let on = true;
  const cleaner = createReelCleaner({ doc, enabled: () => on, styleOf, setTimer: (fn) => timers.push(fn) });
  cleaner.start();
  doc.getElementById('host').innerHTML = REEL();
  await new Promise((resolve) => setTimeout(resolve, 0));
  timers.shift()();
  assert.equal(cleaner.marked(), 3);
  on = false;
  doc.getElementById('host').innerHTML = REEL();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(timers.length, 0);
  cleaner.sync();
  assert.deepEqual(marked(doc), {});
});

test('the switch starts off, sits with Reels and works without the page', () => {
  assert.equal(cleanUpReels.default, false);
  assert.equal(cleanUpReels.section, 'reels');
  assert.equal(cleanUpReels.needsPage, undefined);
  assert.deepEqual(cleanUpReels.options.map((option) => [option.key, option.default]), [['follow', true], ['caption', true]]);
});
