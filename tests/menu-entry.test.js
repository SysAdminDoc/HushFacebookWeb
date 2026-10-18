// Settings in your account menu against the account menu as drawn live on 2026-10-11 (shape
// from captures/2026-10-11-account, name made up): the profile card with its /me/ link, five
// rows in a role=list with Log out last and Report a problem carrying a second line, and the
// footer. The top bar button that opens it shares its aria-label and says aria-expanded.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import menuEntry, { LABEL, ROW_MARK, accountMenuList, addRow, buildRow, closeMenu, createMenuEntry } from '../src/features/menu/menu-entry.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const SVG = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M0 0h20v20H0z"></path></svg>';
const CHEVRON = '<div><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg></div>';
const row = (text, { icon = SVG, chevron = CHEVRON, second = '', button = '' } = {}) => `
  <div role="listitem" data-row="${text}"><div><div><div role="button" tabindex="0"${button}>
    <div><div><div><div>${icon}</div></div><div><div><div><div><span>${text}</span></div>${second}</div></div></div>${chevron}</div></div>
    <div role="none" data-visualcompletion="ignore"></div>
  </div></div></div></div>`;

const ROWS = `
  ${row('Settings & privacy')}
  ${row('Help & support')}
  ${row('Report a problem', { chevron: '', second: '<div><span><span>CTRL B</span></span></div>' })}
  ${row('Display & accessibility')}
  ${row('Log out', { icon: '<i data-visualcompletion="css-img"></i>', chevron: '', button: ' aria-label="Log out" id="logout"' })}`;

const ACCOUNT_MENU = `
<div role="dialog" aria-label="Your profile">
  <div>
    <a role="link" tabindex="0" href="/me/"><div><span>Pat Example</span></div></a>
    <div role="button" aria-label="See all profiles" tabindex="0"><span><span>See all profiles</span></span></div>
  </div>
  <div><div role="list" aria-label="Select an option">${ROWS}</div></div>
  <footer role="contentinfo" aria-label="Facebook"><ul><li><a role="link" href="/privacy/policy/">Privacy</a></li></ul></footer>
</div>`;

const BANNER = `
<div role="banner">
  <div role="button" aria-label="Facebook menu" aria-expanded="false"></div>
  <div role="button" aria-label="Your profile" aria-expanded="false" data-test="opener"></div>
</div>`;

// Facebook's other menu: a role=list of rows too, but no /me/ link.
const FACEBOOK_MENU = `<div role="dialog" aria-label="Menu"><div role="list">${row('Events')}${row('Memories')}</div></div>`;

