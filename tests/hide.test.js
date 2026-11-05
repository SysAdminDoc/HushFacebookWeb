// The hider against small HTML fixtures shaped like facebook.com's feed: posts are
// div[aria-posinset] under a plain feed div. The rule that matters most is that nothing is
// written on the post or on the feed's children, only on the post's first child.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { MARK, NOTE, createHider, hideCss } from '../src/core/dom/hide.js';
import { createPostTracker } from '../src/core/dom/posts.js';
import { createSettings } from '../src/core/settings.js';
import { createMemoryStorage } from '../src/core/storage.js';
import { renderFeatureCss } from '../src/core/style.js';
import { contrast } from '../src/features/appearance/accent.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

function page(html) {
  const win = testWindow('https://www.facebook.com/');
  windows.push(win);
  win.document.body.innerHTML = html;
  return win;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const post = (n, href = `/someone/posts/pfbid0Post${n}`) =>
  `<div class="wrap"><div aria-posinset="${n}"><div class="inner"><h4><a href="/someone">Someone</a></h4><a href="${href}">2h</a><div>Post number ${n}</div></div><div class="footer">Like</div></div></div>`;

const feed = (...posts) => `<div role="main"><div class="feed">${posts.join('')}</div></div>`;

const attributesOf = (element) => Object.fromEntries([...element.attributes].map((a) => [a.name, a.value]));

function fakePosts() {
  const listeners = { 'post/remove': new Set() };
  return {
    on(type, fn) {
      listeners[type].add(fn);
    },
    removed(element) {
      for (const fn of listeners['post/remove']) fn({ element });
    },
    count: (type) => listeners[type].size,
  };
}

// Splits "selector { body }" rules so the selectors can be run against the fixture.
const selectorsOf = (css) => css.split('\n').map((rule) => rule.slice(0, rule.indexOf(' {')));

test('hiding marks only the post\'s first child, never the post or the feed child', () => {
  const win = page(feed(post(1), post(2)));
  const [first] = win.document.querySelectorAll('[aria-posinset]');
  const feedChild = first.parentElement;
  const before = { post: attributesOf(first), feedChild: attributesOf(feedChild), feed: attributesOf(feedChild.parentElement) };
  const hider = createHider({ doc: win.document });

  assert.equal(hider.hide(first, 'Sponsored'), true);
  assert.equal(first.firstElementChild.getAttribute(MARK), 'Sponsored');
  assert.equal(first.firstElementChild.getAttribute(NOTE), 'Hidden: Sponsored. Show');
  assert.deepEqual(attributesOf(first), before.post);
  assert.deepEqual(attributesOf(feedChild), before.feedChild);
  assert.deepEqual(attributesOf(feedChild.parentElement), before.feed);
  assert.equal(win.document.querySelectorAll(`[${MARK}]`).length, 1);
  assert.equal(hider.isHidden(first), true);
});

test('the note names the detail when there is one', () => {
  const win = page(feed(post(1)));
  const element = win.document.querySelector('[aria-posinset]');
  createHider({ doc: win.document }).hide(element, 'Filter', 'cats');
  assert.equal(element.firstElementChild.getAttribute(NOTE), 'Hidden: Filter: cats. Show');
});

test('a post with nothing inside it is left alone', () => {
  const win = page(feed('<div aria-posinset="1"></div>'));
  const element = win.document.querySelector('[aria-posinset]');
  const hider = createHider({ doc: win.document });
  assert.equal(hider.hide(element, 'Sponsored'), false);
  assert.deepEqual(hider.counts(), {});
});

test('without notes the rule hides the whole post and nothing else', () => {
  const win = page(feed(post(1), post(2)));
  const [first, second] = win.document.querySelectorAll('[aria-posinset]');
  createHider({ doc: win.document }).hide(first, 'Sponsored');
  const [selector] = selectorsOf(hideCss({ notes: false }));
  assert.deepEqual([...win.document.querySelectorAll(selector)], [first]);
  assert.equal(second.matches(selector), false);
});

test('with notes the rules hide everything in the post except the note line', () => {
  const win = page(feed(post(1), post(2)));
  const [first] = win.document.querySelectorAll('[aria-posinset]');
  createHider({ doc: win.document }).hide(first, 'Sponsored');
  const css = hideCss({ notes: true });
  const [siblings, contents] = selectorsOf(css);
  const marker = first.firstElementChild;
  assert.deepEqual([...win.document.querySelectorAll(siblings)], [first.querySelector('.footer')]);
  assert.deepEqual([...win.document.querySelectorAll(contents)], [...marker.children]);
  assert.match(css, new RegExp(`\\[${MARK}\\]::before \\{ content: attr\\(${NOTE}\\)`));
});

test('counts go up once per post, per reason, and tell subscribers', () => {
  const win = page(feed(post(1), post(2), post(3)));
  const [a, b, c] = win.document.querySelectorAll('[aria-posinset]');
  const hider = createHider({ doc: win.document });
  let heard = 0;
  hider.subscribe(() => heard++);
  hider.hide(a, 'Sponsored');
  hider.hide(a, 'Sponsored');
  hider.hide(b, 'Sponsored');
  hider.hide(c, 'Suggested');
  hider.hide(c, 'Filter', 'cats');
  assert.deepEqual(hider.counts(), { Sponsored: 2, Suggested: 1 });
  assert.equal(hider.hiddenPosts(), 3);
  assert.equal(heard, 3);
});

test('a throwing subscriber is logged and the others still hear', () => {
  const win = page(feed(post(1)));
  const errors = [];
  const hider = createHider({ doc: win.document, log: { error: (message) => errors.push(message) } });
  let heard = 0;
  hider.subscribe(() => {
    throw new Error('boom');
  });
  hider.subscribe(() => heard++);
  hider.hide(win.document.querySelector('[aria-posinset]'), 'Sponsored');
  assert.equal(heard, 1);
  assert.deepEqual(errors, ['A hidden-post listener failed']);
});

test('a click on the note shows the post and Facebook never sees the click', () => {
  const win = page(feed(post(1)));
  const element = win.document.querySelector('[aria-posinset]');
  const hider = createHider({ doc: win.document });
  hider.hide(element, 'Sponsored');
  const marker = element.firstElementChild;
  const facebook = [];
  marker.addEventListener('click', () => facebook.push('target'));
  win.document.addEventListener('click', () => facebook.push('document'));

  const event = new win.MouseEvent('click', { bubbles: true, cancelable: true });
  assert.equal(hider.isRevealed(element), false);
  assert.equal(hider.canHide(element), true);
  marker.dispatchEvent(event);

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(facebook, []);
  assert.equal(hider.isHidden(element), false);
  assert.equal(hider.isRevealed(element), true);
  assert.equal(marker.hasAttribute(NOTE), false);
  assert.equal(hider.canHide(element), false, 'canHide says what hide() will do');
  assert.equal(hider.hide(element, 'Sponsored'), false, 'a shown post stays shown');
  assert.equal(hider.isHidden(element), false);
});

test('ordinary clicks inside posts pass through untouched', () => {
  const win = page(feed(post(1), post(2)));
  const [hidden, other] = win.document.querySelectorAll('[aria-posinset]');
  const hider = createHider({ doc: win.document });
  hider.hide(hidden, 'Sponsored');
  const link = other.querySelector('a');
  let reached = 0;
  link.addEventListener('click', () => reached++);
  const event = new win.MouseEvent('click', { bubbles: true, cancelable: true });
  link.dispatchEvent(event);
  assert.equal(reached, 1);
  assert.equal(event.defaultPrevented, false);
  assert.equal(hider.isHidden(hidden), true);
});

test('a block between posts that is not a post hides and shows its note the same way', () => {
  const win = page(feed(post(1), '<div class="row"><div class="shelf"><a href="/reel/1">r</a><a href="/reel/2">r</a></div></div>', post(2)));
  const row = win.document.querySelector('.row');
  const hider = createHider({ doc: win.document });
  assert.equal(hider.hide(row, 'Reels'), true);
  const [hidden] = selectorsOf(hideCss({ notes: false }));
  assert.deepEqual([...win.document.querySelectorAll(hidden)], [row], 'only the marked block, no post');
  const shelf = row.querySelector('.shelf');
  const event = new win.MouseEvent('click', { bubbles: true, cancelable: true });
  shelf.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true, 'a click on its note line brings it back');
  assert.equal(shelf.hasAttribute(MARK), false);
});

