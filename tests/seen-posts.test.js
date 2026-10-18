// Hide seen posts: the store of seen posts, how a post is recognized on the page and in the
// data, when a post counts as seen, and the feature's two layers and buttons.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { createActions } from '../src/core/actions.js';
import { createDiagnostics } from '../src/core/diagnostics.js';
import { createHider, MARK, NOTE } from '../src/core/dom/hide.js';
import { createPostTracker } from '../src/core/dom/posts.js';
import { halfShown, THRESHOLDS, watchSeen } from '../src/core/dom/seen-watch.js';
import { transformDocumentLine } from '../src/core/net/payload.js';
import { parseRoute } from '../src/core/route.js';
import { mediaIdOf, pageKeys, storyKeys, textKey } from '../src/core/seen-keys.js';
import { CLEARED_KEY, createSeenStore, SEEN_KEY } from '../src/core/seen-store.js';
import { createMemoryStorage } from '../src/core/storage.js';
import hideSeenPosts, { pruneSeen, SHOW_KEY } from '../src/features/feed/hide-seen-posts.js';

const DAY = 24 * 60 * 60 * 1000;
const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

// Storage that reports writes from "another tab" the way GM_addValueChangeListener does.
function sharedStorage(initial = {}) {
  const storage = createMemoryStorage(initial);
  const listeners = new Map();
  storage.onChange = (key, fn) => {
    if (!listeners.has(key)) listeners.set(key, []);
    listeners.get(key).push(fn);
  };
  storage.remote = (key, value) => listeners.get(key)?.forEach((fn) => fn(value));
  return storage;
}

function manualTimers() {
  const queue = [];
  return {
    queue,
    schedule: (fn) => queue.push(fn),
    cancel: () => queue.splice(0),
    run: () => queue.splice(0).forEach((fn) => fn()),
  };
}

test('the store keeps the first time a post was seen and writes once per batch', () => {
  let clock = 1000;
  const storage = sharedStorage();
  const timers = manualTimers();
  const store = createSeenStore({ storage, now: () => clock, schedule: timers.schedule, cancel: timers.cancel, every: null });
  assert.equal(store.add(['m:1', 't:a']), true);
  clock = 2000;
  assert.equal(store.add(['m:1']), false, 'already known');
  store.add('t:b');
  assert.equal(timers.queue.length, 1, 'one write waits for the batch');
  assert.equal(storage.get(SEEN_KEY, null), null);
  timers.run();
  assert.deepEqual(storage.get(SEEN_KEY), { 'm:1': 1000, 't:a': 1000, 't:b': 2000 });
  assert.deepEqual([...store.since(1500)], ['t:b']);
  store.add('t:c');
  store.flush();
  assert.equal(storage.get(SEEN_KEY)['t:c'], 2000, 'flush writes at once');
  store.clear();
  assert.deepEqual(storage.get(SEEN_KEY), {});
  assert.equal(store.size(), 0);
});

test('ready listeners see merged saved history and the earliest duplicate time', () => {
  let load;
  const writes = [];
  const storage = {
    get: (_key, fallback) => fallback,
    getAtLoad: (key, fallback) => (key === SEEN_KEY ? { old: 100, same: 100 } : fallback),
    set: (key, value) => writes.push([key, value]),
    whenReady(run) { load = run; },
    onChange() {},
  };
  let scheduled;
  const store = createSeenStore({
    storage,
    now: () => 200,
    schedule: (run) => { scheduled = run; return 1; },
    cancel: () => {},
    every: null,
  });
  store.add(['new', 'same']);
  scheduled();
  let atReady;
  store.whenReady(() => { atReady = [...store.since(0)].sort(); });
  load();

  assert.deepEqual(atReady, ['new', 'old', 'same']);
  assert.deepEqual(writes.at(-1), [SEEN_KEY, { new: 200, same: 100, old: 100 }]);
});

