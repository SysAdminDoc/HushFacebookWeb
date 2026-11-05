// Keep your Notifications filter against the All and Unread toolbar as drawn live on 2026-11-04:
// two role=button with aria-pressed, All first, in a role=toolbar inside the list of
// notifications. Under the bell the list sits in a banner dialog that's hidden until opened.
// Facebook's side is played by a click handler that moves aria-pressed and counts the asks.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { createMemoryStorage } from '../src/core/storage.js';
import keepNotificationsFilter, { PICK_KEY, createFilterKeeper, pickLabel } from '../src/features/notifications/keep-filter.js';

const FB = 'https://www.facebook.com';
const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const BAR = (pressed) => `<div role="toolbar" aria-label="Notifications filters">${['All', 'Unread'].map((label, i) => `<div role="button" tabindex="0" aria-pressed="${i === pressed}"><span>${label}</span></div>`).join('')}</div>`;
const ROW = (id) => `<div role="listitem"><a href="${FB}/groups/example/?notif_id=${id}&amp;notif_t=group_activity">Someone posted</a></div>`;
const LIST = (pressed = 0, rows = ROW(1) + ROW(2)) => `<div role="list" aria-label="Notifications"><h1>Notifications</h1>${BAR(pressed)}${rows}</div>`;
const BELL = (pressed = 0) => `<div role="banner"><div role="button" class="bell" aria-label="Notifications"></div><div role="dialog" aria-label="Notifications" style="display: none">${LIST(pressed)}</div></div>`;

function page(html, path = '/notifications/') {
  const win = testWindow(`${FB}${path}`);
  windows.push(win);
  win.document.body.innerHTML = html;
  return win;
}

// Facebook's side: a click on All or Unread presses it, lets go of the other and asks for that
// list, unless stuck is set.
function wire(doc, { stuck = false } = {}) {
  const asked = [];
  doc.addEventListener('click', (event) => {
    const button = event.target.closest('[role="toolbar"] [role="button"]');
    if (!button) return;
    const buttons = [...button.parentElement.children];
    asked.push(buttons.indexOf(button));
    if (stuck) return;
    for (const other of buttons) other.setAttribute('aria-pressed', String(other === button));
  });
  return asked;
}

function keeper(win, { storage = createMemoryStorage(), on = () => true, onPage = () => true, now } = {}) {
  const timers = [];
  const kept = createFilterKeeper({ doc: win.document, storage, enabled: on, onPage, trusted: () => true, setTimer: (fn) => timers.push(fn), now });
  return { kept, storage, flush: () => { for (const fn of timers.splice(0)) fn(); }, pending: () => timers.length };
}

const pressedIn = (root) => [...root.querySelectorAll('[role="toolbar"] [role="button"]')].map((button) => button.getAttribute('aria-pressed')).join(',');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('nothing is pressed until you pick, then your pick is kept and pressed on the next load', () => {
  const first = page(LIST(0));
  const asked = wire(first.document);
  const { kept, storage, pending } = keeper(first);
  kept.start();
  assert.equal(asked.length, 0, 'no pick yet, so Facebook keeps All');
  assert.equal(kept.kept(), null);
  first.document.querySelector('h1').click();
  assert.equal(pending(), 0, 'no pick, so a click elsewhere waits for nothing');
  first.document.querySelectorAll('[role="toolbar"] [role="button"]')[1].click();
  assert.equal(storage.get(PICK_KEY), 'unread', 'your click on Unread');

  const next = page(LIST(0));
  const askedNext = wire(next.document);
  keeper(next, { storage }).kept.start();
  assert.deepEqual(askedNext, [1], 'Unread pressed once');
  assert.equal(pressedIn(next.document), 'false,true');
});

test('picking All again is kept too, and the script never presses back', () => {
  const storage = createMemoryStorage({ [PICK_KEY]: 'unread' });
  const win = page(LIST(1));
  const asked = wire(win.document);
  const { kept, flush } = keeper(win, { storage });
  kept.start();
  win.document.querySelectorAll('[role="toolbar"] [role="button"]')[0].click();
  assert.equal(storage.get(PICK_KEY), 'all');
  kept.apply();
  flush();
  assert.deepEqual(asked, [0], 'only your click');
  assert.equal(pressedIn(win.document), 'true,false');
});

