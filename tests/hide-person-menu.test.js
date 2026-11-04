// "Hide posts by <name>" in a post's three-dot menu (Hide posts by words), against the 100 posts
// in organic-posts.jsonl.gz (Home, the groups feed and search, 2026-10-11) and the post menu as
// drawn live on 2026-10-22: a role=menu ("Feed story") in a layer of its own with role=button rows,
// Embed, then Report post with a second line. A group post's heading is the group, and the member
// who posted it is a link of their own under it.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { fixtureLines } from './helpers/fixtures.js';
import { createActions } from '../src/core/actions.js';
import { createDiagnostics } from '../src/core/diagnostics.js';
import { createHider, MARK, NOTE } from '../src/core/dom/hide.js';
import { OUR_ROW, menuPost } from '../src/core/dom/post-menu.js';
import { createPostTracker } from '../src/core/dom/posts.js';
import { postFields, posterOf } from '../src/core/filters/page.js';
import { parseRoute } from '../src/core/route.js';
import { createSettings } from '../src/core/settings.js';
import { startFeatures } from '../src/core/start-features.js';
import { createMemoryStorage } from '../src/core/storage.js';
import { ROW_MARK, createMenuDownload } from '../src/features/downloads/download-menu.js';
import hidePostsByWords from '../src/features/feed/filters.js';

const fixture = (await fixtureLines('organic-posts.jsonl.gz')).map((line) => JSON.parse(line));
// The groups feed's first post, by the member "Stone falcon" in the group "Cobalt falcon summit",
// and a Home post by "Dune lagoon", as scrubbed.
const GROUP_POST = fixture[0].html;
const HOME_POST = fixture[39].html;
const MEMBER = 'Stone falcon';
const GROUP = 'Cobalt falcon summit';
const PERSON_MARK = 'data-hfw-menu-hide-person';
// A post's own text.
const WORDS = '[data-ad-rendering-role="story_message"], [data-ad-preview="message"]';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const row = (id, words, tabindex) => `<div role="button" tabindex="${tabindex}" id="${id}" aria-label="${words[0]}">
  <div><svg aria-hidden="true" width="20" height="20"><path d="M0 0"></path></svg></div>
  <div><div>${words.map((w) => `<div><span>${w}</span></div>`).join('')}</div></div>
  <div role="none"></div>
</div>`;

const MENU = `<div role="menu" aria-label="Feed story"><div><div><div aria-hidden="false"><div><div><div id="rows">
  ${row('embed', ['Embed'], 0)}
  <hr>
  ${row('report-post', ['Report post', "We won't let them know who reported this."], -1)}
</div></div></div></div></div></div></div>`;

const COMMENT = `<div role="article" aria-label="Comment by Someone" id="comment">
  <div role="button" aria-haspopup="menu" aria-expanded="false" aria-label="Report this" id="report"></div>
</div>`;

// Every fetch or XHR the page makes is written down and refused.
function page(href = 'https://www.facebook.com/') {
  const requests = [];
  const refuse = ({ request, window }) => {
    requests.push(request.url);
    return window.Response.error();
  };
  const win = testWindow(href, {
    fetch: { interceptor: { beforeAsyncRequest: async (context) => refuse(context), beforeSyncRequest: ({ request }) => {
      requests.push(request.url);
      return { status: 0, statusText: '', ok: false, url: request.url, redirected: false, headers: new win.Headers(), body: null };
    } } },
  });
  windows.push(win);
  win.document.body.innerHTML = `<div role="main"><div class="feed"><div id="group-wrap">${GROUP_POST}</div><div id="home-wrap">${HOME_POST}</div></div></div><div id="layers"></div>`;
  win.document.querySelector('#home-wrap > [aria-posinset]').insertAdjacentHTML('beforeend', COMMENT);
  return { win, doc: win.document, requests };
}

const groupPost = (doc) => doc.querySelector('#group-wrap > [aria-posinset]');
const homePost = (doc) => doc.querySelector('#home-wrap > [aria-posinset]');
// A post's own three-dot button: the first button in it that opens a menu.
const dotsOf = (post) => [...post.querySelectorAll('[aria-haspopup="menu"]')].find((el) => !el.closest('#comment'));