test('the store drops old and surplus entries, skips junk, and merges other tabs', () => {
  const now = 100 * DAY;
  const storage = sharedStorage({ [SEEN_KEY]: { old: now - 31 * DAY, keep: now - DAY, newer: now - 1000, bad: 'x', '': now } });
  const timers = manualTimers();
  const store = createSeenStore({ storage, now: () => now, maxEntries: 1, schedule: timers.schedule, cancel: timers.cancel, every: null });
  assert.equal(store.size(), 1);
  assert.ok(store.has('newer'), 'the newest one stays under the cap');
  timers.run();
  assert.deepEqual(Object.keys(storage.get(SEEN_KEY)), ['newer'], 'the pruned list is saved');
  storage.remote(SEEN_KEY, { newer: now - 5000, other: now - 10 });
  assert.deepEqual([...store.since(0)].sort(), ['newer', 'other']);
  assert.deepEqual([...store.since(now - 6000)].sort(), ['newer', 'other'], 'the earlier time wins');
  assert.deepEqual([...store.since(0, now - 2000)], ['newer'], 'until leaves out later ones');
});

test('forgetting the list holds against another tab that still has the old one', () => {
  let clock = 10 * DAY;
  const storage = sharedStorage();
  const options = { storage, now: () => clock, schedule: () => {}, cancel: () => {}, every: null };
  const here = createSeenStore(options);
  const there = createSeenStore(options);
  here.add(['t:old']);
  there.add(['t:old', 't:other']);
  clock += 1000;
  here.clear();
  // The other tab writes its old list before it hears about the clear.
  const stale = { 't:old': clock - 1000, 't:other': clock - 1000 };
  here.add('t:new');
  storage.remote(SEEN_KEY, stale);
  assert.deepEqual([...here.since(0)], ['t:new'], 'the old copy is not merged back');
  storage.remote(CLEARED_KEY, storage.get(CLEARED_KEY));
  assert.equal(there.size(), 0, 'the other tab forgets too');
  storage.set(SEEN_KEY, { ...stale, 't:new': clock });
  const reloaded = createSeenStore(options);
  assert.deepEqual([...reloaded.since(0)], ['t:new'], 'and a new tab skips what came before the clear');
});

test('a text key ignores case, spacing, punctuation and emoji, and short texts get none', () => {
  const a = textKey('Sunset over the jetty tonight!! The water was so calm 🌅');
  assert.equal(textKey('sunset   over the JETTY tonight. The water was so calm'), a);
  assert.notEqual(textKey('Sunrise over the jetty tonight, the water was so calm'), a);
  assert.equal(textKey('Happy birthday!!'), null);
  assert.match(a, /^t:[0-9a-z]+$/);
  assert.equal(textKey(`${'a'.repeat(48)}different ending`), textKey(`${'a'.repeat(48)}another ending`), 'only the first words count');
});

test('media ids come from photo, reel, video and watch links, never from a post link', () => {
  assert.equal(mediaIdOf('https://www.facebook.com/photo/?fbid=1234567&set=a.99'), '1234567');
  assert.equal(mediaIdOf('/someone/photos/a.111/7654321/?type=3'), '7654321');
  assert.equal(mediaIdOf('/reel/2345678/?s=feed'), '2345678');
  assert.equal(mediaIdOf('/SomePage/videos/3456789/'), '3456789');
  assert.equal(mediaIdOf('/watch/?ref=x&v=4567890'), '4567890');
  assert.equal(mediaIdOf('/permalink.php?story_fbid=1234567&id=1'), null);
  assert.equal(mediaIdOf('/groups/123456789/posts/987654321/'), null);
});

const TEXT = 'Sunset over the jetty tonight, the water was so calm';

function page(html, href = 'https://www.facebook.com/') {
  const win = new Window({ url: href });
  windows.push(win);
  win.document.body.innerHTML = `<div role="main"><div class="feed">${html}</div></div>`;
  return win;
}

const post = (n, { text = `Post number ${n} with enough words to count`, extra = '' } = {}) => `
  <div><div aria-posinset="${n}">
    <h4><a href="/videos/9999999${n}/">Pat Example</a></h4>
    <div data-ad-rendering-role="story_message"><div>${text} <a href="/reel/8888888${n}/">a reel</a></div><div role="button">See more</div></div>
    ${extra}
  </div></div>`;

