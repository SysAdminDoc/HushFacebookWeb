// Keep posts you hide hidden: Facebook's X at the top of a post, as drawn live on 2026-11-04
// (<a role="link" href="#" aria-label="Hide post by ..."> around a 20px cross), hides the post
// here, remembers it for the next load and never reaches Facebook's own handlers.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { createActions } from '../src/core/actions.js';
import { activityKeyFor, createActivityStorage } from '../src/core/activity.js';
import { createDiagnostics } from '../src/core/diagnostics.js';
import { createHider, MARK, NOTE } from '../src/core/dom/hide.js';
import { createPostTracker } from '../src/core/dom/posts.js';
import { transformDocumentLine } from '../src/core/net/payload.js';
import { parseRoute } from '../src/core/route.js';
import { textKey, wordsKey } from '../src/core/seen-keys.js';
import { createMemoryStorage } from '../src/core/storage.js';
import keepPostsHidden, { HIDDEN_KEY, MAX_HIDDEN, isHideControl } from '../src/features/feed/keep-posts-hidden.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

// Facebook's cross, path and all.
const X_PATH = 'M15.543 3.043a1 1 0 1 1 1.414 1.414L11.414 10l5.543 5.542a1 1 0 0 1-1.414 1.415L10 11.414l-5.543 5.543a1 1 0 0 1-1.414-1.415L8.586 10 3.043 4.457a1 1 0 1 1 1.414-1.414L10 8.586l5.543-5.543z';
const cross = (label) => `<a aria-label="${label}" href="#" role="link" tabindex="0" class="x"><svg viewBox="0 0 20 20" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="${X_PATH}"></path></svg><div role="none" data-visualcompletion="ignore" style="inset: 0px;"></div></a>`;

const words = (n) => `Post number ${n} with enough words to count`;
const post = (n, { text = words(n), label = 'Hide post by Pat Example', photo = true, extra = '', name = 'Pat Example' } = {}) => `
  <div><div aria-posinset="${n}">
    <div>
      <div data-ad-rendering-role="profile_name"><h4><a href="/${name.toLowerCase().replace(' ', '.')}">${name}</a></h4></div>
      <div role="button" aria-haspopup="menu" aria-expanded="false" aria-label="Actions for this post" class="dots"></div>
      ${label === null ? '' : cross(label)}
    </div>
    <div data-ad-rendering-role="story_message"><div>${text}</div></div>
    ${photo ? `<a href="/photo/?fbid=5555555${n}&set=a.1"><img alt="May be an image" src="x.jpg"></a>` : ''}
    ${extra}
  </div></div>`;
const keysOf = (n) => [`m:5555555${n}`, textKey(words(n))];
// A link shared with a few words on top, as the second X on Home was drawn live on 2026-11-04:
// an outside link with its title, and no photo or video of Facebook's.
const share = (title) => `<a href="https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2Fstory&h=AT0"><img src="preview.jpg" alt=""><div data-ad-rendering-role="title"><span>${title}</span></div></a>`;

// Facebook's handlers sit on its root, below the window and the document.
function page(html, href = 'https://www.facebook.com/') {
  const win = testWindow(href);
  windows.push(win);
  win.document.body.innerHTML = `<div id="root"><div role="main"><div class="feed">${html}</div></div></div>`;
  const heard = [];
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click', 'keydown', 'keyup']) {
    win.document.querySelector('#root').addEventListener(type, () => heard.push(type));
    win.document.querySelector('#root').addEventListener(type, () => heard.push(`${type} (capture)`), true);
  }
  return { win, heard };
}

// Storage that reports writes from "another tab" the way GM_addValueChangeListener does.
function sharedStorage(initial = {}) {
  const storage = createMemoryStorage(initial);
  const listeners = new Map();
  storage.onChange = (key, fn) => listeners.set(key, [...(listeners.get(key) ?? []), fn]);
  storage.remote = (key, value) => {
    storage.set(key, value);
    listeners.get(key)?.forEach((fn) => fn(value));
  };
  return storage;
}

