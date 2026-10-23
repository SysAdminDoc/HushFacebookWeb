// Hushfacebook's Download first in post menus on Android puts Download to phone and Save photo at
// the top of a post's three-dot menu (2026-10-18), since the row under a post has no room for a
// button. On the web the Download button only shows on hover or Tab, so this puts a Download row
// at the top of the menu instead, saving what the button would.
//
// Live 2026-10-22 signed out on NASA's Page: the post's three-dot button is a role=button with
// aria-haspopup=menu inside the post, and it says aria-expanded=true while its menu is open. The
// menu is drawn in a layer of its own, far from the post, as a role=menu ("Feed story") whose rows
// are role=button (role=menuitem in other Facebook menus), each an icon and a line of words with
// sometimes a second line under it. A comment's "Report this" button opens a menu the same way, so
// only a post's own button counts. A post with no photo or video that a Download switch that's on
// covers gets no row, like Android's.
//
// The row is a copy of the menu's first row with its picture and words swapped, so it looks like
// Facebook's own in light and dark mode, and a copy carries none of Facebook's click handling.

import { whenBodyReady } from '../../core/env.js';
import { isComment } from '../../core/dom/posts.js';
import { t } from '../../core/i18n.js';
import { DOWNLOAD_ICON } from './button.js';
import { downloads } from './shared.js';

export const ROW_MARK = 'data-hfw-menu-download';
const POST = '[aria-posinset], [role="article"]';
const OPENER = '[aria-haspopup="menu"][aria-expanded="true"]';
const ROWS = '[role="menuitem"], [role="button"]';
const SVG_NS = 'http://www.w3.org/2000/svg';
// After the three-dot button opens its menu, Facebook may draw it a moment later.
const RETRIES_MS = [0, 50, 150, 400, 1000];

// The post whose own three-dot button has its menu open, or null.
export function openPost(doc) {
  for (const button of doc.querySelectorAll(OPENER)) {
    const post = button.closest(POST);
    if (post && !isComment(post)) return post;
  }
  return null;
}

// The post's first photo or video that find() can save, leaving out comments and posts inside it.
export function mediaOf(post, find) {
  for (const media of post.querySelectorAll('video, img')) {
    if (media.closest(POST) !== post) continue;
    const found = find(media);
    if (found) return { media, found };
  }
  return null;
}

function downloadIcon(doc, size) {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('style', 'display: block; fill: none; stroke: var(--primary-icon, currentColor); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round');
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', DOWNLOAD_ICON);
  svg.append(path);
  return svg;
}

const ownText = (el) => [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());

// A copy of one of the menu's rows that reads Download with a download picture, or null when the
// row has no words to replace.
export function buildRow(template, doc) {
  const row = template.cloneNode(true);
  // Ids and labels would point screen readers at the original row.
  for (const el of [row, ...row.querySelectorAll('*')]) {
    for (const name of ['id', 'aria-label', 'aria-labelledby', 'aria-describedby']) el.removeAttribute(name);
  }
  const [label, ...rest] = [...row.querySelectorAll('*')].filter(ownText);
  if (!label) return null;
  label.textContent = t('Download');
  // A second line, like Report post's "We won't let ... know", goes.
  for (const extra of rest) extra.textContent = '';
  const picture = row.querySelector('i, svg, img');
  picture?.replaceWith(downloadIcon(doc, picture.getAttribute('width') || '20'));
  row.setAttribute('tabindex', '0');
  row.setAttribute(ROW_MARK, '');
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

// find(media) and run(found) are the Download button's own (shared.js), missing() says there's
// nothing to save any more.
export function createMenuDownload({ doc, enabled, find, run, missing, log, setTimer = (fn, ms) => (doc.defaultView ?? globalThis).setTimeout(fn, ms) }) {
  let shown = null; // { row, post }: the row in the open menu and the post it saves from
  let added = 0;
  let clicked = 0;
  let opener = null;
  let watched = null;
  const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;

  function remove() {
    watched?.observer.disconnect();
    watched = null;
    shown = null;
    for (const row of doc.querySelectorAll(`[${ROW_MARK}]`)) row.remove();
  }

  function save(post, menu) {
    closeMenu(doc, menu);
    // Asked again, since the post may have changed while its menu was open.
    const pick = post.isConnected ? mediaOf(post, find) : null;
    if (!pick) {
      missing?.();
      return;
    }
    clicked++;
    Promise.resolve(run(pick.found, null)).catch((error) => log?.error('The download failed', error));
  }

  function addRow(menu, post) {
    if (shown && menu.contains(shown.row)) {
      if (shown.post === post) return;
      shown.row.remove();
    }
    shown = null;
    if (!mediaOf(post, find)) return;
    // Ours is gone by now, so the first row is Facebook's.
    const first = menu.querySelector(ROWS);
    const row = first && buildRow(first, doc);
    if (!row) return;
    const go = (event) => {
      event.preventDefault();
      event.stopPropagation();
      save(post, menu);
    };
    row.addEventListener('click', go);
    // The copy keeps the row's role, so it gets the keys a button answers to.
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') go(event);
    });
    first.before(row);
    shown = { row, post };
    added++;
  }

  function sync() {
    if (!enabled()) {
      remove();
      return;
    }
    const post = openPost(doc);
    const menu = post && [...doc.querySelectorAll('[role="menu"]')].at(-1);
    if (!menu) return;
    try {
      addRow(menu, post);
    } catch (error) {
      log?.error("Couldn't add Download to the post menu", error);
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
    state: () => ({ added, clicked }),
  };
}

export default {
  id: 'downloadMenu',
  section: 'downloads',
  android: 'Download first in post menus',
  title: 'Download in post menus',
  description: "Puts Download at the top of a post's three-dot menu when the post has a photo or video to save. It saves the same file as the Download button, so it follows the switches above.",
  default: false,

  setup(ctx) {
    const { doc, settings, enabled, log, diagnostics } = ctx;
    if (!doc) return;
    const shared = downloads(ctx);
    const entry = createMenuDownload({ doc, enabled, find: shared.find, run: shared.run, missing: shared.missing, log });
    whenBodyReady(() => entry.apply(), doc);
    settings?.subscribe(() => entry.apply());
    diagnostics?.add('Post menu downloads', () => {
      const { added, clicked } = entry.state();
      return `Added to ${added} ${added === 1 ? 'menu' : 'menus'}, clicked ${clicked}`;
    });
  },
};
