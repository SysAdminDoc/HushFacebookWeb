// The hider against small HTML fixtures shaped like facebook.com's feed: posts are
// div[aria-posinset] under a plain feed div. The rule that matters most is that nothing is
// written on the post or on the feed's children, only on the post's first child.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { MARK, NOTE, OWN, OWN_REASONS, createHider, hideCss } from '../src/core/dom/hide.js';
import { NOTE_COLORS } from '../src/core/dom/note-colors.js';
import { createPostTracker } from '../src/core/dom/posts.js';
import { setLanguage, t } from '../src/core/i18n.js';
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
  const listeners = { 'post/add': new Set(), 'post/update': new Set(), 'post/remove': new Set() };
  return {
    on(type, fn) {
      listeners[type].add(fn);
    },
    added(element) {
      for (const fn of listeners['post/add']) fn({ element });
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

test('a reason can go by a longer name in the note and keep its one word in the mark', () => {
  const win = page(feed(post(1), post(2)));
  const [first, second] = win.document.querySelectorAll('[aria-posinset]');
  const hider = createHider({ doc: win.document });
  hider.hide(first, 'People', undefined, undefined, 'People you may know');
  assert.equal(first.firstElementChild.getAttribute(MARK), 'People');
  assert.equal(first.firstElementChild.getAttribute(NOTE), 'Hidden: People you may know. Show');
  hider.hide(second, 'Suggested');
  hider.showAll('People');
  assert.equal(hider.isHidden(first), false, 'its own Show all brings it back');
  assert.equal(hider.isHidden(second), true, 'and leaves the other reason alone');
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
  const base = [{ id: 'hidden posts', css: (get) => hideCss({ notes: get('ui.hiddenNote') }) }];
  assert.equal(renderFeatureCss([], settings, undefined, base), `/* hidden posts */\n${hideCss({ notes: false })}`);
  settings.set('ui.hiddenNote', OWN);
  assert.equal(renderFeatureCss([], settings, undefined, base), `/* hidden posts */\n${hideCss({ notes: OWN })}`);
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

// Overview's Show them follows hiddenNow, so every mark that goes on or comes off is heard, even
// when no count moves.
test('subscribers hear every mark go on or come off, not only new counts', () => {
  const win = page(feed(post(1), post(2), post(3)));
  const [a, b, c] = win.document.querySelectorAll('[aria-posinset]');
  const posts = fakePosts();
  const hider = createHider({ doc: win.document, posts });
  let heard = 0;
  hider.subscribe(() => heard++);
  hider.hide(a, 'Sponsored');
  hider.hide(b, 'Filter', 'cats');
  hider.hide(c, 'Seen');
  assert.equal(heard, 3);

  hider.hide(a, 'Filter', 'cats');
  assert.equal(heard, 3, 'another reason on a post already hidden changes nothing');
  hider.show(a, 'Filter');
  assert.equal(heard, 3, 'and neither does taking it off again');
  hider.show(a);
  assert.equal(heard, 4, 'the mark came off');
  assert.equal(hider.hiddenNow(), 2);
  hider.show(a);
  assert.equal(heard, 4, 'nothing to take off');

  hider.showAll('Filter');
  assert.equal(heard, 5, 'showAll is heard once');
  assert.equal(hider.hiddenNow(), 1);
  hider.showAll('Filter');
  assert.equal(heard, 5);

  // Facebook draws the same post again in a new element: no new count, but a new mark.
  const again = win.document.createElement('div');
  again.innerHTML = post(1);
  win.document.querySelector('.feed').append(again);
  hider.hide(again.querySelector('[aria-posinset]'), 'Sponsored');
  assert.deepEqual(hider.counts(), { Sponsored: 1, Filter: 1, Seen: 1 });
  assert.equal(heard, 6);
  assert.equal(hider.hiddenNow(), 2);

  // A hidden post that leaves the page takes its mark along.
  c.remove();
  posts.removed(c);
  assert.equal(heard, 7);
  assert.equal(hider.hiddenNow(), 1);
  posts.removed(a);
  assert.equal(heard, 7, 'a post with no mark leaving is not news');

  // Facebook puts the hidden one back, mark and all.
  win.document.querySelector('.feed').append(c);
  posts.added(c);
  assert.equal(heard, 8, 'its mark is on the page again');
  assert.equal(hider.hiddenNow(), 2);
  posts.added(c);
  posts.added(a);
  assert.equal(heard, 8, 'a post already back, or one that left with no mark, is not news');
});

test('with the real post tracker, a hidden post Facebook takes off and puts back is heard both times', async () => {
  const win = page(feed(post(1), post(2)));
  const posts = createPostTracker({ doc: win.document });
  const hider = createHider({ doc: win.document, posts });
  // Like the feed features, this hides it again when it comes back, which counts nothing new.
  posts.on('post/add', ({ element, id }) => {
    if (id === 'pfbid0Post1') hider.hide(element, 'Sponsored');
  });
  const element = win.document.querySelector('[aria-posinset]');
  assert.equal(hider.hiddenNow(), 1);
  let heard = 0;
  hider.subscribe(() => heard++);

  element.remove();
  await tick();
  assert.deepEqual([heard, hider.hiddenNow()], [1, 0]);
  win.document.querySelector('.feed').prepend(element);
  await tick();
  assert.deepEqual([heard, hider.hiddenNow()], [2, 1]);
  assert.deepEqual(hider.counts(), { Sponsored: 1 });
  assert.deepEqual(hider.revealEvery(), { posts: 1, comments: 0 });
  posts.stop();
});

test('with the real post tracker, a hidden post with no id yet that Facebook takes off and puts back counts once', async () => {
  const lazy = '<div aria-posinset="2"><div><a href="#">2h</a><div>Lazy</div></div></div>';
  const win = page(feed(post(1), lazy));
  const posts = createPostTracker({ doc: win.document });
  const hider = createHider({ doc: win.document, posts });
  // Hidden by what it says, the way a word filter goes, so its missing id doesn't matter.
  posts.on('post/add', ({ element }) => {
    if (element.textContent.includes('Lazy')) hider.hide(element, 'Filter');
  });
  const element = win.document.querySelectorAll('[aria-posinset]')[1];
  const list = win.document.querySelector('.feed');
  assert.equal(hider.isHidden(element), true);
  for (let away = 0; away < 2; away++) {
    element.remove();
    await tick();
    list.append(element);
    await tick();
    assert.equal(hider.isHidden(element), true);
  }
  // Its link filled in while it was off the page: the tracker would call that the same story too.
  element.remove();
  await tick();
  element.querySelector('a').setAttribute('href', '/someone/posts/pfbid0Late');
  list.append(element);
  await tick();
  assert.deepEqual(hider.counts(), { Filter: 1 });
  assert.equal(hider.hiddenPosts(), 1);
  posts.stop();
});

test('with the real post tracker, a post that comes back before its link fills in, or with a better link, is the post it was', async () => {
  // A comment link is all it has at first, which still names the post by the comment's id.
  const named = '<div aria-posinset="2"><div><a href="/photo/?fbid=7&comment_id=55">1h</a><div>Named by a comment</div></div></div>';
  const win = page(feed(post(1), named));
  const posts = createPostTracker({ doc: win.document });
  const hider = createHider({ doc: win.document, posts });
  posts.on('post/add', ({ element }) => {
    if (/Post number 1|Named by a comment/.test(element.textContent)) hider.hide(element, 'Filter');
  });
  const [first, second] = win.document.querySelectorAll('[aria-posinset]');
  const list = win.document.querySelector('.feed');
  assert.deepEqual(hider.counts(), { Filter: 2 });

  // Facebook draws the link again later, so for a moment the post has none.
  first.remove();
  await tick();
  const link = first.querySelector('a[href*="/posts/"]');
  link.setAttribute('href', '#');
  list.append(first);
  await tick();
  assert.equal(hider.isHidden(first), true);

  // The post's own link turns up beside the comment's while it's away.
  second.remove();
  await tick();
  second.querySelector('a').insertAdjacentHTML('afterend', '<a href="/someone/posts/pfbid0Named">2h</a>');
  list.append(second);
  await tick();
  assert.equal(hider.isHidden(second), true);
  assert.deepEqual(hider.counts(), { Filter: 2 });
  posts.stop();
});

test('with the real post tracker, an element Facebook takes off and puts back showing another story counts again', async () => {
  const win = page(feed(post(1), post(2)));
  const posts = createPostTracker({ doc: win.document });
  const hider = createHider({ doc: win.document, posts });
  const sponsored = new Set(['pfbid0Post1', 'pfbid0Post3']);
  posts.on('post/add', ({ element, id }) => {
    if (sponsored.has(id)) hider.hide(element, 'Sponsored');
    else hider.show(element);
  });
  const element = win.document.querySelector('[aria-posinset]');
  const list = win.document.querySelector('.feed');
  const link = () => element.querySelector('a[href*="/posts/"]');
  assert.deepEqual(hider.counts(), { Sponsored: 1 });

  // React reused it while it was off the page.
  element.remove();
  await tick();
  link().setAttribute('href', '/someone/posts/pfbid0Post3');
  list.prepend(element);
  await tick();
  assert.equal(hider.isHidden(element), true);
  assert.deepEqual(hider.counts(), { Sponsored: 2 });

  // Back as a story that isn't hidden, off again, and hidden the next time it's back: it's still
  // a story other than the one it counted as.
  element.remove();
  await tick();
  link().setAttribute('href', '/someone/posts/pfbid0Post4');
  list.prepend(element);
  await tick();
  assert.equal(hider.isHidden(element), false);
  element.remove();
  await tick();
  sponsored.add('pfbid0Post4');
  list.prepend(element);
  await tick();
  assert.equal(hider.isHidden(element), true);
  assert.deepEqual(hider.counts(), { Sponsored: 3 });
  posts.stop();
});

test('with the real post tracker, a post back before its link fills in counts again once the link names another story', async () => {
  const story = (n, text, href) => `<div aria-posinset="${n}"><div><a href="${href}">2h</a><div class="text">${text}</div></div></div>`;
  // A word filter looks as a post is added. Some look again when its link fills in, some don't.
  for (const again of [false, true]) {
    const win = page(feed(story(1, 'Spam one', '/someone/posts/pfbid0First'), story(2, 'Spam three', '#'), story(3, 'Spam four', '/someone/posts/pfbid0Fourth')));
    const posts = createPostTracker({ doc: win.document });
    const hider = createHider({ doc: win.document, posts });
    const filter = ({ element }) => {
      if (element.textContent.includes('Spam')) hider.hide(element, 'Filter');
    };
    posts.on('post/add', filter);
    if (again) posts.on('post/update', filter);
    const [first, second, third] = win.document.querySelectorAll('[aria-posinset]');
    const list = win.document.querySelector('.feed');
    const redraw = (element, text, href) => {
      element.querySelector('.text').textContent = text;
      element.querySelector('a').setAttribute('href', href);
    };
    assert.deepEqual(hider.counts(), { Filter: 3 });

    // Away, React draws another story in it, and it's back before that story's link is.
    first.remove();
    await tick();
    redraw(first, 'Spam two', '#');
    list.append(first);
    await tick();
    assert.equal(hider.isHidden(first), true);
    assert.deepEqual(hider.counts(), { Filter: 3 }, `again=${again}: not yet known to be another story`);
    first.querySelector('a').setAttribute('href', '/other/posts/pfbid0Second');
    await tick();
    assert.deepEqual(hider.counts(), { Filter: 4 }, `again=${again}: the link names another story`);

    // Its link fills in as it leaves, so the tracker never heard the id it left with.
    second.querySelector('a').setAttribute('href', '/someone/posts/pfbid0Third');
    second.remove();
    await tick();
    redraw(second, 'Spam five', '/other/posts/pfbid0Fifth');
    list.append(second);
    await tick();
    assert.deepEqual(hider.counts(), { Filter: 5 }, `again=${again}: back as another story`);

    // Back as itself, its link drawn again a moment later.
    third.remove();
    await tick();
    third.querySelector('a').setAttribute('href', '#');
    list.append(third);
    await tick();
    third.querySelector('a').setAttribute('href', '/someone/posts/pfbid0Fourth');
    await tick();
    assert.equal(hider.isHidden(third), true);
    assert.deepEqual(hider.counts(), { Filter: 5 }, `again=${again}: the same story counts once`);
    assert.equal(hider.hiddenPosts(), 5);
    posts.stop();
  }
});

// The hider starts hearing the tracker at its first hide: after the features when one of them
// asks for it, before them when something was hidden earlier. Both have to come out the same.
const LISTEN_ORDERS = ['features first', 'hider first'];

test('with the real post tracker, an element back as another story keeps only what a feature hides it for now', async () => {
  for (const order of LISTEN_ORDERS) {
    const win = page(feed(post(1), post(2)));
    const posts = createPostTracker({ doc: win.document });
    const hider = createHider({ doc: win.document, posts });
    const [element, other] = win.document.querySelectorAll('[aria-posinset]');
    if (order === 'hider first') hider.hide(other, 'Seed');
    posts.on('post/add', ({ element: added, id }) => {
      if (id === 'pfbid0Post1') hider.hide(added, 'Sponsored');
      if (id === 'pfbid0Post4') hider.hide(added, 'Filter', 'spam');
    });
    const list = win.document.querySelector('.feed');
    const mark = () => element.firstElementChild;
    const backAs = async (id) => {
      element.remove();
      await tick();
      element.querySelector('a[href*="/posts/"]').setAttribute('href', `/someone/posts/${id}`);
      list.prepend(element);
      await tick();
    };
    assert.equal(mark().getAttribute(MARK), 'Sponsored', order);

    // React reused it while it was off the page, for a story another feature hides.
    await backAs('pfbid0Post4');
    assert.equal(mark().getAttribute(MARK), 'Filter', `${order}: the ad's reason went`);
    assert.equal(mark().getAttribute(NOTE), 'Hidden: Filter: spam. Show', order);
    assert.deepEqual([hider.counts().Sponsored, hider.counts().Filter], [1, 1], order);

    // And again, for a story nothing hides.
    let heard = 0;
    hider.subscribe(() => heard++);
    await backAs('pfbid0Post3');
    assert.equal(hider.isHidden(element), false, `${order}: shown`);
    assert.equal(heard, 1, `${order}: its mark leaving the page was the news`);
    assert.deepEqual([hider.counts().Sponsored, hider.counts().Filter], [1, 1], order);
    posts.stop();
  }
});

test('with the real post tracker, a post back before its link keeps only what a feature hid it for since, once the link names another story', async () => {
  const story = (n, text, href) => `<div aria-posinset="${n}"><div><a href="${href}">2h</a><div class="text">${text}</div></div></div>`;
  for (const order of LISTEN_ORDERS) {
    const win = page(feed(story(1, 'Ad one', '/someone/posts/pfbid0First'), story(2, 'Ad two', '/someone/posts/pfbid0Second'), story(3, 'Plain', '/someone/posts/pfbid0Third')));
    const posts = createPostTracker({ doc: win.document });
    const hider = createHider({ doc: win.document, posts });
    const [first, second, third] = win.document.querySelectorAll('[aria-posinset]');
    if (order === 'hider first') hider.hide(third, 'Seed');
    const ads = new Set(['pfbid0First', 'pfbid0Second']);
    posts.on('post/add', ({ element, id }) => {
      if (ads.has(id)) hider.hide(element, 'Sponsored');
      if (element.textContent.includes('Spam')) hider.hide(element, 'Filter');
    });
    const list = win.document.querySelector('.feed');
    const backBeforeLink = async (element, text) => {
      element.remove();
      await tick();
      element.querySelector('.text').textContent = text;
      element.querySelector('a').setAttribute('href', '#');
      list.append(element);
      await tick();
    };
    assert.equal(hider.counts().Sponsored, 2, order);

    // Back with words a filter hides: both reasons until the link says it isn't the ad.
    await backBeforeLink(first, 'Spam');
    assert.equal(first.firstElementChild.getAttribute(MARK), 'Sponsored Filter', order);
    first.querySelector('a').setAttribute('href', '/other/posts/pfbid0Fourth');
    await tick();
    assert.equal(first.firstElementChild.getAttribute(MARK), 'Filter', `${order}: the ad's reason went`);
    assert.equal(first.firstElementChild.getAttribute(NOTE), 'Hidden: Filter. Show', order);
    assert.deepEqual([hider.counts().Sponsored, hider.counts().Filter], [2, 1], `${order}: counted as the new story, under the filter`);

    // Back with words nothing hides: shown once the link names another story, and that's news.
    await backBeforeLink(second, 'Plain words');
    assert.equal(hider.isHidden(second), true, `${order}: not yet known to be another story`);
    let heard = 0;
    hider.subscribe(() => heard++);
    second.querySelector('a').setAttribute('href', '/other/posts/pfbid0Fifth');
    await tick();
    assert.equal(hider.isHidden(second), false, `${order}: shown`);
    assert.equal(heard, 1, `${order}: Overview hears the mark come off`);
    assert.deepEqual([hider.counts().Sponsored, hider.counts().Filter], [2, 1], order);
    posts.stop();
  }
});

test('with the real post tracker, what a post back before its link was hidden for stays with that visit, and counts once its link names the story', async () => {
  const story = (n, text, href) => `<div aria-posinset="${n}"><div><a href="${href}">2h</a><div class="text">${text}</div></div></div>`;
  for (const order of LISTEN_ORDERS) {
    const win = page(feed(story(1, 'Ad one', '/someone/posts/pfbid0First'), story(2, 'Ad two', '/someone/posts/pfbid0Second'), story(3, 'Plain', '/someone/posts/pfbid0Third')));
    const posts = createPostTracker({ doc: win.document });
    const hider = createHider({ doc: win.document, posts });
    const [first, second, third] = win.document.querySelectorAll('[aria-posinset]');
    const seeded = order === 'hider first' ? 1 : 0;
    if (seeded) hider.hide(third, 'Seed');
    const ads = new Set(['pfbid0First', 'pfbid0Second']);
    posts.on('post/add', ({ element, id }) => {
      if (ads.has(id)) hider.hide(element, 'Sponsored');
      if (element.textContent.includes('Spam')) hider.hide(element, 'Filter');
    });
    const list = win.document.querySelector('.feed');
    const leave = async (element, href) => {
      if (href) element.querySelector('a').setAttribute('href', href);
      element.remove();
      await tick();
    };
    const back = async (element, text, href) => {
      element.querySelector('.text').textContent = text;
      element.querySelector('a').setAttribute('href', href);
      list.append(element);
      await tick();
    };

    // Back before its link with words a filter hides, gone again before the link came, and back
    // as a story nothing hides: what the filter saw the last time says nothing about this one.
    await leave(first);
    await back(first, 'Spam', '#');
    assert.equal(first.firstElementChild.getAttribute(MARK), 'Sponsored Filter', order);
    await leave(first);
    await back(first, 'Plain words', '/other/posts/pfbid0Fourth');
    assert.equal(hider.isHidden(first), false, `${order}: shown`);

    // Back before its link with words a filter hides, its link filling in as it goes: that story
    // was hidden on the page, so it counts, once, wherever Facebook draws it next.
    await leave(second);
    await back(second, 'Spam', '#');
    await leave(second, '/other/posts/pfbid0Fifth');
    assert.deepEqual([hider.counts().Sponsored, hider.counts().Filter], [2, 1], `${order}: counted as the story it showed`);
    list.insertAdjacentHTML('beforeend', story(4, 'Spam', '/other/posts/pfbid0Fifth'));
    await tick();
    assert.deepEqual([hider.counts().Sponsored, hider.counts().Filter], [2, 1], `${order}: once`);
    assert.equal(hider.hiddenPosts(), 3 + seeded, order);
    posts.stop();
  }
});

test('with the real post tracker, a post hidden while it was off the page, before its link, counts as the story it comes back as', async () => {
  const story = (n, text, href) => `<div aria-posinset="${n}"><div><a href="${href}">2h</a><div class="text">${text}</div></div></div>`;
  for (const order of LISTEN_ORDERS) {
    const win = page(feed(story(1, 'Ad one', '/someone/posts/pfbid0First'), story(2, 'Plain', '/someone/posts/pfbid0Third')));
    const posts = createPostTracker({ doc: win.document });
    const hider = createHider({ doc: win.document, posts });
    const [first, second] = win.document.querySelectorAll('[aria-posinset]');
    const seeded = order === 'hider first' ? 1 : 0;
    if (seeded) hider.hide(second, 'Seed');
    posts.on('post/add', ({ element, id }) => {
      if (id === 'pfbid0First') hider.hide(element, 'Sponsored');
    });
    const list = win.document.querySelector('.feed');

    // React draws another story in it while it's away, and a check that finished late hides it
    // before the link is in.
    first.remove();
    await tick();
    first.querySelector('.text').textContent = 'Spam';
    first.querySelector('a').setAttribute('href', '#');
    hider.hide(first, 'Filter');
    first.querySelector('a').setAttribute('href', '/other/posts/pfbid0Fourth');
    let heard = 0;
    hider.subscribe(() => heard++);
    list.append(first);
    await tick();
    assert.equal(first.firstElementChild.getAttribute(MARK), 'Filter', `${order}: the ad's reason went`);
    assert.deepEqual([hider.counts().Sponsored, hider.counts().Filter], [1, 1], `${order}: counted as the story it showed`);
    assert.equal(hider.hiddenPosts(), 2 + seeded, order);
    assert.equal(heard, 1, order);
    posts.stop();
  }
});

// Facebook taking an adFeed post out of the feed for a moment while it stays on the page. The
// tracker reports it gone and then back, and it's the same post throughout.
const BLIPS = {
  // Wrapped in another post, then drawn on its own again.
  wrapped: async (s) => {
    const list = s.first.parentElement;
    const outer = list.ownerDocument.createElement('div');
    outer.setAttribute('aria-posinset', '9');
    list.prepend(outer);
    outer.append(s.first);
    await tick();
    list.append(s.first);
    await tick();
  },
  // No longer a post for a moment, then one again.
  'lost its place': async (s) => {
    s.first.removeAttribute('aria-posinset');
    await tick();
    s.first.setAttribute('aria-posinset', '1');
    await tick();
  },
};

// An ad a feature hid for Sponsored and a plain post, for a post that leaves and comes back.
// judge(hider, event) hears post/add, and post/update first with `updates`. heard holds what's
// hidden on the page at each notification, and noted each reason onHide was told about.
function adFeed(order, judge, { text = 'Ad one', href = '/someone/posts/pfbid0First', updates = false } = {}) {
  const drawn = (n, words, link) => `<div aria-posinset="${n}"><div><a href="${link}">2h</a><div class="text">${words}</div></div></div>`;
  const win = page(feed(drawn(1, text, href), drawn(2, 'Plain', '/someone/posts/pfbid0Third')));
  const posts = createPostTracker({ doc: win.document });
  const noted = [];
  const hider = createHider({ doc: win.document, posts, onHide: ({ reason }) => noted.push(reason) });
  const [first, second] = win.document.querySelectorAll('[aria-posinset]');
  const seeded = order === 'hider first' ? 1 : 0;
  if (seeded) hider.hide(second, 'Seed');
  const listen = (event) => judge(hider, event);
  if (updates) posts.on('post/update', listen);
  posts.on('post/add', listen);
  const heard = [];
  hider.subscribe(() => heard.push(hider.hiddenNow() - seeded));
  const list = win.document.querySelector('.feed');
  return {
    posts,
    hider,
    first,
    seeded,
    heard,
    noted,
    mark: () => first.firstElementChild.getAttribute(MARK),
    counts: () => Object.fromEntries(Object.entries(hider.counts()).filter(([reason]) => reason !== 'Seed')),
    link: (href) => first.querySelector('a').setAttribute('href', href),
    leave: async () => {
      first.remove();
      await tick();
    },
    back: async (words, href) => {
      if (words !== undefined) first.querySelector('.text').textContent = words;
      if (href !== undefined) first.querySelector('a').setAttribute('href', href);
      list.append(first);
      await tick();
    },
    // Another post drawn at the end of the feed.
    draw: async (words, href) => {
      list.insertAdjacentHTML('beforeend', drawn(list.children.length + 1, words, href));
      await tick();
    },
  };
}

test('with the real post tracker, a post gone again before its link loses what it was hidden for on that visit, even back as the story it was', async () => {
  for (const order of LISTEN_ORDERS) {
    const s = adFeed(order, (hider, { element, id }) => {
      if (id === 'pfbid0First') hider.hide(element, 'Sponsored');
      if (element.textContent.includes('Spam')) hider.hide(element, 'Filter');
    });
    await s.leave();
    await s.back('Spam', '#');
    assert.equal(s.mark(), 'Sponsored Filter', order);
    await s.leave();
    await s.back('Ad one', '/someone/posts/pfbid0First');
    assert.equal(s.mark(), 'Sponsored', `${order}: the filter's reason went`);
    s.hider.showAll('Sponsored');
    assert.equal(s.hider.isHidden(s.first), false, `${order}: shown with ads`);
    s.posts.stop();
  }
});

test('with the real post tracker, a post hidden off the page while its link still names the story it was counts as the story it comes back as', async () => {
  // A check that finished late hides it for another reason, or for the ad's again.
  for (const reason of ['Filter', 'Sponsored']) {
    for (const order of LISTEN_ORDERS) {
      const s = adFeed(order, (hider, { element, id }) => {
        if (id === 'pfbid0First') hider.hide(element, 'Sponsored');
      });
      await s.leave();
      s.hider.hide(s.first, reason);
      await s.back('Plain words', '/other/posts/pfbid0Fourth');
      const where = `${reason} ${order}`;
      assert.equal(s.mark(), reason, `${where}: hidden for what it was given since it left`);
      assert.deepEqual(s.counts(), reason === 'Filter' ? { Sponsored: 1, Filter: 1 } : { Sponsored: 2 }, `${where}: counted as the story it showed`);
      assert.equal(s.hider.hiddenPosts() - s.seeded, 2, where);
      assert.equal(s.heard.at(-1), s.hider.hiddenNow() - s.seeded, `${where}: the last news is what's hidden`);
      s.posts.stop();
    }
  }
});

test('with the real post tracker, a post hidden off the page after its link already names the new story counts as that story', async () => {
  for (const reason of ['Filter', 'Sponsored']) {
    for (const order of LISTEN_ORDERS) {
      const s = adFeed(order, (hider, { element, id }) => {
        if (id === 'pfbid0First') hider.hide(element, 'Sponsored');
      });
      await s.leave();
      s.first.querySelector('.text').textContent = 'Plain words';
      s.link('/other/posts/pfbid0Fourth');
      s.hider.hide(s.first, reason);
      await s.back();
      const where = `${reason} ${order}`;
      assert.equal(s.mark(), reason, where);
      assert.deepEqual(s.counts(), reason === 'Filter' ? { Sponsored: 1, Filter: 1 } : { Sponsored: 2 }, `${where}: counted as the story it showed`);
      assert.equal(s.hider.hiddenPosts() - s.seeded, 2, where);
      assert.equal(s.heard.at(-1), s.hider.hiddenNow() - s.seeded, `${where}: the last news is what's hidden`);
      s.posts.stop();
    }
  }
});

test('with the real post tracker, a post nothing hid, hidden off the page, counts as the story it comes back as and no other', async () => {
  for (const order of LISTEN_ORDERS) {
    const s = adFeed(order, (hider, { element }) => {
      if (element.textContent.includes('Spam')) hider.hide(element, 'Filter');
    });
    await s.leave();
    // A check that finished late, while its link still names the story it was.
    s.hider.hide(s.first, 'Filter');
    await s.back('Plain words', '/other/posts/pfbid0Fourth');
    assert.equal(s.mark(), 'Filter', order);
    assert.deepEqual(s.counts(), { Filter: 1 }, order);
    await s.draw('Spam again', '/other/posts/pfbid0Fourth');
    assert.equal(s.hider.hiddenPosts() - s.seeded, 1, `${order}: the story it came back as counted once`);
    await s.draw('Spam from before', '/someone/posts/pfbid0First');
    assert.equal(s.hider.hiddenPosts() - s.seeded, 2, `${order}: the story it left as never counted`);
    s.posts.stop();
  }
});

test('with the real post tracker, a post hidden after it left but before the tracker heard keeps that reason as whichever story it comes back as', async () => {
  // React may write the new story's link before the late check, too.
  for (const rewritten of [false, true]) {
    for (const order of LISTEN_ORDERS) {
      const s = adFeed(order, (hider, { element, id }) => {
        if (id === 'pfbid0First') hider.hide(element, 'Sponsored');
      });
      s.first.remove();
      if (rewritten) s.link('/other/posts/pfbid0Fourth');
      s.hider.hide(s.first, 'Filter');
      await tick();
      await s.back('Plain words', '/other/posts/pfbid0Fourth');
      const where = `${rewritten ? 'link rewritten' : 'old link'} ${order}`;
      assert.equal(s.mark(), 'Filter', where);
      assert.deepEqual(s.counts(), { Sponsored: 1, Filter: 1 }, where);
      assert.equal(s.hider.hiddenPosts() - s.seeded, 2, where);
      assert.equal(s.heard.at(-1), s.hider.hiddenNow() - s.seeded, `${where}: the last news is what's hidden`);
      await s.draw('Ad one', '/someone/posts/pfbid0First');
      assert.equal(s.hider.hiddenPosts() - s.seeded, 2, `${where}: the ad it left as stays counted`);
      s.posts.stop();
    }
  }
});

test('with the real post tracker, a post hidden while away and back before its link forgets that reason when it goes again, whether or not the tracker had heard it leave', async () => {
  for (const order of LISTEN_ORDERS) {
    // Nothing hid it, and the tracker heard it leave.
    const quiet = adFeed(order, () => {});
    await quiet.leave();
    quiet.hider.hide(quiet.first, 'Filter');
    await quiet.back('Ad one', '#');
    assert.equal(quiet.mark(), 'Filter', order);
    await quiet.leave();
    assert.equal(quiet.mark(), null, `${order}: the late reason went with that visit`);
    quiet.posts.stop();

    // The ad, hidden again before the tracker heard it leave.
    const ad = adFeed(order, (hider, { element, id }) => {
      if (id === 'pfbid0First') hider.hide(element, 'Sponsored');
    });
    ad.first.remove();
    ad.hider.hide(ad.first, 'Filter');
    await tick();
    await ad.back('Ad one', '#');
    await ad.leave();
    assert.equal(ad.mark(), 'Sponsored', `${order}: back to what it left with`);
    ad.posts.stop();
  }
});

test('with the real post tracker, a post counted before its link stays that story when its link fills in as it goes and a late check hides it before the tracker heard', async () => {
  for (const order of LISTEN_ORDERS) {
    const s = adFeed(order, (hider, { element }) => {
      if (element.textContent.includes('Spam')) hider.hide(element, 'Filter');
    }, { text: 'Spam', href: '#' });
    s.first.remove();
    s.link('/someone/posts/pfbid0Spam');
    s.hider.hide(s.first, 'People');
    await tick();
    await s.draw('Spam', '/someone/posts/pfbid0Spam');
    assert.equal(s.hider.hiddenPosts() - s.seeded, 1, `${order}: the story counted once`);
    s.posts.stop();
  }
});

test('with the real post tracker, a post hidden off the page and back with its link gone counts at once, and its link gives that count to the story it names', async () => {
  const spam = (hider, { element }) => {
    if (element.textContent.includes('Spam')) hider.hide(element, 'Filter');
  };
  for (const order of LISTEN_ORDERS) {
    const s = adFeed(order, spam);
    await s.leave();
    s.hider.hide(s.first, 'Filter');
    await s.back('Spam', '#');
    assert.deepEqual(s.counts(), { Filter: 1 }, `${order}: counted with no link`);
    assert.equal(s.hider.hiddenPosts() - s.seeded, 1, order);
    assert.equal(s.heard.at(-1), s.hider.hiddenNow() - s.seeded, `${order}: the last news is what's hidden`);
    s.link('/other/posts/pfbid0Fourth');
    await tick();
    assert.equal(s.hider.hiddenPosts() - s.seeded, 1, `${order}: still one post once its link fills in`);
    await s.draw('Spam again', '/other/posts/pfbid0Fourth');
    assert.equal(s.hider.hiddenPosts() - s.seeded, 1, `${order}: the story its link named has that count`);
    await s.draw('Spam from before', '/someone/posts/pfbid0First');
    assert.equal(s.hider.hiddenPosts() - s.seeded, 2, `${order}: the story it left as never counted`);
    s.posts.stop();
  }
  // A link naming a story that counted already, another one or the one it left as, takes the
  // count back off, shown since or not.
  for (const shown of [false, true]) {
    for (const story of ['/other/posts/pfbid0Fourth', '/someone/posts/pfbid0First']) {
      for (const order of LISTEN_ORDERS) {
        const s = adFeed(order, spam);
        const where = `${shown ? 'shown ' : ''}${story} ${order}`;
        await s.draw('Ad two', story);
        s.hider.hide(s.first.parentElement.lastElementChild, 'People');
        await s.leave();
        s.hider.hide(s.first, 'Filter');
        await s.back('Spam', '#');
        assert.equal(s.hider.hiddenPosts() - s.seeded, 2, where);
        if (shown) s.hider.show(s.first);
        const heard = s.heard.length;
        s.link(story);
        await tick();
        assert.deepEqual(s.counts(), { People: 1 }, `${where}: counted once, as the story was`);
        assert.equal(s.hider.hiddenPosts() - s.seeded, 1, where);
        assert.ok(s.heard.length > heard, `${where}: listeners heard the count come off`);
        s.posts.stop();
      }
    }
  }
});

test('with the real post tracker, a post hidden and put back before the tracker looked keeps nothing from it when it comes back later as another story', async () => {
  // Its link can go as it's put back, too, so it's back before its link.
  for (const gone of [false, true]) {
    for (const order of LISTEN_ORDERS) {
      const s = adFeed(order, (hider, { element, id }) => {
        if (id === 'pfbid0First') hider.hide(element, 'Sponsored');
      });
      const where = `${gone ? 'link gone' : 'old link'} ${order}`;
      s.first.remove();
      if (gone) s.link('#');
      s.hider.hide(s.first, 'Filter');
      await s.back();
      assert.equal(s.mark(), 'Sponsored Filter', where);
      assert.equal(s.heard.at(-1), s.hider.hiddenNow() - s.seeded, `${where}: the last news is what's hidden`);
      await s.leave();
      await s.back('Plain words', '/other/posts/pfbid0Fourth');
      assert.equal(s.mark(), null, `${where}: nothing hid it since it left`);
      assert.deepEqual(s.counts(), { Sponsored: 1 }, where);
      assert.equal(s.hider.hiddenPosts() - s.seeded, 1, where);
      s.posts.stop();
    }
  }
});

test('with the real post tracker, a post put back before the tracker looked is the story the tracker knows until its link says otherwise', async () => {
  const judge = (hider, { element }) => {
    if (element.textContent.includes('Spam')) hider.hide(element, 'Filter');
    if (element.textContent.includes('Gossip')) hider.hide(element, 'People');
  };
  // Its link goes before or after it's hidden, and fills back in as the story it was.
  for (const early of [false, true]) {
    for (const order of LISTEN_ORDERS) {
      const s = adFeed(order, judge);
      const where = `${early ? 'link gone first' : 'hidden first'} ${order}`;
      s.first.remove();
      if (early) s.link('#');
      s.hider.hide(s.first, 'Filter');
      if (!early) s.link('#');
      await s.back();
      assert.deepEqual(s.counts(), { Filter: 1 }, where);
      s.link('/someone/posts/pfbid0First');
      await tick();
      await s.draw('Spam', '/someone/posts/pfbid0First');
      assert.equal(s.hider.hiddenPosts() - s.seeded, 1, `${where}: that story counted once`);
      s.posts.stop();
    }
  }
  // Gone again before its link fills back in, it's still that story, and stays hidden back as it.
  for (const order of LISTEN_ORDERS) {
    const s = adFeed(order, judge);
    s.first.remove();
    s.hider.hide(s.first, 'Filter');
    s.link('#');
    await s.back();
    await s.leave();
    await s.back(undefined, '/someone/posts/pfbid0First');
    assert.equal(s.mark(), 'Filter', order);
    assert.deepEqual(s.counts(), { Filter: 1 }, order);
    s.posts.stop();
  }
  // A link naming another story is the tracker's reused element: both stories count.
  for (const order of LISTEN_ORDERS) {
    const s = adFeed(order, judge);
    await s.draw('Gossip', '/other/posts/pfbid0Fourth');
    s.first.remove();
    s.link('#');
    s.hider.hide(s.first, 'Filter');
    await s.back('Spam');
    s.link('/other/posts/pfbid0Fourth');
    await tick();
    assert.deepEqual(s.counts(), { People: 1, Filter: 1 }, order);
    assert.equal(s.hider.hiddenPosts() - s.seeded, 2, order);
    s.posts.stop();
  }
});

test('with the real post tracker, a visit forgotten before its link counts as the story it left as, and another story it comes back as counts on its own', async () => {
  const judge = (hider, { element }) => {
    if (element.textContent.includes('Spam')) hider.hide(element, 'Filter');
    if (element.textContent.includes('Gossip')) hider.hide(element, 'People');
  };
  const cases = [
    // Back as a new story a feature hides, or as one counted already that nothing hides.
    { name: 'a new story', words: 'Gossip', href: '/other/posts/pfbid0Fifth', counts: { Filter: 1, People: 1 } },
    { name: 'a counted story', before: '/other/posts/pfbid0Fourth', words: 'Plain', href: '/other/posts/pfbid0Fourth', counts: { People: 1, Filter: 1 } },
    // Back as itself, hidden again, it counts once.
    { name: 'itself', words: 'Spam', href: '/someone/posts/pfbid0First', counts: { Filter: 1 } },
    // The story it left as was counted already, drawn again while it was back, and it was shown
    // by then or not.
    { name: 'a story counted meanwhile', meanwhile: '/someone/posts/pfbid0First', words: 'Plain', href: '/other/posts/pfbid0Fifth', counts: { People: 1 } },
    { name: 'a story counted meanwhile, shown', meanwhile: '/someone/posts/pfbid0First', shown: true, words: 'Plain', href: '/other/posts/pfbid0Fifth', counts: { People: 1 } },
  ];
  for (const { name, before, meanwhile, shown, words, href, counts } of cases) {
    for (const order of LISTEN_ORDERS) {
      const s = adFeed(order, judge);
      const where = `${name} ${order}`;
      if (before) await s.draw('Gossip', before);
      await s.leave();
      s.hider.hide(s.first, 'Filter');
      await s.back('Spam', '#');
      if (meanwhile) await s.draw('Gossip', meanwhile);
      if (shown) s.hider.show(s.first);
      const heard = s.heard.length;
      await s.leave();
      if (meanwhile) assert.ok(s.heard.length > heard, `${where}: listeners heard the count come off`);
      await s.back(words, href);
      assert.deepEqual(s.counts(), counts, where);
      assert.equal(s.hider.hiddenPosts() - s.seeded, Object.keys(counts).length, where);
      s.posts.stop();
    }
  }
});

test('with the real post tracker, a post hidden before its link, on the page or while away, stops counting when its link names a story counted already', async () => {
  const counted = '/other/posts/pfbid0Fourth';
  // Its link fills in on the page, or as it leaves, or it's back from a trip off the page with
  // it, shown by then or not. One hidden while away and gone again before its link is the story
  // it left as (the forgotten visit test).
  const cases = [['on the page', false], ['as it leaves', false], ['back again', false], ['on the page', true], ['as it leaves', true]];
  for (const [when, away] of cases) {
    for (const shown of [false, true]) {
      for (const order of LISTEN_ORDERS) {
        const s = adFeed(order, (hider, { element }) => {
          if (element.textContent.includes('Spam')) hider.hide(element, 'Filter');
          if (element.textContent.includes('Gossip')) hider.hide(element, 'People');
        });
        const where = `${when}${away ? ' hidden away' : ''}${shown ? ' shown' : ''} ${order}`;
        await s.draw('Gossip', counted);
        await s.leave();
        if (away) s.hider.hide(s.first, 'Filter');
        await s.back(away ? 'Plain' : 'Spam', '#');
        assert.deepEqual(s.counts(), { People: 1, Filter: 1 }, where);
        if (shown) s.hider.show(s.first);
        const heard = s.heard.length;
        if (when === 'on the page') {
          s.link(counted);
          await tick();
        } else if (when === 'as it leaves') {
          s.link(counted);
          await s.leave();
        } else {
          await s.leave();
          await s.back('Plain', counted);
        }
        assert.deepEqual(s.counts(), { People: 1 }, where);
        assert.equal(s.hider.hiddenPosts() - s.seeded, 1, where);
        assert.ok(s.heard.length > heard, `${where}: listeners heard the count come off`);
        s.posts.stop();
      }
    }
  }
});

test('with the real post tracker, a post hidden before its link and hidden again as the link fills in counts as the story the link names', async () => {
  const spam = '/someone/posts/pfbid0Spam';
  // A feature that only knows the story once the link names it hides it then, or a check hides it
  // again before the tracker has heard the link. The story is new, or a post on the page already
  // showed it.
  for (const how of ['a feature on the link', 'before the tracker heard']) {
    for (const already of [false, true]) {
      for (const order of LISTEN_ORDERS) {
        const s = adFeed(order, (hider, { element, id }) => {
          if (how === 'a feature on the link' && id === 'pfbid0Spam') hider.hide(element, 'Filter');
        }, { text: 'Gossip', href: '#', updates: true });
        const where = `${how}${already ? ', counted already' : ''} ${order}`;
        if (already) {
          await s.draw('Spam', spam);
          s.hider.hide(s.posts.current().at(-1).element, 'Filter');
        }
        s.hider.hide(s.first, 'People');
        const heard = s.heard.length;
        s.link(spam);
        // Settled as the hide lands, for an element the tracker never says more about.
        if (how === 'before the tracker heard') {
          s.hider.hide(s.first, 'Filter');
          assert.deepEqual(s.counts(), already ? { Filter: 1 } : { People: 1 }, `${where}, at the hide`);
        }
        await tick();
        assert.deepEqual(s.counts(), already ? { Filter: 1 } : { People: 1 }, where);
        assert.equal(s.hider.hiddenPosts() - s.seeded, 1, where);
        if (already) assert.ok(s.heard.length > heard, `${where}: listeners heard the count come off`);
        s.posts.stop();
      }
    }
  }
});

test('with the real post tracker, an element reused for another story and hidden before the tracker heard counts that story on its own', async () => {
  // The filter hides it again once the tracker reports it reused, or never does, and the post the
  // tracker shows as it reports that counts for nothing. The tracker knew it as the first story,
  // hidden as that or not, and wrapped or taken out of the feed for a moment before the reuse.
  for (const [how, blip] of [['as drawn', async () => {}], ...Object.entries(BLIPS)]) {
    for (const hiddenBefore of [true, false]) {
      for (const again of [true, false]) {
        for (const order of LISTEN_ORDERS) {
          const s = adFeed(order, (hider, { element }) => {
            if (again && element.textContent.includes('Spam')) hider.hide(element, 'Filter');
          });
          const where = `${how}, ${hiddenBefore ? 'hidden' : 'not hidden'} before, ${again ? 'hidden again' : 'not hidden again'} ${order}`;
          const before = hiddenBefore ? { Sponsored: 1 } : {};
          if (hiddenBefore) s.hider.hide(s.first, 'Sponsored');
          await blip(s);
          // Back, a check hides it again as the story it was.
          if (hiddenBefore) s.hider.hide(s.first, 'Sponsored');
          // Facebook draws another story in it, and a check hides it before the tracker's look.
          s.first.querySelector('.text').textContent = 'Spam';
          s.link('/other/posts/pfbid0Fourth');
          s.hider.hide(s.first, 'Filter');
          assert.deepEqual(s.counts(), before, `${where}, at the hide`);
          await tick();
          assert.deepEqual(s.counts(), again ? { ...before, Filter: 1 } : before, where);
          assert.equal(s.hider.hiddenPosts() - s.seeded, (hiddenBefore ? 1 : 0) + (again ? 1 : 0), where);
          assert.equal(s.hider.isHidden(s.first), again, where);
          s.posts.stop();
        }
      }
    }
  }
});

test('with the real post tracker, an element reused and hidden before the tracker heard, then taken off the page before it looked, comes back hidden only when the story it shows is', async () => {
  // As above, but the tracker next hears of it leaving, and then back as the story it shows.
  for (const [how, blip] of [['as drawn', async () => {}], ...Object.entries(BLIPS)]) {
    for (const hiddenBefore of [true, false]) {
      for (const again of [true, false]) {
        for (const order of LISTEN_ORDERS) {
          const s = adFeed(order, (hider, { element }) => {
            if (again && element.textContent.includes('Spam')) hider.hide(element, 'Filter');
          });
          const where = `${how}, ${hiddenBefore ? 'hidden' : 'not hidden'} before, ${again ? 'hidden again' : 'not hidden again'} ${order}`;
          const before = hiddenBefore ? { Sponsored: 1 } : {};
          if (hiddenBefore) s.hider.hide(s.first, 'Sponsored');
          await blip(s);
          if (hiddenBefore) s.hider.hide(s.first, 'Sponsored');
          s.first.querySelector('.text').textContent = 'Spam';
          s.link('/other/posts/pfbid0Fourth');
          s.hider.hide(s.first, 'Filter');
          await s.leave();
          assert.deepEqual(s.counts(), before, `${where}, away`);
          await s.back();
          assert.deepEqual(s.counts(), again ? { ...before, Filter: 1 } : before, where);
          assert.equal(s.hider.hiddenPosts() - s.seeded, (hiddenBefore ? 1 : 0) + (again ? 1 : 0), where);
          assert.equal(s.hider.isHidden(s.first), again, where);
          assert.equal(s.mark(), again ? 'Filter' : null, where);
          assert.equal(s.heard.at(-1), s.hider.hiddenNow() - s.seeded, `${where}: the last news is what's hidden`);
          s.posts.stop();
        }
      }
    }
  }
});

test('with the real post tracker, a post settled at a hide as one story and reused for another before the tracker heard either counts that one on its own', async () => {
  const spam = '/someone/posts/pfbid0Spam';
  const other = '/other/posts/pfbid0Other';
  // The tracker never knew it as the first story, so the second is its link filling in, and the
  // tracker never reports it reused. A check hides it before the tracker looks, or a feature
  // hides it on the link.
  for (const [when, updates] of [['at the hide', false], ['at the hide', true], ['on the link', true]]) {
    for (const order of LISTEN_ORDERS) {
      const s = adFeed(order, (hider, { element, id }) => {
        if (id === 'pfbid0Other') hider.hide(element, 'Filter');
      }, { text: 'Gossip', href: '#', updates });
      const where = `${when}${updates ? ', heard on updates' : ''} ${order}`;
      s.hider.hide(s.first, 'People');
      s.link(spam);
      s.hider.hide(s.first, 'People');
      assert.deepEqual(s.counts(), { People: 1 }, `${where}, settled`);
      s.first.querySelector('.text').textContent = 'Other';
      s.link(other);
      if (when === 'at the hide') {
        s.hider.hide(s.first, 'Filter');
        assert.deepEqual(s.counts(), { People: 1, Filter: 1 }, `${where}, at the hide`);
      }
      await tick();
      assert.deepEqual(s.counts(), { People: 1, Filter: 1 }, where);
      assert.equal(s.hider.hiddenPosts() - s.seeded, 2, where);
      assert.equal(s.hider.isHidden(s.first), true, where);
      // Drawn again elsewhere, it's counted already.
      await s.draw('Other', other);
      assert.equal(s.hider.hiddenPosts() - s.seeded, 2, `${where}, drawn again`);
      s.posts.stop();
    }
  }
});

test('with the real post tracker, a story that gains a better link counts once, drawn again by either link', async () => {
  // Hidden before the better link turns up, and wrapped or taken out of the feed for a moment
  // after it, or hidden first after it while the tracker still knows the story by the old link.
  // (Wrapped or taken out first, the tracker hears it as new by the better link, and nothing says
  // the old link is that story.)
  const cases = [
    ...[['as drawn', async () => {}], ...Object.entries(BLIPS)].map(([how, blip]) => ['before', how, blip]),
    ['after', 'as drawn', async () => {}],
  ];
  for (const [when, how, blip] of cases) {
    for (const order of LISTEN_ORDERS) {
      const where = `hidden ${when} its better link, ${how} ${order}`;
      const s = adFeed(order, () => {}, { href: '/story.php?story_fbid=12345&id=4' });
      if (when === 'before') s.hider.hide(s.first, 'Sponsored');
      // A permalink to the same story turns up next to the old link, and a check hides it again.
      const better = s.first.ownerDocument.createElement('a');
      better.setAttribute('href', '/someone/posts/pfbid0Better');
      s.first.firstElementChild.prepend(better);
      await tick();
      await blip(s);
      if (when === 'after') s.hider.hide(s.first, 'Sponsored');
      s.hider.hide(s.first, 'Filter');
      await s.draw('Ad one', '/someone/posts/pfbid0Better');
      s.hider.hide(s.posts.current().at(-1).element, 'Sponsored');
      await s.draw('Ad one', '/story.php?story_fbid=12345&id=4');
      s.hider.hide(s.posts.current().at(-1).element, 'Sponsored');
      assert.deepEqual(s.counts(), { Sponsored: 1 }, where);
      assert.equal(s.hider.hiddenPosts() - s.seeded, 1, where);
      s.posts.stop();
    }
  }
});

test('with the real post tracker, a story counted by its old link is counted already where it shows a better link', async () => {
  for (const order of LISTEN_ORDERS) {
    const s = adFeed(order, () => {}, { href: '/story.php?story_fbid=12345&id=4' });
    // The same story drawn again further down, by the old link alone, and hidden there first.
    await s.draw('Ad one', '/story.php?story_fbid=12345&id=4');
    s.hider.hide(s.posts.current().at(-1).element, 'Sponsored');
    const better = s.first.ownerDocument.createElement('a');
    better.setAttribute('href', '/someone/posts/pfbid0Better');
    s.first.firstElementChild.prepend(better);
    await tick();
    s.hider.hide(s.first, 'Filter');
    assert.deepEqual(s.counts(), { Sponsored: 1 }, order);
    assert.equal(s.hider.hiddenPosts() - s.seeded, 1, order);
    s.posts.stop();
  }
});

test('with the real post tracker, listeners hear the count come off for a post shown while away that comes back as a story counted already', async () => {
  const spam = '/someone/posts/pfbid0Spam';
  // Hidden on the page before its link, it leaves, or it's hidden again while away before the
  // tracker heard it go. Shown while away, it's back with a story's link a post already counted,
  // and nothing hides it again, so the count coming off is the only news.
  for (const unheard of [false, true]) {
    for (const order of LISTEN_ORDERS) {
      const s = adFeed(order, () => {}, { text: 'Gossip', href: '#' });
      const where = `${unheard ? 'hidden away before the tracker heard' : 'heard leaving'} ${order}`;
      await s.draw('Spam', spam);
      s.hider.hide(s.posts.current().at(-1).element, 'Filter');
      s.hider.hide(s.first, 'People');
      if (unheard) {
        s.first.remove();
        s.hider.hide(s.first, 'Other');
      } else await s.leave();
      s.hider.show(s.first);
      const heard = s.heard.length;
      await s.back(undefined, spam);
      assert.deepEqual(s.counts(), { Filter: 1 }, where);
      assert.equal(s.hider.hiddenPosts() - s.seeded, 1, where);
      assert.ok(s.heard.length > heard, `${where}: listeners heard the count come off`);
      s.posts.stop();
    }
  }
});

test('with the real post tracker, a post counted before its link and taken into another post counts as the story its link names when it shows on its own', async () => {
  const spam = '/someone/posts/pfbid0Spam';
  // The story is new, or a post on the page counted it already. The filter hides it again as it's
  // drawn on its own, or nothing does.
  for (const again of [true, false]) {
    for (const already of [false, true]) {
      for (const order of LISTEN_ORDERS) {
        const s = adFeed(order, (hider, { element, id }) => {
          if (again && id === 'pfbid0Spam') hider.hide(element, 'Filter');
        }, { text: 'Gossip', href: '#' });
        const where = `${again ? 'hidden again' : 'not hidden again'}${already ? ', counted already' : ''} ${order}`;
        const list = s.first.parentElement;
        if (already) {
          await s.draw('Spam', spam);
          s.hider.hide(s.posts.current().at(-1).element, 'Filter');
        }
        s.hider.hide(s.first, 'People');
        // Facebook wraps it in another post, then draws it on its own again showing a story the
        // filter hides, and it leaves.
        const outer = list.ownerDocument.createElement('div');
        outer.setAttribute('aria-posinset', '9');
        list.prepend(outer);
        outer.append(s.first);
        await tick();
        s.link(spam);
        const heard = s.heard.length;
        list.append(s.first);
        await tick();
        if (already) assert.ok(s.heard.length > heard, `${where}: listeners heard the count come off`);
        await s.leave();
        assert.deepEqual(s.counts(), already ? { Filter: 1 } : { People: 1 }, where);
        assert.equal(s.hider.hiddenPosts() - s.seeded, 1, where);
        s.posts.stop();
      }
    }
  }
});

test('with the real post tracker, a post hidden before its link that Facebook wraps or takes out of the feed for a moment is the same post, settled by the story its link names', async () => {
  const spam = '/someone/posts/pfbid0Spam';
  for (const [how, blip] of Object.entries(BLIPS)) {
    for (const already of [false, true]) {
      for (const order of LISTEN_ORDERS) {
        const s = adFeed(order, (hider, { element, id }) => {
          if (id === 'pfbid0Spam') hider.hide(element, 'Filter');
        }, { text: 'Gossip', href: '#', updates: true });
        const where = `${how}${already ? ', counted already' : ''} ${order}`;
        if (already) await s.draw('Spam', spam);
        s.hider.hide(s.first, 'People');
        await blip(s);
        // A check hides it again, its link still missing.
        s.hider.hide(s.first, 'People');
        assert.deepEqual(s.counts(), already ? { Filter: 1, People: 1 } : { People: 1 }, `${where}, before the link`);
        assert.equal(s.hider.hiddenPosts() - s.seeded, already ? 2 : 1, `${where}, before the link`);
        const heard = s.heard.length;
        s.link(spam);
        await tick();
        assert.deepEqual(s.counts(), already ? { Filter: 1 } : { People: 1 }, where);
        assert.equal(s.hider.hiddenPosts() - s.seeded, 1, where);
        if (already) assert.ok(s.heard.length > heard, `${where}: listeners heard the count come off`);
        else {
          // Drawn again elsewhere, it's counted already.
          await s.draw('Spam', spam);
          assert.equal(s.hider.hiddenPosts() - s.seeded, 1, `${where}, drawn again`);
        }
        s.posts.stop();
      }
    }
  }
});

test('with the real post tracker, a comment hidden while it was off the page counts at once', () => {
  const win = page(feed('<div aria-posinset="1"><div><a href="/someone/posts/pfbid0Post1">2h</a><div class="comments"><div role="article"><div><a href="/someone/posts/pfbid0Post1?comment_id=123">1h</a><div>Spam comment</div></div></div></div></div></div>'));
  const posts = createPostTracker({ doc: win.document });
  const hider = createHider({ doc: win.document, posts });
  const comment = win.document.querySelector('[role="article"]');
  const list = win.document.querySelector('.comments');
  comment.remove();
  assert.equal(hider.hide(comment, 'Filter'), true);
  list.append(comment);
  assert.deepEqual(hider.counts(), { Filter: 1 });
  assert.equal(hider.hiddenPosts(), 0, 'comments stay out of the post count');
  posts.stop();
});

test('with the real post tracker, listeners hear a post hidden while it was off the page come back hidden', async () => {
  // The ad left hidden, or shown by a feature first, or a post nothing had hidden.
  for (const was of ['hidden', 'shown', 'never hidden']) {
    for (const order of LISTEN_ORDERS) {
      const s = adFeed(order, (hider, { element, id }) => {
        if (was !== 'never hidden' && id === 'pfbid0First') hider.hide(element, 'Sponsored');
      });
      if (was === 'shown') s.hider.show(s.first);
      await s.leave();
      s.hider.hide(s.first, 'Filter');
      await s.back();
      const where = `${was} ${order}`;
      assert.equal(s.hider.hiddenNow() - s.seeded, 1, where);
      assert.equal(s.heard.at(-1), 1, `${where}: the last news is what's hidden`);
      s.posts.stop();
    }
  }
});

test('with the real post tracker, a post back as another story counts under the first reason a feature gave it since, its link late or not', async () => {
  for (const late of [false, true]) {
    for (const order of LISTEN_ORDERS) {
      // It leaves hidden for the filter, and comes back hidden for the same two reasons in
      // another order.
      const s = adFeed(order, (hider, { element }) => {
        if (element.textContent.includes('people')) hider.hide(element, 'People');
        if (element.textContent.includes('Spam')) hider.hide(element, 'Filter');
      }, { text: 'Spam' });
      await s.leave();
      await s.back('Spam people', late ? '#' : '/other/posts/pfbid0Fourth');
      if (late) {
        s.link('/other/posts/pfbid0Fourth');
        await tick();
      }
      const where = `${late ? 'late' : 'at once'} ${order}`;
      assert.equal(s.mark(), 'People Filter', where);
      assert.deepEqual(s.counts(), { Filter: 1, People: 1 }, where);
      s.posts.stop();
    }
  }
});

test('with the real post tracker, both listen orders tell the same when a feature decides on a post back as another story', async () => {
  const ads = new Set(['pfbid0First', 'pfbid0Fourth']);
  const cases = [
    // Back with its link in, an ad hidden or another post a feature shows.
    { name: 'an ad', to: 'pfbid0Fourth', mark: 'Sponsored', noted: 1 },
    { name: 'a post the feature shows', to: 'pfbid0Plain', mark: null, noted: 0 },
    // Back before its link, an ad the feature only knows once the link fills in.
    { name: 'an ad known late', to: 'pfbid0Fourth', mark: 'Sponsored', noted: 1, updates: true },
  ];
  for (const { name, to, mark, noted, updates = false } of cases) {
    const seen = {};
    for (const order of LISTEN_ORDERS) {
      const s = adFeed(order, (hider, { element, id }) => {
        if (ads.has(id)) hider.hide(element, 'Sponsored');
        else if (id === 'pfbid0Plain') hider.show(element);
      }, { updates });
      await s.leave();
      const [heard, told] = [s.heard.length, s.noted.length];
      if (updates) {
        await s.back('Ad two', '#');
        s.link(`/other/posts/${to}`);
        await tick();
      } else await s.back('Ad two', `/other/posts/${to}`);
      seen[order] = { mark: s.mark(), counts: s.counts(), heard: s.heard.slice(heard), noted: s.noted.length - told };
      assert.equal(seen[order].mark, mark, `${name} ${order}`);
      assert.equal(seen[order].noted, noted, `${name} ${order}: onHide`);
      s.posts.stop();
    }
    assert.deepEqual(seen['features first'], seen['hider first'], name);
  }
});

test('with the real post tracker, an article counted before its link that turns out to be a comment leaves its post to count on its own', async () => {
  const article = (text) => `<div role="article"><div><a href="#">1h</a><div class="text">${text}</div></div></div>`;
  const story = (n, href) => `<div aria-posinset="${n}"><div><a href="${href}">2h</a><div class="text">Spam post</div></div></div>`;
  const win = page(feed(article('Spam comment'), article('Spam reply')));
  const posts = createPostTracker({ doc: win.document });
  const hider = createHider({ doc: win.document, posts });
  posts.on('post/add', ({ element }) => {
    if (element.textContent.includes('Spam')) hider.hide(element, 'Filter');
  });
  const [first, second] = win.document.querySelectorAll('[role="article"]');
  const list = win.document.querySelector('.feed');
  assert.equal(hider.hiddenPosts(), 2);

  // One's link fills in on the page, the other's as it leaves, each a comment's link naming the
  // post it's on. Those posts turn up in elements of their own.
  first.querySelector('a').setAttribute('href', '/someone/posts/pfbid0Parent?comment_id=123');
  await tick();
  second.querySelector('a').setAttribute('href', '/someone/posts/pfbid0Other?comment_id=456');
  second.remove();
  await tick();
  list.insertAdjacentHTML('beforeend', story(3, '/someone/posts/pfbid0Parent') + story(4, '/someone/posts/pfbid0Other'));
  await tick();
  assert.equal(hider.hiddenPosts(), 4, 'each post counts');
  posts.stop();
});

test('with the real post tracker, a story counted before its link counts once wherever Facebook draws it again', async () => {
  const story = (n, href) => `<div aria-posinset="${n}"><div><a href="${href}">2h</a><div class="text">Spam</div></div></div>`;
  const win = page(feed(story(1, '#'), story(2, '#')));
  const posts = createPostTracker({ doc: win.document });
  const hider = createHider({ doc: win.document, posts });
  posts.on('post/add', ({ element }) => {
    if (element.textContent.includes('Spam')) hider.hide(element, 'Filter');
  });
  const [first, second] = win.document.querySelectorAll('[aria-posinset]');
  const list = win.document.querySelector('.feed');
  assert.equal(hider.hiddenPosts(), 2);

  // Its link fills in on the page, and the same story turns up in another element.
  first.querySelector('a').setAttribute('href', '/someone/posts/pfbid0Spam');
  await tick();
  list.insertAdjacentHTML('beforeend', story(3, '/someone/posts/pfbid0Spam'));
  await tick();
  assert.equal(hider.hiddenPosts(), 2, 'the story it filled in as');

  // Its link fills in as it leaves for good, and the story turns up in another element.
  second.querySelector('a').setAttribute('href', '/someone/posts/pfbid0Other');
  second.remove();
  await tick();
  list.insertAdjacentHTML('beforeend', story(4, '/someone/posts/pfbid0Other'));
  await tick();
  assert.equal(hider.hiddenPosts(), 2, 'the story it left as');
  assert.deepEqual(hider.counts(), { Filter: 2 });
  posts.stop();
});

test('Show them says how many posts and how many comments came back', () => {
  const comment = '<div role="article" class="comment"><div><a href="/someone/posts/pfbid0Post1?comment_id=123">1h</a><div>A comment</div></div></div>';
  const win = page(feed(post(1), post(2)) + comment);
  const [a, b] = win.document.querySelectorAll('[aria-posinset]');
  const hider = createHider({ doc: win.document });
  hider.hide(a, 'Sponsored');
  hider.hide(b, 'Seen');
  hider.hide(win.document.querySelector('.comment'), 'Filter', 'cats');
  assert.equal(hider.hiddenNow(), 3);
  assert.deepEqual(hider.revealEvery(), { posts: 2, comments: 1 });
  assert.deepEqual(hider.revealEvery(), { posts: 0, comments: 0 });
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

// The note's colors in each of Facebook's modes and on a page with no mode class yet, as
// note-colors.js sets them: the rules each element matches, later ones winning.
const noteColors = () => {
  const { document } = testWindow('https://www.facebook.com/');
  const element = (name) => Object.assign(document.createElement('div'), { className: name });
  const places = { 'no class': document.documentElement, dark: element('__fb-dark-mode'), light: element('__fb-light-mode') };
  const rules = [...NOTE_COLORS.matchAll(/^([^{]+)\{([^}]*)\}/gm)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
  return Object.fromEntries(Object.entries(places).map(([mode, place]) => [mode, Object.fromEntries(rules
    .filter(({ selector }) => place.matches(selector))
    .flatMap(({ body }) => [...body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})/g)].map(([, name, value]) => [name, value])))]));
};

test('the focus ring on a note and on Show hidden shows on a light page as well as a dark one', () => {
  const css = hideCss({ notes: true });
  assert.ok(css.includes(NOTE_COLORS), 'the colors ship with the rules that use them');
  const modes = noteColors();
  assert.deepEqual(Object.keys(modes).sort(), ['dark', 'light', 'no class']);
  const rules = [...css.matchAll(/:focus-visible \{([^}]*)\}/g)].map(([, body]) => body);
  assert.equal(rules.length, 2);
  for (const body of rules) {
    const ring = /outline: 2px solid var\((--[\w-]+)\)/.exec(body)?.[1];
    const offset = Number(/outline-offset: (\d+)px/.exec(body)?.[1]);
    const halo = /box-shadow: 0 0 0 (\d+)px var\((--[\w-]+)\)/.exec(body);
    assert.ok(ring && halo, `a ring and a halo: ${body}`);
    assert.ok(Number(halo[1]) >= offset + 2, 'the halo fills the gap and runs under the ring, so no page shows between');
    // Each mode's pair on every page, since a note in one of Facebook's islands of the other
    // mode sits on that mode's colors.
    for (const [mode, colors] of Object.entries(modes)) {
      const [ringColor, haloColor] = [colors[ring], colors[halo[2]]];
      assert.ok(ringColor && haloColor, `${mode} sets ${ring} and ${halo[2]}`);
      assert.ok(contrast(ringColor, haloColor) >= 3, `the ring reads on its halo in ${mode}`);
      for (const behind of PAGES_BEHIND) {
        assert.ok(Math.max(contrast(ringColor, behind), contrast(haloColor, behind)) >= 3, `one of them reads on ${behind} in ${mode}`);
      }
    }
  }
});

test("a hidden post's note reads in both of Facebook's modes", () => {
  for (const [mode, colors] of Object.entries(noteColors())) {
    for (const background of ['--hfw-note-bg', '--hfw-note-bg-strong']) {
      assert.ok(contrast(colors['--hfw-note-text'], colors[background]) >= 4.5, `${mode}: the note's words on ${background}`);
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

// Hidden by the words, people and sites lists, by Keep posts you hide hidden, by both in either
// order, and by an ad or a suggestion, alone or with a filter.
const OWN_CASES = [[['Filter'], true], [['Dismissed'], true], [['Dismissed', 'Filter'], true], [['Filter', 'Dismissed'], true], [['Sponsored'], false], [['Suggested', 'Filter'], false], [['Filter', 'Sponsored'], false]];

test('with notes for your own filters, a post they hid keeps its note line and every other hidden post goes completely', () => {
  assert.deepEqual([...OWN_REASONS], ['Filter', 'Dismissed']);
  const win = page(feed(...OWN_CASES.map((_, i) => post(i + 1))));
  const elements = [...win.document.querySelectorAll('[aria-posinset]')];
  const hider = createHider({ doc: win.document, notesShown: () => OWN });
  OWN_CASES.forEach(([reasons], i) => reasons.forEach((reason) => hider.hide(elements[i], reason)));
  const [gone, siblings, contents] = selectorsOf(hideCss({ notes: OWN }));
  OWN_CASES.forEach(([reasons, noted], i) => {
    const element = elements[i];
    const marker = element.firstElementChild;
    const where = reasons.join(' then ');
    assert.equal(element.matches(gone), !noted, `${where}: gone completely`);
    assert.equal(element.querySelector('.footer').matches(siblings), noted, `${where}: the rest of the post hidden around the note`);
    assert.equal(marker.firstElementChild.matches(contents), noted, `${where}: what's in the mark hidden under the note`);
    assert.deepEqual(buttonParts(marker), noted ? ['button', '0', `Hidden: ${reasons[0]}. Show`] : [null, null, null], `${where}: a button only with its note`);
  });
  // A post nothing hid is left alone, and Always and Never are as they were.
  const plain = win.document.createElement('div');
  plain.innerHTML = post(99);
  assert.equal(plain.firstElementChild.firstElementChild.matches(gone), false);
  assert.equal(hideCss({ notes: true }).includes(':not(:is('), false);
  assert.equal(hideCss({ notes: 'sometimes' }), hideCss({ notes: false }), 'anything else is no note');
});

test('with notes for your own filters, a post moves between note and gone as its reasons change, and clicks on one gone pass through', () => {
  const win = page(feed(post(1), post(2), post(3)));
  const [filtered, ad, dismissed] = win.document.querySelectorAll('[aria-posinset]');
  const hider = createHider({ doc: win.document, notesShown: () => OWN });
  hider.hide(filtered, 'Filter', 'cats');
  hider.hide(ad, 'Sponsored');
  hider.hide(dismissed, 'Dismissed');
  const note = filtered.firstElementChild;
  assert.deepEqual(buttonParts(note), ['button', '0', 'Hidden: Filter: cats. Show']);
  hider.hide(filtered, 'Sponsored');
  assert.deepEqual(buttonParts(note), [null, null, null], 'an ad as well: gone, no button');
  assert.equal(press(win, note).defaultPrevented, false, 'a click on it goes to Facebook');
  assert.equal(hider.isHidden(filtered), true);
  hider.show(filtered, 'Sponsored');
  assert.deepEqual(buttonParts(note), ['button', '0', 'Hidden: Filter: cats. Show'], 'the filter alone again: its note is back');

  // Show hidden on a note brings back the posts with a note, and the ad stays gone.
  press(win, note.firstElementChild);
  assert.equal(hider.isHidden(filtered), false);
  assert.equal(hider.isHidden(dismissed), false);
  assert.equal(hider.isHidden(ad), true, 'an ad hidden completely stays hidden');
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

test('Show hidden is drawn and read out in the chosen language', () => {
  setLanguage('ru');
  try {
    const win = page(feed(post(1)));
    const [a] = win.document.querySelectorAll('[aria-posinset]');
    const hider = createHider({ doc: win.document, posts: fakePosts(), notesShown: () => true });
    hider.hide(a, 'Sponsored');
    assert.equal(a.firstElementChild.firstElementChild.getAttribute('aria-label'), 'Показать скрытые');
    assert.match(hideCss({ notes: true }), /::before \{ all: unset !important; content: "Показать скрытые" !important;/);
  } finally {
    setLanguage('en');
  }
  assert.match(hideCss({ notes: true }), /content: "Show hidden" !important;/);
});

test("a hidden post's note reads in the chosen language, keeps the person's own word, and follows a change of language", () => {
  setLanguage('ru');
  try {
    const win = page(feed(post(1), post(2), post(3)));
    const [a, b, c] = win.document.querySelectorAll('[aria-posinset]');
    const hider = createHider({ doc: win.document, posts: fakePosts(), notesShown: () => true });
    hider.hide(a, 'Sponsored');
    hider.hide(b, 'Filter', 'football');
    hider.hide(c, 'People', undefined, undefined, () => t('People you may know'));
    const notes = () => [a, b, c].map((element) => element.firstElementChild.getAttribute(NOTE));
    assert.deepEqual(notes(), ['Скрыто: Реклама. Показать', 'Скрыто: Фильтр: football. Показать', 'Скрыто: Вы можете их знать. Показать']);
    assert.equal(a.firstElementChild.getAttribute('aria-label'), 'Скрыто: Реклама. Показать', 'the button is named by its note');
    setLanguage('en');
    hider.refresh();
    assert.deepEqual(notes(), ['Hidden: Sponsored. Show', 'Hidden: Filter: football. Show', 'Hidden: People you may know. Show']);
    assert.equal(a.firstElementChild.getAttribute('aria-label'), 'Hidden: Sponsored. Show');
  } finally {
    setLanguage('en');
  }
});

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
