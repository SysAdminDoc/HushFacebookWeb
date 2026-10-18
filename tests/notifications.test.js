// Hide kinds of notifications against the Notifications page as drawn live on 2026-10-11
// (captures/2026-10-11-run8 notif-anatomy and run12 notif-hide, names and ids made up): New,
// Today and Earlier titles, and list item rows whose link carries the kind as notif_t, with a
// Notification Actions button beside it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import hideNotificationKinds, { GROUPS, KIND_MARK, createKindMarker, groupOf, hideKindsCss, notifType, parseKinds, rowOf } from '../src/features/notifications/hide-kinds.js';

const FB = 'https://www.facebook.com';
const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const row = (id, kind, path = '/groups/example/') => `
  <div class="row" role="listitem" data-kind="${kind}"><div><div>
    <a role="link" tabindex="0" href="${FB}${path}?notif_id=${id}&amp;notif_t=${kind}&amp;ref=notif"><span>Someone did something</span></a>
  </div><div><div role="button" aria-label="Notification Actions"></div></div></div></div>`;

const PAGE = `
<div role="main"><div role="list">
  <h1>Notifications</h1>
  <div class="bucket"><h2>New</h2>${row(11, 'friend', '/friends/requests/')}</div>
  <div class="bucket"><h2>Today</h2>${row(12, 'feedback_reaction_generic')}${row(13, 'birthday_reminder')}</div>
  <div class="bucket"><h2>Earlier</h2>${row(14, 'pymk_email')}${row(15, 'group_r2j_approved')}${row(16, 'onthisday_memories')}${row(17, 'public_figures_to_follow')}</div>
</div></div>`;

function page(html = PAGE) {
  const win = testWindow(`${FB}/notifications/`);
  windows.push(win);
  win.document.body.innerHTML = html;
  return win;
}

// The settings a person picked, read the way style.js reads them.
const picked = (values = {}) => (key) => {
  const option = key.split('.')[1];
  if (option in values) return values[option];
  return hideNotificationKinds.options.find((spec) => spec.key === option)?.default;
};

// The rows a CSS rule hides, by the kind each row was drawn with.
const hiddenBy = (doc, css) => (css ? [...doc.querySelectorAll(css.slice(0, css.indexOf(' {')))].map((el) => el.dataset.kind).sort() : []);

test('the kind comes from the link, the same name as in the notifications data', () => {
  assert.equal(notifType(`${FB}/groups/x/?notif_id=1&notif_t=group_r2j_approved&ref=notif`), 'group_r2j_approved');
  assert.equal(notifType('/friends/requests/?profile_id=5&notif_id=1&notif_t=friend'), 'friend');
  assert.equal(notifType(`${FB}/groups/x/`), null);
  assert.equal(notifType(`${FB}/?notif_t=%3Cscript%3E`), null);
});

test("the notifications data's kinds match the kinds in each notification's link, and each has a group", () => {
  const lines = readFileSync(new URL('./fixtures/CometNotificationsRootQuery.jsonl', import.meta.url), 'utf8').trim().split('\n');
  const notifs = lines.flatMap((line) => JSON.parse(line).data.viewer.notifications_page.edges)
    .map((edge) => edge.node.notif).filter(Boolean);
  assert.equal(notifs.length, 6);
  for (const notif of notifs) assert.equal(notifType(notif.url), notif.notif_type, notif.url);
  assert.deepEqual(notifs.map((notif) => groupOf(notif.notif_type)).sort(), ['activity', 'follow', 'groups', 'reactions', 'suggestions', 'suggestions']);
});

test('every kind seen live has its group, and birthdays and memories go by their names', () => {
  const live = {
    friend: 'other',
    feedback_reaction_generic: 'reactions',
    group_r2j_approved: 'groups',
    pymk_email: 'suggestions',
    close_friend_activity: 'activity',
    public_figures_to_follow: 'follow',
  };
  for (const [type, group] of Object.entries(live)) assert.equal(groupOf(type), group, type);
  assert.equal(groupOf('birthday_reminder'), 'birthdays');
  assert.equal(groupOf('onthisday'), 'memories');
  assert.equal(groupOf('memories_digest'), 'memories');
  assert.equal(groupOf('friend', parseKinds('friend, event_invite')), 'custom', 'a kind listed by hand');
});

test("a row is the notification's own box, never its titled section or the list", () => {
  const win = page();
  const doc = win.document;
  for (const link of doc.querySelectorAll('a[href*="notif_t="]')) {
    const box = rowOf(link);
    assert.ok(box.classList.contains('row'), `${link.getAttribute('href')} -> ${box.className}`);
  }
  // A section holding just one notification still stops at the row, below the New title.
  assert.equal(rowOf(doc.querySelector('[data-kind="friend"] a')).querySelector('h2'), null);
});

