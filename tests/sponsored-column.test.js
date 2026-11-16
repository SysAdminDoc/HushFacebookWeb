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
import { transformDocumentLine } from '../src/core/net/payload.js';

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

test("a box linking past the Friends pages and people, or never to Friend requests, isn't Friend requests", () => {
  assert.equal(friendRequestsBoxes(page(sponsoredBox() + birthdays + contacts + suggestions).document).length, 0);
  // Its request links to the person, but nothing in it goes to Friend requests.
  const noRequestsLink = friendRequests.replace('/friends/requests/?profile_id=1', '/profile.php?id=1');
  assert.equal(friendRequestsBoxes(page(noRequestsLink).document).length, 0);
  const main = `<div role="main">${friendRequests}</div>`;
  assert.equal(friendRequestsBoxes(page(contacts, main).document).length, 0, 'the Friends page draws its requests in role=main');
  // A side column inside a dialog isn't the page's.
  const dialog = `<div role="main">Feed</div><div role="dialog"><div role="complementary">${friendRequests}</div></div>`;
  assert.equal(friendRequestsBoxes(page('', dialog).document).length, 0, 'in a dialog');
  // A link to one of Facebook's own pages, or out through l.php, isn't a person.
  for (const href of ['/marketplace/', '/watch', '/groups/feed/', '/home.php', 'https://l.facebook.com/l.php?u=x', '/profile.php', '/help']) {
    assert.equal(friendRequestsBoxes(page(profileRequests(request(href)) + birthdays).document)[0]?.querySelector('.request') ? 'took the row' : 'left it', 'left it', href);
  }
});

// A request as the box's data draws it (each request's user.url, captured 2026-10-21): the
// picture and the name go to the person, with Confirm and Delete beside them. The box links to
// Friend requests too (seen live by another extension, which finds the box by that link).
const request = (href = '/some.person', name = '<span>A Friend</span>') => `
    <div class="request"><a role="link" href="${href}" aria-label="A Friend"><svg></svg></a>
      <div><a role="link" href="${href}">${name}</a><span>3 mutual friends</span></div>
      <div role="button" aria-label="Confirm">Confirm</div><div role="button" aria-label="Delete">Delete</div></div>`;
const profileRequests = (rows = request(), seeAll = '/friends/requests/') => `
  <div class="friends"><div>
    <div><h3><span><span>Friend requests</span></span></h3><a role="link" href="${seeAll}">See all</a></div>
    ${rows}
  </div></div>`;
const hasRow = (box) => Boolean(box?.querySelector('.request'));

test("requests that link to the person are part of the box, Confirm and Delete included, and the boxes around it stay", () => {
  for (const href of ['/some.person', 'https://www.facebook.com/some.person?__tn__=R', '/profile.php?id=1', '/people/A-Friend/1/']) {
    const doc = page(sponsoredBox() + profileRequests(request(href)) + birthdays + contacts).document;
    const boxes = friendRequestsBoxes(doc);
    assert.equal(boxes.length, 1, href);
    assert.equal(boxes[0] === doc.querySelector('.friends'), true, `${href}: the whole box and nothing past it`);
    assert.equal(hasRow(boxes[0]), true, `${href}: the request goes with it`);
  }
  // Two requests and a See more button with nothing but its own words.
  const more = page(profileRequests(`${request()}${request('/another.person')}<div class="more"><div role="button">See more</div></div>`) + birthdays).document;
  const [box] = friendRequestsBoxes(more);
  assert.equal(box === more.querySelector('.friends'), true, 'the whole box');
  assert.equal(Boolean(box.querySelector('.more')), true, 'See more goes with it');
});

test("a person's name drawn as a heading doesn't split the box", () => {
  const named = [
    request('/some.person', '<span role="heading" aria-level="4">A Friend</span>'),
    `<div class="request"><h4><a href="/profile.php?id=1">A Friend</a></h4><div role="button" aria-label="Confirm">Confirm</div></div>`,
    // A name heading in a request that also links to Friend requests isn't a box of its own.
    `<div class="request"><a href="/friends/requests/?profile_id=1"><span role="heading">A Friend</span></a><a href="/some.person"><svg></svg></a></div>`,
  ];
  for (const row of named) {
    const doc = page(profileRequests(row) + birthdays + contacts).document;
    const boxes = friendRequestsBoxes(doc);
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0] === doc.querySelector('.friends'), true, 'the whole box');
    assert.equal(hasRow(boxes[0]), true);
  }
  // A heading of another box still stops it, even beside a person's link.
  const doc = page(`<div class="both">${profileRequests()}<div><h3>Birthdays</h3><span>Today</span></div></div>`).document;
  assert.equal(friendRequestsBoxes(doc)[0] === doc.querySelector('.friends'), true);
});