// Facebook's three-dot buttons: a click opens the menu in the layers, a second closes it.
function wireMenus(doc) {
  for (const button of doc.querySelectorAll('[aria-haspopup="menu"]')) {
    button.addEventListener('click', () => {
      const open = button.getAttribute('aria-expanded') === 'true';
      for (const other of doc.querySelectorAll('[aria-expanded="true"]')) other.setAttribute('aria-expanded', 'false');
      doc.getElementById('layers').replaceChildren();
      if (open) return;
      button.setAttribute('aria-expanded', 'true');
      doc.getElementById('layers').innerHTML = MENU;
    });
  }
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });
const ROWS = '[role="menuitem"], [role="button"]';
// Every row the open menu shows, top to bottom.
const ids = (doc) => [...(doc.querySelector('[role="menu"]')?.querySelectorAll(ROWS) ?? [])].filter((el) => !el.parentElement.closest(ROWS))
  .map((el) => el.id || (el.hasAttribute(PERSON_MARK) ? 'person' : el.hasAttribute(ROW_MARK) ? 'download' : '?'));
const personRow = (doc) => doc.querySelector(`[role="menu"] [${PERSON_MARK}]`);
const noteOf = (post) => post.querySelector(`[${MARK}]`)?.getAttribute(NOTE) ?? null;

async function feature({ href = 'https://www.facebook.com/', settings: saved = {} } = {}) {
  const { win, doc, requests } = page(href);
  wireMenus(doc);
  let address = href;
  const storage = createMemoryStorage({ settings: { hidePostsByWords: true, ...saved } });
  // refuse(true) makes saves fail later, the way a full or closed extension storage does.
  let refusing = false;
  const mutate = storage.mutate;
  storage.mutate = (key, mutation) => (refusing ? Promise.reject(new Error('Storage refused the save')) : mutate(key, mutation));
  const settings = createSettings({ storage, features: [hidePostsByWords], migrations: [] });
  const posts = createPostTracker({ doc });
  const hider = createHider({ doc, posts });
  const diagnostics = createDiagnostics();
  const toasts = [];
  const errors = [];
  startFeatures({
    features: [hidePostsByWords], settings, unavailable: new Map(),
    log: { error: (...args) => errors.push(args) },
    context: (feat) => ({
      win, doc, posts, hider, diagnostics,
      storage: createMemoryStorage(),
      actions: createActions().for(feat.id),
      router: { current: () => parseRoute(address) },
      log: { warn() {}, info() {}, error: (...args) => errors.push(args) },
      toast: (message, options = {}) => {
        toasts.push({ message, options });
        return { dismiss() {} };
      },
    }),
  });
  await settle();
  const people = () => settings.get('hidePostsByWords.people');
  const go = (to) => { address = to; };
  return { win, doc, requests, settings, posts, diagnostics, toasts, errors, people, go, refuse: (on) => { refusing = on; } };
}

async function open(doc, post) {
  dotsOf(post).click();
  await settle();
}

// One captured post on a page of its own, closed after, as organic-posts.test.js reads them.
async function read(html, look) {
  const win = testWindow('https://www.facebook.com/');
  try {
    win.document.body.innerHTML = html;
    return look(win.document.body.firstElementChild);
  } finally {
    await win.happyDOM.close();
  }
}

test('every captured post names who posted it, and a group post names the member, never the group', async () => {
  const groups = [];
  const problems = [];
  for (const [index, { html }] of fixture.entries()) {
    const seen = await read(html, (post) => {
      const heading = post.querySelector('[data-ad-rendering-role="profile_name"] a[href*="/groups/"]:not([href*="/user/"])');
      const poster = posterOf(post);
      const members = [...post.querySelectorAll('a[href*="/groups/"][href*="/user/"]')].map((a) => a.textContent.trim());
      return { poster, group: heading?.textContent.trim() ?? null, members, authors: postFields(post).authors };
    });
    const { poster, group, members, authors } = seen;
    if (!poster) problems.push(`#${index} names nobody`);
    else if (!authors.includes(poster)) problems.push(`#${index}: the page check doesn't read ${poster} as an author`);
    if (!group) continue;
    groups.push(index);
    if (poster === group) problems.push(`#${index} names the group`);
    if (!members.includes(poster)) problems.push(`#${index}: ${poster} isn't a member's link`);
    if (!authors.includes(group)) problems.push(`#${index}: a people line naming the group stops matching`);
  }
  assert.deepEqual(problems, []);
  assert.equal(groups.length, 73);
  const sample = await read(GROUP_POST, (post) => postFields(post).authors);
  assert.deepEqual(sample, [GROUP, MEMBER]);
});

