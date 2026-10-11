// Default comment order and Show every reply. Facebook's order menu is simulated the way it
// behaved live on 2026-10-11: a button titled with the current order opens a role=menu with
// three role=menuitem rows (title, then a description), and picking one refetches.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { fixtureLines, parseLine } from './helpers/fixtures.js';
import commentOrder, { createOrderDriver } from '../src/features/comments/comment-order.js';
import { createOrderTitles, ORDERS } from '../src/features/comments/orders.js';
import showAllReplies, { createReplyExpander, REPLY_BUTTON } from '../src/features/comments/show-all-replies.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

function page(html, href = 'https://www.facebook.com/') {
  const win = new Window({ url: href });
  windows.push(win);
  win.document.body.innerHTML = html;
  return win;
}

const ENGLISH = [['Most relevant', "Show friends' comments and the most engaging comments first."], ['Newest', 'Show all comments with the newest comments first.'], ['All comments', 'Show all comments, including potential spam.']];
const GERMAN = [['Relevanteste', 'Kommentare von Freunden zuerst.'], ['Neueste', 'Neueste zuerst.'], ['Alle Kommentare', 'Auch möglichen Spam.']];

// A comment order button that opens Facebook's menu, and a log of what was picked.
function orderMenu(doc, button, rows) {
  const picked = [];
  button.addEventListener('click', () => {
    const open = doc.querySelector('[role="menu"]');
    if (open) {
      open.remove();
      return;
    }
    const menu = doc.createElement('div');
    menu.setAttribute('role', 'menu');
    rows.forEach(([title, description], index) => {
      const item = doc.createElement('div');
      item.setAttribute('role', 'menuitem');
      item.innerHTML = `<span>${title}</span><span>${description}</span>`;
      item.addEventListener('click', () => {
        picked.push(index);
        menu.remove();
        button.textContent = title;
      });
      menu.append(item);
    });
    // Facebook opens the menu a moment later, in a layer of its own.
    setTimeout(() => doc.body.append(menu), 20);
  });
  return picked;
}

const intents = (rows) => ({
  selected_intent: { title: rows[0][0], intent_token: ORDERS[0].token },
  selectable_intents: rows.map(([title, description], i) => ({ title, description, intent_token: ORDERS[i].token })),
});

function driver(doc, { titles = createOrderTitles(), order = 'newest', page: pageKey = null, menuWait } = {}) {
  const done = [];
  const warnings = [];
  const drive = createOrderDriver({
    doc, titles, menuWait,
    wanted: () => ORDERS.find((o) => o.value === order) ?? null,
    pageKey: () => pageKey,
    log: { warn: (m) => warnings.push(m) },
    onDone: () => done.push(order),
  });
  return { drive, done, warnings };
}

test('the titles come from a captured post page, and English stands in until then', async () => {
  const titles = createOrderTitles();
  assert.equal(titles.title(ORDERS[1]), 'Newest');
  titles.learn({ data: { a: [intents(GERMAN)] } });
  assert.equal(titles.title(ORDERS[0]), 'Relevanteste');
  assert.equal(titles.title(ORDERS[2]), 'Alle Kommentare');
  // The order list from a post page captured live on 2026-10-11.
  const captured = createOrderTitles();
  for (const line of await fixtureLines('comment-order-intents.jsonl')) captured.learn(parseLine(line));
  assert.equal(captured.size(), 3);
  assert.deepEqual(ORDERS.map((o) => captured.title(o)), ['Most relevant', 'Newest', 'All comments']);
});

test('a post opened over the feed gets the order picked once, and a later change by hand sticks', async () => {
  const win = page('<div role="dialog"><div role="button">Most relevant</div></div>');
  const doc = win.document;
  const button = doc.querySelector('[role="button"]');
  const picked = orderMenu(doc, button, ENGLISH);
  const { drive, done } = driver(doc);
  assert.equal(await drive.scan(), true);
  assert.deepEqual(picked, [1], 'Newest');
  assert.equal(button.textContent, 'Newest');
  assert.deepEqual(done, ['newest']);
  // Picked back by hand: the same dialog isn't touched again.
  button.textContent = 'Most relevant';
  assert.equal(await drive.scan(), null);
  assert.deepEqual(picked, [1]);
});

