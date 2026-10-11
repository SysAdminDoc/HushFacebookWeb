// Hide Stories tray against Home's top block as it was drawn live on 2026-10-11 (structure
// only, from the harness's anatomy probe), with Facebook's top bar beside the page as it is
// live: the bar's next sibling holds everything else.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import hideStoriesTray, { COMPOSER_MARK, COMPOSER_SELECTORS, composerBlock, TRAY_SELECTORS } from '../src/features/feed/hide-stories-tray.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const FEED = `<div class="feed"><h3>Feed posts</h3>
  <div><div aria-posinset="1"><h4><a href="/a">A</a></h4><a href="/a/posts/1">1h</a></div></div></div>`;
const TOP = (feed = FEED) => `
  <div role="banner" class="banner"><a href="/">Facebook</a><div role="navigation"><a href="/friends/">Find friends</a></div></div>
  <div class="page"><div role="main"><div class="column">
    <div class="empty"></div>
    <div class="composer-block"><div><div><div role="region" aria-label="Create a post"><h3>Create a post</h3><div role="button">What's on your mind?</div></div></div></div></div>
    <div class="tray-block"><div><div><div data-virtualized="false" class="tray-virtual"><div><div role="region" aria-label="Stories" data-focus-target="stories_tray" data-visualcompletion="ignore-dynamic" style="min-height:160px">
      <h3>Stories</h3><div role="grid" aria-label="stories tray"><a href="/stories/create/">Create story</a><a aria-label="Someone's story" href="/stories/123/">S</a></div>
    </div></div></div></div></div></div>
    ${feed}
  </div></div></div>`;

function page(html, route = 'home') {
  const win = new Window({ url: 'https://www.facebook.com/' });
  windows.push(win);
  win.document.documentElement.dataset.hfwRoute = route;
  win.document.body.innerHTML = html;
  return win;
}

const matches = (win, selectors) => selectors.flatMap((selector) => [...win.document.querySelectorAll(selector)]).map((element) => element.className || element.getAttribute('aria-label'));
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the tray and its own virtual block are hidden, nothing that holds a post', () => {
  const win = page(TOP());
  assert.deepEqual(matches(win, TRAY_SELECTORS).sort(), ['Stories', 'tray-virtual']);
});

test('the composer block is the one right before the Stories block, never the top bar', () => {
  const win = page(TOP());
  assert.equal(composerBlock(win.document)?.className, 'composer-block');
  // Until the feed has a post, there's no column to go by, so nothing is taken.
  assert.equal(composerBlock(page(TOP('<div class="feed"></div>')).document), null);
  assert.equal(composerBlock(page('<div role="banner"></div><div><div role="region" data-focus-target="stories_tray"></div></div>').document), null);
});

test('the marked composer and the English label are hidden, only on Home', () => {
  const win = page(TOP());
  win.document.querySelector('.composer-block').setAttribute(COMPOSER_MARK, '');
  assert.deepEqual(matches(win, COMPOSER_SELECTORS).sort(), ['Create a post', 'composer-block']);
  for (const route of ['profile', 'groups', 'stories']) {
    const other = page(TOP(), route);
    other.document.querySelector('.composer-block').setAttribute(COMPOSER_MARK, '');
    assert.deepEqual(matches(other, [...TRAY_SELECTORS, ...COMPOSER_SELECTORS]), [], route);
  }
});

test('setup marks the composer once the feed is drawn, in any language', async () => {
  const win = page(TOP('<div class="feed"></div>').replace('aria-label="Create a post"', 'aria-label="Créer une publication"'));
  const doc = win.document;
  let composer = true;
  hideStoriesTray.setup({ doc, win, option: () => composer, enabled: () => true });
  assert.equal(doc.querySelector(`[${COMPOSER_MARK}]`), null);
  doc.querySelector('.feed').innerHTML = '<div><div aria-posinset="1"><a href="/a/posts/1">1h</a></div></div>';
  await tick(300);
  assert.deepEqual([...doc.querySelectorAll(`[${COMPOSER_MARK}]`)].map((e) => e.className), ['composer-block']);
  assert.equal(doc.querySelector('.banner').hasAttribute(COMPOSER_MARK), false);
  composer = false;
});

test('the composer stays when its option is off', () => {
  const settings = { 'hideStoriesTray.composer': true };
  const get = (key) => settings[key];
  assert.ok(hideStoriesTray.css(get).includes('Create a post'));
  settings['hideStoriesTray.composer'] = false;
  const css = hideStoriesTray.css(get);
  assert.ok(!css.includes('Create a post') && !css.includes(COMPOSER_MARK));
  assert.ok(css.includes('stories_tray'));
  assert.ok(!css.includes(':has(+'), 'no sibling rule that could reach the top bar');
  assert.match(css, /\{ display: none !important; \}$/);
});
