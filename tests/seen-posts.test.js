// Hide seen posts: the store of seen posts, how a post is recognized on the page and in the
// data, when a post counts as seen, and the feature's two layers and buttons.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { createActions } from '../src/core/actions.js';
import { activityKeyFor, createActivityStorage } from '../src/core/activity.js';
import { createDiagnostics } from '../src/core/diagnostics.js';
import { createHider, MARK, NOTE } from '../src/core/dom/hide.js';
import { createPostTracker } from '../src/core/dom/posts.js';
import { halfShown, THRESHOLDS, watchSeen } from '../src/core/dom/seen-watch.js';
import { transformDocumentLine } from '../src/core/net/payload.js';
import { parseRoute } from '../src/core/route.js';
import { mediaIdOf, pageKeys, storyKeys, textKey } from '../src/core/seen-keys.js';
import { CLEARED_KEY, createSeenStore, SEEN_KEY } from '../src/core/seen-store.js';
import { createSettings } from '../src/core/settings.js';
import { startFeatures } from '../src/core/start-features.js';
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
  const roomy = createSeenStore({ storage, now: () => now, schedule: timers.schedule, cancel: timers.cancel, every: null });
  storage.remote(SEEN_KEY, { newer: now - 5000, other: now - 10 });
  assert.deepEqual([...store.since(0)], ['other'], "another tab's list keeps to the cap too");
  assert.deepEqual([...roomy.since(0)].sort(), ['newer', 'other']);
  assert.deepEqual([...roomy.since(now - 6000)].sort(), ['newer', 'other'], 'the earlier time wins');
  assert.deepEqual([...roomy.since(0, now - 2000)], ['newer'], 'until leaves out later ones');
  storage.remote(SEEN_KEY, { newer: now - 100 });
  assert.deepEqual([...roomy.since(0, now - 2000)], ['newer'], "another tab's later time doesn't replace it");
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

test('a list that loads late or comes from another tab keeps to the days and the cap, and one within them is not written back', () => {
  const now = 100 * DAY;
  const storage = sharedStorage({ [SEEN_KEY]: { a: now - 3000, b: now - 2000, c: now - 1000 } });
  let load;
  storage.whenReady = (run) => { load = run; };
  const timers = manualTimers();
  const options = { storage, now: () => now, maxEntries: 2, schedule: timers.schedule, cancel: timers.cancel, every: null };
  const store = createSeenStore(options);
  load();
  assert.deepEqual([...store.since(0)].sort(), ['b', 'c'], 'only the newest fit');
  assert.equal(timers.queue.length, 1, 'the trimmed list is due to be saved');
  timers.run();
  assert.deepEqual(storage.get(SEEN_KEY), { b: now - 2000, c: now - 1000 });

  storage.set(SEEN_KEY, { ...storage.get(SEEN_KEY), gone: now - 31 * DAY });
  const expired = createSeenStore(options);
  load();
  assert.equal(expired.has('gone'), false, 'a post seen too long ago is dropped');
  timers.run();
  assert.deepEqual(storage.get(SEEN_KEY), { b: now - 2000, c: now - 1000 });

  const reloaded = createSeenStore(options);
  load();
  assert.deepEqual([...reloaded.since(0)].sort(), ['b', 'c'], 'the recent ones survive a reload');
  assert.equal(timers.queue.length, 0, 'a list within the limits is not written back');

  // Another tab wrote before it heard from these, so its list isn't the newest two.
  storage.remote(SEEN_KEY, { a: now - 3000, d: now - 500 });
  assert.deepEqual([...reloaded.since(0)].sort(), ['c', 'd']);
  assert.ok(timers.queue.length > 0, 'the newest two are due to be saved over it');
  timers.run();
  assert.deepEqual(storage.get(SEEN_KEY), { c: now - 1000, d: now - 500 });
});

