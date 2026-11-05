import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRouter, parseRoute } from '../src/core/route.js';
import { followingFeedUrl, isPlainHome } from '../src/features/opening/following-feed.js';
import { rootlessDocument } from './fake-dom.js';

const fb = (path) => `https://www.facebook.com${path}`;

test('parseRoute names the kind of page', () => {
  const cases = [
    ['/', 'home', false],
    ['/?sk=h_chr', 'home', false],
    ['/home.php', 'home', false],
    ['/marketplace/item/1/', 'marketplace', false],
    ['/watch/?v=1', 'watch', false],
    ['/reel/123', 'reel', false],
    ['/someone', 'profile', false],
    ['/profile.php?id=1', 'profile', false],
    ['/someone/posts/pfbid02abcXYZ', 'profile', true],
    ['/someone/posts/123456', 'profile', true],
    ['/groups/x/posts/123/', 'groups', true],
    ['/groups/x/permalink/123/', 'groups', true],
    ['/groups/x/?multi_permalinks=1', 'groups', true],
    ['/permalink.php?story_fbid=1&id=2', 'post', true],
  ];
  for (const [path, type, permalink] of cases) {
    const route = parseRoute(fb(path));
    assert.equal(route.type, type, path);
    assert.equal(route.permalink, permalink, path);
  }
  assert.equal(parseRoute(fb('/?sk=h_chr')).feed, 'h_chr');
});

test('the router follows history changes and stamps <html>', () => {
  const location = { href: fb('/') };
  const navigate = (_state, _title, url) => { location.href = new URL(url, location.href).href; };
  const dataset = {};
  const win = {
    location,
    document: { documentElement: { dataset } },
    history: { pushState: navigate, replaceState: navigate },
    addEventListener() {},
    setInterval() {},
  };
  const router = createRouter({ win, pageAccess: 'page' });
  assert.equal(dataset.hfwRoute, 'home');

  const seen = [];
  router.subscribe((route) => seen.push(route.type));
  win.history.pushState(null, '', '/marketplace/');
  win.history.replaceState(null, '', '/marketplace/');
  win.history.pushState(null, '', '/groups/1/posts/2/');
  assert.deepEqual(seen, ['marketplace', 'groups']);
  assert.equal(dataset.hfwRoute, 'groups');
  assert.equal(dataset.hfwPermalink, 'true');
  assert.equal(router.current().path, '/groups/1/posts/2/');
});

// A content-mode window: the page's history calls can't be wrapped from here.
function contentWindow({ navigation } = {}) {
  const location = { href: fb('/') };
  const timers = [];
  const win = {
    location,
    document: { documentElement: { dataset: {} } },
    history: { pushState() { throw new Error('content mode never wraps history'); }, replaceState() {} },
    addEventListener() {},
    setInterval: (fn, ms) => timers.push({ fn, ms }),
    navigation,
  };
  return { win, timers, go: (path) => { location.href = fb(path); } };
}

test('content mode follows the page through the Navigation API where it has one, with no timer', () => {
  const listeners = {};
  const navigation = { addEventListener: (type, fn) => (listeners[type] ??= []).push(fn) };
  const { win, timers, go } = contentWindow({ navigation });
  const router = createRouter({ win, pageAccess: 'content' });
  const seen = [];
  router.subscribe((route) => seen.push(route.type));
  const fire = (type) => (listeners[type] ?? []).forEach((fn) => fn({ type }));

  assert.deepEqual(timers, [], 'no polling');
  go('/marketplace/');
  fire('currententrychange');
  fire('navigatesuccess');
  go('/groups/1/posts/2/');
  fire('currententrychange');
  // A replace to the same address changes nothing.
  fire('currententrychange');
  assert.deepEqual(seen, ['marketplace', 'groups']);
  assert.equal(win.document.documentElement.dataset.hfwRoute, 'groups');
  // A navigation only navigatesuccess reports still counts.
  go('/watch/?v=1');
  fire('navigatesuccess');
  assert.deepEqual(seen, ['marketplace', 'groups', 'watch']);
});

test('content mode polls the address in a browser without the Navigation API', () => {
  const { win, timers, go } = contentWindow();
  const router = createRouter({ win, pageAccess: 'content', pollMs: 500 });
  const seen = [];
  router.subscribe((route) => seen.push(route.type));
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 500);
  timers[0].fn();
  go('/marketplace/');
  timers[0].fn();
  timers[0].fn();
  assert.deepEqual(seen, ['marketplace']);
});

test('the first route stamp waits for <html> when the router starts before it exists', () => {
  const { doc, addRoot } = rootlessDocument();
  const win = {
    location: { href: fb('/reel/1') },
    document: doc,
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    setInterval() {},
  };
  createRouter({ win, pageAccess: 'page' });
  const dataset = {};
  addRoot({ dataset });
  assert.equal(dataset.hfwRoute, 'reel');
});

test('the Following feed only takes over the plain Home URL', () => {
  assert.equal(isPlainHome(fb('/')), true);
  assert.equal(isPlainHome('https://web.facebook.com/'), true);
  assert.equal(isPlainHome(fb('/?sk=h_chr')), false);
  assert.equal(isPlainHome(fb('/marketplace/')), false);
  assert.equal(isPlainHome('https://m.facebook.com/'), false);
  assert.equal(followingFeedUrl('friends'), '/?filter=friends&sk=h_chr');
});