test('a block beside the box with words and buttons of its own and no link stays out of it', () => {
  const chats = '<div class="chats"><span>Group conversations</span><div role="button" aria-label="Create new group"><svg></svg></div></div>';
  const buttonRows = '<div class="people"><span>Contacts</span><div role="button">A Friend</div><div role="button">B Friend</div></div>';
  for (const beside of [chats, buttonRows]) {
    const doc = page(profileRequests() + beside).document;
    const [box] = friendRequestsBoxes(doc);
    assert.equal(box === doc.querySelector('.friends'), true, 'the climb stops short of it');
  }
  // A divider with nothing in it is no reason to stop, and nor are words with no button, like a count.
  const divided = page(`<div class="pair">${profileRequests()}<div class="divider"></div></div>`).document;
  assert.equal(friendRequestsBoxes(divided)[0]?.contains(divided.querySelector('.divider')), true);
  const counted = page(profileRequests().replace('</h3>', '</h3><span>2</span>') + birthdays).document;
  assert.equal(friendRequestsBoxes(counted)[0] === counted.querySelector('.friends'), true);
});

test('a mutual friends link or a Remove link drawn as a button stays in the box, and so do words beside a request', () => {
  const rows = [
    request().replace('<span>3 mutual friends</span>', '<a href="/browse/mutual_friends/?uid=1">3 mutual friends</a>'),
    request().replace('</div>\n', '</div><a href="#" role="button">Remove</a>\n'),
    // Its words and buttons go with a link to Friend requests, so it's no title of its own.
    '<div class="request"><a href="/friends/requests/?profile_id=1">A Friend</a><span>3 mutual friends</span><div role="button" aria-label="Confirm">Confirm</div><div role="button" aria-label="Delete">Delete</div></div>',
  ];
  // A request's own words can share a wrapper with its buttons, which looks just like a title
  // over a Search button, so a plain-text title beside one person can't be told from them.
  const avatar = '<a href="/some.person"><svg></svg></a>';
  const name = '<a href="/some.person"><span>A Friend</span></a>';
  const buttons = '<div role="button" aria-label="Confirm">Confirm</div><div role="button" aria-label="Delete">Delete</div>';
  for (const inner of [
    `${avatar}<div>${name}<div><span>3 mutual friends</span><div>${buttons}</div></div></div>`,
    `<div>${name}<div><span>3 mutual friends</span><div>${buttons}</div></div></div>`,
    `${avatar}<div><div>${name}<div><span>2w</span><div role="button" aria-label="More"></div></div></div><span>3 mutual friends</span><div>${buttons}</div></div>`,
    `${avatar}<div>${name}<div><span>3 mutual friends</span><a href="#" role="button">Remove</a></div>${buttons}</div>`,
    `${avatar}<div><span>A Friend</span><span>3 mutual friends</span>${buttons}</div>`,
  ]) rows.push(`<div class="request">${inner}</div>`);
  for (const row of rows) {
    const doc = page(profileRequests(row) + birthdays + contacts).document;
    const boxes = friendRequestsBoxes(doc);
    assert.equal(boxes.length, 1, row);
    assert.equal(boxes[0] === doc.querySelector('.friends'), true, `the whole box: ${row}`);
    assert.equal(hasRow(boxes[0]), true, row);
  }
});

test('a block beside the box linking to people or to Facebook pages with no buttons, or People you may know, stays out', () => {
  const beside = [
    '<div class="nb"><a href="/fundraisers/">Fundraisers</a></div>',
    '<div class="nb"><span>Birthdays</span><a href="/pat.example">Pat</a> has a birthday today</div>',
    '<div class="nb"><span>Contacts</span><a href="/pat.example">Pat</a><a href="/sam.example">Sam</a></div>',
    // One button for everyone in it, not one each the way a request has Confirm.
    '<div class="nb"><div><span>Contacts</span><div role="button" aria-label="Search"></div></div><a href="/pat.example">Pat</a><a href="/sam.example">Sam</a></div>',
    // Its heading links to the Friends pages, but to suggestions, not to Friend requests.
    `<div class="nb"><a href="/friends/suggestions/"><h3>People you may know</h3></a>
      <div><a href="/pat.example">Pat</a><div role="button">Add friend</div></div></div>`,
    // A heading over a single link is a box of its own, not a request's name.
    '<div class="nb"><h3>Your Pages and profiles</h3><a href="/MyShopPage">My Shop</a><div role="button">Switch into Page</div></div>',
  ];
  for (const block of beside) {
    for (const column of [profileRequests() + block, block + profileRequests()]) {
      const doc = page(column).document;
      const [box] = friendRequestsBoxes(doc);
      assert.equal(box === doc.querySelector('.friends'), true, column);
    }
  }
});

