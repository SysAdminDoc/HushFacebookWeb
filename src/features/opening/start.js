// Where a Home load goes, when a feature wants it somewhere else. Marketplace only sends every
// Home load to Marketplace, Open on a chosen tab sends the first page of a visit to its tab, and
// Following feed on Home sends Home to the newest-first feed. They set up in that order (see
// features/index.js), and the first to claim a load is the one that redirects it, since a
// second location.replace in the same moment would cancel the first.

import { parseRoute } from '../../core/route.js';

const CLAIM = Symbol.for('hushfacebook-web.home-redirect');
const START = Symbol.for('hushfacebook-web.visit-start');
const STARTED_KEY = 'hfw:started';

// True for a plain Home URL: path "/" (or home.php) and no query, on www or web.facebook.com.
export function isPlainHome(href) {
  const url = new URL(href);
  return /^(www|web)\.facebook\.com$/.test(url.hostname) && parseRoute(href).type === 'home' && url.search === '';
}

// Runs a start-of-page decision once the saved choices are in (settings.whenLoaded). They are
// at once in a userscript; the extension's arrive a few milliseconds after the page starts.
export const onceLoaded = (settings, run) => (settings?.whenLoaded ? settings.whenLoaded(run) : run());

// Claims this page load's Home redirect for a feature. False when another feature has it.
export function claimHomeRedirect(win, id) {
  if (win[CLAIM] && win[CLAIM] !== id) return false;
  win[CLAIM] = id;
  return true;
}

export const homeRedirectClaim = (win) => win[CLAIM] ?? null;

// The link a click opens in this tab, or null when the click asks for something else: another
// button or a modifier key (a new tab or window, a download), a target other than _self, or a
// download link. Only a click like that may be sent somewhere other than where the link goes.
export function sameTabLink(event) {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return null;
  const anchor = event.composedPath().find((node) => node?.tagName === 'A' && node.hasAttribute?.('href'));
  if (!anchor || anchor.hasAttribute('download')) return null;
  const target = anchor.getAttribute('target')?.trim().toLowerCase();
  return !target || target === '_self' ? anchor : null;
}

// Whether this page is the first Facebook page in the browser tab, opened fresh rather than by
// a reload or Back. The answer is the same for every feature that asks during one page load,
// and the next load in the tab is never a start. A tab Facebook opened from one of its own
// links carries the mark over, so it isn't a start either. Without session storage nothing
// counts as a start, so nobody gets sent somewhere every time.
export function isVisitStart(win) {
  if (win[START] !== undefined) return win[START];
  let start;
  try {
    start = !win.sessionStorage.getItem(STARTED_KEY);
    win.sessionStorage.setItem(STARTED_KEY, '1');
  } catch {
    start = false;
  }
  const entry = win.performance?.getEntriesByType?.('navigation')?.[0];
  if (entry && entry.type !== 'navigate') start = false;
  win[START] = start;
  return start;
}
