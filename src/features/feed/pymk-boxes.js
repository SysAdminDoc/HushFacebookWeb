// People you may know on the Friends page and on profiles, hidden on the page. Hide suggested
// posts takes the row on Home out of the data, while these are the page's own blocks, so they
// go by the page.
//
// Live 2026-11-03 (signed in, script off): /friends draws an h2 "People you may know" in
// div[role=main] with a See all link to /friends/suggestions/, then a role=list of cards whose
// links go to /friends/suggestions/?profile_id=..., then a second role=list of loading
// placeholders that Facebook fills as you scroll (FriendingCometPYMKGridPaginationQuery). A
// profile draws the same heading and See all link between its header and its tabs, over a row of
// cards with Add friend buttons. On /friends/suggestions the list fills the left column under the
// page's own "Suggestions" heading, with no See all link.
//
// The block is found from the See all link, so it doesn't depend on the language: the smallest
// block around it that holds two other links (a card), grown while the blocks beside it hold no
// link, button or heading, so the loading placeholders go too. A hidden placeholder never comes
// into view, so Facebook doesn't keep fetching cards behind the hidden grid. A Friend requests
// section, the profile's header and its tabs all hold links or buttons, so they stay.

import { whenRootReady } from '../../core/env.js';

export const PYMK_MARK = 'data-hfw-pymk';

// The marks only count on these pages, so one left behind elsewhere hides nothing.
const PAGES = ['friends', 'profile'];
export const PYMK_CSS = `${PAGES.map((page) => `html[data-hfw-route="${page}"] [${PYMK_MARK}]`).join(',\n')} { display: none !important; }`;

const HEADING = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
const BUSY = `a[href], button, [role="button"], [role="tab"], input, textarea, ${HEADING}`;
// A block never grows into or past these.
const EDGE = 'body, [role="main"], [role="navigation"], [role="banner"], [role="complementary"], [role="dialog"], [role="article"], [aria-posinset]';
// A See all link in these is the page's own menu or a post, not the block.
const ELSEWHERE = '[role="navigation"], [role="banner"], [role="dialog"], [role="article"], [aria-posinset]';

export function seeAllLink(a) {
  let url;
  try {
    url = new URL(a.getAttribute('href'), 'https://www.facebook.com/');
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (host === 'facebook.com' || host.endsWith('.facebook.com')) && /^\/friends\/suggestions\/?$/.test(url.pathname) && !url.searchParams.has('profile_id');
}

const busy = (element) => element.matches(BUSY) || Boolean(element.querySelector(BUSY));

// Headings that aren't inside another heading.
const headingsIn = (block) => [...block.querySelectorAll(HEADING)].filter((h) => !h.parentElement?.closest(HEADING));

function linksBesides(block, link, enough) {
  let n = 0;
  for (const a of block.querySelectorAll('a[href]')) {
    if (a !== link && ++n >= enough) return true;
  }
  return false;
}

// Up from `box` while every other block beside it is empty or only placeholders.
function grow(box) {
  for (let parent = box.parentElement; parent && !parent.matches(EDGE); parent = parent.parentElement) {
    if ([...parent.children].some((child) => child !== box && busy(child))) break;
    box = parent;
  }
  return box;
}

// The block around a See all link, or null when it isn't laid out the way it was seen live.
function seeAllBox(link) {
  if (link.closest(ELSEWHERE)) return null;
  for (let block = link.parentElement; block && !block.matches(EDGE); block = block.parentElement) {
    if (!linksBesides(block, link, 2)) continue;
    return headingsIn(block).length <= 1 ? grow(block) : null;
  }
  return null;
}

// /friends/suggestions has no See all link: the list is the left column's block around any
// heading after the column's first, holding no other heading and at least two links.
function suggestionsBoxes(doc) {
  const boxes = [];
  for (const column of doc.querySelectorAll('[role="navigation"]')) {
    if (column.closest('[role="banner"]')) continue;
    const headings = headingsIn(column);
    for (const heading of headings.slice(1)) {
      let box = heading;
      for (let parent = box.parentElement; parent && parent !== column; parent = parent.parentElement) {
        if (headingsIn(parent).length > 1) break;
        box = parent;
      }
      if (box !== heading && linksBesides(box, null, 2)) boxes.push(box);
    }
  }
  return boxes;
}

// Every People you may know block on a page at `path` (a /friends or profile address).
export function pymkBoxes(doc, path = '') {
  const boxes = new Set();
  for (const link of doc.querySelectorAll('a[href*="/friends/suggestions"]')) {
    if (!seeAllLink(link)) continue;
    const box = seeAllBox(link);
    if (box) boxes.add(box);
  }
  if (/^\/friends\/suggestions\/?$/.test(path)) for (const box of suggestionsBoxes(doc)) boxes.add(box);
  const all = [...boxes];
  return all.filter((box) => !all.some((other) => other !== box && other.contains(box)));
}

// Marks each block once per frame of changes, only on the Friends pages and profiles. route()
// is the router's current route, active() says the option is on.
export function watchPymk({ doc, route, active, onBox }) {
  const told = new WeakSet();
  const onPage = () => PAGES.includes(route()?.type);
  let queued = false;
  const check = () => {
    queued = false;
    if (!active() || !onPage()) return;
    const boxes = pymkBoxes(doc, route().path);
    // React reuses blocks when it draws the page again, and a section that arrives later (Friend
    // requests) can sit beside the block, which then shrinks.
    for (const marked of doc.querySelectorAll(`[${PYMK_MARK}]`)) {
      if (!boxes.includes(marked)) marked.removeAttribute(PYMK_MARK);
    }
    for (const box of boxes) {
      if (!box.hasAttribute(PYMK_MARK)) box.setAttribute(PYMK_MARK, '');
      if (told.has(box)) continue;
      told.add(box);
      onBox?.(box);
    }
  };
  const view = doc.defaultView;
  // Before the browser paints the change, once however many changes came in.
  const frame = view?.requestAnimationFrame ? (fn) => view.requestAnimationFrame(fn) : (fn) => setTimeout(fn, 16);
  const Observer = view?.MutationObserver ?? globalThis.MutationObserver;
  const observer = new Observer(() => {
    if (queued || !active() || !onPage()) return;
    queued = true;
    frame(check);
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