test('the page language comes from the data, and the place in the menu when the titles are unknown', async () => {
  const win = page('<div role="dialog"><div role="button">Relevanteste</div></div><div role="dialog" class="b"><div role="button">Most relevant</div></div>');
  const doc = win.document;
  const [german, other] = doc.querySelectorAll('[role="button"]');
  const titles = createOrderTitles();
  titles.learn(intents(GERMAN));
  const pickedGerman = orderMenu(doc, german, GERMAN);
  assert.equal(await driver(doc, { titles, order: 'all' }).drive.scan(), true);
  assert.deepEqual(pickedGerman, [2], 'Alle Kommentare');
  // English button, menu rows the script can't read: the third row is All comments.
  const pickedOther = orderMenu(doc, other, [['?', ''], ['??', ''], ['???', '']]);
  assert.equal(await driver(doc, { order: 'all' }).drive.scan(), true);
  assert.deepEqual(pickedOther, [2]);
});

test("the feed's own comments are left alone, and a post's own page is done once", async () => {
  const win = page('<div role="feed"><div role="button">Most relevant</div></div>');
  const doc = win.document;
  const button = doc.querySelector('[role="button"]');
  const picked = orderMenu(doc, button, ENGLISH);
  assert.equal(await driver(doc).drive.scan(), null, 'not on the feed');
  const onPost = driver(doc, { page: 'https://www.facebook.com/Page/posts/pfbid0abc' });
  assert.equal(await onPost.drive.scan(), true);
  button.textContent = 'Most relevant';
  assert.equal(await onPost.drive.scan(), null);
  assert.deepEqual(picked, [1]);
  assert.equal(await driver(doc, { order: 'relevant', page: 'x' }).drive.scan(), null, "Facebook's own order needs nothing");
});

test("a post opened from its link over Home is done in its dialog, and the feed's copy behind it is left alone", async () => {
  const win = page('<div role="feed"><div role="button">Most relevant</div></div><div role="dialog"><div role="button">Most relevant</div></div>');
  const doc = win.document;
  const [behind, shown] = doc.querySelectorAll('[role="button"]');
  let behindClicks = 0;
  behind.addEventListener('click', () => behindClicks++);
  const picked = orderMenu(doc, shown, ENGLISH);
  const onPost = driver(doc, { page: 'https://www.facebook.com/Page/posts/pfbid0abc', menuWait: 150 });
  assert.equal(await onPost.drive.scan(), true);
  assert.deepEqual(picked, [1]);
  // The dialog now reads Newest, and the copy behind it still isn't touched.
  assert.equal(await onPost.drive.scan(), null);
  assert.equal(behindClicks, 0);
  assert.deepEqual(onPost.warnings, []);
});

test("a menu that doesn't open is noted, and one without the order is closed again", async () => {
  const quietPage = page('<div role="dialog"><div role="button">Most relevant</div></div>');
  const quietButton = quietPage.document.querySelector('[role="button"]');
  let clicks = 0;
  quietButton.addEventListener('click', () => clicks++);
  const quiet = driver(quietPage.document, { menuWait: 150 });
  assert.equal(await quiet.drive.scan(), false);
  assert.equal(clicks, 1, "nothing to close when the menu didn't open");
  assert.equal(quiet.done.length, 0);
  assert.match(quiet.warnings[0], /Newest/);

  const shortPage = page('<div role="dialog"><div role="button">Most relevant</div></div>');
  const doc = shortPage.document;
  const button = doc.querySelector('[role="button"]');
  let opened = 0;
  button.addEventListener('click', () => opened++);
  const picked = orderMenu(doc, button, [['Most relevant', ''], ['Newest', '']]);
  const short = driver(doc, { order: 'all', menuWait: 150 });
  assert.equal(await short.drive.scan(), false);
  assert.deepEqual(picked, []);
  assert.equal(opened, 2, 'opened, then clicked again to close');
  assert.equal(doc.querySelector('[role="menu"]'), null, 'the menu was closed again');
  assert.match(short.warnings[0], /All comments/);
});

test("another menu already open is never mistaken for the order menu", async () => {
  const win = page(`<div role="menu"><div role="menuitem">Edit</div><div role="menuitem">Hide</div><div role="menuitem">Report</div></div>
    <div role="dialog"><div role="button">Most relevant</div></div>`);
  const doc = win.document;
  const rows = [...doc.querySelectorAll('[role="menuitem"]')];
  let wrong = 0;
  for (const row of rows) row.addEventListener('click', () => wrong++);
  const quiet = driver(doc, { order: 'all', menuWait: 150 });
  assert.equal(await quiet.drive.scan(), false);
  assert.equal(wrong, 0);
  assert.equal(quiet.warnings.length, 1);
});

