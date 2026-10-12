// Hide tab badges, as on Android: the red counts on the top bar's tabs and buttons and on the
// left column's rows, and the "(3)" Facebook puts in front of the browser tab's title.
//
// A badge is found by what it is, not by class names: an element in the top bar or a
// navigation region whose whole text is a count ("3", "9+", "99+") and that's drawn as a
// badge, which means floating (position absolute or fixed) or on a colored pill. The script
// marks the largest box around the count that holds nothing else and isn't the tab or button
// itself, and CSS hides the marks. So a group or Page whose name is a number stays.
//
// Live 2026-10-12 (the Messenger button with one unread chat): the red pill holds the count and
// a screen-reader line, "1 Unread Chats", in a 1 px clipped box, so the pill's text isn't the
// count alone. Text no one can see doesn't count when the walk compares an ancestor's text.

export const BADGE_MARK = 'data-hfw-badge';
const COUNT = /^\d{1,3}\+?$/;
const SCOPES = '[role="banner"], [role="navigation"]';
const INTERACTIVE = 'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"]';
const TITLE_COUNT = /^\(\d{1,3}\+?\)\s*/;

export const cleanTitle = (title) => String(title ?? '').replace(TITLE_COUNT, '');

const transparent = (color) => !color || color === 'transparent' || /^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(color);

function drawnAsBadge(element, view) {
  const style = view.getComputedStyle(element);
  return style.position === 'absolute' || style.position === 'fixed' || !transparent(style.backgroundColor);
}

// The usual visually hidden box: clipped to nothing, or a 1 px square that hides its overflow.
export function screenReaderOnly(element, view = element.ownerDocument.defaultView) {
  const style = view.getComputedStyle(element);
  if (/^rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)$/.test(style.clip ?? '') || style.clipPath === 'inset(50%)') return true;
  const tiny = (value) => parseFloat(value) <= 1;
  return style.position === 'absolute' && style.overflow === 'hidden' && tiny(style.width) && tiny(style.height);
}

// An element's text without what's only there for screen readers.
export function drawnText(element, view = element.ownerDocument.defaultView) {
  let text = '';
  for (const node of element.childNodes) {
    if (node.nodeType === 3) text += node.data;
    else if (node.nodeType === 1 && !screenReaderOnly(node, view)) text += drawnText(node, view);
  }
  return text;
}

// The box to hide around a count, or null when it isn't a badge.
export function badgeBox(leaf, view = leaf.ownerDocument.defaultView) {
  const count = leaf.textContent.trim();
  if (!COUNT.test(count) || leaf.closest(INTERACTIVE) === leaf) return null;
  let box = leaf;
  let badge = drawnAsBadge(leaf, view);
  for (let el = leaf.parentElement; el; el = el.parentElement) {
    if (el.matches(SCOPES) || el.matches(INTERACTIVE) || el.querySelector(INTERACTIVE)) break;
    // The cheap test first: most ancestors either hold the count alone or plainly hold more.
    const text = el.textContent.trim();
    if (text !== count && (!text.includes(count) || drawnText(el, view).trim() !== count)) break;
    box = el;
    badge ||= drawnAsBadge(el, view);
  }
  return badge ? box : null;
}

export function markBadges(doc) {
  const view = doc.defaultView;
  let marked = 0;
  for (const scope of doc.querySelectorAll(SCOPES)) {
    for (const leaf of scope.querySelectorAll('span, div')) {
      if (leaf.childElementCount || !COUNT.test(leaf.textContent.trim())) continue;
      const box = badgeBox(leaf, view);
      if (box && !box.hasAttribute(BADGE_MARK)) {
        box.setAttribute(BADGE_MARK, '');
        marked += 1;
      }
    }
  }
  return marked;
}

export function createBadgeHider({ doc, enabled, log, delay = 150 }) {
  let observer = null;
  let timer = null;
  let hidden = 0;

  const fixTitle = () => {
    const clean = cleanTitle(doc.title);
    if (clean !== doc.title) doc.title = clean;
  };
  const scan = () => {
    timer = null;
    try {
      hidden += markBadges(doc);
      fixTitle();
    } catch (error) {
      log?.error('Hide tab badges: looking for counts failed', error);
    }
  };
  const later = () => {
    if (!timer) timer = setTimeout(scan, delay);
  };

  function start() {
    if (observer || !doc.documentElement) return;
    const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    observer = new Observer((records) => {
      let title = false;
      let scope = false;
      for (const record of records) {
        const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (element?.closest('title')) title = true;
        else if (!scope && (element?.closest(SCOPES) || [...record.addedNodes].some((node) => node.nodeType === 1 && (node.matches(SCOPES) || node.querySelector(SCOPES))))) scope = true;
      }
      // The title is fixed at once, so "(3)" never shows for a moment.
      if (title) fixTitle();
      // The feed changes all the time; only changes in the top bar or a navigation region
      // (or a new one) bring a scan.
      if (scope) later();
    });
    observer.observe(doc.documentElement, { subtree: true, childList: true, characterData: true });
    scan();
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    if (timer) clearTimeout(timer);
    timer = null;
    for (const box of doc.querySelectorAll(`[${BADGE_MARK}]`)) box.removeAttribute(BADGE_MARK);
  }

  return {
    apply: () => (enabled() ? start() : stop()),
    scan,
    state: () => ({ running: Boolean(observer), hidden }),
  };
}

export default {
  id: 'hideTabBadges',
  section: 'appearance',
  android: 'Hide tab badges',
  title: 'Hide tab badges',
  description: "Hides the red counts on the top bar and left column, and the count in front of the browser tab's title. The notifications are still there when you open them.",
  default: false,
  css: `[${BADGE_MARK}] { display: none !important; }`,

  setup({ doc, settings, enabled, log, diagnostics }) {
    if (!doc) return;
    const hider = createBadgeHider({ doc, enabled, log });
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', () => hider.apply(), { once: true });
    else hider.apply();
    settings?.subscribe(() => hider.apply());
    diagnostics?.add('Counts hidden', () => (enabled() ? String(hider.state().hidden) : 'off'));
  },
};
