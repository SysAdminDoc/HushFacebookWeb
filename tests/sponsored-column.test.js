// The right column's Sponsored box on the page, in happy-dom. The markup follows Home's
// right column as drawn on 2026-10-21 (div#right_rail_container, an h3 per box, the ads going
// out through l.php), with stand-in names.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { createDiagnostics } from '../src/core/diagnostics.js';
import { renderFeatureCss } from '../src/core/style.js';
import hideSponsoredPosts from '../src/features/feed/hide-sponsored-posts.js';
import hideFriendRequestsColumn from '../src/features/feed/hide-friend-requests-column.js';
import { COLUMN_AD_MARK, columnAdBoxes, FRIEND_REQUESTS_MARK, friendRequestsBoxes, watchColumnAds } from '../src/features/feed/sponsored-column.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const ZWSP = String.fromCharCode(0x200b);
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

const ad = (name, href = 'https://l.facebook.com/l.php?u=https%3A%2F%2Fshop.example%2F') => `
  <div class="ad"><div data-visualcompletion="ignore-dynamic">
    <a role="link" href="${href}"><span>${name}</span><span>shop.example</span></a>
    <div><span><div role="button" aria-label="Open menu for ${name} sponsored content"></div></span></div>
  </div></div>`;

const sponsoredBox = (ads = ad('Shop') + ad('Store'), heading = `Sponsored${ZWSP}`) => `
  <div class="sponsored" data-visualcompletion="ignore-late-mutation"><div>
    <div class="heading"><span dir="auto"><div><div><h3><span><span>${heading}</span></span></h3></div></div></span></div>
    <div class="ads">${ads}</div>
  </div></div>`;

const friendRequests = `
  <div class="friends"><div>
    <div><h3><span><span>Friend requests</span></span></h3><a role="link" href="/friends/">See all</a></div>
    <div><a role="link" aria-label="A Friend" href="/friends/requests/?profile_id=1">A Friend</a>
      <div role="button" aria-label="Confirm">Confirm</div><div role="button" aria-label="Delete">Delete</div></div>
  </div></div>`;

function page(column, main = '<div role="main">Feed</div>') {
  const win = testWindow('https://www.facebook.com/');
  windows.push(win);
  win.document.body.innerHTML = `${main}<div role="complementary" id="right_rail_container"><div><div class="boxes">${column}</div></div></div>`;
  return win;
}

test('the Sponsored box is the whole block under its heading, and Friend requests stays', () => {
  const doc = page(sponsoredBox() + friendRequests).document;
  const boxes = columnAdBoxes(doc);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0], doc.querySelector('.sponsored'));
});

test('alone in the column, the box still stops short of the column itself', () => {
  const doc = page(sponsoredBox()).document;
  const [box] = columnAdBoxes(doc);
  assert.ok(box, 'found');
  assert.ok(box.contains(doc.querySelector('.ads')), 'the ads go with the heading');
  assert.notEqual(box, doc.querySelector('[role="complementary"]'));
});

test('an ad pointing at a Facebook Page still goes with its box, and the column past it stays', () => {
  const doc = page(sponsoredBox(ad('A Page', 'https://www.facebook.com/somepage')) + friendRequests).document;
  assert.deepEqual(columnAdBoxes(doc), [doc.querySelector('.sponsored')]);
});

test('a block with a link into Facebook and no ad button is never part of the box', () => {
  // No other heading in the column, so only the link keeps the box from taking the contacts.
  const contacts = '<div class="contacts"><a role="link" href="/messages/t/1">A Friend</a></div>';
  const doc = page(sponsoredBox() + contacts).document;
  const [box] = columnAdBoxes(doc);
  assert.equal(box, doc.querySelector('.sponsored'));
  assert.equal(box.contains(doc.querySelector('.contacts')), false);
});

test('only an exact ad label counts as the heading, and only in a side column', () => {
  assert.deepEqual(columnAdBoxes(page(sponsoredBox(ad('Shop'), 'Sponsored by my mom') + friendRequests).document), []);
  assert.deepEqual(columnAdBoxes(page(friendRequests).document), []);
  const main = `<div role="main">${sponsoredBox()}</div>`;
  assert.deepEqual(columnAdBoxes(page(friendRequests, main).document), [], 'a feed heading is the post check\'s business');
});

