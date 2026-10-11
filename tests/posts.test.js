// The post tracker against small HTML fixtures shaped like facebook.com's markup on
// 2026-10-10: feed posts are div[aria-posinset] under plain divs, comments are role=article,
// each post carries a decoy blockquote and an aria-hidden block.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { classifyCandidate, createPostTracker, postIdFromHrefs, postIdOf } from '../src/core/dom/posts.js';

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

const post = (n, href = `/someone/posts/pfbid0Post${n}`) => `
  <div aria-posinset="${n}" aria-describedby="d${n}">
    <h4><a href="/someone">Someone</a></h4>
    <a href="${href}">2h</a>
    <div data-ad-rendering-role="story_message">Post number ${n}</div>
    <blockquote>Facebook</blockquote>
    <div aria-hidden="true" data-0="x"></div>
  </div>`;

const feed = (...posts) => `<div role="main"><div><div><div class="feed">${posts.join('')}</div></div></div></div>`;

test('a feed post counts and its id comes from its permalink', () => {
  const win = page(feed(post(1)));
  const element = win.document.querySelector('[aria-posinset]');
  assert.deepEqual(classifyCandidate(element), { ok: true, kind: 'feed' });
  assert.deepEqual(postIdOf(element), { id: 'pfbid0Post1', source: 'permalink' });
});

test('nested: a shared post inside a post is not a post of its own', () => {
  const win = page(feed(`<div aria-posinset="1"><a href="/a/posts/111">1h</a><div role="article"><a href="/b/posts/222">3d</a>Shared</div></div>`));
  const inner = win.document.querySelector('[role="article"]');
  assert.deepEqual(classifyCandidate(inner), { ok: false, reason: 'nested', retry: false });
  assert.equal(postIdOf(win.document.querySelector('[aria-posinset]')).id, '111', "the outer post keeps its own id, not the shared one's");
});

test('comment: a role=article whose own link carries comment_id', () => {
  const win = page(`<div role="article" aria-label="Kommentar von Sam"><a href="/a/posts/111?comment_id=999&__cft__[0]=x">5m</a>Nice</div>`);
  assert.deepEqual(classifyCandidate(win.document.querySelector('[role="article"]')), { ok: false, reason: 'comment', retry: false });
});

test('comment: an English "Comment by" label is enough', () => {
  const win = page('<div role="article" aria-label="Comment by Sam"><span>Nice</span></div>');
  assert.equal(classifyCandidate(win.document.querySelector('[role="article"]')).reason, 'comment');
});

test('a permalink post that holds comments is still a post', () => {
  const win = page(`<div role="article"><a href="/a/posts/111">1h</a>Post<div role="article" aria-label="Comment by Sam"><a href="/a/posts/111?comment_id=9">5m</a></div></div>`);
  const [outer, comment] = win.document.querySelectorAll('[role="article"]');
  assert.deepEqual(classifyCandidate(outer), { ok: true, kind: 'article' });
  assert.equal(classifyCandidate(comment).reason, 'nested');
});

test('loading: a skeleton with a progressbar and no links waits', () => {
  const win = page(feed('<div aria-posinset="1"><div role="progressbar" aria-label="Loading..."></div></div>'));
  assert.deepEqual(classifyCandidate(win.document.querySelector('[aria-posinset]')), { ok: false, reason: 'loading', retry: true });
});

test('a video post with a buffering progressbar still counts', () => {
  const win = page(feed('<div aria-posinset="1"><a href="/a/posts/1">1h</a><video></video><div role="progressbar"></div></div>'));
  assert.equal(classifyCandidate(win.document.querySelector('[aria-posinset]')).ok, true);
});

test('empty: a placeholder with nothing drawn yet waits', () => {
  const win = page(feed('<div aria-posinset="1"><div><div></div></div></div>'));
  assert.deepEqual(classifyCandidate(win.document.querySelector('[aria-posinset]')), { ok: false, reason: 'empty', retry: true });
});

test('form: candidates inside a form (the composer preview) are skipped', () => {
  const win = page('<form><div role="article"><a href="/a/posts/1">preview</a></div></form>');
  assert.deepEqual(classifyCandidate(win.document.querySelector('[role="article"]')), { ok: false, reason: 'form', retry: false });
});

test('detached elements are never posts', () => {
  const win = page(feed(post(1)));
  const element = win.document.querySelector('[aria-posinset]');
  element.remove();
  assert.equal(classifyCandidate(element).reason, 'detached');
});

test('the id ladder: permalink, then pfbid anywhere, then story_fbid, then a comment id', () => {
  assert.deepEqual(postIdFromHrefs(['/groups/5/permalink/777/', '/x?story_fbid=888']), { id: '777', source: 'permalink' });
  assert.deepEqual(postIdFromHrefs(['/photo/?fbid=1&set=pcb.2', '/watch/?ref=pfbid0Abc']), { id: 'pfbid0Abc', source: 'pfbid' });
  assert.deepEqual(postIdFromHrefs(['/permalink.php?story_fbid=pfbid0Zz9&id=4']), { id: 'pfbid0Zz9', source: 'pfbid' });
  assert.deepEqual(postIdFromHrefs(['/story.php?story_fbid=12345&id=4']), { id: '12345', source: 'story_fbid' });
  assert.deepEqual(postIdFromHrefs(['/a/posts/111?comment_id=999']), { id: '999', source: 'comment_id' });
  assert.deepEqual(postIdFromHrefs(['/a/posts/111?comment_id=999', '/a/posts/222']), { id: '222', source: 'permalink' });
  assert.deepEqual(postIdFromHrefs(['/someone', '#']), { id: null, source: null });
});

