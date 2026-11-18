// Facebook's j and k keys on a feed with hidden posts. The stand-in below follows what
// useCometFeedKeyCommands does on facebook.com (read 2026-11-18): it remembers a post number, and
// when that post isn't among the visible ones it starts again from the first one that is.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { createHider } from '../src/core/dom/hide.js';
import { keepFeedKeysMoving } from '../src/core/dom/feed-keys.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const POST_HEIGHT = 300;
const NOTE_HEIGHT = 40;
const FIRST_TOP = 100;
const BAR = 56;
const VIEWPORT = 800;

// claims: Facebook takes the key. moves: it also acts on it, rather than only claiming it.
function setup({ count = 8, hide = [], notes = false, claims = true, moves = true, active } = {}) {
  const win = testWindow('https://www.facebook.com/');
  windows.push(win);
  const doc = win.document;
  const hider = createHider({ doc });
  let scrollY = 0;
  const scrolls = [];
  Object.defineProperty(win, 'pageYOffset', { configurable: true, get: () => scrollY });
  Object.defineProperty(doc.documentElement, 'scrollHeight', { configurable: true, get: () => 9000 });
  win.scrollTo = (options) => {
    scrolls.push(options);
    scrollY = options.top;
  };

  const posts = Array.from({ length: count }, (_, i) => {
    const post = doc.createElement('div');
    post.setAttribute('aria-posinset', String(i + 1));
    post.append(doc.createElement('div'));
    doc.body.append(post);
    return post;
  });
  // With no note a hidden post is display:none: no box, and focus() does nothing. A post also refuses
  // focus until it has a tabindex, which Facebook only adds to the ones it has moved to.
  const gone = (post) => hider.isHidden(post) && !notes;
  const height = (post) => (hider.isHidden(post) ? (notes ? NOTE_HEIGHT : 0) : POST_HEIGHT);
  const pageTop = (post) => {
    let y = FIRST_TOP;
    for (const other of posts) {
      if (other === post) break;
      y += height(other);
    }
    return y;
  };
  for (const post of posts) {
    const focus = post.focus.bind(post);
    post.focus = (options) => {
      if (!gone(post) && post.hasAttribute('tabindex')) focus(options);
    };
    post.getClientRects = () => (gone(post) ? [] : [{}]);
    post.getBoundingClientRect = () => {
      const top = gone(post) ? 0 : pageTop(post) - scrollY;
      return { top, bottom: gone(post) ? 0 : top + height(post), left: 0, right: 0, width: 0, height: gone(post) ? 0 : height(post) };
    };
  }
  for (const index of hide) hider.hide(posts[index], 'Filter');

  // Facebook's tracker doesn't count a hidden post as visible, note or no note.
  const visible = () => posts.flatMap((post, index) => {
    if (hider.isHidden(post)) return [];
    const { top, bottom } = post.getBoundingClientRect();
    return bottom > BAR && top < VIEWPORT ? [index] : [];
  });
  let current = -1;
  const position = (forward) => {
    const units = visible();
    if (units.includes(current)) return current;
    const unit = forward ? units[0] : units[units.length - 1];
    return unit === 0 ? -1 : unit ?? -1;
  };
  const go = (index) => {
    const post = posts[index];
    post.setAttribute('tabindex', '-1');
    post.focus({ preventScroll: true });
    win.scrollTo({ behavior: 'smooth', top: post.getBoundingClientRect().top + scrollY - 76 });
    current = index;
  };
  doc.addEventListener('keydown', (event) => {
    if (!claims || (event.key !== 'j' && event.key !== 'k')) return;
    event.preventDefault();
    if (!moves) return;
    if (event.key === 'j') {
      const at = position(true);
      if (at < posts.length - 1) go(at + 1);
    } else {
      const at = position(false);
      if (at > 0) go(at - 1);
    }
  });

  keepFeedKeysMoving({ win, doc, hider, active });

  const press = async (key, init = {}) => {
    const target = doc.activeElement ?? doc.body;
    target.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true, ...init }));
    await new Promise((resolve) => win.setTimeout(resolve, 1));
    return doc.activeElement?.getAttribute?.('aria-posinset') ?? null;
  };
  const walk = async (key, times) => {
    const stops = [];
    for (let i = 0; i < times; i++) stops.push(await press(key));
    return stops;
  };
  return { win, doc, hider, posts, scrolls, press, walk, top: () => scrollY };
}

test('j goes past hidden posts, one shown post per press', async () => {
  const { walk } = setup({ hide: [2, 3, 5] });
  assert.deepEqual(await walk('j', 5), ['1', '2', '5', '7', '8']);
});

