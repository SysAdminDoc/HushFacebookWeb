// Hide repeats of a post already on the page: a later copy by the same poster is hidden, the
// first stays, and nothing outlives the page.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { createDiagnostics, hideListener } from '../src/core/diagnostics.js';
import { createHider, MARK, NOTE } from '../src/core/dom/hide.js';
import { createPostTracker, postIdOf } from '../src/core/dom/posts.js';
import { parseRoute } from '../src/core/route.js';
import hideRepeatPosts from '../src/features/feed/hide-repeat-posts.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const TEXT = 'Selling a barely used kayak with two paddles, pick up downtown this weekend only';

function page(html, href = 'https://www.facebook.com/') {
  const win = testWindow(href);
  windows.push(win);
  win.document.body.innerHTML = `<div role="main"><div class="feed">${html}</div></div>`;
  return win;
}

// A post by name, or in a group by its member, with its words, a cut of them behind "See more",
// or a photo.
const post = (n, { name = 'Pat Example', group = null, text = TEXT, cut = false, photo = null } = {}) => {
  const head = group
    ? `<h4><a href="/groups/${group}/">Group ${group}</a></h4><span><a href="/groups/${group}/user/4242/">${name}</a></span>`
    : (name ? `<h4><a href="/pat.example.${n}">${name}</a></h4>` : '');
  const words = cut ? `${text.slice(0, 60)}…<div role="button">See more</div>` : text;
  const picture = photo ? `<a href="/photo/?fbid=${photo}&set=a.1"><img alt="" src="x.jpg"></a>` : '';
  return `<div><div aria-posinset="${n}"><div class="inner">${head}
    <div data-ad-rendering-role="story_message"><div>${words}</div></div>${picture}
  </div></div></div>`;
};

function setup(win, { on = true, href } = {}) {
  const doc = win.document;
  const diagnostics = createDiagnostics();
  const posts = createPostTracker({ doc });
  const hider = createHider({ doc, posts, onHide: hideListener(diagnostics, postIdOf) });
  const state = { on };
  const subscribers = [];
  const touched = [];
  const storage = new Proxy({}, { get: (_, key) => { touched.push(key); return () => undefined; } });
  hideRepeatPosts.setup({
    win, doc, storage, router: { current: () => parseRoute(href ?? win.location.href) }, posts, hider, diagnostics,
    settings: { subscribe: (fn) => subscribers.push(fn) }, enabled: () => state.on,
  });
  const flip = (value) => {
    state.on = value;
    for (const fn of subscribers) fn();
  };
  const rows = () => Object.fromEntries(diagnostics.rows().map(({ label, value }) => [label, value]));
  return { doc, posts, hider, diagnostics, flip, rows, touched };
}

const element = (doc, n) => doc.querySelector(`[aria-posinset="${n}"]`);
const note = (doc, n) => element(doc, n).querySelector(`[${MARK}]`)?.getAttribute(NOTE) ?? null;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('off to start, and kept on the Feed page without a parity row', () => {
  assert.equal(hideRepeatPosts.default, false);
  assert.equal(hideRepeatPosts.section, 'filters');
  assert.equal(hideRepeatPosts.webOnly, true);
  assert.equal(hideRepeatPosts.android, undefined);
});

test('a later copy by the same poster is hidden and the first stays, while someone else\'s same words stay', () => {
  const win = page(post(1) + post(2, { name: 'Sam Writer' }) + post(3) + post(4, { text: 'Something else entirely that is long enough to count' }));
  const { doc, posts, diagnostics, rows, touched } = setup(win);
  assert.equal(note(doc, 1), null, 'the first copy stays');
  assert.equal(note(doc, 2), null, 'another person\'s post with the same words is their own');
  assert.equal(note(doc, 3), 'Hidden: Repeat. Show');
  assert.equal(note(doc, 4), null);
  assert.equal(rows()['Repeats hidden on this page'], '1');
  const [decision] = diagnostics.decisions();
  assert.equal(decision.rule, 'Repeat');
  assert.equal(decision.signal, 'same text');
  assert.equal(decision.layer, 'page');
  assert.deepEqual(touched, [], 'nothing is stored');
  posts.stop();
});