test('a side column inside another one gives one box, not two', () => {
  for (const box of [friendRequests, profileRequests()]) {
    const doc = page(`<div role="complementary" class="inner">${box}</div>${birthdays}`).document;
    assert.equal(friendRequestsBoxes(doc).length, 1);
  }
});

test('Hide Friend requests on Home marks the box in content mode, counts it, and hides it only on Home while on', async () => {
  const win = page(sponsoredBox() + friendRequests + contacts);
  const doc = win.document;
  doc.documentElement.dataset.hfwRoute = 'home';
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
  assert.equal(Boolean(doc.querySelector(`[${FRIEND_REQUESTS_MARK}]`)), false, 'nothing is marked while the switch is off');
  on = true;
  listeners[0]();
  assert.equal(doc.querySelector('.friends').hasAttribute(FRIEND_REQUESTS_MARK), true, 'and the box is marked again when it comes back on');
  await tick();
});

test('off Home nothing is marked or counted, and back on Home the column is checked at once', async () => {
  const win = page(sponsoredBox() + profileRequests() + contacts);
  const doc = win.document;
  doc.documentElement.dataset.hfwRoute = 'groups';
  const diagnostics = createDiagnostics();
  const routed = [];
  hideFriendRequestsColumn.setup({ doc, net: null, diagnostics, router: { subscribe: (fn) => routed.push(fn), current: () => null }, settings: { subscribe() {} }, enabled: () => true });
  const rows = () => Object.fromEntries(diagnostics.rows().map(({ label, value }) => [label, value]));
  assert.equal(Boolean(doc.querySelector(`[${FRIEND_REQUESTS_MARK}]`)), false, 'not marked on the groups feed');
  doc.querySelector('.boxes').append(doc.createElement('div'));
  await Promise.resolve();
  assert.equal(Boolean(doc.querySelector(`[${FRIEND_REQUESTS_MARK}]`)), false, 'nor when the column changes there');
  assert.equal(rows()['Friend requests boxes hidden on the page'], '0');

  // Facebook kept the column, so nothing in it changes on the way back.
  doc.documentElement.dataset.hfwRoute = 'home';
  assert.equal(routed.length, 1, 'the page change is heard');
  routed[0]();
  assert.equal(doc.querySelector('.friends').hasAttribute(FRIEND_REQUESTS_MARK), true);
  assert.equal(rows()['Friend requests boxes hidden on the page'], '1');

  // Off Home again, the mark stays (the CSS hides it only on Home), and coming back counts nothing new.
  doc.documentElement.dataset.hfwRoute = 'groups';
  routed[0]();
  assert.equal(doc.querySelector('.friends').hasAttribute(FRIEND_REQUESTS_MARK), true);
  doc.documentElement.dataset.hfwRoute = 'home';
  routed[0]();
  assert.equal(rows()['Friend requests boxes hidden on the page'], '1');
  await tick();
});

test('a box that narrows as the column fills in is the same box, counted once', async () => {
  const win = page(profileRequests());
  const doc = win.document;
  doc.documentElement.dataset.hfwRoute = 'home';
  const diagnostics = createDiagnostics();
  hideFriendRequestsColumn.setup({ doc, net: null, diagnostics, settings: { subscribe() {} }, enabled: () => true });
  const rows = () => Object.fromEntries(diagnostics.rows().map(({ label, value }) => [label, value]));
  const outer = doc.querySelector(`[${FRIEND_REQUESTS_MARK}]`);
  assert.equal(Boolean(outer?.contains(doc.querySelector('.friends'))), true, 'alone, the box is the largest block short of the column');
  assert.equal(rows()['Friend requests boxes hidden on the page'], '1');

  // Contacts load beside it.
  doc.querySelector('.boxes').insertAdjacentHTML('beforeend', contacts);
  await Promise.resolve();
  assert.equal(doc.querySelector('.friends').hasAttribute(FRIEND_REQUESTS_MARK), true, 'the mark moves in to the box');
  assert.equal(outer.hasAttribute(FRIEND_REQUESTS_MARK), false, 'and off the block that now holds contacts');
  assert.equal(rows()['Friend requests boxes hidden on the page'], '1', 'still one box');

  await tick();
});

