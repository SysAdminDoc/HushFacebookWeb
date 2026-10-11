// Show View profile on Marketplace sellers, as Hushfacebook does on Android. A listing's seller
// box links the seller's picture and name to their Marketplace profile, /marketplace/profile/<id>/,
// and that id is their Facebook id (live 2026-10-11, captures/2026-10-11-run4 seller), so a View
// profile link to /profile.php?id=<id> goes right after the name.
//
// The name link is the one whose words match the picture link's label, which works in any
// language and passes over Facebook's own Seller details link to the same place. Only listings
// get the link, whether opened on their own page or over Marketplace. Works in content mode.

import { normalizeText } from '../../core/dom/visible-text.js';

export const MARK = 'data-hfw-seller-profile';
export const LABEL = 'View profile';
const PROFILE_LINKS = 'a[href*="/marketplace/profile/"]';
const DELAY = 100;

export const SELLER_PROFILE_CSS = `
a[${MARK}] {
  display: inline-block !important;
  margin-inline-start: 8px !important;
  color: var(--blue-link, #0866ff) !important;
  font-size: .9375rem !important;
  font-weight: 400 !important;
  white-space: nowrap !important;
  text-decoration: none !important;
}
a[${MARK}]:hover, a[${MARK}]:focus-visible { text-decoration: underline !important; }`;

// The seller's id in a Marketplace profile link, or null.
export function sellerId(href, base) {
  try {
    const url = new URL(href, base);
    if (!/(^|\.)facebook\.com$/.test(url.hostname)) return null;
    return url.pathname.match(/^\/marketplace\/profile\/(\d+)\/?$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function isListing(href) {
  try {
    return /^\/marketplace\/item\/\d+/.test(new URL(href).pathname);
  } catch {
    return false;
  }
}

export const profileUrl = (id) => `/profile.php?id=${id}`;

// Each seller's name link: the first profile link whose text is the label on another link to the
// same seller, their picture. The picture link itself never counts, even when it carries the name
// as hidden text too.
export function nameLinks(root, base) {
  const byId = new Map();
  for (const link of root.querySelectorAll(PROFILE_LINKS)) {
    const id = sellerId(link.getAttribute('href'), base);
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(link);
  }
  const found = [];
  for (const [id, links] of byId) {
    const labels = links.map((link) => normalizeText(link.getAttribute('aria-label') ?? ''));
    const name = links.find((link, index) => {
      const text = normalizeText(link.textContent);
      return text && labels.some((label, other) => other !== index && label === text);
    });
    if (name) found.push({ id, link: name });
  }
  return found;
}

// Puts a View profile link after the name, or points the one already there at this seller when
// Facebook reused the name for another listing. True when a link was added.
export function addProfileLink(doc, { id, link }) {
  const next = link.nextElementSibling;
  if (next?.hasAttribute(MARK)) {
    if (next.getAttribute(MARK) !== id) {
      next.setAttribute(MARK, id);
      next.setAttribute('href', profileUrl(id));
    }
    return false;
  }
  const view = doc.createElement('a');
  view.setAttribute(MARK, id);
  view.setAttribute('href', profileUrl(id));
  view.setAttribute('role', 'link');
  view.textContent = LABEL;
  link.after(view);
  return true;
}

// Times one listing's seller gets the link put back before the script leaves it, in case the page
// keeps taking it away.
export const MAX_ADDS = 20;

export function createSellerLinks({ doc, enabled, setTimer = (fn, ms) => setTimeout(fn, ms) }) {
  let added = 0;
  let timer = null;
  let shown = false; // a View profile link is on the page
  let listing = '';
  let addsFor = new Map(); // seller id -> links added on this listing

  const href = () => doc.location?.href ?? '';
  const wanted = () => enabled() && isListing(href());

  function sync() {
    timer = null;
    if (!wanted()) {
      for (const link of doc.querySelectorAll(`a[${MARK}]`)) link.remove();
      shown = false;
      return;
    }
    if (href() !== listing) {
      listing = href();
      addsFor = new Map();
    }
    for (const found of nameLinks(doc, listing)) {
      const adds = addsFor.get(found.id) ?? 0;
      if (adds >= MAX_ADDS) continue;
      if (addProfileLink(doc, found)) {
        added++;
        addsFor.set(found.id, adds + 1);
      }
    }
    shown = Boolean(doc.querySelector(`a[${MARK}]`));
  }

  const schedule = () => {
    timer ??= setTimer(sync, DELAY);
  };

  return {
    start() {
      const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
      // Off listings, page changes cost a look at the address and nothing more.
      new Observer(() => {
        if (shown || wanted()) schedule();
      }).observe(doc.body, { childList: true, subtree: true });
      sync();
    },
    sync,
    schedule,
    added: () => added,
  };
}

export default {
  id: 'sellerProfileLink',
  section: 'marketplace',
  android: 'Show View profile on Marketplace sellers',
  title: 'View profile on Marketplace sellers',
  description: "Adds a View profile link after the seller's name on a listing, so you can see their full Facebook profile before you message them, not just their Marketplace page.",
  default: true,
  css: SELLER_PROFILE_CSS,

  setup({ doc, router, settings, diagnostics, enabled }) {
    const links = createSellerLinks({ doc, enabled });
    diagnostics?.add('Seller profile links added', () => String(links.added()));
    const begin = () => links.start();
    if (doc.body) begin();
    else doc.addEventListener('DOMContentLoaded', begin, { once: true });
    router?.subscribe(() => links.schedule());
    settings?.subscribe(() => links.schedule());
  },
};