function page(body = BANNER) {
  const win = testWindow('https://www.facebook.com/');
  windows.push(win);
  win.document.body.innerHTML = body;
  return { win, doc: win.document };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const texts = (list) => [...list.children].map((el) => el.textContent.replace(/\s+/g, ' ').trim());

// Opens the account menu the way Facebook does: the button says expanded, the dialog is drawn.
function openMenu(doc, html = ACCOUNT_MENU) {
  doc.querySelector('[data-test="opener"]').setAttribute('aria-expanded', 'true');
  doc.body.insertAdjacentHTML('beforeend', html);
}

function entryFor(doc, { on = true } = {}) {
  const state = { on, opened: 0, timers: [], warnings: [], failures: 0 };
  const entry = createMenuEntry({
    doc,
    enabled: () => state.on,
    openSettings: () => { state.opened += 1; },
    log: { warn: (message) => state.warnings.push(message) },
    onFail: () => { state.failures += 1; },
    setTimer: (fn) => state.timers.push(fn),
  });
  state.flush = () => { for (const fn of state.timers.splice(0)) fn(); };
  return { entry, state };
}

test('the account menu is found by its /me/ link, and no other menu is', () => {
  const { doc } = page(`${BANNER}${FACEBOOK_MENU}`);
  assert.equal(accountMenuList(doc), null);
  doc.body.insertAdjacentHTML('beforeend', ACCOUNT_MENU);
  const list = accountMenuList(doc);
  assert.equal(list.getAttribute('aria-label'), 'Select an option');
  assert.ok(list.closest('[aria-label="Your profile"]'));
});

test('the row is a copy of Log out with the sliders picture, put just above it', () => {
  const { doc } = page(`${BANNER}${ACCOUNT_MENU}`);
  const list = accountMenuList(doc);
  assert.equal(addRow(list, doc, () => {}), 'added');
  assert.deepEqual(texts(list), ['Settings & privacy', 'Help & support', 'Report a problemCTRL B', 'Display & accessibility', LABEL, 'Log out']);
  const added = list.querySelector(`[${ROW_MARK}]`);
  assert.equal(added.getAttribute('role'), 'listitem');
  const button = added.querySelector('[role="button"]');
  assert.equal(button.getAttribute('tabindex'), '0', 'it can still be reached with Tab');
  assert.equal(button.getAttribute('aria-label'), null, 'no "Log out" label for screen readers');
  assert.equal(added.querySelector('[id]'), null, 'no copied id');
  assert.equal(added.querySelector('i'), null, "Log out's picture is gone");
  const svg = added.querySelector('svg');
  assert.equal(svg.getAttribute('viewBox'), '0 0 24 24');
  assert.equal(svg.querySelectorAll('path').length, 9);
  assert.equal(doc.querySelector('#logout').textContent.trim(), 'Log out', 'the real Log out is untouched');
  assert.equal(addRow(list, doc, () => {}), 'present');
  assert.equal(list.querySelectorAll(`[${ROW_MARK}]`).length, 1);
});

test("a copied row with a second line keeps only the script's name, and a row with no words isn't copied", () => {
  const { doc } = page(`${BANNER}${ACCOUNT_MENU}`);
  const report = doc.querySelector('[data-row="Report a problem"]');
  const copy = buildRow(report, doc);
  assert.equal(copy.textContent.replace(/\s+/g, ''), 'HushFacebookWeb');
  assert.equal(copy.querySelectorAll('svg').length, 1, 'the sliders picture replaced the row picture');
  const blank = doc.createElement('div');
  blank.setAttribute('role', 'listitem');
  blank.innerHTML = '<div role="button"><i></i></div>';
  assert.equal(buildRow(blank, doc), null);
  const list = doc.createElement('div');
  list.append(blank);
  assert.equal(addRow(list, doc, () => {}), 'no-row');
  assert.equal(addRow(doc.createElement('div'), doc, () => {}), 'no-row');
});

test('clicking the row closes the menu with its own button, then opens the settings, and nothing reaches Facebook', () => {
  const { doc } = page(BANNER);
  const { entry, state } = entryFor(doc);
  openMenu(doc);
  entry.apply();
  const order = [];
  const opener = doc.querySelector('[data-test="opener"]');
  opener.addEventListener('click', () => order.push('menu closed'));
  let reachedFacebook = 0;
  doc.addEventListener('click', (event) => { if (event.target.closest?.(`[${ROW_MARK}]`)) reachedFacebook += 1; });
  let loggedOut = 0;
  doc.querySelector('#logout').addEventListener('click', () => { loggedOut += 1; });
  doc.querySelector(`[${ROW_MARK}] span`).click();
  assert.deepEqual(order, ['menu closed']);
  assert.equal(state.opened, 0, 'the settings wait for the menu to close');
  state.flush();
  assert.equal(state.opened, 1);
  assert.equal(reachedFacebook, 0);
  assert.equal(loggedOut, 0);
});

test('Enter and Space on the row open the settings, other keys do nothing', () => {
  const { doc, win } = page(BANNER);
  const { entry, state } = entryFor(doc);
  openMenu(doc);
  entry.apply();
  const button = doc.querySelector(`[${ROW_MARK}] [role="button"]`);
  const press = (key) => button.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  press('Tab');
  press('a');
  state.flush();
  assert.equal(state.opened, 0);
  press('Enter');
  press(' ');
  state.flush();
  assert.equal(state.opened, 2);
});

test('with no expanded top bar button, the menu is closed with Escape', () => {
  const { doc } = page(`<div role="banner"></div>${ACCOUNT_MENU}`);
  const keys = [];
  doc.addEventListener('keydown', (event) => keys.push(event.key));
  closeMenu(doc, doc.querySelector('[data-row="Log out"]'));
  assert.deepEqual(keys, ['Escape']);
});

test('the row turns up when the menu opens, comes back after a redraw, and is in each new copy of the menu', async () => {
  const { doc } = page(BANNER);
  const { entry, state } = entryFor(doc);
  entry.apply();
  assert.equal(doc.querySelector(`[${ROW_MARK}]`), null);
  openMenu(doc);
  await tick();
  state.flush();
  assert.equal(doc.querySelectorAll(`[${ROW_MARK}]`).length, 1);
  // Facebook draws the rows again.
  accountMenuList(doc).innerHTML = ROWS;
  await tick();
  assert.equal(doc.querySelectorAll(`[${ROW_MARK}]`).length, 1);
  assert.deepEqual(texts(accountMenuList(doc)).slice(-2), [LABEL, 'Log out']);
  // Closed, then opened again as a new dialog.
  const opener = doc.querySelector('[data-test="opener"]');
  opener.setAttribute('aria-expanded', 'false');
  doc.querySelector('[role="dialog"]').remove();
  await tick();
  openMenu(doc);
  await tick();
  state.flush();
  assert.equal(doc.querySelectorAll(`[${ROW_MARK}]`).length, 1);
  assert.equal(entry.state().added, 3);
});

test('other menus opening from the top bar get no row', async () => {
  const { doc } = page(BANNER);
  const { entry, state } = entryFor(doc);
  entry.apply();
  doc.querySelector('[aria-label="Facebook menu"]').setAttribute('aria-expanded', 'true');
  doc.body.insertAdjacentHTML('beforeend', FACEBOOK_MENU);
  await tick();
  state.flush();
  assert.equal(doc.querySelector(`[${ROW_MARK}]`), null);
});

test('switching it off takes the row out, and on again with the menu open puts it back', async () => {
  const { doc } = page(BANNER);
  const { entry, state } = entryFor(doc);
  openMenu(doc);
  entry.apply();
  assert.equal(doc.querySelectorAll(`[${ROW_MARK}]`).length, 1);
  state.on = false;
  entry.apply();
  assert.equal(doc.querySelector(`[${ROW_MARK}]`), null);
  // A redraw while off doesn't bring it back.
  accountMenuList(doc).innerHTML = ROWS;
  await tick();
  state.flush();
  assert.equal(doc.querySelector(`[${ROW_MARK}]`), null);
  state.on = true;
  entry.apply();
  assert.equal(doc.querySelectorAll(`[${ROW_MARK}]`).length, 1);
});

test('a menu with no row to copy is reported once, in the log and Diagnostics', async () => {
  const { doc } = page(BANNER);
  const { entry, state } = entryFor(doc);
  openMenu(doc, ACCOUNT_MENU.replace(ROWS, ''));
  entry.apply();
  entry.sync();
  assert.equal(state.warnings.length, 1);
  assert.match(state.warnings[0], /no row to copy/);
  assert.deepEqual(entry.state(), { added: 0, failed: true });
  assert.equal(state.failures, 1, 'the corner button is told to come back, once');
});

test('the feature is in the Menu section, on by default, with the corner button left alone', () => {
  assert.equal(menuEntry.section, 'menu');
  assert.equal(menuEntry.default, true);
  assert.equal(menuEntry.needsPage, undefined, 'it works in content mode');
  assert.deepEqual(menuEntry.options.map(({ key, default: value }) => [key, value]), [['hideButton', false]]);
});