test('the page and the data name a post the same way, without its comments or text links', () => {
  const photo = '<a href="/photo/?fbid=99887766&set=a.1"><img alt="May be an image of the sea" src="x.jpg"></a>';
  const comment = '<div role="article" aria-label="Comment by Sam"><a href="/photo/?fbid=11112222">pic</a><div data-ad-rendering-role="story_message">Comment text that is long enough to count</div></div>';
  const win = page(post(1, { text: `${TEXT} 🌅`, extra: photo + comment }));
  const keys = pageKeys(win.document.querySelector('[aria-posinset]'));
  // The words of a link in the text are part of the text; its address isn't.
  assert.deepEqual(keys.sort(), ['m:99887766', textKey(`${TEXT} a reel`)].sort());

  const story = {
    __typename: 'Story',
    comet_sections: {
      content: { story: {
        comet_sections: { message_container: { story: { message: { text: `${TEXT} 🌅 a reel` } } } },
        attachments: [{ styles: { attachment: { media: { __typename: 'Photo', id: '99887766' } } } }],
      } },
      feedback: { story: { comments: [{ attachment: { media: { __typename: 'Photo', id: '11112222' } } }] } },
    },
  };
  assert.ok(storyKeys(story).includes('m:99887766'));
  assert.ok(storyKeys(story).includes(textKey(`${TEXT} a reel`)));
  assert.ok(!storyKeys(story).includes('m:11112222'), 'a comment photo is not the post');
});

test('the data keys a post by the text the page shows first, so a share with words of its own is new', () => {
  const words = 'My friend wrote these words above the post they shared';
  const shared = { message: { text: TEXT } };
  const share = (message) => ({ __typename: 'Story', comet_sections: { content: { story: { ...(message ? { message: { text: message } } : {}), attached_story: shared } } } });
  assert.deepEqual(storyKeys(share(words)), [textKey(words)]);
  assert.deepEqual(storyKeys(share(null)), [textKey(TEXT)], 'a bare share shows the shared words first');

  const title = 'A link title that is long enough to count as a key';
  const link = (message) => ({
    __typename: 'Story',
    comet_sections: { content: { story: {
      ...(message ? { comet_sections: { message: { story: { message: { text: message } } } } } : {}),
      attachments: [{ styles: { attachment: { title_with_entities: { text: title } } } }],
    } } },
  });
  assert.deepEqual(storyKeys(link(null)), [textKey(title)], 'without words, the link title');
  assert.deepEqual(storyKeys(link(words)), [textKey(words)], 'with words, never the title');
});

test('only photos and videos a post carries count, not a profile picture beside it', () => {
  const story = {
    __typename: 'Story',
    actors: [{ name: 'Pat', profile_picture: { __typename: 'Photo', id: '77778888' } }],
    comet_sections: { content: { story: {
      attachments: [{ styles: { attachment: { all_subattachments: { nodes: [{ media: { __typename: 'Photo', id: '55556666' } }] } } } }],
      attached_story: { attachments: [{ media: { __typename: 'Video', id: '44445555' } }] },
    } } },
  };
  assert.deepEqual(storyKeys(story).sort(), ['m:44445555', 'm:55556666']);
});

// A stand-in IntersectionObserver the tests drive by hand.
class FakeObserver {
  constructor(callback) {
    this.callback = callback;
    this.targets = new Set();
    FakeObserver.last = this;
  }
  observe(target) { this.targets.add(target); }
  unobserve(target) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
  show(target, shown, tall = 400) {
    this.callback([{ target, isIntersecting: shown > 0, intersectionRect: { height: shown }, boundingClientRect: { height: tall }, rootBounds: { height: 1000 } }]);
  }
}

function fakeWin(clock) {
  const listeners = {};
  return {
    IntersectionObserver: FakeObserver,
    innerHeight: 1000,
    performance: { now: () => clock.now },
    addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
    removeEventListener() {},
    fire: (type) => (listeners[type] ?? []).forEach((fn) => fn()),
  };
}

