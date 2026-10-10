import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRouter, parseRoute } from '../src/core/route.js';
import { followingFeedUrl, isPlainHome } from '../src/features/opening/following-feed.js';

const fb = (path) => `https://www.facebook.com${path}`;

test('parseRoute names the kind of page', () => {
  const cases = [
    ['/', 'home', false],
    ['/?sk=h_chr', 'home', false],
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

test('the Following feed only takes over the plain Home URL', () => {
  assert.equal(isPlainHome(fb('/')), true);
  assert.equal(isPlainHome('https://web.facebook.com/'), true);
  assert.equal(isPlainHome(fb('/?sk=h_chr')), false);
  assert.equal(isPlainHome(fb('/marketplace/')), false);
  assert.equal(isPlainHome('https://m.facebook.com/'), false);
  assert.equal(followingFeedUrl('friends'), '/?filter=friends&sk=h_chr');
});