test('the watcher marks the box when Facebook draws it later, tells once, and the CSS hides only marked boxes', async () => {
  const win = page(friendRequests);
  const doc = win.document;
  const told = [];
  let on = true;
  const watcher = watchColumnAds({ doc, enabled: () => on, onAd: (box) => told.push(box) });
  assert.equal(doc.querySelector(`[${COLUMN_AD_MARK}]`), null);

  // The way a streamed segment lands: drawn hidden at the end of the page, then moved in.
  doc.body.insertAdjacentHTML('beforeend', `<div hidden id="S:4">${sponsoredBox()}</div>`);
  await tick();
  assert.deepEqual(told, [], 'not in a column yet');
  const segment = doc.getElementById('S:4');
  doc.querySelector('.boxes').prepend(...segment.childNodes);
  segment.remove();
  await Promise.resolve();
  const box = doc.querySelector('.sponsored');
  assert.ok(box.hasAttribute(COLUMN_AD_MARK), 'marked as soon as the observer hears of it, with no timer');
  assert.equal(doc.querySelector('.friends').hasAttribute(COLUMN_AD_MARK), false);
  watcher.check();
  assert.deepEqual(told, [box], 'told once');

  on = false;
  box.removeAttribute(COLUMN_AD_MARK);
  watcher.check();
  assert.equal(box.hasAttribute(COLUMN_AD_MARK), false, 'nothing is marked while the switch is off');
  watcher.stop();

  const settings = (switchedOn) => ({ get: () => undefined, enabled: () => switchedOn });
  assert.match(renderFeatureCss([hideSponsoredPosts], settings(true)), new RegExp(`\\[${COLUMN_AD_MARK}\\] \\{ display: none !important; \\}`));
  assert.doesNotMatch(renderFeatureCss([hideSponsoredPosts], settings(false)), new RegExp(COLUMN_AD_MARK), 'switched off, no rule');
});

test('the watcher starts before the page has a body, so a box streamed in early is caught at once', async () => {
  const win = testWindow('https://www.facebook.com/');
  windows.push(win);
  const doc = win.document;
  doc.body.remove();
  const told = [];
  watchColumnAds({ doc, enabled: () => true, onAd: (box) => told.push(box) });
  const body = doc.createElement('body');
  body.innerHTML = `<div role="complementary"><div><div class="boxes">${sponsoredBox()}${friendRequests}</div></div></div>`;
  doc.documentElement.append(body);
  await Promise.resolve();
  assert.ok(doc.querySelector('.sponsored').hasAttribute(COLUMN_AD_MARK));
  assert.equal(told.length, 1);
});

test('a marked block that React fills with something else loses the mark', async () => {
  const win = page(sponsoredBox() + friendRequests);
  const doc = win.document;
  watchColumnAds({ doc, enabled: () => true });
  const box = doc.querySelector('.sponsored');
  assert.ok(box.hasAttribute(COLUMN_AD_MARK));
  box.innerHTML = '<div><h3>Birthdays</h3><a href="/events/birthdays/">A Friend</a></div>';
  await Promise.resolve();
  assert.equal(box.hasAttribute(COLUMN_AD_MARK), false);
});

test('Hide sponsored posts hides the column box in content mode and counts it on the page', async () => {
  const win = page(sponsoredBox() + friendRequests);
  const doc = win.document;
  const warnings = [];
  const diagnostics = createDiagnostics();
  hideSponsoredPosts.setup({
    doc, net: null, posts: null, hider: null, diagnostics,
    log: { info() {}, warn: (message) => warnings.push(message), error() {} },
    settings: { subscribe() {} },
    enabled: () => true,
  });
  assert.ok(doc.querySelector('.sponsored').hasAttribute(COLUMN_AD_MARK));
  const rows = Object.fromEntries(diagnostics.rows().map(({ label, value }) => [label, value]));
  assert.equal(rows['Ads hidden on the page'], 'right column 1');
  assert.deepEqual(warnings, [], 'no "got past the data rules" warning in content mode');
  await tick();
});

test('in page mode the column box is hidden and counted with no warning, since a fresh Home sends it drawn', () => {
  const win = page(sponsoredBox() + friendRequests);
  const doc = win.document;
  const warnings = [];
  const diagnostics = createDiagnostics();
  hideSponsoredPosts.setup({
    doc, net: { transformResponses() {} }, posts: null, hider: null, diagnostics,
    log: { info() {}, warn: (message) => warnings.push(message), error() {} },
    settings: { subscribe() {} },
    enabled: () => true,
  });
  assert.ok(doc.querySelector('.sponsored').hasAttribute(COLUMN_AD_MARK));
  const rows = Object.fromEntries(diagnostics.rows().map(({ label, value }) => [label, value]));
  assert.equal(rows['Ads hidden on the page'], 'right column 1');
  assert.deepEqual(warnings, []);
});

// Friend requests, for Hide Friend requests on Home. Birthdays and contacts as Wider feed's
// tests draw them, People you may know as the Friends page draws its See all link.
const birthdays = '<div class="birthdays"><div><h3>Birthdays</h3><a href="/events/birthdays/">A Friend has a birthday today</a></div></div>';
const contacts = '<div class="contacts"><h2>Contacts</h2><a role="link" href="/messages/t/1">A Friend</a></div>';
const suggestions = '<div class="pymk"><h3>People you may know</h3><a href="/friends/suggestions/">See all</a><a href="/friends/suggestions/?profile_id=2">B Friend</a></div>';