function fakePosts(elements) {
  const listeners = {};
  const records = elements.map((element) => ({ element }));
  return {
    // Like the real tracker, a late post/add listener hears about the posts already there.
    on: (type, fn) => {
      (listeners[type] ??= []).push(fn);
      if (type === 'post/add') records.forEach(fn);
      return () => {};
    },
    current: () => records,
    remove: (record) => listeners['post/remove']?.forEach((fn) => fn(record)),
    records,
  };
}

test('half of a post, or half the screen for a tall one, is enough to be reading it', () => {
  const entry = (shown, tall) => ({ isIntersecting: shown > 0, intersectionRect: { height: shown }, boundingClientRect: { height: tall }, rootBounds: { height: 1000 } });
  assert.equal(halfShown(entry(200, 400), 1000), true);
  assert.equal(halfShown(entry(150, 400), 1000), false);
  assert.equal(halfShown(entry(600, 3000), 1000), true);
  assert.equal(halfShown(entry(400, 3000), 1000), false);
  assert.equal(halfShown(entry(0, 0), 1000), false);
});

test('a post counts as seen after a second on screen, when it leaves or the page goes away', () => {
  const clock = { now: 0 };
  const win = fakeWin(clock);
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  const posts = fakePosts([a, b, c, d]);
  const seen = [];
  let active = true;
  watchSeen({ posts, win, active: () => active, onSeen: (post) => seen.push(post.element.id) });
  const io = FakeObserver.last;
  io.show(a, 300);
  io.show(b, 300);
  clock.now = 600;
  io.show(b, 0);
  clock.now = 1200;
  io.show(a, 100);
  assert.deepEqual(seen, ['a'], 'a had its second, b left too soon');
  active = false;
  io.show(c, 300);
  clock.now = 3000;
  io.show(c, 0);
  assert.deepEqual(seen, ['a'], 'c started showing where the feature is off');
  active = true;
  io.show(d, 300);
  io.show(b, 300);
  clock.now = 4500;
  posts.remove(posts.records[3]);
  win.fire('pagehide');
  assert.deepEqual(seen, ['a', 'd', 'b']);
});

test('a post up to 25 screens tall still gets a callback while half the screen shows it', () => {
  for (let tall = 1; tall <= 25; tall += 0.25) {
    // The observer calls back when the share of the post showing crosses a threshold. The
    // most that can show is one screen, 1/tall of the post.
    const hit = THRESHOLDS.some((t) => t > 0 && t <= 1 / tall && t * tall >= 0.5);
    assert.ok(hit, `${tall} screens`);
  }
});

test('what a post was is read when it starts showing, in case Facebook reuses its element', () => {
  const clock = { now: 0 };
  const win = fakeWin(clock);
  const element = { story: 'first' };
  const posts = fakePosts([element]);
  const seen = [];
  watchSeen({ posts, win, active: () => true, snapshot: (post) => post.element.story, onSeen: (post, taken) => seen.push(taken) });
  const io = FakeObserver.last;
  io.show(element, 300);
  element.story = 'second';
  clock.now = 2000;
  io.show(element, 0);
  assert.deepEqual(seen, ['first']);
});

function setupFeature(win, { storage = sharedStorage(), days = 7, net = null, href, clock = { now: Date.now() } } = {}) {
  const doc = win.document;
  win.IntersectionObserver = FakeObserver;
  const values = { days };
  const subscribers = [];
  const posts = createPostTracker({ doc });
  const hider = createHider({ doc, posts });
  const diagnostics = createDiagnostics();
  const actions = createActions();
  hideSeenPosts.setup({
    win, net, router: { current: () => parseRoute(href ?? win.location.href) }, posts, hider, storage, diagnostics,
    actions: actions.for('hideSeenPosts'), log: { warn() {}, error() {}, info() {} },
    settings: { subscribe: (fn) => subscribers.push(fn) }, enabled: () => true, option: (key) => values[key], now: () => clock.now,
  });
  const button = (label) => actions.list('hideSeenPosts').find((action) => action.label === label);
  const rows = () => Object.fromEntries(diagnostics.rows().map(({ label, value }) => [label, value]));
  return { doc, posts, hider, storage, button, rows, io: FakeObserver.last };
}