test('a mark this hider did not set is not treated as a note', () => {
  const win = page(`<div><span ${MARK}="Sponsored">x</span></div>`);
  createHider({ doc: win.document });
  const span = win.document.querySelector('span');
  const event = new win.MouseEvent('click', { bubbles: true, cancelable: true });
  span.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  assert.equal(span.hasAttribute(MARK), true);
});

test('show and showAll bring posts back by element and by reason', () => {
  const win = page(feed(post(1), post(2), post(3)));
  const [a, b, c] = win.document.querySelectorAll('[aria-posinset]');
  const hider = createHider({ doc: win.document });
  hider.hide(a, 'Sponsored');
  hider.hide(b, 'Sponsored');
  hider.hide(c, 'Suggested');
  hider.show(a);
  assert.equal(hider.isHidden(a), false);
  hider.showAll('Sponsored');
  assert.equal(hider.isHidden(b), false);
  assert.equal(hider.isHidden(c), true);
  assert.equal(hider.hide(a, 'Sponsored'), true, 'show() is not a reveal by the person');
});

test('a post hidden for two reasons stays hidden until both are taken off', () => {
  const win = page(feed(post(1)));
  const element = win.document.querySelector('[aria-posinset]');
  const hider = createHider({ doc: win.document });
  const mark = () => element.querySelector(`[${MARK}]`);
  hider.hide(element, 'Filter', 'cats');
  hider.hide(element, 'Seen');
  assert.equal(mark().getAttribute(MARK), 'Filter Seen');
  assert.equal(mark().getAttribute(NOTE), 'Hidden: Filter: cats. Show', 'the note names the first reason');
  hider.showAll('Filter');
  assert.equal(hider.isHidden(element), true, 'still seen');
  assert.equal(mark().getAttribute(NOTE), 'Hidden: Seen. Show');
  hider.hide(element, 'Filter', 'dogs');
  hider.showAll('Seen');
  assert.equal(mark().getAttribute(NOTE), 'Hidden: Filter: dogs. Show');
  hider.showAll('Filter');
  assert.equal(hider.isHidden(element), false);
  assert.deepEqual(hider.counts(), { Filter: 1 }, 'counted once, under the first reason');
});