test('Friend requests is the whole block under its heading, found by its links, and the boxes around it stay', () => {
  const doc = page(sponsoredBox() + friendRequests + birthdays + contacts).document;
  const boxes = friendRequestsBoxes(doc);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0] === doc.querySelector('.friends'), true);
  assert.equal(columnAdBoxes(doc)[0] === doc.querySelector('.sponsored'), true, 'the Sponsored box is still its own');

  // Another language: the words don't matter.
  const other = page(friendRequests.replace('Friend requests', 'Solicitudes de amistad')).document;
  const [alone] = friendRequestsBoxes(other);
  assert.equal(Boolean(alone?.querySelector('a[href^="/friends/requests/"]')), true, 'found, with its request');
  assert.equal(alone === other.querySelector('[role="complementary"]'), false, 'never the column itself');

  // A block with no heading of its own: only its link elsewhere keeps it out of the box.
  const bare = page(`${friendRequests}<div class="elsewhere"><a role="link" href="/messages/t/1">A Friend</a></div>`).document;
  const [box] = friendRequestsBoxes(bare);
  assert.equal(box === bare.querySelector('.friends'), true, 'the climb stops short of a block linking elsewhere');
});

test("a box linking past the Friends pages, or never to Friend requests, isn't Friend requests", () => {
  assert.equal(friendRequestsBoxes(page(sponsoredBox() + birthdays + contacts + suggestions).document).length, 0);
  // A request row that links to the person's profile stops the climb at the heading's own block,
  // which has no request in it.
  const profile = friendRequests.replace('/friends/requests/?profile_id=1', '/profile.php?id=1');
  assert.equal(friendRequestsBoxes(page(profile).document).length, 0);
  const main = `<div role="main">${friendRequests}</div>`;
  assert.equal(friendRequestsBoxes(page(contacts, main).document).length, 0, 'the Friends page draws its requests in role=main');
});

test('Hide Friend requests on Home marks the box in content mode, counts it, and hides it only on Home while on', async () => {
  const win = page(sponsoredBox() + friendRequests + contacts);
  const doc = win.document;
  const diagnostics = createDiagnostics();
  let on = true;
  const listeners = [];
  hideFriendRequestsColumn.setup({ doc, net: null, diagnostics, settings: { subscribe: (fn) => listeners.push(fn) }, enabled: () => on });
  const box = doc.querySelector('.friends');
  assert.equal(box.hasAttribute(FRIEND_REQUESTS_MARK), true);
  assert.equal(doc.querySelectorAll(`[${FRIEND_REQUESTS_MARK}]`).length, 1, 'only that box');
  const rows = () => Object.fromEntries(diagnostics.rows().map(({ label, value }) => [label, value]));
  assert.equal(rows()['Friend requests boxes hidden on the page'], '1');
  assert.equal(rows()['Friend requests taken out of the data'], "Off: the script can't reach the page's data");

  // Drawn again later: marked again, and counted once more.
  box.remove();
  doc.querySelector('.boxes').insertAdjacentHTML('beforeend', friendRequests);
  await Promise.resolve();
  assert.equal(doc.querySelector('.friends').hasAttribute(FRIEND_REQUESTS_MARK), true);
  assert.equal(rows()['Friend requests boxes hidden on the page'], '2');

  const settings = (switchedOn) => ({ get: () => undefined, enabled: () => switchedOn });
  const css = renderFeatureCss([hideFriendRequestsColumn], settings(true));
  assert.equal(css.includes(`html[data-hfw-route="home"] [${FRIEND_REQUESTS_MARK}] { display: none !important; }`), true);
  assert.doesNotMatch(renderFeatureCss([hideFriendRequestsColumn], settings(false)), new RegExp(FRIEND_REQUESTS_MARK), 'switched off, no rule');
  assert.equal(listeners.length, 1, 'a switch change checks the column again');
  on = false;
  doc.querySelector('.friends').removeAttribute(FRIEND_REQUESTS_MARK);
  listeners[0]();
  assert.equal(doc.querySelector(`[${FRIEND_REQUESTS_MARK}]`), null, 'nothing is marked while the switch is off');
  on = true;
  listeners[0]();
  assert.equal(doc.querySelector('.friends').hasAttribute(FRIEND_REQUESTS_MARK), true, 'and the box is marked again when it comes back on');
  await tick();
});

test('in page mode Hide Friend requests on Home also takes the box out of the data', () => {
  const doc = page(friendRequests).document;
  const rules = [];
  hideFriendRequestsColumn.setup({ doc, net: { transformResponses: (rule) => rules.push(rule) }, diagnostics: createDiagnostics(), settings: { subscribe() {} }, enabled: () => true });
  assert.deepEqual(rules.map((rule) => rule.id), ['hideFriendRequestsColumn']);
  // Alone in the column, the box is the largest block around it short of the column.
  const box = doc.querySelector(`[${FRIEND_REQUESTS_MARK}]`);
  assert.equal(Boolean(box?.contains(doc.querySelector('.friends'))), true, 'and the drawn box is hidden too');
  assert.equal(box.matches('[role="complementary"]'), false);
});
