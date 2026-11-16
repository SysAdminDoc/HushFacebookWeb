// Show View profile on Marketplace sellers, as Hushfacebook does on Android. A listing's seller
// box links the seller's picture and name to their Marketplace profile, /marketplace/profile/<id>/,
// and that id is their Facebook id (live 2026-10-11, captures/2026-10-11-run4 seller), so a View
// profile link to /profile.php?id=<id> goes right after the name.
//
// The name link is the one whose words match the picture link's label, which works in any
// language and passes over Facebook's own Seller details link to the same place. Only listings
// get the link, whether opened on their own page or over Marketplace. Works in content mode.
//
// A listing loaded from its own address comes with the seller box drawn on the server, and React
// takes that markup over a moment later. A node put into it first made React throw #418 and draw
// the page again (live 2026-11-15: 2 of 4 loads with Facebook's scripts held back 2.5 s, 0 of 2
// with the switch off). So the link never joins Facebook's nodes. It sits in a shadow root on the
// name's box, after a slot that shows the box's own children as before. React only walks those
// children, so it finds what the server drew.

import { normalizeText } from '../../core/dom/visible-text.js';
import { whenBodyReady } from '../../core/env.js';

export const MARK = 'data-hfw-seller-profile';
// On the name's box while it shows a link. Attributes are safe there: React's check compares
// nodes and text, not attributes.
export const HOST_MARK = 'data-hfw-seller-host';
const SLOT_MARK = 'data-hfw-seller-slot';
// The script's own, like its other elements, so Hide parts doesn't take the link for Facebook's.
const OWN_MARK = 'data-hushfacebook-web';
const OWN_NAME = 'seller-profile';
export const LABEL = 'View profile';
const PROFILE_LINKS = 'a[href*="/marketplace/profile/"]';
const DELAY = 100;

// Styles the link inside its shadow root, which page CSS doesn't reach. Facebook's color
// variables still do, since custom properties inherit.
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
// same seller, their picture. A link with a label of its own is a picture and never counts, even
// when it carries the name as hidden text too (live, the name link has no label).
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
      if (labels[index]) return false;
      const text = normalizeText(link.textContent);
      return text && labels.some((label, other) => other !== index && label === text);
    });
    if (name) found.push({ id, link: name });
  }
  return found;
}

// The shadow root on a name's box: the one put there before (by this copy of the script or an
// earlier one), a new one, or null when the box can't take one or has someone else's.
function shadowFor(doc, box) {
  const existing = box.shadowRoot;
  if (existing) return existing.querySelector(`slot[${SLOT_MARK}]`) ? existing : null;
  let root;
  try {
    root = box.attachShadow({ mode: 'open' });
  } catch {
    return null;
  }
  const style = doc.createElement('style');
  style.textContent = SELLER_PROFILE_CSS;
  const slot = doc.createElement('slot');
  slot.setAttribute(SLOT_MARK, '');
  root.append(style, slot);
  return root;
}

// The View profile link shown on a name's box, or null.
export const shownLink = (box) => box?.shadowRoot?.querySelector(`a[${MARK}]`) ?? null;

// Takes a box's link away. The shadow root stays, holding only the slot, which shows the box's
// children just as they'd be without it.
export function removeProfileLink(box) {
  shownLink(box)?.remove();
  box.removeAttribute(HOST_MARK);
}

// Puts a View profile link after the name, or points the one already there at this seller when
// Facebook reused the name for another listing. True when a link was added. It follows everything
// in the name's box, which live holds the name link alone.
export function addProfileLink(doc, { id, link }) {
  const box = link.parentElement;
  const root = box && shadowFor(doc, box);
  if (!root) return false;
  const shown = shownLink(box);
  if (shown) {
    if (shown.getAttribute(MARK) !== id) {
      shown.setAttribute(MARK, id);
      shown.setAttribute('href', profileUrl(id));
    }
    // A link an earlier version added without it.
    if (!shown.hasAttribute(OWN_MARK)) shown.setAttribute(OWN_MARK, OWN_NAME);
    return false;
  }
  const view = doc.createElement('a');
  view.setAttribute(MARK, id);
  view.setAttribute(OWN_MARK, OWN_NAME);
  view.setAttribute('href', profileUrl(id));
  view.setAttribute('role', 'link');
  view.textContent = LABEL;
  root.append(view);
  box.setAttribute(HOST_MARK, '');
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
      for (const box of doc.querySelectorAll(`[${HOST_MARK}]`)) removeProfileLink(box);
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
    shown = Boolean(doc.querySelector(`[${HOST_MARK}]`));
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
  description: "Adds a View profile link after the seller's name on a listing. It opens their full Facebook profile, not just their Marketplace page, so you can see it before you message them.",
  default: true,

  setup({ doc, router, settings, diagnostics, enabled }) {
    const links = createSellerLinks({ doc, enabled });
    diagnostics?.add('Seller profile links added', () => String(links.added()));
    const begin = () => links.start();
    whenBodyReady(begin, doc);
    router?.subscribe(() => links.schedule());
    settings?.subscribe(() => links.schedule());
  },
};