test('show with a reason takes only that one off the one post', () => {
  const win = page(feed(post(1), post(2)));
  const [a, b] = win.document.querySelectorAll('[aria-posinset]');
  const hider = createHider({ doc: win.document });
  const mark = () => a.querySelector(`[${MARK}]`);
  hider.hide(a, 'Reels');
  hider.hide(a, 'Filter', 'cats');
  hider.hide(b, 'Reels');
  hider.show(a, 'Reels');
  assert.equal(mark().getAttribute(NOTE), 'Hidden: Filter: cats. Show');
  assert.equal(hider.isHidden(b), true, 'the other post keeps its reason');
  hider.show(a, 'Reels');
  hider.show(a, 'Filter');
  assert.equal(hider.isHidden(a), false);
  hider.show(a, 'Filter');
  assert.equal(hider.hide(a, 'Filter'), true, 'not a reveal by the person');
});

test('a recycled post forgets that it was shown and is cleared', () => {
  const win = page(feed(post(1)));
  const element = win.document.querySelector('[aria-posinset]');
  const posts = fakePosts();
  const hider = createHider({ doc: win.document, posts });
  assert.equal(posts.count('post/remove'), 0, 'subscribes only once something is hidden');
  hider.hide(element, 'Sponsored');
  hider.hide(element, 'Sponsored');
  assert.equal(posts.count('post/remove'), 1);
  element.firstElementChild.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(hider.hide(element, 'Sponsored'), false);

  // The tracker reports a recycle when the element starts showing a different story.
  element.querySelector('a[href*="/posts/"]').setAttribute('href', '/someone/posts/pfbid0Post9');
  posts.removed(element);
  assert.equal(hider.hide(element, 'Sponsored'), true);
  assert.deepEqual(hider.counts(), { Sponsored: 2 });

  posts.removed(element);
  assert.equal(hider.isHidden(element), false, 'what the old story had is wiped');
});

test('with the real post tracker, a recycled element is judged again', async () => {
  const win = page(feed(post(1)));
  const posts = createPostTracker({ doc: win.document });
  const hider = createHider({ doc: win.document, posts });
  const sponsored = new Set(['pfbid0Post1', 'pfbid0Post3']);
  const judge = ({ element, id }) => {
    if (sponsored.has(id)) hider.hide(element, 'Sponsored');
    else hider.show(element);
  };
  posts.on('post/add', judge);
  posts.on('post/update', judge);
  const element = win.document.querySelector('[aria-posinset]');
  assert.equal(hider.isHidden(element), true);

  element.querySelector('a[href*="posts"]').setAttribute('href', '/someone/posts/pfbid0Post2');
  await tick();
  assert.equal(hider.isHidden(element), false);

  element.querySelector('a[href*="posts"]').setAttribute('href', '/someone/posts/pfbid0Post3');
  await tick();
  assert.equal(hider.isHidden(element), true);
  assert.deepEqual(hider.counts(), { Sponsored: 2 });
  posts.stop();
});