test("while a post's dialog is still drawing, the copy behind it is left alone", async () => {
  // Only the dialog's Close button is there yet; the order button behind belongs to the feed.
  const win = page('<div role="feed"><div role="button">Most relevant</div></div><div role="dialog"><div role="button" aria-label="Close"></div></div>');
  const doc = win.document;
  const behind = doc.querySelector('[role="feed"] [role="button"]');
  let clicks = 0;
  behind.addEventListener('click', () => clicks++);
  assert.equal(await driver(doc, { page: 'https://www.facebook.com/Page/posts/pfbid0abc' }).drive.scan(), null);
  assert.equal(clicks, 0);
});

test('a dialog Facebook reuses for the next post gets that post put in order too', async () => {
  const win = page('<div role="dialog"><div role="button">Most relevant</div></div>', 'https://www.facebook.com/photo/?fbid=1');
  const doc = win.document;
  const button = doc.querySelector('[role="button"]');
  const picked = orderMenu(doc, button, ENGLISH);
  const { drive } = driver(doc);
  assert.equal(await drive.scan(), true);
  button.textContent = 'Most relevant';
  assert.equal(await drive.scan(), null, 'same post, left as it is');
  win.history.pushState({}, '', '/photo/?fbid=2');
  assert.equal(await drive.scan(), true, 'next photo in the same dialog');
  assert.deepEqual(picked, [1, 1]);
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('every folded reply is opened, new ones too, and the rounds rest after five with nothing', async () => {
  const win = page(`<div role="dialog">
    <div role="button">View all 3 replies</div><div role="button">View 1 reply</div><div role="button">Reply</div>
    <div role="button">Like</div><div role="button">12 Replies</div><div role="button">View more replies</div></div>
    <div role="feed"><div role="button">View 2 replies</div></div>`);
  const doc = win.document;
  const clicked = [];
  // Facebook swaps a reply button for the replies once they load.
  for (const button of doc.querySelectorAll('[role="button"]')) {
    button.addEventListener('click', () => {
      clicked.push(button.textContent);
      if (button.textContent === 'View all 3 replies') {
        const more = doc.createElement('div');
        more.setAttribute('role', 'button');
        more.textContent = 'View 2 more replies';
        more.addEventListener('click', () => {
          clicked.push(more.textContent);
          more.remove();
        });
        button.after(more);
      }
      if (REPLY_BUTTON.test(button.textContent)) button.remove();
    });
  }
  const expander = createReplyExpander({ doc, win: globalThis, inPage: () => false, enabled: () => true, delay: 5 });
  expander.wake();
  await wait(120);
  assert.deepEqual(clicked.sort(), ['12 Replies', 'View 1 reply', 'View 2 more replies', 'View all 3 replies', 'View more replies']);
  assert.equal(expander.state().running, false, 'resting');
  assert.equal(expander.state().idle, 5);
  assert.equal(expander.state().total, 5);
  expander.wake();
  assert.equal(expander.state().running, true, 'woken by a change on the page');
  expander.stop();
  assert.ok(!REPLY_BUTTON.test('Reply') && !REPLY_BUTTON.test('Replying to Pat'), 'the Reply link is no reply thread');
});

test("replies on a post's own page are opened too, never on the feed, and it stops at its limit", async () => {
  const win = page('<div role="main"><div role="button">View 4 replies</div><div role="button">View 5 replies</div></div>');
  const doc = win.document;
  let clicks = 0;
  for (const button of doc.querySelectorAll('[role="button"]')) button.addEventListener('click', () => clicks++);
  const feed = createReplyExpander({ doc, win: globalThis, inPage: () => false, enabled: () => true, delay: 5 });
  feed.wake();
  await wait(60);
  assert.equal(clicks, 0);
  const post = createReplyExpander({ doc, win: globalThis, inPage: () => true, enabled: () => true, delay: 5, maxClicks: 1 });
  post.wake();
  await wait(60);
  assert.equal(clicks, 1);
});

test("with a post open over Home, the feed's copy behind it keeps its replies folded", async () => {
  const win = page(`<div role="feed"><div role="button">View 3 replies</div></div>
    <div role="dialog"><div role="article" aria-label="Comment by Pat Example"><div role="button">View 2 replies</div></div></div>`);
  const doc = win.document;
  const clicked = [];
  for (const button of doc.querySelectorAll('[role="button"]')) button.addEventListener('click', () => clicked.push(button.textContent));
  const expander = createReplyExpander({ doc, win: globalThis, inPage: () => true, enabled: () => true, delay: 5 });
  expander.wake();
  await wait(60);
  assert.deepEqual(clicked, ['View 2 replies']);
  expander.stop();
});

test('a button Facebook reuses for the next page of replies is clicked again, a few times at most', async () => {
  const win = page('<div role="dialog"><div role="button">View 9 replies</div></div>');
  const doc = win.document;
  const button = doc.querySelector('[role="button"]');
  let clicks = 0;
  // Each click loads some replies and the same button offers the rest, the way a long thread pages.
  button.addEventListener('click', () => {
    clicks++;
    button.textContent = `View ${20 - clicks} more replies`;
  });
  const expander = createReplyExpander({ doc, win: globalThis, inPage: () => false, enabled: () => true, delay: 5 });
  expander.wake();
  await wait(150);
  assert.equal(clicks, 5, 'five pages, then the button is left alone');
  expander.stop();
  // "View more replies" can keep its words while the next page loads: it's tried again a few
  // rounds later, never in the very next round, and five times at most.
  const still = page('<div role="dialog"><div role="button">View more replies</div></div>');
  const times = [];
  still.document.querySelector('[role="button"]').addEventListener('click', () => times.push(again.state().rounds));
  const again = createReplyExpander({ doc: still.document, win: globalThis, inPage: () => false, enabled: () => true, delay: 5 });
  again.wake();
  await wait(300);
  assert.equal(times.length, 5);
  assert.ok(times.every((round, i) => i === 0 || round - times[i - 1] >= 3), String(times));
  again.stop();
  // A counted button that keeps its words may be a toggle, so it's never clicked twice.
  const toggle = page('<div role="dialog"><div role="button">12 Replies</div></div>');
  let toggles = 0;
  toggle.document.querySelector('[role="button"]').addEventListener('click', () => toggles++);
  const once = createReplyExpander({ doc: toggle.document, win: globalThis, inPage: () => false, enabled: () => true, delay: 5 });
  once.wake();
  await wait(120);
  assert.equal(toggles, 1);
  once.stop();
});

test('each post gets its own click budget, so later posts still open after a long visit', async () => {
  const win = page('<div role="dialog" id="a"><div role="button">View 1 reply</div><div role="button">View 2 replies</div><div role="button">View 3 replies</div></div>');
  const doc = win.document;
  let clicks = 0;
  const count = (root) => root.querySelectorAll('[role="button"]').forEach((b) => b.addEventListener('click', () => clicks++));
  count(doc);
  const expander = createReplyExpander({ doc, win: globalThis, inPage: () => false, enabled: () => true, delay: 5, maxClicks: 2 });
  expander.wake();
  await wait(80);
  assert.equal(clicks, 2, 'this post hit its budget');
  doc.getElementById('a').remove();
  doc.body.insertAdjacentHTML('beforeend', '<div role="dialog"><div role="button">View 4 replies</div><div role="button">View 5 replies</div></div>');
  count(doc.querySelector('[role="dialog"]'));
  expander.wake();
  await wait(80);
  assert.equal(clicks, 4, 'the next post has a budget of its own');
  expander.stop();
});

test("while a post's dialog is still drawing, the replies behind it stay folded", async () => {
  const win = page('<div role="feed"><div role="button">View 3 replies</div></div><div role="dialog"><div role="button" aria-label="Close"></div></div>');
  const doc = win.document;
  let clicks = 0;
  doc.querySelector('[role="feed"] [role="button"]').addEventListener('click', () => clicks++);
  const expander = createReplyExpander({ doc, win: globalThis, inPage: () => true, enabled: () => true, delay: 5 });
  expander.wake();
  await wait(60);
  assert.equal(clicks, 0);
  expander.stop();
});

test('both switches start off and sit under Comments', () => {
  for (const feature of [commentOrder, showAllReplies]) {
    assert.equal(feature.section, 'comments');
    assert.equal(feature.default, false);
    assert.ok(!feature.needsPage, 'they work in content mode too');
  }
  assert.deepEqual(commentOrder.options[0].choices.map((c) => c.value), ['newest', 'all']);
});