const note = (doc, n) => doc.querySelector(`[aria-posinset="${n}"] [${MARK}]`)?.getAttribute(NOTE) ?? null;
const keyOf = (n) => textKey(`Post number ${n} with enough words to count a reel`);

test('posts seen on an earlier visit are hidden, within the days picked, and ones seen now stay', () => {
  const now = 50 * DAY;
  const storage = sharedStorage({ [SEEN_KEY]: { [keyOf(1)]: now - 2 * DAY, [keyOf(3)]: now - 10 * DAY } });
  const win = page(post(1) + post(2) + post(3));
  const clock = { now };
  const { doc, posts, io, rows } = setupFeature(win, { storage, clock });
  assert.equal(note(doc, 1), 'Hidden: Seen. Show');
  assert.equal(note(doc, 2), null);
  assert.equal(note(doc, 3), null, 'seen ten days ago, and the list keeps seven');
  // Post 2 is read now. It's remembered, but stays on the page for this visit.
  const two = doc.querySelector('[aria-posinset="2"]');
  io.show(two, 300);
  clock.now += 1500;
  io.callback([{ target: two, isIntersecting: false, intersectionRect: { height: 0 }, boundingClientRect: { height: 400 }, rootBounds: { height: 1000 } }]);
  assert.equal(note(doc, 2), null);
  assert.equal(rows()['Seen posts remembered'], '3');
  assert.equal(rows()['Seen posts hidden'], '1 hidden on the page');
  posts.stop();

  const longer = page(post(1) + post(3));
  const again = setupFeature(longer, { storage, clock: { now }, days: 30 });
  assert.equal(note(again.doc, 3), 'Hidden: Seen. Show', 'thirty days covers it');
  again.posts.stop();
});

test('changing the days leaves the posts seen during this visit on the page', () => {
  const now = 50 * DAY;
  const storage = sharedStorage({ [SEEN_KEY]: { [keyOf(1)]: now - 2 * DAY } });
  const win = page(post(1) + post(2));
  const clock = { now };
  const values = { days: 7 };
  const subscribers = [];
  win.IntersectionObserver = FakeObserver;
  const posts = createPostTracker({ doc: win.document });
  hideSeenPosts.setup({
    win, router: { current: () => parseRoute(win.location.href) }, posts, hider: createHider({ doc: win.document, posts }), storage,
    log: { warn() {}, error() {}, info() {} }, settings: { subscribe: (fn) => subscribers.push(fn) },
    enabled: () => true, option: (key) => values[key], now: () => clock.now,
  });
  const io = FakeObserver.last;
  const two = win.document.querySelector('[aria-posinset="2"]');
  io.show(two, 300);
  clock.now += 1500;
  io.show(two, 0);
  assert.equal(note(win.document, 2), null);
  values.days = 30;
  subscribers.forEach((fn) => fn());
  assert.equal(note(win.document, 1), 'Hidden: Seen. Show', 'the earlier one is hidden again');
  assert.equal(note(win.document, 2), null, 'the one just read stays');
  posts.stop();
});

test('Show seen posts lets them back for the tab, and Forget all seen posts empties the list', () => {
  const storage = sharedStorage({ [SEEN_KEY]: { [keyOf(1)]: Date.now() - DAY } });
  const win = page(post(1) + post(2));
  const { doc, posts, button, rows } = setupFeature(win, { storage });
  assert.equal(note(doc, 1), 'Hidden: Seen. Show');
  button('Show seen posts in this tab').run();
  assert.equal(note(doc, 1), null);
  assert.equal(win.sessionStorage.getItem(SHOW_KEY), '1');
  assert.equal(rows()['Seen posts hidden'], 'None: showing them in this tab');
  button('Hide seen posts again').run();
  assert.equal(note(doc, 1), 'Hidden: Seen. Show');
  assert.equal(win.sessionStorage.getItem(SHOW_KEY), null);
  button('Forget all seen posts').run();
  assert.equal(note(doc, 1), null);
  assert.equal(rows()['Seen posts remembered'], '0');
  assert.deepEqual(storage.get(SEEN_KEY), {});
  posts.stop();
});