test('the tracker reports posts as they arrive and leave, and resets when all are gone', async () => {
  const win = page(feed(post(1)));
  const tracker = createPostTracker({ doc: win.document });
  const events = [];
  tracker.on('post/add', (p) => events.push(['add', p.id, p.kind]));
  tracker.on('post/remove', (p) => events.push(['remove', p.id]));
  tracker.on('reset', () => events.push(['reset']));
  assert.deepEqual(events, [['add', 'pfbid0Post1', 'feed']], 'posts already on the page are found at start');

  const list = win.document.querySelector('.feed');
  list.insertAdjacentHTML('beforeend', post(2) + post(3));
  await tick();
  assert.deepEqual(events.slice(1), [['add', 'pfbid0Post2', 'feed'], ['add', 'pfbid0Post3', 'feed']]);
  assert.equal(tracker.current().length, 3);

  list.querySelector('[aria-posinset="2"]').remove();
  await tick();
  assert.deepEqual(events.at(-1), ['remove', 'pfbid0Post2']);

  list.replaceChildren();
  await tick();
  assert.deepEqual(events.slice(-3), [['remove', 'pfbid0Post1'], ['remove', 'pfbid0Post3'], ['reset']]);
  assert.equal(tracker.current().length, 0);
  tracker.stop();
});

test('a skeleton becomes a post once Facebook fills it in', async () => {
  const win = page(feed('<div aria-posinset="1"><div role="progressbar"></div></div>'));
  const tracker = createPostTracker({ doc: win.document });
  const added = [];
  tracker.on('post/add', (p) => added.push(p.id));
  assert.deepEqual(added, []);
  const skeleton = win.document.querySelector('[aria-posinset]');
  skeleton.replaceChildren();
  skeleton.insertAdjacentHTML('beforeend', '<a href="/a/posts/42">1h</a><div>Hello</div>');
  await tick();
  assert.deepEqual(added, ['42']);
  tracker.stop();
});

test('an id that shows up late is an update, a different story in the same element is remove and add', async () => {
  const win = page(feed('<div aria-posinset="1"><a href="#">2h</a><div>Text</div></div>'));
  const tracker = createPostTracker({ doc: win.document });
  const events = [];
  for (const type of ['post/add', 'post/update', 'post/remove']) tracker.on(type, (p) => events.push([type, p.id]));
  assert.deepEqual(events, [['post/add', null]]);

  const link = win.document.querySelector('[aria-posinset] a');
  link.setAttribute('href', '/a/posts/500?__cft__[0]=AZ');
  await tick();
  assert.deepEqual(events.at(-1), ['post/update', '500']);

  link.insertAdjacentHTML('afterend', '<a href="/b/posts/pfbid0Other">shared link</a>');
  await tick();
  assert.equal(events.length, 2, 'a second link while the first id is still there changes nothing');

  win.document.querySelector('[aria-posinset]').innerHTML = '<a href="/c/posts/600">1m</a><div>Recycled</div>';
  await tick();
  assert.deepEqual(events.slice(-2), [['post/remove', '500'], ['post/add', '600']]);
  tracker.stop();
});

test('nothing is written on the page, and only one observer watches it', async () => {
  const win = page(feed(post(1), post(2)));
  let observers = 0;
  const Original = win.MutationObserver;
  win.MutationObserver = class extends Original {
    constructor(callback) {
      super(callback);
      observers++;
    }
  };
  const attributes = (element) => element.getAttributeNames().map((name) => `${name}=${element.getAttribute(name)}`).join(' ');
  const original = [...win.document.body.querySelectorAll('*')].map((element) => [element, attributes(element)]);
  const tracker = createPostTracker({ doc: win.document });
  const added = [];
  tracker.on('post/add', (p) => added.push(p.id));
  tracker.on('post/remove', () => {});
  tracker.on('reset', () => {});
  const list = win.document.querySelector('.feed');
  list.insertAdjacentHTML('beforeend', post(3));
  await tick();
  assert.deepEqual(added, ['pfbid0Post1', 'pfbid0Post2', 'pfbid0Post3']);
  assert.equal(observers, 1);
  for (const [element, before] of original) assert.equal(attributes(element), before);
  assert.equal(attributes(list.lastElementChild), 'aria-posinset=3 aria-describedby=d3', "the feed's own child carries only Facebook's attributes");
  tracker.stop();
});

test('the tracker does nothing until a feature subscribes', async () => {
  const win = page(feed(post(1)));
  let observers = 0;
  const Original = win.MutationObserver;
  win.MutationObserver = class extends Original {
    constructor(callback) {
      super(callback);
      observers++;
    }
  };
  const tracker = createPostTracker({ doc: win.document });
  assert.equal(observers, 0);
  assert.deepEqual(tracker.current(), []);
  assert.throws(() => tracker.on('post/added', () => {}), /Unknown post event/);
  tracker.on('post/add', () => {});
  assert.equal(observers, 1);
  assert.equal(tracker.current().length, 1);
  tracker.stop();
});

test('a listener that throws is logged and the others still run', async () => {
  const win = page(feed(post(1)));
  const errors = [];
  const tracker = createPostTracker({ doc: win.document, log: { error: (message) => errors.push(message) } });
  const seen = [];
  tracker.on('post/add', () => {
    throw new Error('boom');
  });
  tracker.on('post/add', (p) => seen.push(p.id));
  assert.deepEqual(seen, ['pfbid0Post1']);
  assert.equal(errors.length, 1);
  tracker.stop();
});