function setup(win, { storage = sharedStorage(), href, net = null, on = { value: true }, clock = { now: 1000 } } = {}) {
  const doc = win.document;
  const posts = createPostTracker({ doc });
  const hider = createHider({ doc, posts });
  const diagnostics = createDiagnostics();
  const actions = createActions();
  const toasts = [];
  const subscribers = [];
  const errors = [];
  keepPostsHidden.setup({
    win, doc, net, router: { current: () => parseRoute(href ?? win.location.href) }, posts, hider, storage, diagnostics,
    actions: actions.for('keepPostsHidden'), toast: (message, options) => toasts.push({ message, ...options }),
    log: { warn() {}, info() {}, error: (message) => errors.push(message) }, settings: { subscribe: (fn) => subscribers.push(fn) },
    enabled: () => on.value, now: () => clock.now,
  });
  const button = (label) => actions.list('keepPostsHidden').find((action) => action.label === label);
  const rows = () => Object.fromEntries(diagnostics.rows().map(({ label, value }) => [label, value]));
  const flip = (value) => {
    on.value = value;
    subscribers.forEach((fn) => fn());
  };
  return { doc, posts, storage, toasts, button, rows, flip, errors, clock };
}

const postOf = (doc, n) => doc.querySelector(`[aria-posinset="${n}"]`);
const xOf = (doc, n) => postOf(doc, n).querySelector('a.x');
const note = (doc, n) => postOf(doc, n).querySelector(`[${MARK}]`)?.getAttribute(NOTE) ?? null;
// A mouse press on the cross itself, the way a person clicks it. Returns whether the click went
// through unprevented.
function press(win, target) {
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) target.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true }));
  return target.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
}
const key = (win, target, name, type = 'keydown') => target.dispatchEvent(new win.KeyboardEvent(type, { key: name, bubbles: true, cancelable: true }));

test("the X hides the post, keeps it for the next load, and Facebook's handlers never hear the press", () => {
  const storage = sharedStorage();
  const { win, heard } = page(post(1) + post(2));
  const { doc, posts, toasts, rows, flip } = setup(win, { storage, clock: { now: 5000 } });
  assert.equal(note(doc, 1), null);

  assert.equal(press(win, xOf(doc, 1).querySelector('path')), false, 'the link to # is not followed');
  assert.deepEqual(heard, []);
  assert.equal(note(doc, 1), 'Hidden: Dismissed. Show');
  assert.equal(note(doc, 2), null);
  assert.deepEqual(storage.get(HIDDEN_KEY), Object.fromEntries(keysOf(1).map((k) => [k, 5000])));
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].message, 'Post hidden. It stays hidden when the feed loads again.');
  assert.equal(toasts[0].action.label, 'Undo');
  assert.equal(rows()['Hidden posts remembered'], '2');
  // The page check finds it again (the switch off and on), and it still isn't counted.
  flip(false);
  flip(true);
  assert.equal(note(doc, 1), 'Hidden: Dismissed. Show');
  assert.equal(rows()['Hidden posts kept away'], '0 hidden on the page', 'the one you pressed is not counted as kept away');

  // The post's other controls still reach Facebook.
  press(win, postOf(doc, 2).querySelector('.dots'));
  assert.ok(heard.includes('click') && heard.includes('pointerdown (capture)'));
  posts.stop();

  // The feed loads again: post 1 is hidden from the start, post 2 isn't.
  const again = page(post(2) + post(1));
  const next = setup(again.win, { storage });
  assert.equal(note(next.doc, 1), 'Hidden: Dismissed. Show');
  assert.equal(note(next.doc, 2), null);
  assert.equal(next.rows()['Hidden posts kept away'], '1 hidden on the page');
  next.posts.stop();
});