test('Enter or Space on a filter is a pick, other keys are not', () => {
  const storage = createMemoryStorage();
  const win = page(LIST(0));
  keeper(win, { storage }).kept.start();
  const [all, unread] = win.document.querySelectorAll('[role="toolbar"] [role="button"]');
  unread.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  assert.equal(storage.get(PICK_KEY, null), null, 'Tab');
  unread.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(storage.get(PICK_KEY), 'unread', 'Enter');
  all.dispatchEvent(new win.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  assert.equal(storage.get(PICK_KEY), 'all', 'Space');
});

test("the bell's hidden list is left alone until a click opens it", () => {
  const storage = createMemoryStorage({ [PICK_KEY]: 'unread' });
  const win = page(BELL(0), '/');
  const doc = win.document;
  const asked = wire(doc);
  const { kept, flush, pending } = keeper(win, { storage, onPage: () => false });
  kept.start();
  assert.equal(asked.length, 0, 'hidden, so Facebook is asked for nothing');
  doc.querySelector('[role="dialog"]').style.display = '';
  doc.querySelector('.bell').click();
  assert.ok(pending() > 0, 'looked at again after the click');
  flush();
  assert.deepEqual(asked, [1]);
  assert.equal(pressedIn(doc), 'false,true');
});

test('the bell opened with Enter gets the same look, other keys do not', () => {
  const storage = createMemoryStorage({ [PICK_KEY]: 'unread' });
  const win = page(BELL(0), '/');
  const doc = win.document;
  const asked = wire(doc);
  const { kept, flush, pending } = keeper(win, { storage, onPage: () => false });
  kept.start();
  const bell = doc.querySelector('.bell');
  bell.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  assert.equal(pending(), 0, 'Tab');
  doc.querySelector('[role="dialog"]').style.display = '';
  bell.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  flush();
  assert.deepEqual(asked, [1]);
});

test('a bell list that fills in after the looks still gets your pick, for a few seconds after the click', async () => {
  const storage = createMemoryStorage({ [PICK_KEY]: 'unread' });
  const win = page(BELL(0).replace(ROW(1) + ROW(2), ''), '/');
  const doc = win.document;
  doc.querySelector('[role="dialog"]').style.display = '';
  const asked = wire(doc);
  let clock = 1000;
  const { kept, flush, pending } = keeper(win, { storage, onPage: () => false, now: () => clock });
  kept.start();
  doc.querySelector('.bell').click();
  flush();
  assert.equal(asked.length, 0, 'no notifications drawn yet, so it is not known as the filter');
  clock += 1500;
  doc.querySelector('[role="list"]').insertAdjacentHTML('beforeend', ROW(1));
  await tick();
  assert.ok(pending() > 0, 'the late rows bring a look');
  flush();
  assert.deepEqual(asked, [1]);

  // Long after the click, the page's own changes bring no look.
  clock += 5000;
  const [all, unread] = doc.querySelectorAll('[role="toolbar"] [role="button"]');
  all.setAttribute('aria-pressed', 'true');
  unread.setAttribute('aria-pressed', 'false');
  doc.querySelector('[role="list"]').insertAdjacentHTML('beforeend', ROW(2));
  await tick();
  assert.equal(pending(), 0);
});

test('Space or Enter typed in a text box is not a look', () => {
  const storage = createMemoryStorage({ [PICK_KEY]: 'unread' });
  const win = page(`${BELL(0)}<div contenteditable="true" class="box"><span>Hi</span></div><input class="search"><textarea></textarea>`, '/');
  const doc = win.document;
  const { kept, pending } = keeper(win, { storage, onPage: () => false });
  kept.start();
  for (const field of [doc.querySelector('.box span'), doc.querySelector('.search'), doc.querySelector('textarea')]) {
    for (const key of [' ', 'Enter']) field.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true }));
  }
  assert.equal(pending(), 0);
  doc.querySelector('.bell').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.ok(pending() > 0, 'Enter on the bell still looks');
});

test("the page's own clicks are not your pick", () => {
  const storage = createMemoryStorage();
  const win = page(LIST(0));
  wire(win.document);
  createFilterKeeper({ doc: win.document, storage, enabled: () => true, setTimer: () => assert.fail('nothing to look at') }).start();
  win.document.querySelectorAll('[role="toolbar"] [role="button"]')[1].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  assert.equal(pressedIn(win.document), 'false,true', 'Facebook still switched');
  assert.equal(storage.get(PICK_KEY, null), null);
});

test('a list emptied by Unread still takes your pick of All', () => {
  const storage = createMemoryStorage();
  const win = page(LIST(0));
  const doc = win.document;
  wire(doc);
  keeper(win, { storage }).kept.start();
  const [all, unread] = doc.querySelectorAll('[role="toolbar"] [role="button"]');
  unread.click();
  for (const row of doc.querySelectorAll('[role="listitem"]')) row.remove();
  all.click();
  assert.equal(storage.get(PICK_KEY), 'all');
});

test('two pressed-or-not buttons anywhere else are not the filter', () => {
  const storage = createMemoryStorage({ [PICK_KEY]: 'unread' });
  const win = page(`<div role="main"><div role="list">${BAR(0)}<div role="listitem"><a href="${FB}/groups/example/">A group</a></div></div></div>`);
  const asked = wire(win.document);
  const { kept } = keeper(win, { storage });
  kept.start();
  assert.equal(asked.length, 0, 'not pressed');
  storage.set(PICK_KEY, 'all');
  win.document.querySelectorAll('[role="toolbar"] [role="button"]')[1].click();
  assert.equal(storage.get(PICK_KEY), 'all', 'not taken as a pick');

  storage.set(PICK_KEY, 'unread');
  const three = page(LIST(0).replace('</div><div role="listitem">', '<div role="button" aria-pressed="false">More</div></div><div role="listitem">'));
  const askedThree = wire(three.document);
  keeper(three, { storage }).kept.start();
  assert.equal(three.document.querySelectorAll('[role="toolbar"] [role="button"]').length, 3);
  assert.equal(askedThree.length, 0, 'three buttons in the list, not pressed');
});