test("the open menu belongs to a post only through its own first menu button, never a comment's", () => {
  const { doc } = page();
  // Identity as booleans: a failed equal on an element formats all of happy-dom's window.
  assert.equal(menuPost(doc) === null, true);
  doc.getElementById('report').setAttribute('aria-expanded', 'true');
  assert.equal(menuPost(doc) === null, true, "a comment's Report this");
  doc.getElementById('report').setAttribute('aria-expanded', 'false');
  // Comment order, under the post and outside any comment.
  groupPost(doc).insertAdjacentHTML('beforeend', '<div role="button" aria-haspopup="menu" aria-expanded="true" aria-label="Most relevant" id="sort"></div>');
  assert.equal(menuPost(doc) === null, true, 'a later menu button in the post');
  doc.getElementById('sort').setAttribute('aria-expanded', 'false');
  dotsOf(groupPost(doc)).setAttribute('aria-expanded', 'true');
  assert.equal(menuPost(doc) === groupPost(doc), true);
  dotsOf(groupPost(doc)).setAttribute('aria-expanded', 'false');
  // A post whose first menu button sits below its text has no three-dot button of its own there.
  const post = homePost(doc);
  dotsOf(post).remove();
  post.querySelector('#comment').insertAdjacentHTML('beforebegin', '<div role="button" aria-haspopup="menu" aria-expanded="true" id="late"></div>');
  assert.equal(menuPost(doc) === null, true, 'a first menu button under the post text');
});

test("every captured post's first menu button sits after its header and before its text, so each opens as that post's menu", async () => {
  const misses = [];
  for (const [index, { html }] of fixture.entries()) {
    const ok = await read(html, (post) => {
      const header = post.querySelector('[data-ad-rendering-role="profile_name"]');
      const dots = [...post.querySelectorAll('[aria-haspopup="menu"]')].find((el) => el.closest('[aria-posinset], [role="article"]') === post);
      const words = post.querySelector(WORDS);
      dots.setAttribute('aria-expanded', 'true');
      const after = Boolean(header.compareDocumentPosition(dots) & 4);
      // Some posts are only a link preview, with no text of their own.
      const before = !words || Boolean(dots.compareDocumentPosition(words) & 4);
      return after && before && menuPost(post.ownerDocument) === post;
    });
    if (!ok) misses.push(index);
  }
  assert.deepEqual(misses, []);
});

test('a group post with no member link of its own names nobody and gets no row, rather than a shared post or a name in its text', async () => {
  const anonymous = async (doc) => {
    const post = groupPost(doc);
    for (const link of post.querySelectorAll('a[href*="/groups/"][href*="/user/"]')) link.remove();
    // A shared post under the text: its own header (a group) and its member.
    post.querySelector(WORDS).insertAdjacentHTML('afterend',
      '<div><div data-ad-rendering-role="profile_name"><h4><a href="/groups/9/">Other group</a></h4></div><a href="/groups/9/user/5/">Shared poster</a></div>');
    post.querySelector(WORDS).insertAdjacentHTML('beforeend', '<a href="/groups/9/user/6/">Named in text</a>');
    return post;
  };
  const { doc } = page();
  assert.equal(posterOf(await anonymous(doc)), null);
  const shown = await feature();
  await anonymous(shown.doc);
  await open(shown.doc, groupPost(shown.doc));
  assert.deepEqual(ids(shown.doc), ['embed', 'report-post']);
});

test('a stale open button on another post never names that post, and the row closes the menu through the one that opened last', async () => {
  const { doc, people } = await feature();
  await open(doc, groupPost(doc));
  // Facebook leaves the group post's button saying open and opens the Home post's menu.
  const clicks = [];
  for (const post of [groupPost(doc), homePost(doc)]) dotsOf(post).addEventListener('click', () => clicks.push(post === groupPost(doc) ? 'group' : 'home'));
  dotsOf(homePost(doc)).setAttribute('aria-expanded', 'true');
  await settle();
  assert.equal(dotsOf(groupPost(doc)).getAttribute('aria-expanded'), 'true');
  assert.equal(personRow(doc).textContent.replace(/\s+/g, ' ').trim(), 'Hide posts by Dune lagoon');
  personRow(doc).click();
  await settle();
  assert.deepEqual([people(), clicks], ['Dune lagoon', ['home']]);
});