test('the hiding rules ship while the script runs and follow the note setting', () => {
  const settings = createSettings({ storage: createMemoryStorage(), features: [] });
  const base = [{ id: 'hidden posts', css: (get) => hideCss({ notes: get('ui.hiddenNote') === true }) }];
  assert.equal(renderFeatureCss([], settings, undefined, base), `/* hidden posts */\n${hideCss({ notes: false })}`);
  settings.set('ui.hiddenNote', true);
  assert.equal(renderFeatureCss([], settings, undefined, base), `/* hidden posts */\n${hideCss({ notes: true })}`);
  settings.set('paused', true);
  assert.equal(renderFeatureCss([], settings, undefined, base), '');
});

test('a base style that throws is logged and the rest still render', () => {
  const settings = createSettings({ storage: createMemoryStorage(), features: [] });
  const errors = [];
  const base = [
    { id: 'broken', css: () => { throw new Error('no'); } },
    { id: 'fine', css: () => '.x{}' },
  ];
  assert.equal(renderFeatureCss([], settings, { error: (message) => errors.push(message) }, base), '/* fine */\n.x{}');
  assert.deepEqual(errors, ["The broken styles couldn't be built"]);
});

test('the mark is still found after Facebook puts something in front of it', () => {
  const win = page(feed(post(1)));
  const element = win.document.querySelector('[aria-posinset]');
  const hider = createHider({ doc: win.document });
  hider.hide(element, 'Sponsored');
  const marker = element.firstElementChild;
  element.prepend(win.document.createElement('header'));
  assert.equal(hider.isHidden(element), true);
  hider.hide(element, 'Sponsored');
  assert.equal(element.querySelectorAll(`[${MARK}]`).length, 1, 'hiding again never adds a second note');
  marker.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(hider.isHidden(element), false);
  assert.equal(element.querySelectorAll(`[${MARK}], [${NOTE}]`).length, 0);
});

test('show and showAll find a mark that moved', () => {
  const win = page(feed(post(1), post(2)));
  const [a, b] = win.document.querySelectorAll('[aria-posinset]');
  const hider = createHider({ doc: win.document });
  hider.hide(a, 'Sponsored');
  hider.hide(b, 'Sponsored');
  a.prepend(win.document.createElement('header'));
  b.prepend(win.document.createElement('header'));
  hider.show(a);
  assert.equal(a.querySelectorAll(`[${MARK}], [${NOTE}]`).length, 0);
  hider.showAll('Sponsored');
  assert.equal(b.querySelectorAll(`[${MARK}], [${NOTE}]`).length, 0);
});

test('while the note isn\'t on screen, clicks on a mark go to Facebook', () => {
  const win = page(feed(post(1)));
  const element = win.document.querySelector('[aria-posinset]');
  let shown = false;
  const hider = createHider({ doc: win.document, notesShown: () => shown });
  hider.hide(element, 'Sponsored');
  let reached = 0;
  element.firstElementChild.addEventListener('click', () => reached++);
  const event = new win.MouseEvent('click', { bubbles: true, cancelable: true });
  element.firstElementChild.dispatchEvent(event);
  assert.equal(reached, 1);
  assert.equal(event.defaultPrevented, false);
  assert.equal(hider.isHidden(element), true);
  shown = true;
  element.firstElementChild.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(hider.isHidden(element), false);
});

test('a post drawn again, or whose id turns up late, counts once', () => {
  const win = page(feed(post(1), '<div aria-posinset="2"><div><a href="#">2h</a><div>Lazy</div></div></div>'));
  const [first, lazy] = win.document.querySelectorAll('[aria-posinset]');
  const posts = fakePosts();
  const hider = createHider({ doc: win.document, posts });
  hider.hide(first, 'Sponsored');
  const list = first.parentElement;
  first.remove();
  posts.removed(first);
  list.prepend(first);
  hider.hide(first, 'Sponsored');
  hider.hide(lazy, 'Sponsored');
  lazy.querySelector('a').setAttribute('href', '/someone/posts/pfbid0Late');
  hider.hide(lazy, 'Sponsored');
  assert.deepEqual(hider.counts(), { Sponsored: 2 });
});

test('a post whose first child is an image or video is left alone', () => {
  const win = page(feed('<div aria-posinset="1"><img src="x.png" alt=""><a href="/a/posts/1">1h</a></div>'));
  const element = win.document.querySelector('[aria-posinset]');
  const hider = createHider({ doc: win.document });
  assert.equal(hider.hide(element, 'Sponsored'), false);
  assert.equal(win.document.querySelectorAll(`[${MARK}]`).length, 0);
});

