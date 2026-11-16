// The right column's Sponsored box, hidden on the page. The data rule (AdsSideFeedUnit in
// ad-markers.js) covers Home drawn again in the browser, but a fresh load of Home brings the
// box already drawn (see watchColumnAds), and content mode has no data rule at all.
//
// Live 2026-10-21 on Home: div#right_rail_container[role=complementary] holds one block per
// box, each opening with an <h3>: "Sponsored" (a zero-width space after it), then "Friend
// requests". The ads under the Sponsored heading are l.facebook.com/l.php links, each with an
// "Open menu for <advertiser> sponsored content" button. The box is the largest block around
// the heading that holds no other heading and no link to a page on Facebook outside an ad, so
// Friend requests, contacts and the rest of the column stay.
//
// Friend requests, for Hide Friend requests on Home, the same way: the data rule
// (FriendingRequestsSideFeedUnit) for Home drawn again, the page for a fresh load and content
// mode. Its box is found by its links, not its words, so it works in any language.

import { whenRootReady } from '../../core/env.js';
import { normalizeText } from '../../core/dom/visible-text.js';
import { adLabel } from './sponsored-dom.js';

export const COLUMN_AD_MARK = 'data-hfw-column-ad';
export const COLUMN_AD_CSS = `[${COLUMN_AD_MARK}] { display: none !important; }`;
export const FRIEND_REQUESTS_MARK = 'data-hfw-friend-requests';
// Only on Home, so a mark left on a box Facebook reuses elsewhere hides nothing.
export const FRIEND_REQUESTS_CSS = `html[data-hfw-route="home"] [${FRIEND_REQUESTS_MARK}] { display: none !important; }`;

const COLUMN = '[role="complementary"]';
const HEADING = 'h1, h2, h3, h4, h5, h6, [role="heading"]';

const hasAdMenu = (element) => [...element.querySelectorAll('[role="button"][aria-label]')]
  .some((button) => /sponsored content$/i.test(normalizeText(button.getAttribute('aria-label'))));

function intoFacebook(href) {
  let url;
  try {
    url = new URL(href, 'https://www.facebook.com/');
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (host === 'facebook.com' || host.endsWith('.facebook.com')) && url.pathname !== '/l.php';
}

// A link to a profile, Friend requests or any other page on Facebook that isn't part of an ad,
// so the block around it is more than the Sponsored box. An ad that points at a Facebook Page
// still counts as the ad: its link shares a block with the ad's own "Open menu for ...
// sponsored content" button below `block`.
function linksPastAds(block) {
  for (const a of block.querySelectorAll('a[href]')) {
    if (!intoFacebook(a.getAttribute('href'))) continue;
    let inAd = false;
    for (let up = a; up && up !== block; up = up.parentElement) {
      if (hasAdMenu(up)) {
        inAd = true;
        break;
      }
    }
    if (!inAd) return true;
  }
  return false;
}

const holdsAnotherHeading = (block, heading) => [...block.querySelectorAll(HEADING)]
  .some((other) => other !== heading && !heading.contains(other) && !other.contains(heading));

// Every Sponsored box in the page's side columns.
export function columnAdBoxes(doc) {
  const boxes = [];
  for (const column of doc.querySelectorAll(COLUMN)) {
    for (const heading of column.querySelectorAll(HEADING)) {
      if (!adLabel(heading.textContent)) continue;
      let box = heading;
      for (let parent = box.parentElement; parent && parent !== column; parent = parent.parentElement) {
        if (holdsAnotherHeading(parent, heading) || linksPastAds(parent)) break;
        box = parent;
      }
      if (box !== heading) boxes.push(box);
    }
  }
  return boxes;
}

// The Friends page a link goes to: 'requests' for Friend requests, 'other' for another page
// under /friends/, null for anything else.
function friendsPage(href) {
  let url;
  try {
    url = new URL(href, 'https://www.facebook.com/');
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'facebook.com' && !host.endsWith('.facebook.com')) return null;
  if (/^\/friends\/requests\/?$/.test(url.pathname)) return 'requests';
  return /^\/friends(\/|$)/.test(url.pathname) ? 'other' : null;
}

const linksIn = (block) => [...block.querySelectorAll('a[href]')].map((a) => friendsPage(a.getAttribute('href')));

// Every Friend requests box in the page's side columns: the largest block around a heading that
// holds no other heading and only links to the Friends pages (See all, and each request), with at
// least one to Friend requests. Sponsored, Birthdays and contacts link elsewhere or carry their
// own heading, so the climb stops before them.
export function friendRequestsBoxes(doc) {
  const boxes = [];
  for (const column of doc.querySelectorAll(COLUMN)) {
    for (const heading of column.querySelectorAll(HEADING)) {
      let box = heading;
      for (let parent = box.parentElement; parent && parent !== column; parent = parent.parentElement) {
        if (holdsAnotherHeading(parent, heading) || linksIn(parent).includes(null)) break;
        box = parent;
      }
      if (box !== heading && !boxes.includes(box) && linksIn(box).includes('requests')) boxes.push(box);
    }
  }
  return boxes;
}

function touchesColumn(records) {
  for (const record of records) {
    const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
    if (target?.closest(COLUMN)) return true;
    for (const node of record.addedNodes) {
      if (node.nodeType === 1 && (node.matches(COLUMN) || node.querySelector(COLUMN))) return true;
    }
  }
  return false;
}

// Marks each Sponsored box as it's drawn, and onAd hears about each one once. The box comes
// already drawn in the page's HTML (live 2026-10-21: a streamed React segment, <div hidden
// id="S:4">, moved into the column about a second in), so taking it out of the data can't
// stop it on a fresh load of Home. The check runs straight from the observer, before the
// browser paints, and only for changes in or around a side column. The observer starts on
// <html> at document start: Home's HTML runs to megabytes, and waiting for its body (or for
// DOMContentLoaded) let the box show for a second (64 frames, live 2026-10-21).
export const watchColumnAds = ({ doc, enabled, onAd }) => watchColumnBoxes({ doc, enabled, find: columnAdBoxes, mark: COLUMN_AD_MARK, onBox: onAd });

// The same for any box find(doc) returns in a side column, under its own mark.
export function watchColumnBoxes({ doc, enabled, find, mark, onBox }) {
  const told = new WeakSet();
  const check = () => {
    if (!enabled()) return;
    const boxes = find(doc);
    // React can reuse a marked block for something else when it draws the column again.
    for (const marked of doc.querySelectorAll(`[${mark}]`)) {
      if (!boxes.includes(marked)) marked.removeAttribute(mark);
    }
    for (const box of boxes) {
      if (!box.hasAttribute(mark)) box.setAttribute(mark, '');
      if (told.has(box)) continue;
      told.add(box);
      onBox?.(box);
    }
  };
  const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  const observer = new Observer((records) => {
    if (touchesColumn(records)) check();
  });
  whenRootReady(() => {
    observer.observe(doc.documentElement, { childList: true, subtree: true });
    check();
  }, doc);
  return {
    check,
    stop: () => observer.disconnect(),
  };
}
