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
import { parseRoute } from '../../core/route.js';
import { sideColumns } from '../appearance/wider-feed.js';
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

// What a link in the Friend requests box goes to: { kind: 'requests' } for Friend requests,
// 'friends' for another page under /friends/ or a request's mutual friends, 'person' for
// someone's profile (each request links to the person, the user.url in the box's data), and
// `who` for the one person a link names, null for anything else.
function requestsLink(href) {
  let url;
  try {
    url = new URL(href, 'https://www.facebook.com/');
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'facebook.com' && !host.endsWith('.facebook.com')) return null;
  if (/^\/friends\/requests\/?$/.test(url.pathname)) {
    const id = url.searchParams.get('profile_id');
    return id ? { kind: 'requests', who: `id ${id}` } : { kind: 'requests' };
  }
  if (/^\/(friends|browse\/mutual_friends)(\/|$)/.test(url.pathname)) return { kind: 'friends' };
  const parts = url.pathname.split('/').filter(Boolean);
  if (parseRoute(url.href).type !== 'profile') return null;
  if (parts[0] === 'profile.php') return url.searchParams.has('id') ? { kind: 'person', who: `id ${url.searchParams.get('id')}` } : null;
  if (parts[0] === 'people') return { kind: 'person', who: parts.slice(1).join('/') };
  // A username: letters, digits and dots, five or more, alone in the path.
  return parts.length === 1 && /^[a-z0-9.]{5,}$/i.test(parts[0]) && !parts[0].endsWith('.php') ? { kind: 'person', who: parts[0].toLowerCase() } : null;
}

// A link drawn as a button that goes nowhere, like a request's Remove, is a button.
const goesNowhere = (a) => a.matches('[role="button"]') && /^\s*(#|javascript:|$)/i.test(a.getAttribute('href'));
const realLinks = (block) => [...block.querySelectorAll('a[href]')].filter((a) => !goesNowhere(a));
const kindsIn = (links) => links.map((a) => requestsLink(a.getAttribute('href')));
const linksIn = (block) => kindsIn(realLinks(block)).map((link) => link?.kind ?? null);

const peopleIn = (links) => new Set(kindsIn(links).map((link) => link?.who).filter(Boolean)).size;

// A request's name drawn as a heading: in a link, or holding links, that name one person. It's
// part of a box, and any other heading starts a box of its own. People you may know's heading
// links to the Friends pages and no one. A heading beside a link isn't taken as a name, since
// a box like Your Pages and profiles can have a heading over a single link.
function namesOnePerson(heading) {
  const around = heading.closest('a[href]');
  const links = around ? [around] : realLinks(heading);
  return links.length > 0 && !kindsIn(links).includes(null) && peopleIn(links) === 1;
}

const holdsAnotherBox = (block, heading) => [...block.querySelectorAll(HEADING)]
  .some((other) => other !== heading && !heading.contains(other) && !other.contains(heading) && !namesOnePerson(other));

// Words outside every button and link, so a block shows something of its own.
function looseText(block) {
  const walker = block.ownerDocument.createTreeWalker(block, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue.trim() && !node.parentElement?.closest('a[href], button, [role="button"]')) return true;
  }
  return false;
}

const BUTTON = 'button, [role="button"]';

// Whether each person a block links to has a button of their own beside them, as each request
// has Confirm and Delete.
function buttonEach(block) {
  for (const a of realLinks(block)) {
    if (requestsLink(a.getAttribute('href'))?.kind !== 'person') continue;
    let row = a;
    while (row !== block && !row.querySelector(BUTTON)) row = row.parentElement;
    if (!row.querySelector(BUTTON) || peopleIn(realLinks(row)) > 1) return false;
  }
  return true;
}

// A block beside the box with no heading that's still something else: its own words and
// buttons with no link, like a title drawn as plain text over rows of buttons, or links to
// people (or to Facebook pages a username can't be told from) without a button each, like
// birthdays or contacts under a Search button. A request links to the person with Confirm and
// Delete beside it, or to Friend requests, and a See more button or an empty divider has no
// words of its own.
function somethingElse(block) {
  const kinds = linksIn(block);
  if (kinds.includes('person')) return !kinds.includes('requests') && !buttonEach(block);
  return !kinds.some(Boolean) && Boolean(block.querySelector(BUTTON)) && looseText(block);
}

// Every Friend requests box in the page's own side columns: the largest block around a heading
// that holds no other box's heading, links only to the Friends pages and to people (See all,
// and each request), and has nothing else beside it, with at least one link to Friend requests.
// Sponsored, Birthdays and contacts carry their own heading or link elsewhere, so the climb
// stops before them.
export function friendRequestsBoxes(doc) {
  const boxes = [];
  for (const column of sideColumns(doc)) {
    for (const heading of column.querySelectorAll(HEADING)) {
      let box = heading;
      for (let parent = box.parentElement; parent && parent !== column; parent = parent.parentElement) {
        if (holdsAnotherBox(parent, heading) || linksIn(parent).includes(null)) break;
        const inside = box;
        if ([...parent.children].some((kid) => kid !== inside && somethingElse(kid))) break;
        box = parent;
      }
      if (box !== heading && !boxes.includes(box) && linksIn(box).includes('requests')) boxes.push(box);
    }
  }
  // A request's name heading climbs only as far as its request: that's inside the box.
  return boxes.filter((box) => !boxes.some((other) => other !== box && other.contains(box)));
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

// The same for any box find(doc) returns in a side column, under its own mark. onBox hears
// about a box once: a box the last check found, or a block in or around one of them, is that
// box again, since the box can narrow as the column fills in (contacts loading beside it) or
// widen when the box beside it goes. Each earlier box stands for one box only, so a second box
// drawn in the same block is new, and so is one drawn after a check found none.
export function watchColumnBoxes({ doc, enabled, find, mark, onBox }) {
  let last = [];
  const check = () => {
    if (!enabled()) return;
    const boxes = find(doc);
    // React can reuse a marked block for something else when it draws the column again.
    for (const marked of doc.querySelectorAll(`[${mark}]`)) {
      if (!boxes.includes(marked)) marked.removeAttribute(mark);
    }
    const before = last.filter((old) => old.isConnected);
    for (const box of boxes) {
      if (!box.hasAttribute(mark)) box.setAttribute(mark, '');
      let at = before.indexOf(box);
      if (at < 0) at = before.findIndex((old) => old.contains(box) || box.contains(old));
      if (at < 0) onBox?.(box);
      else before.splice(at, 1);
    }
    last = boxes;
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