test("one click adds the group post's member to the people list and hides the post, Undo takes it back, and nothing reaches Facebook", async () => {
  const { win, doc, requests, toasts, people, diagnostics, errors } = await feature();
  await open(doc, groupPost(doc));
  assert.deepEqual(ids(doc), ['person', 'embed', 'report-post']);
  assert.equal(personRow(doc).textContent.replace(/\s+/g, ' ').trim(), `Hide posts by ${MEMBER}`);
  assert.ok(personRow(doc).hasAttribute(OUR_ROW));
  assert.equal(personRow(doc).querySelectorAll('svg path').length, 1, 'its own picture');

  const seen = [];
  doc.querySelector('[role="menu"]').addEventListener('click', () => seen.push('menu'));
  for (const id of ['embed', 'report-post']) doc.getElementById(id).addEventListener('click', () => seen.push(id));
  const allowed = personRow(doc).dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepEqual([allowed, seen], [false, []], "Facebook's menu never sees the click");
  assert.ok(!doc.querySelector('[role="menu"]'), 'the menu closes the way its button does');
  await settle();
  assert.equal(people(), MEMBER);
  assert.equal(noteOf(groupPost(doc)), `Hidden: Filter: ${MEMBER}. Show`);
  assert.equal(noteOf(homePost(doc)), null);
  assert.deepEqual(toasts.map(({ message }) => message), [`Hiding posts by ${MEMBER}.`]);
  const row = Object.fromEntries(diagnostics.rows().map(({ label, value }) => [label, value]))['People hidden from post menus'];
  assert.equal(row, 'Offered in 1 menu, added 1');

  toasts[0].options.action.run();
  await settle();
  assert.equal(people(), '');
  assert.equal(noteOf(groupPost(doc)), null, 'Undo shows the post again');
  assert.equal(toasts[0].options.action.label, 'Undo');
  assert.deepEqual(requests, [], 'no hide, snooze or unfollow request, or any other');
  assert.deepEqual(errors, []);
});

test('a name goes on a line of its own after the list, Undo takes out only that line, and a name already listed is not added twice', async () => {
  const { doc, toasts, people, settings } = await feature({ settings: { 'hidePostsByWords.people': 'Loud Page' } });
  await open(doc, homePost(doc));
  assert.equal(personRow(doc).textContent.replace(/\s+/g, ' ').trim(), 'Hide posts by Dune lagoon');
  personRow(doc).click();
  await settle();
  assert.equal(people(), 'Loud Page\nDune lagoon');
  assert.equal(noteOf(homePost(doc)), 'Hidden: Filter: Dune lagoon. Show');
  // A line typed in after the click stays when Undo runs.
  await settings.set('hidePostsByWords.people', 'Loud Page\nDune lagoon\nQuiet Page');
  toasts[0].options.action.run();
  await settle();
  assert.equal(people(), 'Loud Page\nQuiet Page');

  await settings.set('hidePostsByWords.people', 'loud page\n  stone   FALCON\n');
  await settle();
  await open(doc, groupPost(doc));
  personRow(doc).click();
  await settle();
  assert.equal(people(), 'loud page\n  stone   FALCON\n', 'the same name, written another way, is already there');
  assert.equal(toasts.at(-1).message, `${MEMBER} is already on your list of people to hide.`);

  await settings.set('hidePostsByWords.people', 'Loud Page\n');
  await settle();
  await open(doc, groupPost(doc));
  personRow(doc).click();
  await open(doc, homePost(doc));
  personRow(doc).click();
  await settle();
  assert.equal(people(), 'Loud Page\nStone falcon\nDune lagoon', 'a list ending in a new line gets no blank line, and two in a row both stay');
});

test("a comment's menu, the filter off, preview on and a page the filter doesn't cover get no row", async () => {
  const { doc, settings, go } = await feature();
  doc.getElementById('report').click();
  await settle();
  assert.deepEqual(ids(doc), ['embed', 'report-post'], "a comment's menu");

  go('https://www.facebook.com/groups/1/posts/2/');
  await open(doc, groupPost(doc));
  assert.deepEqual(ids(doc), ['embed', 'report-post'], 'a post opened by its link');
  go('https://www.facebook.com/');

  await settings.set('hidePostsByWords.preview', true);
  await open(doc, groupPost(doc));
  await open(doc, groupPost(doc));
  assert.deepEqual(ids(doc), ['embed', 'report-post'], 'preview hides nothing, so it adds nothing');
  await settings.set('hidePostsByWords.preview', false);

  await settings.set('hidePostsByWords', false);
  await open(doc, groupPost(doc));
  await open(doc, groupPost(doc));
  assert.deepEqual(ids(doc), ['embed', 'report-post'], 'the filter is off');
  await settings.set('hidePostsByWords', true);
  await settle();
  assert.deepEqual(ids(doc), ['person', 'embed', 'report-post'], 'switching it on adds it to the open menu');
  await settings.set('hidePostsByWords', false);
  await settle();
  assert.deepEqual(ids(doc), ['embed', 'report-post'], 'and switching it off takes it out');
});

