import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { createPostTracker } from '../src/core/dom/posts.js';
import { parseRoute } from '../src/core/route.js';

import feature, { createOffscreenPauser, OFFSCREEN_MS, inFeed } from '../src/features/playback/pause-offscreen-videos.js';

const cleanups = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const POST = '<div aria-posinset="1"><a href="/someone/posts/100001">1h</a><video src="/first.mp4"></video></div>';

function timers() {
  let now = 0;
  let nextId = 0;
  const pending = new Map();
  return {
    set(fn, ms) { const id = ++nextId; pending.set(id, { at: now + ms, fn }); return id; },
    clear: (id) => pending.delete(id),
    count: () => pending.size,
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...pending].filter(([, job]) => job.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        pending.delete(due[0]);
        due[1].fn();
      }
      now = until;
    },
  };
}

function fakePosts(records) {
  const listeners = new Map();
  return {
    on(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
      if (type === 'post/add') for (const record of records) listener(record);
      return () => listeners.get(type).delete(listener);
    },
    current: () => records,
    emit(type, post) {
      if (type === 'post/remove') records.splice(records.indexOf(post), 1);
      if (type === 'post/add') records.push(post);
      if (type === 'reset') records.splice(0);
      for (const listener of listeners.get(type) ?? []) listener(post);
    },
    subscriptions: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  };
}

function media(win, video, { paused = false, currentSrc = '', object = null } = {}) {
  let pauses = 0;
  let plays = 0;
  Object.defineProperties(video, {
    paused: { get: () => paused, configurable: true },
    ended: { get: () => false, configurable: true },
    currentSrc: { get: () => currentSrc, configurable: true },
    srcObject: { get: () => object, set: (value) => { object = value; }, configurable: true },
  });
  const fire = (type) => video.dispatchEvent(new win.Event(type));
  video.pause = () => { pauses++; paused = true; fire('pause'); };
  video.play = () => { plays++; paused = false; fire('play'); fire('playing'); return Promise.resolve(); };
  return {
    video, fire,
    pauses: () => pauses,
    plays: () => plays,
    source: (value) => { currentSrc = value; },
    start: () => video.play(),
  };
}