test('Enter and Space on the X hide it too, and a held key or a second press adds nothing', () => {
  for (const name of ['Enter', ' ']) {
    const storage = sharedStorage();
    const { win, heard } = page(post(1));
    const { doc, posts, toasts } = setup(win, { storage });
    const x = xOf(doc, 1);
    assert.equal(key(win, x, name), false, 'the key does nothing else, a scroll or the link');
    assert.equal(key(win, x, name), false);
    assert.equal(key(win, x, name, 'keyup'), false);
    assert.equal(press(win, x), false);
    assert.deepEqual(heard, [], JSON.stringify(name));
    assert.equal(note(doc, 1), 'Hidden: Dismissed. Show');
    assert.equal(toasts.length, 1, 'one toast');
    assert.deepEqual(Object.keys(storage.get(HIDDEN_KEY)).sort(), keysOf(1).sort());
    // Other keys on the X are Facebook's.
    key(win, x, 'Tab');
    assert.deepEqual(heard, ['keydown (capture)', 'keydown']);
    posts.stop();
  }
});

test('Undo brings the post back and forgets only what its X added', () => {
  const storage = sharedStorage({ [HIDDEN_KEY]: { 'm:99999999': 10, [keysOf(1)[1]]: 20 } });
  const { win, heard } = page(post(1, { photo: false, extra: '<a href="/photo/?fbid=77777777&set=a.1">x</a>' }) + post(2));
  // Post 1 was already hidden by its words, so only post 2 has an X to press.
  const { doc, posts, toasts, rows } = setup(win, { storage });
  assert.equal(note(doc, 1), 'Hidden: Dismissed. Show');
  press(win, xOf(doc, 2));
  assert.deepEqual(heard, []);
  assert.equal(rows()['Hidden posts remembered'], '4');
  toasts[0].action.run();
  assert.equal(note(doc, 2), null);
  assert.equal(note(doc, 1), 'Hidden: Dismissed. Show', 'a post hidden on an earlier visit stays hidden');
  assert.deepEqual(storage.get(HIDDEN_KEY), { 'm:99999999': 10, [keysOf(1)[1]]: 20 });
  assert.equal(rows()['Hidden posts remembered'], '2');
  // Pressed again after the Undo, it hides again.
  press(win, xOf(doc, 2));
  assert.equal(note(doc, 2), 'Hidden: Dismissed. Show');
  assert.equal(toasts.length, 2);
  posts.stop();
});

test("Undo keeps a key another post's X added, and the post sharing it stays hidden", () => {
  const shared = '<a href="/photo/?fbid=44444444&set=a.1">pic</a>';
  const storage = sharedStorage();
  const { win } = page(post(1, { photo: false, extra: shared }) + post(2, { photo: false, extra: shared }));
  const { doc, posts, toasts } = setup(win, { storage, clock: { now: 70 } });
  press(win, xOf(doc, 1));
  // Post 2 shows the same photo. Its own look found nothing before the press, so it's still up.
  assert.equal(note(doc, 2), null);
  press(win, xOf(doc, 2));
  toasts[1].action.run();
  assert.deepEqual(storage.get(HIDDEN_KEY), { 'm:44444444': 70, [textKey(words(1))]: 70 });
  assert.equal(note(doc, 2), 'Hidden: Dismissed. Show', 'the photo post 1 hid is still hidden');
  posts.stop();
});

