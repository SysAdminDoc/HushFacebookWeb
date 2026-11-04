// Hides Marketplace listings and ads on the page, for the ones Facebook drew on the server. Those
// stay in the page's own data, since React hydrates them from it and throws #418 when one is
// missing (live 2026-11-03 on search, and on categories for ads), so their cards are marked here
// and hidden by CSS instead.

import { whenRootReady } from '../../core/env.js';

export const LISTING_MARK = 'data-hfw-filtered-listing';
export const LISTING_CSS = `html[data-hfw-route="marketplace"] [${LISTING_MARK}] { display: none !important; }`;
export const AD_MARK = 'data-hfw-sponsored-listing';
export const AD_CSS = `html[data-hfw-route="marketplace"] [${AD_MARK}] { display: none !important; }`;

const LISTING_LINK = 'a[href*="/marketplace/item/"]';
const LINKS = `[role="main"] ${LISTING_LINK}`;
// Live 2026-11-03, a drawn ad's card links to its advertiser through l.facebook.com and to
// /ads/about/, has no listing link, and has no Sponsored text.
const AD_LINKS = '[role="main"] a[href*="/ads/about/"]';
const ITEM = /\/marketplace\/item\/(\d+)/;

export const itemId = (link) => link.getAttribute('href')?.match(ITEM)?.[1] ?? null;

// The card a listing's link sits in: the largest box around the link that holds no other
// listing. Null when there's nothing else to tell it from before the main column.
export function listingCard(link, id) {
  let card = link;
  for (let parent = card.parentElement; parent && parent.getAttribute('role') !== 'main'; parent = parent.parentElement) {
    for (const other of parent.querySelectorAll(LISTING_LINK)) {
      if (itemId(other) !== id) return card;
    }
    card = parent;
  }
  return null;
}

// The card an ad's /ads/about/ link sits in: the largest box around it that holds no listing and
// no page title. On the results that's a cell of the grid. On a listing's own page (live
// 2026-11-03) it's the ad box under the listing's details, whose column holds the h1. Null when
// neither bounds it before the main column.
export function adCard(link) {
  let card = link;
  for (let parent = card.parentElement; parent && parent.getAttribute('role') !== 'main'; parent = parent.parentElement) {
    if (parent.querySelector(`${LISTING_LINK}, h1`)) return card;
    card = parent;
  }
  return null;
}

// Marketplace's home, search and categories. A listing's own page shows its seller's other
// listings, and the one you opened isn't a card there.
export const listingPage = (route) => route?.type === 'marketplace' && !/^\/marketplace\/item\//.test(route.path ?? '');
const marketplacePage = (route) => route?.type === 'marketplace';

// Sets mark on every card that cardsOf() gives as [card, id, reason], once per frame of changes,
// and takes it off the ones it no longer gives, on the pages page(route) says yes to. active()
// says there may be something to hide. onHidden(id, reason, card) runs each time a card gets
// its mark, or keeps it for another id.
function watchCards({ doc, route, page, active, mark, cardsOf, onHidden }) {
  let queued = false;
  // The id each marked card was hidden for: a reused card can show another listing that's
  // hidden for the same reason.
  const ids = new WeakMap();
  const check = () => {
    queued = false;
    if (!page(route())) return;
    const wanted = new Set();
    if (active()) {
      for (const [card, id, reason] of cardsOf()) {
        if (!card || wanted.has(card)) continue;
        wanted.add(card);
        if (card.getAttribute(mark) === reason && ids.get(card) === id) continue;
        card.setAttribute(mark, reason);
        ids.set(card, id);
        onHidden?.(id, reason, card);
      }
    }
    for (const marked of doc.querySelectorAll(`[${mark}]`)) {
      if (!wanted.has(marked)) marked.removeAttribute(mark);
    }
  };
  const view = doc.defaultView;
  const frame = view?.requestAnimationFrame ? (fn) => view.requestAnimationFrame(fn) : (fn) => setTimeout(fn, 16);
  const Observer = view?.MutationObserver ?? globalThis.MutationObserver;
  const observer = new Observer(() => {
    if (queued || !active() || !page(route())) return;
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

// Marks the card of every listing that reasonOf(id) names a reason for. onHidden(id, reason).
export function watchListingCards({ doc, route, active, reasonOf, onHidden }) {
  return watchCards({
    doc,
    route,
    page: listingPage,
    active,
    onHidden,
    mark: LISTING_MARK,
    cardsOf: () => [...doc.querySelectorAll(LINKS)].flatMap((link) => {
      const id = itemId(link);
      const reason = id && reasonOf(id);
      return reason ? [[listingCard(link, id), id, reason]] : [];
    }),
  });
}

// Marks the card of every ad on Marketplace, a listing's own page included. onHidden(card).
export function watchAdCards({ doc, route, active, onHidden }) {
  return watchCards({
    doc,
    route,
    page: marketplacePage,
    active,
    onHidden: onHidden && ((id, reason, card) => onHidden(card)),
    mark: AD_MARK,
    cardsOf: () => [...doc.querySelectorAll(AD_LINKS)].map((link) => [adCard(link), null, 'sponsored']),
  });
}
