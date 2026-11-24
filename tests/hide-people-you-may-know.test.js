// People you may know rows that reach Home or the groups feed anyway are hidden on the page by
// their links (#5: the row still showed on 0.0.45 for its reporter). The row here is laid out
// like the reporter's picture: a heading, cards with a person's link and an Add friend button,
// and a See all link under them. The words play no part.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { setLanguage } from '../src/core/i18n.js';
import { parseRoute } from '../src/core/route.js';
import hidePeopleYouMayKnow, { pymkRow } from '../src/features/feed/hide-people-you-may-know.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const card = (n, href = `/profile.php?id=${n}`) => `<div><a href="${href}"><img alt=""></a><a href="${href}"><span>Person ${n}</span></a><div role="button">Add friend</div></div>`;
const ROW = (id, { title = 'People you may know', more = 'See all', seeAll = '/friends/suggestions/', cards = [1, 2, 3].map((n) => card(n)).join('') } = {}) => `<div id="${id}" aria-posinset="2">
  <div><h3><span>${title}</span></h3><div role="button" aria-label="More"></div></div>
  <div>${cards}</div>${seeAll ? `<a href="${seeAll}">${more}</a>` : ''}</div>`;
// A friend's post that links to the suggestions page in what it says.
const POST = (id) => `<div id="${id}" aria-posinset="3"><div data-ad-rendering-role="profile_name"><h4><a href="/sam">Sam Example</a></h4></div>
  <div data-ad-rendering-role="story_message">Look who it suggests now <a href="https://www.facebook.com/friends/suggestions/">facebook.com/friends/suggestions</a></div></div>`;

function feed(url) {
  const win = testWindow(url);
  windows.push(win);
  const doc = win.document;
  doc.body.innerHTML = '<div role="main"><div class="feed"></div></div>';
  let current = parseRoute(url);
  const listeners = new Map();
  const tracked = [];
  const posts = {
    on: (event, fn) => {
      listeners.set(event, fn);
      return () => listeners.delete(event);
    },
    current: () => tracked,
  };
  const hidden = new Map();
  const names = [];
  const hider = {
    hide: (element, reason, detail, signal, name) => {
      names.push(typeof name === 'function' ? name() : name);
      hidden.set(element.id, reason);
      return true;
    },
    isHidden: (element) => hidden.has(element.id),
    showAll: (reason) => {
      for (const [id, why] of hidden) if (why === reason) hidden.delete(id);
    },
  };
  const values = { hidePeopleYouMayKnow: true };
  const settingListeners = [];
  const settings = { get: (key) => values[key], enabled: (id) => values[id] === true, subscribe: (fn) => settingListeners.push(fn) };
  const rows = new Map();
  const diagnostics = { add: (label, read) => rows.set(label, read), changed: () => {} };
  const router = { current: () => current, subscribe: () => {} };
  hidePeopleYouMayKnow.setup({ doc, net: null, router, posts, hider, settings, diagnostics, enabled: () => values.hidePeopleYouMayKnow === true, option: () => false });
  return {
    doc,
    hidden,
    names,
    add(html) {
      doc.querySelector('.feed').insertAdjacentHTML('beforeend', html);
      const element = doc.querySelector('.feed').lastElementChild;
      tracked.push({ element });
      listeners.get('post/add')({ element });
      return element;
    },
    // Taken off the page, so its retries stop.
    clear() {
      for (const { element } of tracked.splice(0)) listeners.get('post/remove')({ element });
    },
    go: (to) => {
      current = parseRoute(to);
    },
    flip(on) {
      values.hidePeopleYouMayKnow = on;
      for (const fn of settingListeners) fn();
    },
    shown: () => [...rows].find(([label]) => label === 'People you may know rows hidden on the page')[1](),
  };
}

test('a People you may know row on Home is hidden by its See all link, under its own name, in content mode too (#5)', () => {
  const page = feed('https://www.facebook.com/');
  page.add(ROW('row'));
  page.add(POST('post'));
  assert.deepEqual([...page.hidden], [['row', 'People']]);
  assert.deepEqual(page.names, ['People you may know'], 'the note gets the long name');
  assert.equal(page.shown(), '1');
  page.clear();
});

test("the row's name in its note reads in the chosen language", () => {
  setLanguage('ru');
  try {
    const page = feed('https://www.facebook.com/');
    page.add(ROW('row'));
    assert.deepEqual(page.names, ['Вы можете их знать']);
    page.clear();
  } finally {
    setLanguage('en');
  }
});

test('the words play no part: a row in another language goes, and so does one whose cards link to the suggestions page', () => {
  const page = feed('https://www.facebook.com/groups/feed/');
  page.add(ROW('other', { title: 'Personas que quizá conozcas', more: 'Ver todo' }));
  page.add(ROW('cards', { seeAll: '', cards: [1, 2].map((n) => card(n, `/friends/suggestions/?profile_id=${n}`)).join('') }));
  page.add(ROW('one', { seeAll: '', cards: card(1, '/friends/suggestions/?profile_id=1') }));
  assert.deepEqual([...page.hidden.keys()], ['other', 'cards'], "one card linking there isn't enough");
  page.clear();
});

test("a post that links to the suggestions page stays, and so does a row anywhere but Home and the groups feed", () => {
  const page = feed('https://www.facebook.com/');
  const post = page.add(POST('post'));
  assert.equal(pymkRow(post), false);
  page.go('https://www.facebook.com/profile.php?id=1');
  page.add(ROW('profile'));
  page.go('https://www.facebook.com/groups/garden');
  page.add(ROW('group'));
  assert.equal(page.hidden.size, 0, 'the Friends page and profiles are the friendsPages option');
  page.clear();
});

test('switched off the row comes back, switched on it goes again, and a row the data already hid counts once', () => {
  const page = feed('https://www.facebook.com/');
  page.add(ROW('row'));
  assert.equal(page.hidden.get('row'), 'People');
  page.flip(false);
  assert.equal(page.hidden.size, 0);
  page.flip(true);
  assert.equal(page.hidden.get('row'), 'People');
  const before = page.shown();
  page.hidden.set('drawn', 'People');
  page.add(ROW('drawn'));
  assert.equal(page.hidden.get('drawn'), 'People');
  assert.equal(page.shown(), before, 'hidden by its place in the data first, so not counted again');
  page.clear();
});