test("a post shown again from its note leaves its X to Facebook, and one shown by Forget or another tab hides again", () => {
  const storage = sharedStorage();
  const { win, heard } = page(post(1) + post(2));
  const { doc, posts, toasts, button } = setup(win, { storage });
  press(win, xOf(doc, 1));
  postOf(doc, 1).querySelector(`[${MARK}]`).dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(note(doc, 1), null);
  assert.equal(press(win, xOf(doc, 1)), true, "the X is Facebook's");
  assert.deepEqual(heard.filter((type) => !type.endsWith('(capture)')), ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'], 'the whole press, not just its click');
  assert.equal(note(doc, 1), null);
  assert.equal(toasts.length, 1);

  heard.length = 0;
  press(win, xOf(doc, 2));
  button('Forget posts you hid').run();
  assert.equal(note(doc, 2), null);
  assert.equal(press(win, xOf(doc, 2)), false);
  assert.deepEqual(heard, []);
  assert.equal(note(doc, 2), 'Hidden: Dismissed. Show');
  assert.deepEqual(Object.keys(storage.get(HIDDEN_KEY)).sort(), keysOf(2).sort());
  storage.remote(HIDDEN_KEY, {});
  assert.equal(note(doc, 2), null);
  assert.equal(press(win, xOf(doc, 2)), false);
  assert.equal(note(doc, 2), 'Hidden: Dismissed. Show');
  assert.equal(toasts.filter((toast) => toast.action).length, 4);
  posts.stop();
});

test('a key the extension would refuse is left out, so the rest still saves', () => {
  const long = '1'.repeat(40);
  const storage = sharedStorage();
  const { win } = page(post(1, { photo: false, extra: `<a href="/photo/?fbid=${long}&set=a.1">pic</a>` }));
  const { doc, posts } = setup(win, { storage, clock: { now: 9 } });
  press(win, xOf(doc, 1));
  assert.deepEqual(storage.get(HIDDEN_KEY), { [textKey(words(1))]: 9 });
  posts.stop();
});

test('a post you hid is only hidden on Home and in the groups feed', () => {
  for (const href of ['https://www.facebook.com/pat.example', 'https://www.facebook.com/pat.example/posts/pfbid0P1', 'https://www.facebook.com/search/posts/?q=sunset', 'https://www.facebook.com/groups/feed/']) {
    const storage = sharedStorage({ [HIDDEN_KEY]: { [keysOf(1)[0]]: 10 } });
    const { win } = page(post(1), href);
    const { doc, posts } = setup(win, { storage, href });
    assert.equal(note(doc, 1), href.endsWith('/groups/feed/') ? 'Hidden: Dismissed. Show' : null, href);
    posts.stop();
  }
});

test('a link shared with a few words is remembered by who posted it, its words and its title', () => {
  const storage = sharedStorage();
  const short = { photo: false, text: 'Nice one' };
  const { win, heard } = page(post(1, { ...short, extra: share('Ten places to eat downtown') }));
  const { doc, posts, toasts } = setup(win, { storage, clock: { now: 40 } });
  assert.equal(press(win, xOf(doc, 1)), false);
  assert.deepEqual(heard, []);
  assert.equal(note(doc, 1), 'Hidden: Dismissed. Show');
  const saved = Object.keys(storage.get(HIDDEN_KEY));
  assert.deepEqual(saved, [wordsKey(postOf(doc, 1), 'Pat Example')]);
  assert.match(saved[0], /^w:[0-9a-z]{2,14}$/, 'a key the extension keeps');
  assert.equal(toasts[0].message, 'Post hidden. It stays hidden when the feed loads again.');
  posts.stop();

  // The feed loads again. Only the same words and title from the same person match, and only on
  // a post with nothing else to know it by.
  const again = page(post(2, { ...short, extra: share('Five places to eat uptown') })
    + post(3, { ...short, name: 'Sam Other', label: 'Hide post by Sam Other', extra: share('Ten places to eat downtown') })
    + post(4, { text: 'Nice one', extra: share('Ten places to eat downtown') })
    + post(1, { ...short, extra: share('Ten places to eat downtown') }));
  const next = setup(again.win, { storage });
  assert.equal(note(next.doc, 1), 'Hidden: Dismissed. Show');
  for (const n of [2, 3, 4]) assert.equal(note(next.doc, n), null, `post ${n}`);
  next.posts.stop();
});

test('a post with nothing to know it by is hidden until the page loads again', () => {
  const storage = sharedStorage();
  const bare = () => post(1, { photo: false, text: '' });
  const { win, heard } = page(bare() + post(2));
  const { doc, posts, toasts, button } = setup(win, { storage });
  assert.equal(press(win, xOf(doc, 1)), false);
  assert.deepEqual(heard, []);
  assert.equal(note(doc, 1), 'Hidden: Dismissed. Show');
  assert.equal(storage.get(HIDDEN_KEY, null), null, 'who posted it alone is no key');
  assert.equal(toasts[0].message, "Post hidden for now. There's nothing in it to know it by when the feed loads again.");
  // Undo on another post's toast shows that one and leaves this one hidden.
  press(win, xOf(doc, 2));
  toasts[1].action.run();
  assert.equal(note(doc, 2), null);
  assert.equal(note(doc, 1), 'Hidden: Dismissed. Show');
  // Its own Undo shows it, and the X hides it again.
  toasts[0].action.run();
  assert.equal(note(doc, 1), null);
  assert.equal(press(win, xOf(doc, 1)), false);
  assert.equal(note(doc, 1), 'Hidden: Dismissed. Show');
  // Forget posts you hid lets it back for good.
  button('Forget posts you hid').run();
  storage.remote(HIDDEN_KEY, { [keysOf(2)[0]]: 10 });
  assert.equal(note(doc, 1), null);
  assert.equal(note(doc, 2), 'Hidden: Dismissed. Show');
  posts.stop();

  const again = page(bare());
  const next = setup(again.win, { storage });
  assert.equal(note(next.doc, 1), null);
  next.posts.stop();
});

test('the switch off and pages other than Home and the groups feed leave the X to Facebook', () => {
  const cases = [
    ['switch off', post(1), { on: { value: false } }],
    ['a profile', post(1), { href: 'https://www.facebook.com/pat.example' }],
    ['a post opened by its link', post(1), { href: 'https://www.facebook.com/pat.example/posts/pfbid0P1' }],
    ['search', post(1), { href: 'https://www.facebook.com/search/posts/?q=sunset' }],
  ];
  for (const [label, html, options] of cases) {
    const storage = sharedStorage();
    const { win, heard } = page(html, options.href);
    const { doc, posts, toasts } = setup(win, { storage, ...options });
    assert.equal(press(win, xOf(doc, 1)), true, label);
    assert.ok(heard.includes('click') && heard.includes('mousedown'), label);
    assert.equal(note(doc, 1), null, label);
    assert.equal(toasts.length, 0, label);
    assert.equal(storage.get(HIDDEN_KEY, null), null, label);
    posts.stop();
  }
});

test('only the X on the post itself counts, by its English label or by its cross and the name of who posted', () => {
  const close = cross('Close');
  const { win, heard } = page(post(1, { label: null, extra: `<div role="article" aria-label="Comment by Sam">${close}<div>Comment text</div></div>` })
    + post(2, { label: 'Ocultar publicación de Pat Example' })
    + post(3, { label: 'Remove' })
    + post(4, { label: 'Hide post' }));
  const doc = win.document;
  assert.equal(isHideControl(postOf(doc, 1).querySelector('a.x'), postOf(doc, 1)), false, "a comment's close cross");
  assert.equal(isHideControl(xOf(doc, 2), postOf(doc, 2)), true, 'another language, naming who posted');
  assert.equal(isHideControl(xOf(doc, 3), postOf(doc, 3)), false, "a cross that doesn't name who posted");
  assert.equal(isHideControl(xOf(doc, 4), postOf(doc, 4)), true);
  assert.equal(isHideControl(xOf(doc, 4), postOf(doc, 2)), false, "another post's X");
  assert.equal(isHideControl(postOf(doc, 4).querySelector('.dots'), postOf(doc, 4)), false, 'the three-dot button');
  // The same text without the X's shape is just text.
  const plain = doc.createElement('a');
  plain.setAttribute('href', '/help');
  plain.textContent = 'Hide post';
  postOf(doc, 3).append(plain);
  assert.equal(isHideControl(plain, postOf(doc, 3)), false);

  const { posts } = setup(win, { storage: sharedStorage() });
  const clicks = () => heard.filter((type) => type === 'click').length;
  press(win, postOf(doc, 1).querySelector('a.x'));
  press(win, xOf(doc, 3));
  assert.equal(clicks(), 2, 'both crosses reach Facebook');
  press(win, xOf(doc, 2));
  assert.equal(clicks(), 2);
  assert.equal(note(doc, 2), 'Hidden: Dismissed. Show');
  posts.stop();
});

test('switching it off shows the posts, on hides them again, and Forget posts you hid empties the list', () => {
  const storage = sharedStorage({ [HIDDEN_KEY]: { [keysOf(1)[0]]: 10 } });
  const { win } = page(post(1) + post(2));
  const { doc, posts, flip, button, rows, toasts } = setup(win, { storage });
  assert.equal(note(doc, 1), 'Hidden: Dismissed. Show');
  flip(false);
  assert.equal(note(doc, 1), null);
  flip(true);
  assert.equal(note(doc, 1), 'Hidden: Dismissed. Show');
  button('Forget posts you hid').run();
  assert.equal(note(doc, 1), null);
  assert.deepEqual(storage.get(HIDDEN_KEY), {});
  assert.equal(rows()['Hidden posts remembered'], '0');
  assert.equal(toasts.at(-1).message, 'Forgot every post you hid');
  posts.stop();
});

test('the list keeps the newest keys, MAX_HIDDEN at most', () => {
  const full = Object.fromEntries(Array.from({ length: MAX_HIDDEN }, (_, i) => [`m:${1000000 + i}`, 100 + i]));
  const storage = sharedStorage({ [HIDDEN_KEY]: full });
  const { win } = page(post(1));
  const { doc, posts } = setup(win, { storage, clock: { now: 1e9 } });
  press(win, xOf(doc, 1));
  const kept = storage.get(HIDDEN_KEY);
  assert.equal(Object.keys(kept).length, MAX_HIDDEN);
  for (const k of keysOf(1)) assert.equal(kept[k], 1e9);
  assert.equal(kept['m:1000000'], undefined, 'the oldest went');
  assert.equal(kept['m:1000001'], undefined);
  assert.equal(kept['m:1000002'], 102);
  posts.stop();
});

test("another tab's X hides the post here, and another tab forgetting the list shows it", () => {
  const storage = sharedStorage();
  const { win } = page(post(1) + post(2));
  const { doc, posts } = setup(win, { storage });
  storage.remote(HIDDEN_KEY, { [keysOf(2)[0]]: 10 });
  assert.equal(note(doc, 2), 'Hidden: Dismissed. Show');
  storage.remote(HIDDEN_KEY, {});
  assert.equal(note(doc, 2), null);
  posts.stop();
});

test('in page mode the data rule drops hidden stories from Home, keeps the ones the server drew, and leaves search alone', () => {
  const rules = [];
  const storage = sharedStorage({ [HIDDEN_KEY]: { 'm:99887766': 10 } });
  const { win } = page(post(1, { extra: '<a href="/photo/?fbid=99887766&set=a.1">pic</a>' }));
  const { doc, posts, rows } = setup(win, { storage, net: { transformResponses: (rule) => rules.push(rule) } });
  const [rule] = rules;
  assert.deepEqual(rule.markers, ['"__isFeedUnit"']);
  const story = (id, media) => ({ __typename: 'Story', __isFeedUnit: 'Story', id, attachments: [{ media: { __typename: 'Photo', id: media } }] });
  const line = JSON.stringify({ data: { viewer: { news_feed: { edges: [{ node: story('s1', '99887766'), cursor: 'c1' }, { node: story('s2', '12345678'), cursor: 'c2' }] } } } });
  const feed = { transport: 'xhr', path: '/api/graphql/', friendlyName: 'CometNewsFeedPaginationQuery' };
  const out = JSON.parse(transformDocumentLine(line, [rule], feed));
  assert.deepEqual(out.data.viewer.news_feed.edges.map((edge) => edge.node?.id ?? null), [null, 's2']);
  assert.equal(out.data.viewer.news_feed.edges[0].cursor, 'c1', 'paging still works');
  assert.equal(transformDocumentLine(line, [rule], { ...feed, friendlyName: 'SearchCometResultsPaginatedResultsQuery' }), line);
  // The page's own first answer keeps the story, and the page check hides its post.
  const inline = { transport: 'json-parse', method: '', url: '', host: '', path: '', friendlyName: '' };
  const drawn = JSON.stringify({ data: { viewer: { news_feed: { edges: [{ node: story('s1', '99887766'), cursor: 'c1' }] } } }, extensions: { is_final: false } });
  assert.equal(transformDocumentLine(drawn, [rule], inline), drawn);
  assert.equal(note(doc, 1), 'Hidden: Dismissed. Show');
  assert.equal(rows()['Hidden posts kept away'], '1 taken out of the data, 1 hidden on the page');
  // The same story in inline data the server didn't draw is taken out.
  const streamed = JSON.stringify({ data: { viewer: { news_feed: { edges: [{ node: story('s1', '99887766'), cursor: 'c1' }] } } } });
  assert.deepEqual(JSON.parse(transformDocumentLine(streamed, [rule], inline)).data.viewer.news_feed.edges.map((edge) => edge.node?.id ?? null), [null]);
  posts.stop();
});

// The extension's storage, which fills a few milliseconds after the script starts (core/bridge.js).
function lateStorage(saved) {
  const data = new Map();
  const waiting = [];
  let loaded = false;
  const writes = [];
  return {
    writes,
    get: (k, fallback) => (data.has(k) ? structuredClone(data.get(k)) : fallback),
    set: (k, value) => {
      writes.push(k);
      data.set(k, structuredClone(value));
    },
    remove: (k) => data.delete(k),
    onChange() {},
    whenReady(run) {
      if (loaded) run();
      else waiting.push(run);
    },
    load() {
      for (const [k, value] of Object.entries(saved)) data.set(k, structuredClone(value));
      loaded = true;
      for (const run of waiting.splice(0)) run();
    },
  };
}

test("an X pressed before the extension's storage loads goes on top of the saved list, not over it", () => {
  const storage = lateStorage({ [HIDDEN_KEY]: { 'm:77777777': 10 } });
  const { win } = page(post(1) + post(2, { extra: '<a href="/photo/?fbid=77777777&set=a.1">pic</a>' }));
  const { doc, posts, rows } = setup(win, { storage, clock: { now: 50 } });
  press(win, xOf(doc, 1));
  assert.equal(note(doc, 1), 'Hidden: Dismissed. Show');
  assert.deepEqual(storage.writes, [], 'nothing written yet');
  assert.equal(note(doc, 2), null);
  storage.load();
  assert.deepEqual(storage.get(HIDDEN_KEY), { 'm:77777777': 10, ...Object.fromEntries(keysOf(1).map((k) => [k, 50])) });
  assert.equal(note(doc, 2), 'Hidden: Dismissed. Show', 'the saved list hides its post once it loads');
  assert.equal(rows()['Hidden posts remembered'], '3');
  posts.stop();
});

test("each account keeps its own list, and the page signing in as someone else lets the posts back", () => {
  const A = '615000000000035';
  const base = createMemoryStorage({ [activityKeyFor(HIDDEN_KEY, A)]: { [keysOf(1)[0]]: 10 }, [activityKeyFor(HIDDEN_KEY, '615000000000036')]: { [keysOf(2)[0]]: 10 } });
  const signedIn = { account: A };
  const activity = createActivityStorage({ storage: base, account: A, currentAccount: () => signedIn.account, log: { warn() {}, error() {}, info() {} } });
  const { win, heard } = page(post(1) + post(2) + post(3) + post(4, { photo: false, text: '' }));
  const { doc, posts, toasts, flip } = setup(win, { storage: activity.storage });
  assert.equal(note(doc, 1), 'Hidden: Dismissed. Show');
  assert.equal(note(doc, 2), null, "the other account's list isn't read");
  press(win, xOf(doc, 3));
  press(win, xOf(doc, 4));
  assert.deepEqual(Object.keys(base.get(activityKeyFor(HIDDEN_KEY, A))).sort(), [keysOf(1)[0], ...keysOf(3)].sort());
  signedIn.account = '615000000000036';
  // The next press notices. Nothing can be saved for this page now, so the X is Facebook's.
  assert.equal(press(win, xOf(doc, 2)), true);
  assert.deepEqual(heard.filter((type) => !type.endsWith('(capture)')), ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  // The switch off and on again doesn't bring back the one hidden for the visit.
  flip(false);
  flip(true);
  for (const n of [1, 2, 3, 4]) assert.equal(note(doc, n), null, `post ${n}`);
  assert.equal(toasts.length, 2, 'no promise that it stays hidden');
  assert.deepEqual(base.get(activityKeyFor(HIDDEN_KEY, '615000000000036')), { [keysOf(2)[0]]: 10 });
  posts.stop();
});
