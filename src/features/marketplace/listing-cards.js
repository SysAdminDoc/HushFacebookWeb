// Hides Marketplace listings on the page, for the ones Facebook drew on the server. Those stay in
// the page's own data, since React hydrates them from it and throws #418 when one is missing
// (live 2026-11-03 on search), so their cards are marked here and hidden by CSS instead.

import { whenRootReady } from '../../core/env.js';

export const LISTING_MARK = 'data-hfw-filtered-listing';
export const LISTING_CSS = `html[data-hfw-route="marketplace"] [${LISTING_MARK}] { display: none !important; }`;

const LINKS = '[role="main"] a[href*="/marketplace/item/"]';
const ITEM = /\/marketplace\/item\/(\d+)/;

export const itemId = (link) => link.getAttribute('href')?.match(ITEM)?.[1] ?? null;

// The card a listing's link sits in: the largest box around the link that holds no other
// listing. Null when there's nothing else to tell it from before the main column.
export function listingCard(link, id) {
  let card = link;
  for (let parent = card.parentElement; parent && parent.getAttribute('role') !== 'main'; parent = parent.parentElement) {
    for (const other of parent.querySelectorAll('a[href*="/marketplace/item/"]')) {
      if (itemId(other) !== id) return card;
    }
    card = parent;
  }
  return null;
}

// Marketplace's home, search and categories. A listing's own page shows its seller's other
// listings, and the one you opened isn't a card there.
export const listingPage = (route) => route?.type === 'marketplace' && !/^\/marketplace\/item\//.test(route.path ?? '');

// Marks the card of every listing that reasonOf(id) names a reason for, once per frame of
// changes, and unmarks the ones it no longer does. active() says there may be something to
// hide. onHidden(id, reason) runs each time a card gets its mark.
export function watchListingCards({ doc, route, active, reasonOf, onHidden }) {
  let queued = false;
  const check = () => {
    queued = false;
    if (!listingPage(route())) return;
    const wanted = new Set();
    if (active()) {
      for (const link of doc.querySelectorAll(LINKS)) {
        const id = itemId(link);
        const reason = id && reasonOf(id);
        const card = reason ? listingCard(link, id) : null;
        if (!card || wanted.has(card)) continue;
        wanted.add(card);
        if (card.getAttribute(LISTING_MARK) === reason) continue;
        card.setAttribute(LISTING_MARK, reason);
        onHidden?.(id, reason);
      }
    }
    for (const marked of doc.querySelectorAll(`[${LISTING_MARK}]`)) {
      if (!wanted.has(marked)) marked.removeAttribute(LISTING_MARK);
    }
  };
  const view = doc.defaultView;
  const frame = view?.requestAnimationFrame ? (fn) => view.requestAnimationFrame(fn) : (fn) => setTimeout(fn, 16);
  const Observer = view?.MutationObserver ?? globalThis.MutationObserver;
  const observer = new Observer(() => {
    if (queued || !active() || !listingPage(route())) return;
    queued = true;
    frame(check);
  });
  whenRootReady(() => {
    // A card Facebook reuses for another listing keeps its element and gets a new link.
    observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
    check();
  }, doc);
  return {
    check,
    stop: () => observer.disconnect(),
  };
}