test('a box that widens when the box beside it goes is the same box, counted once', async () => {
  const win = page(profileRequests() + contacts);
  const doc = win.document;
  doc.documentElement.dataset.hfwRoute = 'home';
  const diagnostics = createDiagnostics();
  hideFriendRequestsColumn.setup({ doc, net: null, diagnostics, settings: { subscribe() {} }, enabled: () => true });
  const rows = () => Object.fromEntries(diagnostics.rows().map(({ label, value }) => [label, value]));
  assert.equal(doc.querySelector('.friends').hasAttribute(FRIEND_REQUESTS_MARK), true);
  doc.querySelector('.contacts').remove();
  await Promise.resolve();
  const wider = doc.querySelector(`[${FRIEND_REQUESTS_MARK}]`);
  assert.equal(Boolean(wider?.contains(doc.querySelector('.friends'))) && !wider.matches('.friends'), true, 'the mark moves out to a block it never heard of');
  assert.equal(rows()['Friend requests boxes hidden on the page'], '1', 'still one box');
  await tick();
});

test('a new box drawn where an earlier one was found counts, after the column filled in or with the column empty between', async () => {
  // Alone at first, so the box found is a block around it, then narrowed when the column fills in.
  const win = page(sponsoredBox());
  const doc = win.document;
  const told = [];
  watchColumnAds({ doc, enabled: () => true, onAd: (box) => told.push(box) });
  doc.querySelector('.boxes').insertAdjacentHTML('beforeend', friendRequests);
  await Promise.resolve();
  assert.equal(told.length, 1, 'narrowing is the same box');
  doc.querySelector('.sponsored').outerHTML = sponsoredBox(ad('Other'));
  await Promise.resolve();
  assert.equal(told.length, 2, 'a new box in its place');
  // Gone, then a new one alone again: found as the same block around it, but it's a new box.
  doc.querySelector('.boxes').replaceChildren();
  await Promise.resolve();
  doc.querySelector('.boxes').insertAdjacentHTML('beforeend', sponsoredBox(ad('Third')));
  await Promise.resolve();
  assert.equal(told.length, 3);
  // The block it was found as stands for one box, so a second one drawn in it is new.
  doc.querySelector('.boxes').insertAdjacentHTML('beforeend', friendRequests + sponsoredBox(ad('Fourth')));
  await Promise.resolve();
  assert.equal(told.length, 4);
  await tick();
});

test('in page mode Hide Friend requests on Home also takes the box out of the data', () => {
  const doc = page(friendRequests).document;
  doc.documentElement.dataset.hfwRoute = 'home';
  const rules = [];
  let route = { type: 'home' };
  hideFriendRequestsColumn.setup({ doc, net: { transformResponses: (rule) => rules.push(rule) }, router: { current: () => route, subscribe() {} }, diagnostics: createDiagnostics(), settings: { subscribe() {} }, enabled: () => true });
  assert.deepEqual(rules.map((rule) => rule.id), ['hideFriendRequestsColumn']);
  // Inline data, on Home only: the rule asks the router which page this is.
  const line = JSON.stringify({ data: { viewer: { side_feed: { nodes: [{ __typename: 'FriendingRequestsSideFeedUnit' }] } } } });
  const inline = { transport: 'json-parse', friendlyName: '' };
  assert.equal(transformDocumentLine(line, rules, inline).includes('FriendingRequestsSideFeedUnit'), false, 'on Home');
  route = { type: 'groups' };
  assert.equal(transformDocumentLine(line, rules, inline), line, 'elsewhere');
  // Alone in the column, the box is the largest block around it short of the column.
  const box = doc.querySelector(`[${FRIEND_REQUESTS_MARK}]`);
  assert.equal(Boolean(box?.contains(doc.querySelector('.friends'))), true, 'and the drawn box is hidden too');
  assert.equal(box.matches('[role="complementary"]'), false);
});
