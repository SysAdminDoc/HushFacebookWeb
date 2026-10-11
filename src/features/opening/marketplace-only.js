// Marketplace only, as on Android: Facebook as a Marketplace app for buying and selling, without
// the feed. Facebook opens on Marketplace, and Home goes to Marketplace whenever it would load,
// whether by its address, a click on the logo or the Home tab, or Facebook moving there itself.
// The top bar keeps the Marketplace tab and the Menu, Messenger, Notifications and profile
// buttons, and the other tabs and Find friends go. Links to anything else (a seller's profile, a
// chat, a notification) still open where they lead. Works in content mode.
//
// Live 2026-10-11: the logo and the Home tab are both a[href="/"] in the top bar, the tab inside
// an li of the tab list and the logo outside it. This account's top bar has no Marketplace tab,
// so the left column's Marketplace row is the in-page way there, and a plain load the fallback.

import { parseRoute } from '../../core/route.js';
import { FIND_FRIENDS, HOSTS, TAB_ROWS, hide, place } from '../appearance/declutter-table.js';
import { claimHomeRedirect } from './start.js';

export const MARKETPLACE = '/marketplace/';
const MARKETPLACE_LINKS = ['[role="banner"] a[href="/marketplace/"]', ...HOSTS.map((host) => `[role="navigation"] a[href^="${host}/marketplace/"]`)].join(', ');
// Set on <html> while the script has stopped sending Home away (see mayRedirect).
export const LOOP_MARK = 'data-hfw-marketplace-loop';
const GUARD_KEY = 'hfw:marketplaceOnlyGuard';
export const BOUNCE_MS = 60000; // back on Home this soon after a send, with no input, is a bounce
export const MAX_BOUNCES = 4;
export const STOP_MS = 10 * 60000; // how long the script leaves Home alone after a loop

const OTHER_TABS = ['a[href="/"]', ...TAB_ROWS.filter((row) => row.option !== 'marketplace').map((row) => row.link)].join(', ');
// The feed stays out of sight for the moment it takes to leave Home.
export const MARKETPLACE_ONLY_CSS = [
  hide([place.tab(OTHER_TABS), FIND_FRIENDS].join(',\n')),
  `html[data-hfw-route="home"]:not([${LOOP_MARK}]) [role="main"] { visibility: hidden !important; }`,
].join('\n');

function readGuard(storage) {
  try {
    const guard = JSON.parse(storage.getItem(GUARD_KEY) ?? '{}');
    return guard && typeof guard === 'object' ? guard : {};
  } catch {
    return {};
  }
}

// False when going to Marketplace again would loop. Each send is noted with its time. Landing on
// Home again within a minute, with no click or key press on a page in between, is a bounce:
// Marketplace sending the tab back, as it does for an account it isn't open to. However slow
// each round is, the fourth bounce in a row stops the sends for ten minutes in this tab. Without
// session storage there's no count to keep, so it always goes.
export function mayRedirect(win, now = Date.now()) {
  try {
    const storage = win.sessionStorage;
    const guard = readGuard(storage);
    if (Number.isFinite(guard.stopped) && now - guard.stopped >= 0 && now - guard.stopped < STOP_MS) return false;
    const bounced = Number.isFinite(guard.sent) && now - guard.sent >= 0 && now - guard.sent < BOUNCE_MS;
    const bounces = bounced ? (Number(guard.bounces) || 0) + 1 : 0;
    if (bounces >= MAX_BOUNCES) {
      storage.setItem(GUARD_KEY, JSON.stringify({ stopped: now }));
      return false;
    }
    storage.setItem(GUARD_KEY, JSON.stringify({ sent: now, bounces }));
    return true;
  } catch {
    return true;
  }
}

// A click or key press means a person is using the page, so a later Home isn't a bounce. A loop
// that has already stopped stays stopped.
export function noteInput(win) {
  try {
    const guard = readGuard(win.sessionStorage);
    if (Number.isFinite(guard.sent)) win.sessionStorage.removeItem(GUARD_KEY);
  } catch {
    // Nothing kept, nothing to clear.
  }
}

const isHome = (href) => {
  try {
    const url = new URL(href);
    return /^(www|web)\.facebook\.com$/.test(url.hostname) && parseRoute(href).type === 'home';
  } catch {
    return false;
  }
};

// To Marketplace without a reload when there's a Marketplace link to click, else by address.
export function goToMarketplace(win) {
  const link = win.document.querySelector(MARKETPLACE_LINKS);
  if (link) link.click();
  else win.location.assign(MARKETPLACE);
}

export default {
  id: 'marketplaceOnly',
  section: 'opening',
  android: 'Marketplace only',
  title: 'Marketplace only',
  description: 'Turns Facebook into Marketplace for buying and selling, without the feed. Facebook opens on Marketplace, Home takes you there too, and the top bar keeps only Marketplace and its buttons. Profiles, chats and notifications still open. While this is on, Open on a chosen tab waits.',
  default: false,
  css: MARKETPLACE_ONLY_CSS,

  setup({ win, router, enabled, log }) {
    let warned = false;
    const leaveHome = () => {
      if (mayRedirect(win)) {
        win.location.replace(MARKETPLACE);
        return;
      }
      win.document?.documentElement?.setAttribute(LOOP_MARK, '');
      if (warned) return;
      warned = true;
      log?.warn('Marketplace only stopped sending Home to Marketplace for a while, because Marketplace keeps sending this tab back. It may not be open to this account.');
    };

    if (enabled() && isHome(win.location.href) && claimHomeRedirect(win, 'marketplaceOnly')) leaveHome();

    // Once per page is enough to start the bounce count over.
    let counting = true;
    const onInput = (event) => {
      if (!counting || !event.isTrusted || !enabled() || isHome(win.location.href)) return;
      counting = false;
      noteInput(win);
    };
    win.addEventListener('pointerdown', onInput, { capture: true, passive: true });
    win.addEventListener('keydown', onInput, { capture: true, passive: true });

    // Before Following feed's own Home click handler, which it keeps from running. A link meant
    // for a new tab or window opens there, and that page's own load goes to Marketplace.
    win.addEventListener('click', (event) => {
      if (!enabled() || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor = event.composedPath().find((node) => node?.tagName === 'A' && node.hasAttribute?.('href'));
      if (!anchor || !isHome(anchor.href)) return;
      const target = anchor.getAttribute('target');
      if ((target && target !== '_self') || anchor.hasAttribute('download')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      goToMarketplace(win);
    }, { capture: true });

    // Facebook moving to Home by itself, or Back to a Home page. Replaced, so Back doesn't land
    // on Home again and bounce.
    // Off Home the mark goes, so a later Home hides the feed again while it leaves.
    router?.subscribe((route) => {
      if (route.type !== 'home') win.document?.documentElement?.removeAttribute(LOOP_MARK);
      else if (enabled()) leaveHome();
    });
  },
};