test('a notification link pasted into a post or a comment is left alone', () => {
  const pasted = (kind) => `<a href="${FB}/?notif_id=9&amp;notif_t=${kind}">a link someone pasted</a>`;
  const win = page(`
    <div role="feed">
      <div aria-posinset="1" data-kind="post"><div role="listitem" data-kind="post-item">${pasted('pymk_email')}</div>
        <div role="list"><div role="listitem" data-kind="comment-item"><div role="article" data-kind="comment">${pasted('birthday_reminder')}</div></div></div>
      </div>
    </div>
    <div role="main"><div role="list"><div role="listitem" data-kind="reply"><div role="article">${pasted('onthisday')}</div></div></div></div>
    <div role="list">${row(31, 'pymk_email')}</div>`);
  const doc = win.document;
  for (const link of doc.querySelectorAll('[role="feed"] a, [data-kind="reply"] a')) assert.equal(rowOf(link), null, link.closest('[data-kind]').dataset.kind);
  createKindMarker({ doc, enabled: () => true, custom: () => new Set(), setTimer: (fn) => fn() }).sync();
  assert.deepEqual(hiddenBy(doc, hideKindsCss(picked())), ['pymk_email'], 'only the real notification row');
});

test('the groups on by default hide birthdays, memories, suggestions and Pages to follow', () => {
  const win = page();
  const doc = win.document;
  createKindMarker({ doc, enabled: () => true, custom: () => new Set(), setTimer: (fn) => fn() }).sync();
  assert.deepEqual(hiddenBy(doc, hideKindsCss(picked())), ['birthday_reminder', 'onthisday_memories', 'public_figures_to_follow', 'pymk_email']);
  // Facebook's titles and the other rows stay.
  assert.equal(doc.querySelectorAll('h2').length, 3);
  assert.deepEqual(hiddenBy(doc, hideKindsCss(picked({ birthdays: false, memories: false, suggestions: false, follow: false }))), []);
  assert.deepEqual(hiddenBy(doc, hideKindsCss(picked({ reactions: true }))), ['birthday_reminder', 'feedback_reaction_generic', 'onthisday_memories', 'public_figures_to_follow', 'pymk_email']);
});

test('kinds listed by hand are hidden once settings change, and Diagnostics names what it saw', () => {
  const win = page();
  const doc = win.document;
  let list = new Set();
  const marker = createKindMarker({ doc, enabled: () => true, custom: () => list, setTimer: (fn) => fn() });
  marker.sync();
  list = parseKinds('friend');
  marker.refresh();
  const none = { birthdays: false, memories: false, suggestions: false, follow: false, custom: 'friend' };
  assert.deepEqual(hiddenBy(doc, hideKindsCss(picked(none))), ['friend']);
  assert.deepEqual(marker.seen().sort(), ['birthday_reminder', 'feedback_reaction_generic', 'friend', 'group_r2j_approved', 'onthisday_memories', 'public_figures_to_follow', 'pymk_email']);
  assert.equal(hideKindsCss(picked({ ...none, custom: '' })), '');
});

test('a reused row follows its new kind, and switching off takes the marks away', async () => {
  const win = page();
  const doc = win.document;
  let on = true;
  const marker = createKindMarker({ doc, enabled: () => on, custom: () => new Set(), setTimer: (fn) => win.setTimeout(fn, 0) });
  marker.start();
  const link = doc.querySelector('[data-kind="friend"] a');
  assert.equal(rowOf(link).getAttribute(KIND_MARK), 'other');
  link.setAttribute('href', `${FB}/?notif_id=21&notif_t=birthday_reminder`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(rowOf(link).getAttribute(KIND_MARK), 'birthdays');
  on = false;
  marker.sync();
  assert.equal(doc.querySelectorAll(`[${KIND_MARK}]`).length, 0);
});

test('the feature starts off, offers a switch per group and reports to Diagnostics', () => {
  const win = page();
  const rows = [];
  hideNotificationKinds.setup({ doc: win.document, enabled: () => true, option: () => '', diagnostics: { add: (label, read) => rows.push([label, read]) } });
  assert.equal(rows[0][0], 'Notification kinds seen');
  assert.match(rows[0][1](), /friend/);
  assert.equal(hideNotificationKinds.default, false);
  assert.equal(hideNotificationKinds.section, 'notifications');
  assert.deepEqual(hideNotificationKinds.options.map((spec) => spec.key), [...GROUPS.map((group) => group.option), 'custom']);
  assert.equal(hideNotificationKinds.options.find((spec) => spec.key === 'birthdays').label, 'Hide birthdays');
});