// Tabs that read and write one list, each told about the others' writes as they land.
function tabsSharing() {
  const saved = new Map();
  const tabs = new Set();
  let writes = 0;
  const copy = (value) => JSON.parse(JSON.stringify(value));
  return {
    writes: () => writes,
    saved: (key) => saved.get(key),
    tab() {
      const listeners = new Map();
      const storage = {
        get: (key, fallback) => (saved.has(key) ? copy(saved.get(key)) : fallback),
        set(key, value) {
          if (key === SEEN_KEY) writes++;
          saved.set(key, copy(value));
          for (const other of tabs) if (other !== storage) other.hear(key, copy(value));
        },
        onChange(key, fn) { listeners.set(key, [...(listeners.get(key) ?? []), fn]); },
        hear: (key, value) => listeners.get(key)?.forEach((fn) => fn(value)),
      };
      tabs.add(storage);
      return storage;
    },
  };
}

test('two tabs with different posts settle on the newest within the cap, without writing back and forth', () => {
  let clock = 10 * DAY;
  const shared = tabsSharing();
  const timers = manualTimers();
  const open = () => createSeenStore({
    storage: shared.tab(), now: () => clock, maxEntries: 3, schedule: timers.schedule, cancel: timers.cancel, every: null,
  });
  const settle = () => {
    for (let round = 0; round < 10 && timers.queue.length; round++) timers.run();
    assert.equal(timers.queue.length, 0, 'the tabs stop writing');
  };
  const here = open();
  const there = open();
  for (const [store, id] of [[here, 'a1'], [there, 'b1'], [here, 'a2'], [there, 'b2'], [here, 'a3'], [there, 'b3']]) {
    clock += 1000;
    store.add(id);
  }
  settle();
  const newest = ['a3', 'b2', 'b3'];
  assert.deepEqual([...here.since(0)].sort(), newest);
  assert.deepEqual([...there.since(0)].sort(), newest);
  assert.deepEqual(Object.keys(shared.saved(SEEN_KEY)).sort(), newest);
  assert.equal(shared.writes(), 2, 'one write from each tab');

  // Forgetting wins over a tab that writes its old copy late.
  const old = shared.saved(SEEN_KEY);
  clock += 1000;
  here.clear();
  shared.tab().set(SEEN_KEY, old);
  settle();
  assert.equal(here.size() + there.size(), 0);
  assert.equal(open().size(), 0, 'a new tab skips the old copy too');

  clock += 1000;
  there.add('c1');
  settle();
  const writes = shared.writes();
  const reloaded = open();
  assert.deepEqual([...reloaded.since(0)], ['c1'], 'what was seen since survives a reload');
  assert.deepEqual([...here.since(0)], ['c1']);
  settle();
  assert.equal(shared.writes(), writes, 'and nobody writes it back');
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
  const win = testWindow(href);
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

// A window whose tab can go to the background and back.
function tabWin(clock) {
  const win = fakeWin(clock);
  const listeners = [];
  win.document = {
    visibilityState: 'visible',
    addEventListener: (type, fn) => type === 'visibilitychange' && listeners.push(fn),
    removeEventListener() {},
  };
  win.setVisible = (visible) => {
    win.document.visibilityState = visible ? 'visible' : 'hidden';
    listeners.forEach((fn) => fn());
  };
  return win;
}

test('time with the feature off, or the tab in the background, never counts toward a second', () => {
  const clock = { now: 0 };
  const win = tabWin(clock);
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  const posts = fakePosts([a, b, c, d]);
  const seen = [];
  let active = true;
  const watch = watchSeen({ posts, win, active: () => active, onSeen: (post) => seen.push(post.element.id) });
  const io = FakeObserver.last;

  // A tenth of a second, then a minute with the feature off, then gone at once.
  io.show(a, 300);
  clock.now = 100;
  active = false;
  watch.update();
  clock.now = 60100;
  active = true;
  watch.update();
  clock.now = 60150;
  io.show(a, 0);
  // Turned off without update() hearing: a leave then can't tell what counted.
  io.show(b, 300);
  active = false;
  clock.now = 120000;
  io.show(b, 0);
  assert.deepEqual(seen, []);

  // The same tenth of a second, then a minute in the background.
  active = true;
  io.show(c, 300);
  clock.now += 100;
  win.setVisible(false);
  clock.now += 60000;
  win.setVisible(true);
  clock.now += 100;
  assert.deepEqual(seen, []);
  // Still showing after the tab came back, it gets a fresh second.
  clock.now += 1000;
  io.show(c, 0);
  assert.deepEqual(seen, ['c']);

  // A post that had its second before the tab went away counts then, and only once.
  io.show(d, 300);
  clock.now += 1500;
  win.setVisible(false);
  assert.deepEqual(seen, ['c', 'd']);
  io.show(d, 0);
  win.setVisible(true);
  clock.now += 5000;
  win.setVisible(false);
  assert.deepEqual(seen, ['c', 'd'], "d left while the tab was away, so it isn't timed again");
  watch.stop();
});

test('a post that had its second still counts when you leave Home for another page', () => {
  const clock = { now: 0 };
  const win = tabWin(clock);
  const [a, b] = ['a', 'b'].map((id) => ({ id }));
  const posts = fakePosts([a, b]);
  const seen = [];
  let active = true;
  const watch = watchSeen({ posts, win, active: () => active, onSeen: (post) => seen.push(post.element.id) });
  const io = FakeObserver.last;
  io.show(a, 300);
  clock.now = 1200;
  io.show(b, 300);
  clock.now = 1500;
  // The address changes before Facebook takes the feed away.
  active = false;
  watch.update();
  posts.remove(posts.records[0]);
  posts.remove(posts.records[1]);
  assert.deepEqual(seen, ['a']);
  watch.stop();
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

// The extension's storage, which fills a few milliseconds after the script starts. Until
// load() nothing is in it, and load() runs what was waiting in the order it came, the way
// core/bridge.js does. main.js makes the settings first, so they always hear first.
function lateStorage(saved, { unreadable = false } = {}) {
  const data = new Map();
  const listeners = new Map();
  const waiting = [];
  let loaded = false;
  const value = (key, fallback) => (data.has(key) ? structuredClone(data.get(key)) : fallback);
  return {
    get: value,
    getAtLoad(key, fallback) {
      if (unreadable && key.startsWith(SEEN_KEY)) throw new Error('unreadable');
      return value(key, fallback);
    },
    set: (key, next) => data.set(key, structuredClone(next)),
    remove: (key) => data.delete(key),
    onChange: (key, fn) => listeners.set(key, [...(listeners.get(key) ?? []), fn]),
    remote: (key, next) => listeners.get(key)?.forEach((fn) => fn(next)),
    whenReady(run) {
      if (loaded) run();
      else waiting.push(run);
    },
    load() {
      for (const [key, next] of Object.entries(saved)) data.set(key, structuredClone(next));
      loaded = true;
      for (const run of waiting.splice(0)) run();
    },
  };
}

// Settings, activity and the feature put together the way main.js does it.
function startLikeMain(win, storage, { account = null, clock = { now: 50 * DAY } } = {}) {
  const quiet = { warn() {}, error() {}, info() {}, debug() {} };
  const errors = [];
  const log = { ...quiet, error: (message) => errors.push(message) };
  const settings = createSettings({ storage, features: [hideSeenPosts], account, migrations: [] });
  const signedIn = { account };
  const activity = createActivityStorage({ storage, account, currentAccount: () => signedIn.account, log });
  const heard = [];
  const router = { current: () => parseRoute(win.location.href), subscribe: (fn) => heard.push(fn) };
  activity.watch({ router });
  win.IntersectionObserver = FakeObserver;
  const posts = createPostTracker({ doc: win.document });
  const hider = createHider({ doc: win.document, posts });
  const diagnostics = createDiagnostics();
  const rules = [];
  startFeatures({
    features: [hideSeenPosts], net: { transformResponses: (rule) => rules.push(rule) }, settings, log, unavailable: new Map(),
    context: () => ({
      win, doc: win.document, diagnostics, actions: createActions().for('hideSeenPosts'), storage: activity.storage,
      router, posts, hider, log, now: () => clock.now,
    }),
  });
  const rows = () => Object.fromEntries(diagnostics.rows().map(({ label, value }) => [label, value]));
  // Facebook redrawing the same page, which is when activity looks at the account again.
  const navigate = () => heard.forEach((fn) => fn(router.current()));
  return { settings, posts, rule: rules[0], io: FakeObserver.last, rows, errors, signedIn, navigate, clock };
}

const SEEN = activityKeyFor(SEEN_KEY, null);
const feedLine = (media) => JSON.stringify({ data: { viewer: { news_feed: { edges: [{ node: { __typename: 'Story', __isFeedUnit: 'Story', id: 's1', attachments: [{ media: { __typename: 'Photo', id: media } }] }, cursor: 'c1' }] } } } });
const FEED = { transport: 'xhr', path: '/api/graphql/', friendlyName: 'CometNewsFeedPaginationQuery' };
const dataDrops = (rule, media) => JSON.parse(transformDocumentLine(feedLine(media), [rule], FEED)).data.viewer.news_feed.edges[0].node === undefined;

test('in the extension, posts seen on an earlier visit go once its storage loads, with no page change', () => {
  const now = 50 * DAY;
  // Post 3 was read in another tab while this one was still loading, so it's from this visit.
  const storage = lateStorage({ settings: { hideSeenPosts: true }, 'settings.migrated': [], [SEEN]: { [keyOf(1)]: now - DAY, 'm:99887766': now - DAY, [keyOf(3)]: now + 20 } });
  const win = page(post(1) + post(2) + post(3));
  const { settings, posts, rule, io, rows, errors, clock } = startLikeMain(win, storage, { clock: { now } });
  // Still loading: the switch reads as off and nothing is known yet.
  assert.equal(rule.enabled(), false);
  assert.equal(note(win.document, 1), null);

  clock.now += 50;
  storage.load();
  assert.equal(rule.enabled(), true);
  assert.equal(note(win.document, 1), 'Hidden: Seen. Show', 'on the page');
  assert.equal(dataDrops(rule, '99887766'), true, 'and in the data');
  assert.equal(dataDrops(rule, '12345678'), false);
  assert.equal(note(win.document, 3), null);
  assert.equal(rows()['Seen posts remembered'], '3');

  // Post 2 is read on this visit. It's kept, and stays where it is, even when the days change.
  const two = win.document.querySelector('[aria-posinset="2"]');
  io.show(two, 300);
  clock.now += 1500;
  io.show(two, 0);
  assert.equal(rows()['Seen posts remembered'], '4');
  settings.set('hideSeenPosts.days', 30);
  assert.equal(note(win.document, 2), null);
  assert.equal(note(win.document, 3), null);
  assert.equal(note(win.document, 1), 'Hidden: Seen. Show');
  posts.stop();
  assert.deepEqual(errors, []);
});

test('in the extension, an empty or unreadable seen list hides nothing and still keeps what you read', () => {
  const now = 50 * DAY;
  for (const unreadable of [false, true]) {
    const storage = lateStorage({ settings: { hideSeenPosts: true }, 'settings.migrated': [] }, { unreadable });
    const win = page(post(1));
    const { posts, rule, io, rows, errors, clock } = startLikeMain(win, storage, { clock: { now } });
    storage.load();
    assert.equal(rule.enabled(), false, 'nothing to hide');
    assert.equal(note(win.document, 1), null);
    assert.deepEqual(errors, unreadable ? ["Couldn't read the seen posts list, starting a new one"] : []);
    const one = win.document.querySelector('[aria-posinset="1"]');
    io.show(one, 300);
    clock.now += 1500;
    io.show(one, 0);
    assert.equal(rows()['Seen posts remembered'], '1');
    assert.equal(note(win.document, 1), null);
    posts.stop();
  }
});

test('with a userscript manager, settings and seen posts are there from the start', () => {
  const now = 50 * DAY;
  const storage = createMemoryStorage({ settings: { hideSeenPosts: true }, 'settings.migrated': [], [SEEN]: { [keyOf(1)]: now - DAY, 'm:99887766': now - DAY } });
  const win = page(post(1) + post(2));
  const { posts, rule } = startLikeMain(win, storage, { clock: { now } });
  assert.equal(rule.enabled(), true);
  assert.equal(note(win.document, 1), 'Hidden: Seen. Show');
  assert.equal(note(win.document, 2), null);
  assert.equal(dataDrops(rule, '99887766'), true);
  posts.stop();
});

test("after the account changes, the old account's seen posts aren't hidden on the page or in the data", () => {
  const now = 50 * DAY;
  const account = '615000000000041';
  const mine = activityKeyFor(SEEN_KEY, account);
  const saved = { [mine]: { [keyOf(1)]: now - DAY, 'm:99887766': now - DAY } };
  const storage = createMemoryStorage({ settings: { hideSeenPosts: true }, 'settings.migrated': [], [mine]: saved[mine] });
  const win = page(post(1) + post(2));
  const { posts, rule, signedIn, rows, navigate } = startLikeMain(win, storage, { account, clock: { now } });
  assert.equal(note(win.document, 1), 'Hidden: Seen. Show');

  // Signed in to someone else without a reload. A page change notices.
  signedIn.account = '615000000000042';
  navigate();
  assert.equal(rows()['Seen posts remembered'], '0');
  assert.equal(rule.enabled(), false);
  assert.equal(dataDrops(rule, '99887766'), false);
  assert.equal(note(win.document, 1), null);
  posts.stop();

  // Switched before the extension's storage loaded: the old list never comes in at all.
  const late = lateStorage({ settings: { hideSeenPosts: true }, 'settings.migrated': [], [mine]: saved[mine] });
  const lateWin = page(post(1));
  const early = startLikeMain(lateWin, late, { account, clock: { now } });
  early.signedIn.account = null;
  late.load();
  assert.equal(early.rule.enabled(), false);
  assert.equal(note(lateWin.document, 1), null);
  early.posts.stop();
});

test('on the page, leaving Home counts posts that had their second, and time with the switch off never counts', () => {
  const now = 50 * DAY;
  const storage = createMemoryStorage({ settings: { hideSeenPosts: true }, 'settings.migrated': [] });
  const win = page(post(1) + post(2) + post(3));
  const { settings, posts, io, rows, navigate, clock } = startLikeMain(win, storage, { clock: { now } });
  const element = (n) => win.document.querySelector(`[aria-posinset="${n}"]`);

  // Post 3 shows for a tenth of a second, then the switch is off for a minute.
  io.show(element(3), 300);
  clock.now += 100;
  settings.set('hideSeenPosts', false);
  clock.now += 60000;
  settings.set('hideSeenPosts', true);
  io.show(element(3), 0);
  assert.equal(rows()['Seen posts remembered'], '0');

  io.show(element(1), 300);
  clock.now += 1200;
  io.show(element(2), 300);
  clock.now += 300;
  win.history.pushState({}, '', '/marketplace/');
  navigate();
  assert.equal(rows()['Seen posts remembered'], '1', 'post 1 had its second, post 2 had 300 ms');
  io.show(element(2), 0);
  io.show(element(1), 0);
  assert.equal(rows()['Seen posts remembered'], '1');
  posts.stop();
});

test('when another tab forgets the seen posts, the ones hidden here come back', () => {
  const now = 50 * DAY;
  const storage = sharedStorage({ [SEEN_KEY]: { [keyOf(1)]: now - 2 * DAY, [keyOf(2)]: now - DAY } });
  const win = page(post(1) + post(2));
  const { doc, posts, rows } = setupFeature(win, { storage, clock: { now } });
  assert.equal(note(doc, 1), 'Hidden: Seen. Show');
  assert.equal(note(doc, 2), 'Hidden: Seen. Show');
  // Forgotten in between the two: post 2 was seen after, so it stays hidden.
  storage.remote(CLEARED_KEY, now - 1.5 * DAY);
  assert.equal(note(doc, 1), null);
  assert.equal(note(doc, 2), 'Hidden: Seen. Show');
  storage.remote(CLEARED_KEY, now);
  assert.equal(note(doc, 2), null);
  assert.equal(rows()['Seen posts remembered'], '0');
  posts.stop();
});