test('j goes past the note line of a hidden post without stopping on it', async () => {
  const { walk } = setup({ hide: [2, 3, 5], notes: true });
  assert.deepEqual(await walk('j', 5), ['1', '2', '5', '7', '8']);
});

test('k comes back over the same hidden posts', async () => {
  for (const notes of [false, true]) {
    const { walk } = setup({ hide: [2, 3, 5], notes });
    await walk('j', 5);
    assert.deepEqual(await walk('k', 4), ['7', '5', '2', '1'], `notes ${notes}`);
  }
});

test('the post moved to lands under the top bar, as Facebook places one', async () => {
  const { walk, posts, top } = setup({ hide: [1] });
  await walk('j', 2);
  assert.equal(posts[2].getBoundingClientRect().top, 76);
  assert.ok(top() > 0);
});

test('j from a note someone tabbed to moves on to the next shown post', async () => {
  const { press, doc, posts } = setup({ hide: [1], notes: true });
  posts[1].setAttribute('tabindex', '-1');
  posts[1].focus();
  assert.equal(doc.activeElement === posts[1], true);
  assert.equal(await press('j'), '3');
});

test('with hidden posts at the end, j scrolls down so more of the feed loads', async () => {
  const { walk, scrolls } = setup({ count: 4, hide: [2, 3] });
  await walk('j', 3);
  assert.equal(scrolls.at(-1).top, 9000);
});

test('k at the first shown post stays there, not on a hidden post above it', async () => {
  for (const notes of [false, true]) {
    const { walk, press } = setup({ count: 4, hide: [0], notes });
    await press('j');
    assert.deepEqual(await walk('k', 2), ['2', '2'], `notes ${notes}`);
  }
});

test('j at the last shown post stays there, not on a hidden post below it', async () => {
  for (const notes of [false, true]) {
    const { walk, scrolls } = setup({ count: 4, hide: [2, 3], notes });
    assert.deepEqual(await walk('j', 3), ['1', '2', '2'], `notes ${notes}`);
    assert.equal(scrolls.at(-1).top, 9000, `notes ${notes}`);
  }
});

test('a feed with nothing hidden is left to Facebook', async () => {
  const { walk, scrolls } = setup();
  assert.deepEqual(await walk('j', 4), ['1', '2', '3', '4']);
  assert.equal(scrolls.length, 4, 'one scroll per press, all of them its own');
});

test("a key Facebook doesn't claim does nothing, as with its shortcuts turned off", async () => {
  const { walk, scrolls } = setup({ hide: [0, 1], claims: false });
  assert.deepEqual(await walk('j', 2), [null, null]);
  assert.equal(scrolls.length, 0);
});

test('j with a modifier is not a feed move', async () => {
  const { press, scrolls } = setup({ hide: [0], claims: false });
  for (const init of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }]) await press('j', init);
  assert.equal(scrolls.length, 0);
});

test('typing in a box and working in a dialog are left alone', async () => {
  const typing = setup({ hide: [1, 2], moves: false });
  const box = typing.doc.createElement('textarea');
  typing.doc.body.append(box);
  box.focus();
  await typing.press('j');
  assert.equal(typing.doc.activeElement === box, true);
  assert.equal(typing.scrolls.length, 0);

  const open = setup({ hide: [1, 2], moves: false });
  const dialog = open.doc.createElement('div');
  dialog.setAttribute('role', 'dialog');
  const button = open.doc.createElement('button');
  dialog.append(button);
  open.doc.body.append(dialog);
  button.focus();
  await open.press('j');
  assert.equal(open.doc.activeElement === button, true);
  assert.equal(open.scrolls.length, 0);
});

test('posts in a dialog are not stops', async () => {
  const { doc, walk, posts } = setup({ count: 3, hide: [1] });
  const dialog = doc.createElement('div');
  dialog.setAttribute('role', 'dialog');
  doc.body.insertBefore(dialog, posts[2]);
  const inside = doc.createElement('div');
  inside.setAttribute('aria-posinset', '99');
  inside.setAttribute('tabindex', '-1');
  inside.getClientRects = () => [{}];
  inside.getBoundingClientRect = () => ({ top: 500, bottom: 600 });
  dialog.append(inside);
  assert.deepEqual(await walk('j', 2), ['1', '3']);
});

test('while the script is paused its marks are ignored', async () => {
  const { walk, scrolls } = setup({ hide: [1, 2], active: () => false });
  await walk('j', 3);
  assert.equal(scrolls.length, 3, "only Facebook's own scrolls");
});
