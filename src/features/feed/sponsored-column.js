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

import { whenRootReady } from '../../core/env.js';
import { normalizeText } from '../../core/dom/visible-text.js';
import { adLabel } from './sponsored-dom.js';

export const COLUMN_AD_MARK = 'data-hfw-column-ad';
export const COLUMN_AD_CSS = `[${COLUMN_AD_MARK}] { display: none !important; }`;

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
export function watchColumnAds({ doc, enabled, onAd }) {
  const told = new WeakSet();
  const check = () => {
    if (!enabled()) return;
    const boxes = columnAdBoxes(doc);
    // React can reuse a marked block for something else when it draws the column again.
    for (const marked of doc.querySelectorAll(`[${COLUMN_AD_MARK}]`)) {
      if (!boxes.includes(marked)) marked.removeAttribute(COLUMN_AD_MARK);
    }
    for (const box of boxes) {
      if (!box.hasAttribute(COLUMN_AD_MARK)) box.setAttribute(COLUMN_AD_MARK, '');
      if (told.has(box)) continue;
      told.add(box);
      onAd?.(box);
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