test('an svg, style or template first child is refused too, since no note can draw there', () => {
  for (const first of ['<svg><path d="M0 0"></path></svg>', '<style>.x{}</style>', '<template></template>']) {
    const win = page(feed(`<div aria-posinset="1">${first}<a href="/a/posts/1">1h</a></div>`));
    const hider = createHider({ doc: win.document });
    assert.equal(hider.hide(win.document.querySelector('[aria-posinset]'), 'Sponsored'), false, first);
    assert.equal(win.document.querySelectorAll(`[${MARK}]`).length, 0, first);
  }
});

test('note mode hides loose text inside the mark too', () => {
  const css = hideCss({ notes: true });
  assert.ok(css.includes(`[${MARK}] { font-size: 0 !important; }`));
  assert.ok(!hideCss({ notes: false }).includes('font-size'));
});

const key = (win, target, type, name, init = {}) => {
  const event = new win.KeyboardEvent(type, { key: name, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};
const buttonParts = (element) => ['role', 'tabindex', 'aria-label'].map((name) => element.getAttribute(name));

// Behind a post: Facebook's white and grey light pages, and its dark ones.
const PAGES_BEHIND = ['#ffffff', '#f0f2f5', '#18191a', '#242526'];

test('the focus ring on a note and on Show hidden shows on a light page as well as a dark one', () => {
  const rules = [...hideCss({ notes: true }).matchAll(/:focus-visible \{([^}]*)\}/g)].map(([, body]) => body);
  assert.equal(rules.length, 2);
  for (const body of rules) {
    const ring = /outline: 2px solid (#[0-9a-f]{6})/.exec(body)?.[1];
    const offset = Number(/outline-offset: (\d+)px/.exec(body)?.[1]);
    const halo = /box-shadow: 0 0 0 (\d+)px (#[0-9a-f]{6})/.exec(body);
    assert.ok(ring && halo, `a ring and a dark halo: ${body}`);
    assert.ok(Number(halo[1]) >= offset + 2, 'the halo fills the gap and runs under the ring, so no page shows between');
    assert.ok(contrast(ring, halo[2]) >= 3, 'the ring reads on its halo');
    for (const behind of PAGES_BEHIND) {
      assert.ok(Math.max(contrast(ring, behind), contrast(halo[2], behind)) >= 3, `one of them reads on ${behind}`);
    }
  }
});

test('the note is a button keyboards and screen readers reach, and Enter shows the post', () => {
  const win = page(feed(post(1), post(2)));
  const [first] = win.document.querySelectorAll('[aria-posinset]');
  const before = { post: attributesOf(first), feedChild: attributesOf(first.parentElement) };
  const hider = createHider({ doc: win.document });
  hider.hide(first, 'Filter', 'cats');
  const marker = first.firstElementChild;
  assert.deepEqual(buttonParts(marker), ['button', '0', 'Hidden: Filter: cats. Show']);
  assert.deepEqual(attributesOf(first), before.post, 'the post itself is never written on');
  assert.deepEqual(attributesOf(first.parentElement), before.feedChild, "nor the feed's child");
  assert.match(hideCss({ notes: true }), new RegExp(`\\[${MARK}\\] \\{ display: flex !important;`), "Facebook's display:contents mark gets a box that can take focus");
  assert.match(hideCss({ notes: true }), new RegExp(`\\[${MARK}\\]:focus-visible \\{ outline:`));

  const facebook = [];
  marker.addEventListener('keydown', () => facebook.push('target'));
  win.document.addEventListener('keydown', () => facebook.push('document'));
  marker.focus();
  assert.equal(key(win, marker, 'keydown', 'Enter', { ctrlKey: true }).defaultPrevented, false, 'Ctrl+Enter stays the page\'s');
  assert.equal(hider.isHidden(first), true);
  facebook.length = 0;
  const enter = key(win, marker, 'keydown', 'Enter');
  assert.equal(enter.defaultPrevented, true);
  assert.deepEqual(facebook, []);
  assert.equal(hider.isHidden(first), false);
  assert.deepEqual(buttonParts(marker), [null, null, null], 'the button goes with the note');
  assert.ok(win.document.activeElement === first.querySelector('h4 a'), 'focus moves to the first control the post brings back');
  assert.equal(key(win, win.document.activeElement, 'keydown', 'Enter').defaultPrevented, false, 'it shows once; the next Enter is the link\'s');
  assert.equal(hider.hide(first, 'Filter', 'cats'), false, 'a shown post stays shown');
});

test('Space shows the post as it comes up, and only on the note it went down on', () => {
  const win = page(feed(post(1), post(2)));
  const [a, b] = win.document.querySelectorAll('[aria-posinset]');
  const hider = createHider({ doc: win.document });
  hider.hide(a, 'Sponsored');
  hider.hide(b, 'Sponsored');
  const [markA, markB] = [a.firstElementChild, b.firstElementChild];
  // The name link isn't drawn (Facebook keeps some controls in the page but off screen).
  a.querySelector('h4 a').getClientRects = () => [];
  markA.focus();
  assert.equal(key(win, markA, 'keydown', ' ').defaultPrevented, true, 'the page does not scroll');
  assert.equal(hider.isHidden(a), true, 'not yet');
  assert.equal(key(win, markA, 'keyup', ' ').defaultPrevented, true);
  assert.equal(hider.isHidden(a), false);
  assert.ok(win.document.activeElement === a.querySelector('a[href*="/posts/"]'), 'focus skips a control that is not drawn');

  markB.focus();
  key(win, markB, 'keydown', ' ');
  key(win, a.querySelector('h4 a'), 'keyup', ' ');
  assert.equal(hider.isHidden(b), true, 'let go somewhere else');
  assert.equal(key(win, markB, 'keyup', ' ').defaultPrevented, false, 'and the press is spent');
  assert.equal(hider.isHidden(b), true);

  // The name link is drawn but won't take focus (visibility:hidden does that).
  b.querySelector('h4 a').focus = () => {};
  markB.focus();
  key(win, markB, 'keydown', 'Enter');
  assert.ok(win.document.activeElement === b.querySelector('a[href*="/posts/"]'), 'a control that refuses focus is passed over');
});

test('a note with nothing focusable behind it keeps focus on the mark, given a box, until focus moves on', () => {
  const words = '<div class="wrap"><div aria-posinset="N"><div class="inner"><div>Just text</div></div></div></div>';
  const win = page(feed(words.replace('N', '1'), words.replace('N', '2').replace('class="inner"', 'class="inner" tabindex="-1"')));
  const [element, other] = win.document.querySelectorAll('[aria-posinset]');
  const hider = createHider({ doc: win.document });
  hider.hide(element, 'Sponsored');
  hider.hide(other, 'Sponsored');
  // Without its mark the wrapper is display:contents again, and a browser takes focus off it.
  // happy-dom doesn't.
  const fixup = (marker) => {
    const remove = marker.removeAttribute.bind(marker);
    marker.removeAttribute = (name) => {
      remove(name);
      if (name === MARK) marker.blur();
    };
  };
  const marker = element.firstElementChild;
  fixup(marker);
  marker.focus();
  key(win, marker, 'keydown', 'Enter');
  assert.equal(hider.isHidden(element), false);
  assert.ok(win.document.activeElement === marker);
  assert.deepEqual([marker.getAttribute('tabindex'), marker.hasAttribute('data-hfw-held')], ['-1', true]);
  assert.ok(hideCss({ notes: true }).includes('[data-hfw-held] { display: block !important; }'), 'Facebook\'s display:contents wrapper gets a box to keep focus on');
  marker.blur();
  assert.deepEqual([marker.hasAttribute('tabindex'), marker.hasAttribute('data-hfw-held')], [false, false]);

  // When focus won't stay anyway, nothing is left behind on Facebook's element.
  const stuck = other.firstElementChild;
  fixup(stuck);
  stuck.focus();
  stuck.focus = () => {};
  key(win, stuck, 'keydown', 'Enter');
  assert.equal(hider.isHidden(other), false);
  assert.deepEqual([stuck.getAttribute('tabindex'), stuck.hasAttribute('data-hfw-held')], ['-1', false], 'the page\'s own tabindex comes back');
});

test('pausing or switching the note off takes the button back off and puts back the page\'s own values', () => {
  const win = page(feed('<div class="wrap"><div aria-posinset="1"><div class="inner" role="none"><a href="/a/posts/1">1h</a></div></div></div>', post(2)));
  const [first, second] = win.document.querySelectorAll('[aria-posinset]');
  let shown = true;
  const hider = createHider({ doc: win.document, notesShown: () => shown });
  hider.hide(first, 'Sponsored');
  const marker = first.firstElementChild;
  assert.deepEqual(buttonParts(marker), ['button', '0', 'Hidden: Sponsored. Show']);
  hider.hide(first, 'Filter', 'cats');
  hider.refresh();
  // Someone else's element carrying the mark, like a second copy of the script's.
  win.document.body.insertAdjacentHTML('beforeend', `<div class="foreign" ${MARK}="x">not ours</div>`);
  hider.refresh();
  assert.deepEqual(buttonParts(win.document.querySelector('.foreign')), [null, null, null], 'only the script\'s own marks become buttons');

  shown = false;
  hider.refresh();
  assert.deepEqual(buttonParts(marker), ['none', null, null], 'the page\'s values, even after the button was written twice');
  marker.focus();
  assert.equal(key(win, marker, 'keydown', 'Enter').defaultPrevented, false, 'a paused script takes no keys');
  assert.equal(hider.isHidden(first), true);
  hider.hide(second, 'Sponsored');
  assert.deepEqual(buttonParts(second.firstElementChild), [null, null, null], 'hidden while the note is off: no button');

  shown = true;
  hider.refresh();
  assert.deepEqual(buttonParts(marker), ['button', '0', 'Hidden: Sponsored. Show']);
  assert.deepEqual(buttonParts(second.firstElementChild), ['button', '0', 'Hidden: Sponsored. Show']);
  hider.show(first);
  assert.deepEqual(buttonParts(marker), ['none', null, null]);
});

test('a click on the note shows the post and leaves focus where it was', () => {
  const win = page(feed(post(1), post(2)));
  const [a, b] = win.document.querySelectorAll('[aria-posinset]');
  const hider = createHider({ doc: win.document });
  hider.hide(a, 'Sponsored');
  const elsewhere = b.querySelector('h4 a');
  elsewhere.focus();
  a.firstElementChild.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(hider.isHidden(a), false);
  assert.ok(win.document.activeElement === elsewhere);
});

test('a recycled post loses the note\'s button and its reveal', () => {
  const win = page(feed(post(1)));
  const element = win.document.querySelector('[aria-posinset]');
  const posts = fakePosts();
  const hider = createHider({ doc: win.document, posts });
  hider.hide(element, 'Sponsored');
  const marker = element.firstElementChild;
  marker.focus();
  key(win, marker, 'keydown', 'Enter');
  assert.equal(hider.hide(element, 'Sponsored'), false);
  posts.removed(element);
  assert.equal(hider.hide(element, 'Sponsored'), true, 'the new story is judged on its own');
  assert.deepEqual(buttonParts(marker), ['button', '0', 'Hidden: Sponsored. Show']);
  posts.removed(element);
  assert.deepEqual(buttonParts(marker), [null, null, null]);
});

// The rule that draws Show hidden on the mark's first element.
const showAllSelector = () => selectorsOf(hideCss({ notes: true })).find((selector) => selector.includes(':first-child:not('));
const press = (win, target) => {
  const event = new win.MouseEvent('click', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
};

test('the note\'s Show hidden is a button of its own while the note shows, and goes back with it', () => {
  const win = page(feed(
    post(1),
    '<div class="wrap"><div aria-posinset="2"><div class="inner"><div class="head" role="heading" aria-label="Page"><a href="/b">B</a></div><a href="/b/posts/2">1h</a></div></div></div>',
    '<div class="wrap"><div aria-posinset="3"><div class="inner"><img src="x.png" alt=""><a href="/c/posts/3">1h</a></div></div></div>',
  ));
  const [a, b, c] = win.document.querySelectorAll('[aria-posinset]');
  const posts = fakePosts();
  let shown = true;
  const hider = createHider({ doc: win.document, posts, notesShown: () => shown });
  for (const element of [a, b, c]) hider.hide(element, 'Sponsored');
  const [allA, allB, image] = [a, b, c].map((element) => element.firstElementChild.firstElementChild);
  assert.deepEqual(buttonParts(allA), ['button', '0', 'Show hidden']);
  assert.deepEqual(buttonParts(allB), ['button', '0', 'Show hidden']);
  assert.deepEqual(buttonParts(image), [null, null, null], 'an image can\'t draw the label, so its note has none');
  const drawn = [...win.document.querySelectorAll(showAllSelector())];
  assert.equal(drawn.length, 2);
  assert.ok(drawn[0] === allA && drawn[1] === allB, 'the rule draws it on the same elements');
  assert.match(hideCss({ notes: true }), /::before \{ all: unset !important; content: "Show hidden" !important;/);
  assert.ok(!hideCss({ notes: false }).includes('Show hidden'));

  shown = false;
  hider.refresh();
  assert.deepEqual(buttonParts(allA), [null, null, null]);
  assert.deepEqual(buttonParts(allB), ['heading', null, 'Page'], 'the page\'s own values come back');
  let reached = 0;
  allA.addEventListener('click', () => reached++);
  assert.equal(press(win, allA).defaultPrevented, false, 'a paused script leaves the click to Facebook');
  assert.equal(reached, 1);
  assert.equal(hider.isHidden(a), true);

  shown = true;
  hider.refresh();
  assert.deepEqual(buttonParts(allB), ['button', '0', 'Show hidden']);
  // Facebook puts a new element in front.
  const fresh = win.document.createElement('div');
  b.firstElementChild.prepend(fresh);
  hider.refresh();
  assert.deepEqual(buttonParts(allB), ['heading', null, 'Page'], 'the old one is put back as it was');
  assert.deepEqual(buttonParts(fresh), ['button', '0', 'Show hidden']);

  hider.show(a);
  assert.deepEqual(buttonParts(allA), [null, null, null]);
  posts.removed(b);
  assert.deepEqual(buttonParts(fresh), [null, null, null], 'a recycled post gives it back too');

  // Someone else's element carrying the mark.
  win.document.body.insertAdjacentHTML('beforeend', `<div class="foreign" ${MARK}="x"><div class="kid">not ours</div></div>`);
  hider.refresh();
  assert.deepEqual(buttonParts(win.document.querySelector('.kid')), [null, null, null]);
  assert.equal(press(win, win.document.querySelector('.kid')).defaultPrevented, false);
});

test('a click on Show hidden shows every hidden post, leaves focus where it was, and later posts still hide', () => {
  const win = page(feed(post(1), post(2), post(3), post(4)));
  const [a, b, c, d] = win.document.querySelectorAll('[aria-posinset]');
  const hider = createHider({ doc: win.document });
  hider.hide(a, 'Sponsored');
  hider.hide(b, 'Filter', 'cats');
  hider.hide(c, 'Suggested');
  win.document.body.insertAdjacentHTML('beforeend', `<div class="foreign" ${MARK}="x"><div>not ours</div></div>`);
  const elsewhere = d.querySelector('h4 a');
  elsewhere.focus();
  const facebook = [];
  const allB = b.firstElementChild.firstElementChild;
  allB.addEventListener('click', () => facebook.push('target'));
  win.document.addEventListener('click', () => facebook.push('document'));

  assert.equal(press(win, allB).defaultPrevented, true);
  assert.deepEqual(facebook, [], 'Facebook never hears it');
  assert.deepEqual([a, b, c].map((element) => hider.isHidden(element)), [false, false, false]);
  assert.deepEqual([a, b, c].map((element) => hider.isRevealed(element)), [true, true, true]);
  assert.equal(win.document.querySelector('.foreign').getAttribute(MARK), 'x', 'only the script\'s own marks are taken off');
  assert.ok(win.document.activeElement === elsewhere);
  assert.deepEqual(buttonParts(allB), [null, null, null]);
  assert.deepEqual(hider.counts(), { Sponsored: 1, Filter: 1, Suggested: 1 }, 'what was hidden still counts');

  assert.equal(hider.hide(b, 'Filter', 'cats'), false, 'a shown post stays shown');
  assert.equal(hider.hide(d, 'Sponsored'), true, 'a post that comes along later is still hidden');
  assert.equal(press(win, elsewhere).defaultPrevented, false, 'the link inside is the page\'s again');
});

test('Enter or Space on Show hidden shows them all and moves focus into its own post', () => {
  for (const name of ['Enter', ' ']) {
    const win = page(feed(post(1), post(2)));
    const [a, b] = win.document.querySelectorAll('[aria-posinset]');
    const hider = createHider({ doc: win.document });
    hider.hide(a, 'Sponsored');
    hider.hide(b, 'Sponsored');
    const allB = b.firstElementChild.firstElementChild;
    allB.focus();
    assert.equal(key(win, allB, 'keydown', name, { ctrlKey: true }).defaultPrevented, false, `Ctrl+${name} stays the page's`);
    assert.equal(key(win, allB, 'keydown', name).defaultPrevented, true);
    if (name === ' ') {
      assert.equal(hider.isHidden(a), true, 'Space waits for the key to come up');
      assert.equal(key(win, allB, 'keyup', name).defaultPrevented, true);
    }
    assert.deepEqual([hider.isHidden(a), hider.isHidden(b)], [false, false], name);
    assert.ok(win.document.activeElement === b.querySelector('h4 a'), `${name}: focus goes to the first control in its post`);
  }
});
