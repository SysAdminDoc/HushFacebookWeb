// Hushfacebook in the Menu: a HushFacebook Web row in Facebook's account menu, the one that
// opens from your picture at the right end of the top bar, that opens these settings.
//
// Live 2026-10-11 (captures/2026-10-11-account): the menu is a role=dialog with the same
// aria-label as the top bar button that opened it ("Your profile"), which says
// aria-expanded=true while it's open. A link to /me/ (your profile card) sits at the top, which
// no other menu has, so that's how the menu is found in any language. The rows are
// role=listitem in a role=list, Log out last. A sub-page such as Display & accessibility slides
// over the rows and leaves them in place, and the whole menu is drawn new each time it opens.
//
// The row is a copy of the menu's last row with its picture and words swapped, so it looks like
// Facebook's own in light and dark mode. A copy carries none of Facebook's click handling, so
// clicking it can only open the settings.

import { whenBodyReady } from '../../core/env.js';
import { SLIDERS_ICON } from '../../ui/icons.js';

export const ROW_MARK = 'data-hfw-menu-entry';
export const LABEL = 'HushFacebook Web';
const SVG_NS = 'http://www.w3.org/2000/svg';
const PROFILE_LINK = 'a[href="/me/"], a[href="/me"]';
// After a top bar button opens a menu, Facebook may draw it a moment later.
const RETRIES_MS = [0, 50, 150, 400, 1000, 2500];

// The account menu's list of rows, or null when the menu isn't open.
export function accountMenuList(doc) {
  for (const dialog of doc.querySelectorAll('[role="dialog"]')) {
    if (!dialog.querySelector(PROFILE_LINK)) continue;
    const list = dialog.querySelector('[role="list"]');
    if (list) return list;
  }
  return null;
}

function sliders(doc) {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('style', 'display: block; fill: var(--primary-icon, currentColor)');
  for (const d of SLIDERS_ICON) {
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

const ownText = (el) => [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());

// A copy of one of the menu's rows that reads HushFacebook Web with the sliders picture, or
// null when the row has no words to replace.
export function buildRow(template, doc) {
  const row = template.cloneNode(true);
  // Ids and labels would point screen readers at the original row.
  for (const el of [row, ...row.querySelectorAll('*')]) {
    for (const name of ['id', 'aria-label', 'aria-labelledby', 'aria-describedby']) el.removeAttribute(name);
  }
  const [label, ...rest] = [...row.querySelectorAll('*')].filter(ownText);
  if (!label) return null;
  label.textContent = LABEL;
  // A second line, like Report a problem's keyboard hint, goes.
  for (const extra of rest) extra.textContent = '';
  row.querySelector('i, svg, img')?.replaceWith(sliders(doc));
  row.setAttribute(ROW_MARK, '');
  return row;
}

// Puts the row just above the menu's last row (Log out). 'added', 'present', or 'no-row' when
// the menu has no row to copy.
export function addRow(list, doc, onOpen) {
  if (list.querySelector(`[${ROW_MARK}]`)) return 'present';
  const rows = [...list.children].filter((el) => el.getAttribute('role') === 'listitem');
  const last = rows.at(-1);
  const row = last && buildRow(last, doc);
  if (!row) return 'no-row';
  const run = (event) => {
    event.preventDefault();
    event.stopPropagation();
    onOpen(row);
  };
  row.addEventListener('click', run);
  // The copy keeps the row's role=button and tabindex, so it gets the keys a button answers to.
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') run(event);
  });
  list.insertBefore(row, last);
  return 'added';
}

// Closes the account menu the way a second click on its top bar button does, or with Escape
// when that button can't be found.
export function closeMenu(doc, row) {
  const dialog = row.closest('[role="dialog"]');
  if (!dialog) return;
  const label = dialog.getAttribute('aria-label');
  const opener = label && [...doc.querySelectorAll('[role="banner"] [aria-expanded="true"]')].find((el) => el.getAttribute('aria-label') === label);
  if (opener) {
    opener.click();
    return;
  }
  const Keyboard = doc.defaultView?.KeyboardEvent ?? globalThis.KeyboardEvent;
  dialog.dispatchEvent(new Keyboard('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
}

export function createMenuEntry({ doc, enabled, openSettings, log, setTimer = setTimeout }) {
  let added = 0;
  let failed = false;
  let opener = null;
  let watched = null;
  const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;

  const open = (row) => {
    closeMenu(doc, row);
    // After Facebook's menu has closed, so it can't take focus back from the panel.
    setTimer(() => openSettings(), 0);
  };

  function sync() {
    if (!enabled()) {
      remove();
      return;
    }
    const list = accountMenuList(doc);
    if (!list) return;
    const result = addRow(list, doc, open);
    if (result === 'added') added += 1;
    if (result === 'no-row' && !failed) {
      failed = true;
      log?.warn("Settings in your account menu: Facebook's account menu has no row to copy, so the HushFacebook Web row isn't there.");
    }
    watch(list.closest('[role="dialog"]'));
  }

  // While the menu is open, a redraw of its rows brings the row back.
  function watch(dialog) {
    if (!dialog || watched?.dialog === dialog) return;
    watched?.observer.disconnect();
    const observer = new Observer(() => {
      if (!dialog.isConnected) {
        observer.disconnect();
        if (watched?.dialog === dialog) watched = null;
        return;
      }
      sync();
    });
    observer.observe(dialog, { childList: true, subtree: true });
    watched = { dialog, observer };
  }

  function remove() {
    watched?.observer.disconnect();
    watched = null;
    for (const row of doc.querySelectorAll(`[${ROW_MARK}]`)) row.remove();
  }

  // A top bar button saying it's expanded is the moment a menu opens.
  function start() {
    if (opener || !doc.body) return;
    opener = new Observer((records) => {
      if (!enabled()) return;
      const opened = records.some((record) => record.target.getAttribute?.('aria-expanded') === 'true' && record.target.closest?.('[role="banner"]'));
      if (opened) for (const wait of RETRIES_MS) setTimer(sync, wait);
    });
    opener.observe(doc.body, { subtree: true, attributes: true, attributeFilter: ['aria-expanded'] });
  }

  return {
    apply() {
      start();
      sync();
    },
    sync,
    state: () => ({ added, failed }),
  };
}

export default {
  id: 'menuEntry',
  section: 'menu',
  android: 'Hushfacebook in the Menu',
  title: 'Settings in your account menu',
  description: 'Adds a HushFacebook Web row to the menu that opens from your picture at the right end of the top bar. Click it to open these settings.',
  default: true,
  options: [
    { key: 'hideButton', type: 'toggle', label: 'Hide the round settings button in the corner', default: false },
  ],

  setup({ doc, settings, enabled, log, diagnostics, openSettings }) {
    if (!doc) return;
    const entry = createMenuEntry({ doc, enabled, openSettings: () => openSettings?.(), log });
    whenBodyReady(() => entry.apply(), doc);
    settings?.subscribe(() => entry.apply());
    diagnostics?.add('Account menu row', () => {
      if (!enabled()) return 'off';
      const { added, failed } = entry.state();
      if (failed) return "Facebook's menu had no row to copy";
      return added ? `Added ${added} ${added === 1 ? 'time' : 'times'}` : 'Menu not opened yet';
    });
  },
};
