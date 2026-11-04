// Rows Hush adds to a post's three-dot menu: Download in post menus and Hide posts by words'
// "Hide posts by <name>".
//
// Live 2026-10-22 signed out on NASA's Page: the post's three-dot button is a role=button with
// aria-haspopup=menu inside the post, and it says aria-expanded=true while its menu is open. The
// menu is drawn in a layer of its own, far from the post, as a role=menu ("Feed story") whose rows
// are role=button (role=menuitem in other Facebook menus), each an icon and a line of words with
// sometimes a second line under it. A comment's "Report this" button opens a menu the same way, so
// only a post's own button counts.
//
// A row is a copy of Facebook's first row with its picture and words swapped, so it looks like
// Facebook's own in light and dark mode, and a copy carries none of Facebook's click handling.
// Each feature copies Facebook's row, never another Hush row, so two features' rows look alike.

import { isComment } from './posts.js';

export const POST = '[aria-posinset], [role="article"]';
export const OPENER = '[aria-haspopup="menu"][aria-expanded="true"]';
// On every row Hush adds, next to the feature's own mark.
export const OUR_ROW = 'data-hfw-menu-row';
const ROWS = '[role="menuitem"], [role="button"]';
const SVG_NS = 'http://www.w3.org/2000/svg';
// After the three-dot button opens its menu, Facebook may draw it a moment later.
const RETRIES_MS = [0, 50, 150, 400, 1000];

// The post whose own three-dot button has its menu open, or null. That button is the first one in
// the post that opens a menu: all 100 posts in organic-posts.jsonl.gz (Home, groups and search,
// 2026-11-03) have it in the header, after the author and before the post text. Comment order and
// the comment box's emoji, GIF and sticker buttons come after it, and a comment's own buttons
// belong to the comment.
export function menuPost(doc) {
  for (const button of doc.querySelectorAll(OPENER)) {
    const post = button.closest(POST);
    if (!post || isComment(post)) continue;
    const first = [...post.querySelectorAll('[aria-haspopup="menu"]')].find((el) => el.closest(POST) === post);
    if (first === button) return post;
  }
  return null;
}

export function strokeIcon(doc, d, size) {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('style', 'display: block; fill: none; stroke: var(--primary-icon, currentColor); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round');
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

const ownText = (el) => [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());

// A copy of one of the menu's rows that reads text with the icon's picture, or null when the row
// has no words to replace.
export function buildMenuRow(template, doc, { text, icon, mark }) {
  const row = template.cloneNode(true);
  // Ids and labels would point screen readers at the original row.
  for (const el of [row, ...row.querySelectorAll('*')]) {
    for (const name of ['id', 'aria-label', 'aria-labelledby', 'aria-describedby']) el.removeAttribute(name);
  }
  const [label, ...rest] = [...row.querySelectorAll('*')].filter(ownText);
  if (!label) return null;
  label.textContent = text;
  // A second line, like Report post's "We won't let ... know", goes.
  for (const extra of rest) extra.textContent = '';
  const picture = row.querySelector('i, svg, img');
  picture?.replaceWith(strokeIcon(doc, icon, picture.getAttribute('width') || '20'));
  row.setAttribute('tabindex', '0');
  row.setAttribute(OUR_ROW, '');
  row.setAttribute(mark, '');
  return row;
}

// Closes the menu the way a second click on its three-dot button does, or with Escape when that
// button can't be found.
export function closeMenu(doc, menu) {
  const opener = doc.querySelector(OPENER);
  if (opener) {
    opener.click();
    return;
  }
  const Keyboard = doc.defaultView?.KeyboardEvent ?? globalThis.KeyboardEvent;
  menu.dispatchEvent(new Keyboard('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
}

// One feature's row. pick() says which post the open menu is for, as { post, ... }, or null for
// no row. label(picked) is the row's words, already translated, and run(picked) is the click, after
// the menu has closed. A top row goes above every other row, Hush's too; the rest go right above
// Facebook's first row. failed(error) logs a row that couldn't be drawn, in the feature's words.
export function createPostMenuRow({ doc, mark, enabled, pick, label, icon, run, top = false, failed, setTimer = (fn, ms) => (doc.defaultView ?? globalThis).setTimeout(fn, ms) }) {
  let shown = null; // { row, post, text }: the row in the open menu, the post it's for and its words
  let added = 0;
  let opener = null;
  let watched = null;
  const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;

  function remove() {
    watched?.observer.disconnect();
    watched = null;
    shown = null;
    for (const row of doc.querySelectorAll(`[${mark}]`)) row.remove();
  }

  function addRow(menu, picked) {
    const text = label(picked);
    if (shown && menu.contains(shown.row)) {
      if (shown.post === picked.post && shown.text === text) return;
      shown.row.remove();
    }
    shown = null;
    const rows = [...menu.querySelectorAll(ROWS)].filter((el) => !el.closest(`[${OUR_ROW}]`));
    const first = rows[0];
    const row = first && buildMenuRow(first, doc, { text, icon, mark });
    if (!row) return;
    const go = (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(doc, menu);
      run(picked);
    };
    row.addEventListener('click', go);
    // The copy keeps the row's role, so it gets the keys a button answers to.
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') go(event);
    });
    (top ? menu.querySelector(ROWS) : first).before(row);
    shown = { row, post: picked.post, text };
    added++;
  }

  function sync() {
    if (!enabled()) {
      remove();
      return;
    }
    const picked = pick();
    const menu = [...doc.querySelectorAll('[role="menu"]')].at(-1);
    if (!picked) {
      // The same menu now open for a post with no row: the row for the last one would act on it.
      if (shown && menu?.contains(shown.row)) {
        shown.row.remove();
        shown = null;
      }
      return;
    }
    if (!menu) return;
    try {
      addRow(menu, picked);
    } catch (error) {
      failed?.(error);
    }
    watch(menu);
  }

  // While the menu is open, a redraw of its rows brings the row back.
  function watch(menu) {
    if (watched?.menu === menu) return;
    watched?.observer.disconnect();
    const observer = new Observer(() => {
      if (!menu.isConnected) {
        observer.disconnect();
        if (watched?.menu === menu) watched = null;
        return;
      }
      // Only when the row is gone, so a row going in never sets off another sync.
      if (!shown || !menu.contains(shown.row)) sync();
    });
    observer.observe(menu, { childList: true, subtree: true });
    watched = { menu, observer };
  }

  // A post's three-dot button saying it's expanded is the moment its menu opens.
  function start() {
    if (opener || !doc.body) return;
    opener = new Observer((records) => {
      if (!enabled()) return;
      const opened = records.some((record) => record.target.matches?.(OPENER) && record.target.closest(POST));
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
    added: () => added,
  };
}