test('a "See more" cut of the same words matches, and so does the same photo with other words', () => {
  const win = page(post(1, { cut: true }) + post(2) + post(3, { text: 'First copy of the photo with words of its own', photo: '99887766' }) + post(4, { text: 'Second copy of the photo, worded differently this time', photo: '99887766' }));
  const { doc, posts, diagnostics } = setup(win);
  assert.equal(note(doc, 1), null);
  assert.equal(note(doc, 2), 'Hidden: Repeat. Show', 'the full text matches its cut');
  assert.equal(note(doc, 3), null);
  assert.equal(note(doc, 4), 'Hidden: Repeat. Show');
  assert.deepEqual(diagnostics.decisions().map((decision) => decision.signal), ['same text', 'same photo or video']);
  posts.stop();
});

test('a member cross-posting to two groups is caught in the groups feed', () => {
  const win = page(post(1, { group: 111 }) + post(2, { group: 222 }) + post(3, { group: 333, name: 'Lee Other' }), 'https://www.facebook.com/groups/feed/');
  const { doc, posts } = setup(win);
  assert.equal(note(doc, 1), null);
  assert.equal(note(doc, 2), 'Hidden: Repeat. Show');
  assert.equal(note(doc, 3), null, 'another member');
  posts.stop();
});

test('pages other than Home and the groups feed are left alone', () => {
  const win = page(post(1) + post(2), 'https://www.facebook.com/pat.example');
  const { doc, posts } = setup(win);
  assert.equal(note(doc, 2), null);
  posts.stop();
});

test('a copy higher up that fills in later becomes the first, and the lower one goes', async () => {
  const win = page(post(1, { name: null }) + post(2));
  const { doc, posts } = setup(win);
  assert.equal(note(doc, 2), null, 'post 1 names nobody yet, so post 2 is the first copy');
  element(doc, 1).querySelector('.inner').insertAdjacentHTML('afterbegin', '<h4><a href="/pat.example">Pat Example</a></h4>');
  await wait(350);
  assert.equal(note(doc, 1), null);
  assert.equal(note(doc, 2), 'Hidden: Repeat. Show');
  posts.stop();
});

test('Show hidden brings repeats back, and the switch shows them off and hides them on', () => {
  const win = page(post(1) + post(2) + post(3, { text: 'Another post to repeat, long enough for a key' }) + post(4, { text: 'Another post to repeat, long enough for a key' }));
  const { doc, posts, hider, flip } = setup(win);
  assert.equal(note(doc, 2), 'Hidden: Repeat. Show');
  flip(false);
  assert.equal(note(doc, 2), null, 'off shows them');
  assert.equal(note(doc, 4), null);
  flip(true);
  assert.equal(note(doc, 2), 'Hidden: Repeat. Show', 'on again hides them again');
  assert.equal(note(doc, 4), 'Hidden: Repeat. Show');
  assert.equal(note(doc, 1), null);

  const marker = element(doc, 2).querySelector(`[${MARK}]`);
  const click = new win.MouseEvent('click', { bubbles: true, cancelable: true });
  marker.firstElementChild.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true);
  assert.equal(hider.isHidden(element(doc, 2)), false);
  assert.equal(hider.isHidden(element(doc, 4)), false, 'Show hidden shows every repeat');
  posts.stop();
});

test('a post opened in a dialog is neither a repeat nor a first copy', () => {
  // Ahead of the feed, so a dialog copy counted as the first would hide the feed's own post.
  const win = page(post(1));
  win.document.body.insertAdjacentHTML('afterbegin', `<div role="dialog" aria-label="Pat's post">${post(9)}</div>`);
  const { doc, posts } = setup(win);
  assert.equal(note(doc, 1), null);
  assert.equal(note(doc, 9), null);
  posts.stop();
});