function fixture({ href = 'https://www.facebook.com/', html = POST, on = true, realPosts = false, staleRoute = false } = {}) {
  const win = testWindow(href);
  const doc = win.document;
  doc.body.innerHTML = `<main role="main">${html}</main>`;
  const intersections = [];
  const mutations = [];
  win.IntersectionObserver = class {
    constructor(callback, options) { this.callback = callback; this.options = options; this.targets = new Set(); this.disconnected = false; this.queued = []; intersections.push(this); }
    observe(target) { this.targets.add(target); }
    disconnect() { this.targets.clear(); this.disconnected = true; }
    show(target, ratio, isIntersecting = ratio > 0) { this.callback([{ target, intersectionRatio: ratio, isIntersecting }]); }
    queue(target, ratio) { this.queued.push({ target, intersectionRatio: ratio, isIntersecting: ratio > 0 }); }
    takeRecords() { return this.queued.splice(0); }
  };
  if (!realPosts) win.MutationObserver = class {
    constructor(callback) { this.callback = callback; this.disconnected = false; mutations.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  const cards = [...doc.querySelectorAll('video')].map((video) => media(win, video));
  const posts = realPosts ? createPostTracker({ doc }) : fakePosts([...doc.querySelectorAll('[aria-posinset], [role="article"]')].map((element) => ({
    element, kind: element.hasAttribute('aria-posinset') ? 'feed' : 'article', id: element.querySelector('a')?.getAttribute('href') ?? null,
  })));
  const clock = timers();
  const errors = [];
  const initialRoute = parseRoute(href);
  const pauser = createOffscreenPauser({ doc, win, posts, enabled: () => on, route: () => staleRoute ? initialRoute : parseRoute(win.location.href),
    setTimer: clock.set, clearTimer: clock.clear, log: { error: (...args) => errors.push(args) } });
  pauser.update();
  cleanups.push(async () => { pauser.stop(); posts.stop?.(); await win.happyDOM.close(); });
  return {
    win, doc, cards, posts, clock, pauser, intersections, mutations, errors,
    io: (video = cards[0].video) => intersections.findLast((observer) => observer.targets.has(video)),
    setOn(value) { on = value; pauser.update(); },
    route(path) { win.history.pushState({}, '', path); pauser.reset(); },
    mutate(target, { type = 'childList', addedNodes = [], removedNodes = [] } = {}) {
      for (const observer of [...mutations]) if (!observer.disconnected) observer.callback([{ target, type, addedNodes, removedNodes }]);
    },
  };
}

test('the feed pause feature is default off and declares genuine web-only metadata', () => {
  assert.equal(feature.id, 'pauseOffscreenVideos');
  assert.equal(feature.default, false);
  assert.equal(feature.webOnly, true);
  assert.equal(feature.android, undefined);
  assert.equal(OFFSCREEN_MS, 1000);
});

test('only Home and group feed routes qualify, including filtered Home', () => {
  for (const path of ['/', '/home.php?sk=h_chr', '/?sk=favorites', '/groups/', '/groups/example/']) {
    assert.equal(inFeed(parseRoute(`https://www.facebook.com${path}`)), true, path);
  }
  for (const path of ['/reel/1234567/', '/reels/', '/stories/123/456/', '/watch/?v=1234567', '/someone/posts/1234567',
    '/story.php?story_fbid=1234567&id=1', '/groups/example/posts/1234567/', '/groups/example/?multi_permalinks=1234567',
    '/groups/example/?view=permalink', '/marketplace/', '/feeds/', '/messages/', '/search/']) {
    const h = fixture({ href: `https://www.facebook.com${path}` });
    assert.equal(inFeed(parseRoute(hrefOf(h))), false, path);
    assert.equal(h.intersections.length, 0, path);
  }
  assert.equal(inFeed(undefined), false);
});

const hrefOf = (h) => h.win.location.href;

test('zero intersection for a full second pauses once, including an intersecting edge at zero area', () => {
  const h = fixture();
  const card = h.cards[0];
  h.io().show(card.video, 0, true);
  assert.deepEqual(h.io().options.threshold, [0, Number.EPSILON]);
  h.clock.advance(999);
  assert.equal(card.pauses(), 0);
  h.clock.advance(1);
  assert.equal(card.pauses(), 1);
  h.clock.advance(3000);
  assert.equal(card.pauses(), 1);
  assert.equal(h.clock.count(), 0);
});

test('any positive intersection cancels the pending pause and returning never starts playback', () => {
  const h = fixture();
  const card = h.cards[0];
  h.io().show(card.video, 0);
  h.clock.advance(999);
  h.io().show(card.video, Number.EPSILON);
  h.clock.advance(2000);
  assert.equal(card.pauses(), 0);
  assert.equal(card.plays(), 0);
  h.io().show(card.video, 0);
  h.clock.advance(1000);
  assert.equal(card.pauses(), 1);
  h.io().show(card.video, 1);
  assert.equal(card.plays(), 0);
  assert.equal(card.video.paused, true);
});

test('repeated zero entries keep the same continuous deadline', () => {
  const h = fixture();
  const card = h.cards[0];
  h.io().show(card.video, 0);
  h.clock.advance(800);
  h.io().show(card.video, 0);
  h.clock.advance(200);
  assert.equal(card.pauses(), 1);
});

test('queued re-entry cancels a due timer before the observer callback is delivered', () => {
  const h = fixture();
  const card = h.cards[0];
  h.io().show(card.video, 0);
  h.clock.advance(999);
  h.io().queue(card.video, 0.1);
  h.clock.advance(1);
  assert.equal(card.pauses(), 0);
  assert.equal(h.clock.count(), 0);
  h.io().show(card.video, 0);
  h.clock.advance(999);
  h.io().queue(card.video, 0.1);
  h.io().queue(card.video, 0);
  h.clock.advance(1);
  assert.equal(card.pauses(), 0, 'a fresh departure in the same batch starts another second');
  h.clock.advance(999);
  assert.equal(card.pauses(), 0);
  h.clock.advance(1);
  assert.equal(card.pauses(), 1);
});

test('manual pause clears the timer and stays paused when the post returns', () => {
  const h = fixture();
  const card = h.cards[0];
  h.io().show(card.video, 0);
  h.clock.advance(500);
  card.video.pause();
  assert.equal(h.clock.count(), 0);
  h.io().show(card.video, 1);
  h.clock.advance(1500);
  assert.equal(card.pauses(), 1);
  assert.equal(card.plays(), 0);
  assert.equal(card.video.paused, true);
});

test('an explicit play while still offscreen gets its own second, without calling play itself', () => {
  const h = fixture();
  const card = h.cards[0];
  h.io().show(card.video, 0);
  h.clock.advance(1000);
  card.start();
  h.clock.advance(999);
  assert.equal(card.pauses(), 1);
  h.clock.advance(1);
  assert.equal(card.pauses(), 2);
  assert.equal(card.plays(), 1);
});

test('every route change discards its old deadline, including another Home filter', () => {
  const h = fixture();
  const card = h.cards[0];
  const old = h.io();
  old.show(card.video, 0);
  h.clock.advance(800);
  h.route('/?sk=h_chr');
  assert.equal(old.disconnected, true);
  assert.equal(h.clock.count(), 0);
  old.show(card.video, 0);
  h.clock.advance(1000);
  assert.equal(card.pauses(), 0, 'a callback from the old route is ignored');
  h.io().show(card.video, 0);
  h.clock.advance(500);
  h.route('/reel/1234567/');
  h.clock.advance(1000);
  assert.equal(card.pauses(), 0);
  assert.equal(h.intersections.every((observer) => observer.disconnected), true);
});

test('a changed address cancels a timer before the content-mode router catches up', () => {
  const h = fixture({ staleRoute: true });
  const card = h.cards[0];
  const old = h.io();
  old.show(card.video, 0);
  h.clock.advance(999);
  h.win.history.pushState({}, '', '/reel/1234567/');
  h.clock.advance(1);
  assert.equal(card.pauses(), 0);
  assert.equal(old.disconnected, true);
  assert.equal(h.mutations.every((observer) => observer.disconnected), true);
});

test('changing src disconnects old observation and its stale callbacks cannot pause the new media', () => {
  const h = fixture();
  const card = h.cards[0];
  const old = h.io();
  old.show(card.video, 0);
  h.clock.advance(800);
  card.video.setAttribute('src', '/second.mp4');
  h.mutate(card.video, { type: 'attributes' });
  const fresh = h.io();
  assert.ok(fresh !== old);
  assert.equal(old.disconnected, true);
  old.show(card.video, 0);
  h.clock.advance(1500);
  assert.equal(card.pauses(), 0);
  fresh.show(card.video, 0);
  h.clock.advance(999);
  assert.equal(card.pauses(), 0);
  h.clock.advance(1);
  assert.equal(card.pauses(), 1);
});

test('timer validation catches currentSrc and stream-object replacements without an event', () => {
  for (const replace of [(card) => card.source('blob:new-resource'), (card) => { card.video.srcObject = {}; }]) {
    const h = fixture();
    const card = h.cards[0];
    const old = h.io();
    old.show(card.video, 0);
    h.clock.advance(999);
    replace(card);
    h.clock.advance(1);
    assert.equal(card.pauses(), 0);
    assert.equal(old.disconnected, true);
    h.io().show(card.video, 0);
    h.clock.advance(1000);
    assert.equal(card.pauses(), 1);
  }
});

test('a source child and a same-address reload each discard earlier observations', () => {
  const h = fixture({ html: POST.replace('<video src="/first.mp4"></video>', '<video><source src="/first.mp4"></video>') });
  const card = h.cards[0];
  const old = h.io();
  old.show(card.video, 0);
  h.clock.advance(900);
  const source = card.video.querySelector('source');
  source.setAttribute('src', '/second.mp4');
  h.mutate(source, { type: 'attributes' });
  assert.equal(old.disconnected, true);
  for (const type of ['loadstart', 'emptied']) {
    const previous = h.io();
    previous.show(card.video, 0);
    h.clock.advance(900);
    card.fire(type);
    assert.equal(previous.disconnected, true);
    previous.show(card.video, 0);
    h.clock.advance(1000);
    assert.equal(card.pauses(), 0);
  }
  h.io().show(card.video, 0);
  h.clock.advance(1000);
  assert.equal(card.pauses(), 1);
});

test('one video being replaced does not postpone another video outside the viewport', () => {
  const h = fixture({ html: `${POST}${POST.replaceAll('1', '2')}` });
  const [one, two] = h.cards;
  h.io(one.video).show(one.video, 0);
  h.io(two.video).show(two.video, 0);
  h.clock.advance(900);
  two.fire('loadstart');
  h.clock.advance(100);
  assert.equal(one.pauses(), 1);
  assert.equal(two.pauses(), 0);
});

test('recycling a post drops prior observation even when the video element and source are reused', () => {
  const h = fixture();
  const card = h.cards[0];
  const post = h.posts.current()[0];
  const old = h.io();
  old.show(card.video, 0);
  h.clock.advance(900);
  h.posts.emit('post/remove', post);
  const replacement = { ...post, id: 'second-story' };
  h.posts.emit('post/add', replacement);
  old.show(card.video, 0);
  h.clock.advance(1000);
  assert.equal(card.pauses(), 0);
  h.io().show(card.video, 0);
  h.clock.advance(1000);
  assert.equal(card.pauses(), 1);
});

test('removing and reinserting a video or its wrapper starts a fresh observation in the same mutation batch', () => {
  for (const wrapped of [false, true]) {
    const h = fixture({ html: wrapped ? POST.replace('<video src="/first.mp4"></video>', '<section><video src="/first.mp4"></video></section>') : POST });
    const card = h.cards[0];
    const old = h.io();
    old.show(card.video, 0);
    h.clock.advance(900);
    const post = h.posts.current()[0];
    const node = wrapped ? card.video.parentElement : card.video;
    node.remove();
    post.element.append(node);
    h.mutate(post.element, { removedNodes: [node], addedNodes: [node] });
    assert.equal(old.disconnected, true, 'DOM reuse invalidates the earlier observer');
    const fresh = h.io();
    assert.ok(fresh !== old);
    old.show(card.video, 0);
    fresh.show(card.video, 0);
    h.clock.advance(999);
    assert.equal(card.pauses(), 0);
    h.clock.advance(1);
    assert.equal(card.pauses(), 1);
  }
});

test('late videos are observed from post changes and media events, and removed videos are forgotten', () => {
  const h = fixture({ html: POST.replace('<video src="/first.mp4"></video>', '') });
  const post = h.posts.current()[0];
  const video = h.doc.createElement('video');
  const card = media(h.win, video);
  post.element.append(video);
  h.mutate(post.element, { addedNodes: [video] });
  h.io(video).show(video, 0);
  h.clock.advance(500);
  video.remove();
  h.mutate(post.element, { removedNodes: [video] });
  h.clock.advance(1000);
  assert.equal(card.pauses(), 0);
  assert.ok(h.io(video) === undefined);
  post.element.append(video);
  card.fire('playing');
  h.io(video).show(video, 0);
  h.clock.advance(1000);
  assert.equal(card.pauses(), 1);
});

test('article players, nested comment media and modal viewers get no observation', () => {
  const html = `${POST.replace('</div>', '<div role="article" aria-label="Comment by Someone"><video></video></div></div>')}
    <div role="article"><a href="/someone/posts/200001">Post</a><video></video></div>
    <div role="dialog">${POST.replaceAll('1', '3')}</div>
    <div aria-modal="true">${POST.replaceAll('1', '4')}</div><video></video>`;
  const h = fixture({ html });
  assert.equal(h.intersections.length, 1);
  assert.equal(h.io(h.cards[0].video)?.targets.has(h.cards[0].video), true);
  for (const card of h.cards.slice(1)) assert.ok(h.io(card.video) === undefined);
});

test('moving a tracked post into a viewer cancels its timer and returning starts fresh', () => {
  const h = fixture();
  const card = h.cards[0];
  const post = h.posts.current()[0];
  h.io().show(card.video, 0);
  h.clock.advance(900);
  const viewer = h.doc.createElement('div');
  viewer.setAttribute('role', 'dialog');
  h.doc.body.append(viewer);
  viewer.append(post.element);
  h.mutate(viewer, { addedNodes: [post.element] });
  h.clock.advance(1000);
  assert.equal(card.pauses(), 0);
  assert.ok(h.io() === undefined);
  viewer.removeAttribute('role');
  h.mutate(viewer, { type: 'attributes' });
  h.io().show(card.video, 0);
  h.clock.advance(1000);
  assert.equal(card.pauses(), 1);
});

test('fullscreen and picture-in-picture cancel pending pauses and resume observation only after leaving', () => {
  for (const kind of ['fullscreenElement', 'pictureInPictureElement']) {
    const h = fixture();
    const card = h.cards[0];
    let player = null;
    Object.defineProperty(h.doc, kind, { get: () => player, configurable: true });
    const old = h.io();
    old.show(card.video, 0);
    h.clock.advance(900);
    player = kind === 'fullscreenElement' ? card.video.parentElement : card.video;
    const enter = kind === 'fullscreenElement' ? 'fullscreenchange' : 'enterpictureinpicture';
    (kind === 'fullscreenElement' ? h.doc : card.video).dispatchEvent(new h.win.Event(enter));
    assert.equal(old.disconnected, true);
    assert.equal(h.clock.count(), 0);
    h.clock.advance(1000);
    assert.equal(card.pauses(), 0);
    assert.ok(h.io() === undefined);
    player = null;
    const leave = kind === 'fullscreenElement' ? 'fullscreenchange' : 'leavepictureinpicture';
    (kind === 'fullscreenElement' ? h.doc : card.video).dispatchEvent(new h.win.Event(leave));
    h.io().show(card.video, 0);
    h.clock.advance(1000);
    assert.equal(card.pauses(), 1);
    assert.equal(card.plays(), 0);
  }
});

test('another player entering or leaving fullscreen or picture-in-picture preserves an unrelated continuous deadline', () => {
  for (const kind of ['fullscreenElement', 'pictureInPictureElement']) {
    const h = fixture({ html: `${POST}${POST.replaceAll('1', '2')}` });
    const [one, two] = h.cards;
    let player = null;
    Object.defineProperty(h.doc, kind, { get: () => player, configurable: true });
    const observer = h.io(one.video);
    observer.show(one.video, 0);
    h.clock.advance(900);
    player = kind === 'fullscreenElement' ? two.video.parentElement : two.video;
    (kind === 'fullscreenElement' ? h.doc : two.video).dispatchEvent(new h.win.Event(kind === 'fullscreenElement' ? 'fullscreenchange' : 'enterpictureinpicture'));
    assert.ok(h.io(one.video) === observer, 'another player does not reset this observer');
    assert.ok(h.io(two.video) === undefined, 'the affected player is exempt');
    h.clock.advance(50);
    player = null;
    (kind === 'fullscreenElement' ? h.doc : two.video).dispatchEvent(new h.win.Event(kind === 'fullscreenElement' ? 'fullscreenchange' : 'leavepictureinpicture'));
    assert.ok(h.io(one.video) === observer);
    h.clock.advance(50);
    assert.equal(one.pauses(), 1, 'the original full second still ends on time');
    assert.equal(two.pauses(), 0);
  }
});

test('fullscreen or picture-in-picture set just before a timer fires remains exempt without relying on an event', () => {
  for (const kind of ['fullscreenElement', 'pictureInPictureElement', 'webkitFullscreenElement']) {
    const h = fixture();
    const card = h.cards[0];
    h.io().show(card.video, 0);
    h.clock.advance(999);
    Object.defineProperty(h.doc, kind, { value: card.video, configurable: true });
    h.clock.advance(1);
    assert.equal(card.pauses(), 0);
  }
});

test('disabling disconnects every observer, timer and post subscription, and re-enabling starts fresh', () => {
  const h = fixture();
  const card = h.cards[0];
  const old = h.io();
  old.show(card.video, 0);
  h.clock.advance(900);
  h.setOn(false);
  assert.equal(h.clock.count(), 0);
  assert.equal(h.posts.subscriptions(), 0);
  assert.equal(h.intersections.every((observer) => observer.disconnected), true);
  assert.equal(h.mutations.every((observer) => observer.disconnected), true);
  old.show(card.video, 0);
  card.fire('playing');
  h.clock.advance(1000);
  assert.equal(card.pauses(), 0);
  h.setOn(true);
  assert.ok(h.io() !== old);
  h.io().show(card.video, 0);
  h.clock.advance(1000);
  assert.equal(card.pauses(), 1);
  h.pauser.stop();
  assert.equal(h.posts.subscriptions(), 0);
  assert.equal(h.mutations.every((observer) => observer.disconnected), true);
});

test('default off creates no observers and missing browser APIs mark the switch unavailable', () => {
  const h = fixture({ on: false });
  assert.equal(h.intersections.length, 0);
  assert.equal(h.mutations.length, 0);
  assert.equal(h.posts.subscriptions(), 0);
  h.win.IntersectionObserver = undefined;
  const unavailable = [];
  feature.setup({ doc: h.doc, win: h.win, posts: h.posts, enabled: () => false, markUnavailable: (reason) => unavailable.push(reason) });
  assert.deepEqual(unavailable, ['api']);
});

test('setup follows settings and route subscriptions, including a remote Pause setting', () => {
  const h = fixture({ on: false });
  let on = false;
  const fromSettings = [];
  const fromRouter = [];
  feature.setup({ doc: h.doc, win: h.win, posts: h.posts, enabled: () => on,
    settings: { subscribe: (listener) => fromSettings.push(listener) },
    router: { current: () => parseRoute(hrefOf(h)), subscribe: (listener) => fromRouter.push(listener) } });
  assert.equal(h.intersections.length, 0);
  on = true;
  fromSettings[0]({ keys: ['pauseOffscreenVideos'] });
  const first = h.io();
  assert.ok(first);
  on = false;
  fromSettings[0]({ keys: ['paused'], remote: true });
  assert.equal(first.disconnected, true);
  on = true;
  fromSettings[0]({ keys: ['paused'], remote: true });
  const second = h.io();
  h.win.history.pushState({}, '', '/groups/example/posts/1234567/');
  fromRouter[0](parseRoute(hrefOf(h)));
  assert.equal(second.disconnected, true);
  assert.ok(h.io() === undefined);
});

test('a real post tracker recycles reused media on a changed post link', async () => {
  const h = fixture({ realPosts: true });
  const card = h.cards[0];
  const old = h.io();
  old.show(card.video, 0);
  h.clock.advance(900);
  card.video.parentElement.querySelector('a').setAttribute('href', '/someone/posts/200002');
  await tick();
  await tick();
  assert.equal(old.disconnected, true);
  assert.equal(h.clock.count(), 0);
  old.show(card.video, 0);
  h.clock.advance(1000);
  assert.equal(card.pauses(), 0);
  h.io().show(card.video, 0);
  h.clock.advance(1000);
  assert.equal(card.pauses(), 1);
});