test('a tab that chose to show seen posts keeps showing them after a reload', () => {
  const storage = sharedStorage({ [SEEN_KEY]: { [keyOf(1)]: Date.now() - DAY } });
  const win = page(post(1));
  win.sessionStorage.setItem(SHOW_KEY, '1');
  const { doc, posts, button } = setupFeature(win, { storage });
  assert.equal(note(doc, 1), null);
  assert.ok(button('Hide seen posts again'));
  posts.stop();
});

test('in page mode the data rule drops seen stories from Home and leaves search alone', () => {
  const rules = [];
  const storage = sharedStorage({ [SEEN_KEY]: { 'm:99887766': Date.now() - DAY } });
  const win = page('');
  const { posts } = setupFeature(win, { storage, net: { transformResponses: (rule) => rules.push(rule) } });
  const [rule] = rules;
  assert.deepEqual(rule.markers, ['"__isFeedUnit"']);
  const photoStory = (id, media) => ({ __typename: 'Story', __isFeedUnit: 'Story', id, attachments: [{ media: { __typename: 'Photo', id: media } }] });
  const answer = { data: { viewer: { news_feed: { edges: [{ node: photoStory('s1', '99887766'), cursor: 'c1' }, { node: photoStory('s2', '12345678'), cursor: 'c2' }] } } } };
  const line = JSON.stringify(answer);
  const feed = { transport: 'xhr', path: '/api/graphql/', friendlyName: 'CometNewsFeedPaginationQuery' };
  const out = JSON.parse(transformDocumentLine(line, [rule], feed));
  assert.deepEqual(out.data.viewer.news_feed.edges.map((edge) => edge.node?.id ?? null), [null, 's2']);
  assert.equal(out.data.viewer.news_feed.edges[0].cursor, 'c1', 'paging still works');
  assert.equal(transformDocumentLine(line, [rule], { ...feed, friendlyName: 'SearchCometResultsPaginatedResultsQuery' }), line);
  assert.equal(pruneSeen(structuredClone(answer), () => false), 0);
  posts.stop();
});

test('a seen story in an answer another rule fails on is not counted as taken out', () => {
  const rules = [];
  const storage = sharedStorage({ [SEEN_KEY]: { 'm:99887766': Date.now() - DAY } });
  const win = page('');
  const { posts, rows } = setupFeature(win, { storage, net: { transformResponses: (rule) => rules.push(rule) } });
  const broken = { id: 'broken', transform() { throw new Error('boom'); } };
  const story = { __typename: 'Story', __isFeedUnit: 'Story', id: 's1', attachments: [{ media: { __typename: 'Photo', id: '99887766' } }] };
  const line = JSON.stringify({ data: { viewer: { news_feed: { edges: [{ node: story, cursor: 'c1' }] } } } });
  const feed = { transport: 'xhr', path: '/api/graphql/', friendlyName: 'CometNewsFeedPaginationQuery' };
  assert.equal(transformDocumentLine(line, [rules[0], broken], feed, () => {}), line);
  assert.match(rows()['Seen posts hidden'], /^0 taken out of the data/);
  transformDocumentLine(line, rules, feed);
  assert.match(rows()['Seen posts hidden'], /^1 taken out of the data/);
  posts.stop();
});

test('nothing is hidden on a post opened by its link, or on a profile', () => {
  for (const href of ['https://www.facebook.com/someone/posts/pfbid0P1', 'https://www.facebook.com/someone']) {
    const storage = sharedStorage({ [SEEN_KEY]: { [keyOf(1)]: Date.now() - DAY } });
    const win = page(post(1), href);
    const { doc, posts } = setupFeature(win, { storage, href });
    assert.equal(note(doc, 1), null, href);
    posts.stop();
  }
});