test('a list that does not switch is pressed three times at most, and three more after your next click', () => {
  const storage = createMemoryStorage({ [PICK_KEY]: 'unread' });
  const win = page(`${BELL(0)}<div class="elsewhere"></div>`, '/');
  const doc = win.document;
  doc.querySelector('[role="dialog"]').style.display = '';
  const asked = wire(doc, { stuck: true });
  const { kept, flush } = keeper(win, { storage });
  kept.start();
  for (let i = 0; i < 5; i++) kept.apply();
  assert.equal(asked.length, 3);
  doc.querySelector('.elsewhere').click();
  flush();
  for (let i = 0; i < 5; i++) kept.apply();
  assert.equal(asked.length, 6);
});

test('a bell that goes back to All is kept each time you open it', () => {
  const storage = createMemoryStorage({ [PICK_KEY]: 'unread' });
  const win = page(BELL(0), '/');
  const doc = win.document;
  doc.querySelector('[role="dialog"]').style.display = '';
  const asked = wire(doc);
  const { kept, flush } = keeper(win, { storage, onPage: () => false });
  kept.start();
  const [all] = doc.querySelectorAll('[role="toolbar"] [role="button"]');
  for (let open = 0; open < 4; open++) {
    all.setAttribute('aria-pressed', 'true');
    all.nextElementSibling.setAttribute('aria-pressed', 'false');
    doc.querySelector('.bell').click();
    flush();
  }
  assert.deepEqual(asked, [1, 1, 1, 1, 1], 'once at start and once per opening');
});

test('switched off, nothing is pressed or kept', () => {
  const storage = createMemoryStorage({ [PICK_KEY]: 'unread' });
  const win = page(LIST(0));
  const asked = wire(win.document);
  let on = false;
  const { kept, pending } = keeper(win, { storage, on: () => on });
  kept.start();
  win.document.querySelectorAll('[role="toolbar"] [role="button"]')[0].click();
  assert.deepEqual(asked, [0], 'only your click');
  assert.equal(storage.get(PICK_KEY), 'unread', 'not kept while off');
  kept.lookSoon();
  assert.equal(pending(), 0, 'a page change waits for nothing while off');
  on = true;
  kept.apply();
  assert.deepEqual(asked, [0, 1], 'pressed once it is on');
});

test('on the Notifications page the list is pressed as it draws, elsewhere it waits for a click', async () => {
  const storage = createMemoryStorage({ [PICK_KEY]: 'unread' });
  for (const onPage of [true, false]) {
    const win = page('<div class="root"></div>');
    const asked = wire(win.document);
    const { kept, flush, pending } = keeper(win, { storage, onPage: () => onPage });
    kept.start();
    win.document.querySelector('.root').innerHTML = LIST(0);
    await tick();
    assert.equal(pending() > 0, onPage, `scheduled on the page: ${onPage}`);
    flush();
    assert.equal(asked.length, onPage ? 1 : 0);
  }
});

test('starts off, web only, with a way back to All', async () => {
  assert.equal(keepNotificationsFilter.default, false);
  assert.equal(keepNotificationsFilter.webOnly, true);
  assert.equal(keepNotificationsFilter.section, 'notifications');
  assert.equal(pickLabel('unread'), 'Unread');
  assert.equal(pickLabel(null), 'Not picked yet');
  const storage = createMemoryStorage({ [PICK_KEY]: 'unread' });
  const win = page(LIST(0));
  const asked = wire(win.document);
  const added = {};
  const toasts = [];
  let moved = null;
  const router = { current: () => ({ type: 'notifications' }), subscribe: (listener) => { moved = listener; } };
  keepNotificationsFilter.setup({ doc: win.document, router, storage, enabled: () => true, actions: { add: (name, fn) => { added[name] = fn; } }, diagnostics: { add: (name, read) => { added[name] = read; } }, toast: (text) => toasts.push(text) });
  assert.deepEqual(asked, [1], 'pressed as it starts');
  // Back onto the page with the list already drawn on All: the route change alone brings a look.
  const [all, unread] = win.document.querySelectorAll('[role="toolbar"] [role="button"]');
  all.setAttribute('aria-pressed', 'true');
  unread.setAttribute('aria-pressed', 'false');
  moved({ type: 'notifications' });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.deepEqual(asked, [1, 1], 'pressed again after the move');
  assert.equal(added['Notifications filter kept'](), 'Unread');
  added['Open Notifications on All again']();
  assert.equal(storage.get(PICK_KEY, null), null);
  assert.equal(toasts.length, 1);
});