test('someone on the always-show list and a list at its length limit are left as they are, with a note', async () => {
  const { doc, toasts, people, settings } = await feature({ settings: { 'hidePostsByWords.showPeople': MEMBER } });
  await open(doc, groupPost(doc));
  personRow(doc).click();
  await settle();
  assert.equal(people(), '');
  assert.equal(toasts.at(-1).message, `${MEMBER} is on your list of people to always show, so their posts keep showing.`);

  await settings.set('hidePostsByWords.showPeople', '');
  const full = 'x'.repeat(19995);
  await settings.set('hidePostsByWords.people', full);
  await settle();
  await open(doc, groupPost(doc));
  personRow(doc).click();
  await settle();
  assert.equal(people(), full);
  assert.deepEqual([toasts.at(-1).message, toasts.at(-1).options.tone], [`Your list of people to hide is full, so ${MEMBER} wasn't added.`, 'error']);
});

test("after a save that failed, the panel holds the name for Retry, Undo still takes it out, and the next save leaves it out", async () => {
  const { doc, toasts, people, settings, errors, refuse } = await feature();
  refuse(true);
  await open(doc, groupPost(doc));
  personRow(doc).click();
  await settle();
  assert.equal(people(), '', 'nothing stored');
  assert.equal(settings.display('hidePostsByWords.people'), MEMBER, 'shown in the panel, waiting for Retry');
  assert.equal(settings.saveStatus().state, 'error');
  assert.deepEqual(errors.map(([message]) => message), ["Couldn't save the list of people to hide"]);

  toasts.at(-1).options.action.run();
  await settle();
  assert.equal(settings.display('hidePostsByWords.people'), '', 'Undo takes back the text Retry would send');
  refuse(false);
  await settings.set('hidePostsByWords.sites', 'example.com');
  await settle();
  assert.deepEqual([people(), noteOf(groupPost(doc))], ['', null], 'the next save of another setting brings nothing back');
});

test('when the always-show lists cover the post through its group, the name is added and the notice says this post stays', async () => {
  const { doc, toasts, people } = await feature({ settings: { 'hidePostsByWords.showPeople': GROUP } });
  await open(doc, groupPost(doc));
  personRow(doc).click();
  await settle();
  assert.equal(people(), MEMBER);
  assert.equal(noteOf(groupPost(doc)), null);
  assert.deepEqual([toasts.at(-1).message, toasts.at(-1).options.action.label],
    [`Hiding posts by ${MEMBER}. This post stays, since your always-show lists cover it.`, 'Undo']);
});

test('with Download in post menus on too, Download stays on top and this row comes next', async () => {
  const { win, doc, people } = await feature();
  // A picture put after the Home post's text, the one thing there to save.
  const SRC = 'https://scontent.example.invalid/1.jpg';
  const find = (media) => (media.getAttribute('src') === SRC ? { id: SRC } : null);
  const runs = [];
  const download = createMenuDownload({ doc, enabled: () => true, find, run: (found) => runs.push(found.id), setTimer: (fn) => win.setTimeout(fn, 0) });
  download.apply();
  const post = homePost(doc);
  const picture = doc.createElement('img');
  picture.setAttribute('src', SRC);
  post.querySelector('#comment').before(picture);
  await open(doc, post);
  assert.deepEqual(ids(doc), ['download', 'person', 'embed', 'report-post']);
  // A redraw drops both, and each comes back in its place.
  const rows = doc.getElementById('rows');
  rows.replaceChildren(...[...rows.children].filter((el) => !el.hasAttribute(OUR_ROW)).map((el) => el.cloneNode(true)));
  await settle();
  assert.deepEqual(ids(doc), ['download', 'person', 'embed', 'report-post']);
  assert.equal(personRow(doc).textContent.replace(/\s+/g, ' ').trim(), 'Hide posts by Dune lagoon');
  assert.ok(!personRow(doc).hasAttribute(ROW_MARK), "copied from Facebook's row, not from Download's");
  personRow(doc).click();
  await settle();
  assert.deepEqual([people(), runs], ['Dune lagoon', []]);
});
