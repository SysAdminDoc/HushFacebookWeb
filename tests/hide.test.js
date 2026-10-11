// The hider against small HTML fixtures shaped like facebook.com's feed: posts are
// div[aria-posinset] under a plain feed div. The rule that matters most is that nothing is
// written on the post or on the feed's children, only on the post's first child.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { MARK, NOTE, createHider, hideCss } from '../src/core/dom/hide.js';
import { createPostTracker } from '../src/core/dom/posts.js';
import { createSettings } from '../src/core/settings.js';
import { createMemoryStorage } from '../src/core/storage.js';
import { renderFeatureCss } from '../src/core/style.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

function page(html) {
  const win = new Window({ url: 'https://www.facebook.com/' });
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
  marker.dispatchEvent(event);

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(facebook, []);
  assert.equal(hider.isHidden(element), false);
  assert.equal(marker.hasAttribute(NOTE), false);
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
