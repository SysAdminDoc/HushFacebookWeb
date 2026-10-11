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

const OTHER_TABS = ['a[href="/"]', ...TAB_ROWS.filter((row) => row.option !== 'marketplace').map((row) => row.link)].join(', ');
// The feed stays out of sight for the moment it takes to leave Home.
export const MARKETPLACE_ONLY_CSS = [
  hide([place.tab(OTHER_TABS), FIND_FRIENDS].join(',\n')),
  'html[data-hfw-route="home"] [role="main"] { visibility: hidden !important; }',
].join('\n');

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

  setup({ win, router, enabled }) {
    if (enabled() && isHome(win.location.href) && claimHomeRedirect(win, 'marketplaceOnly')) {
      win.location.replace(MARKETPLACE);
    }

    // Before Following feed's own Home click handler, which it keeps from running.
    win.addEventListener('click', (event) => {
      if (!enabled() || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor = event.composedPath().find((node) => node?.tagName === 'A' && node.hasAttribute?.('href'));
      if (!anchor || !isHome(anchor.href)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      goToMarketplace(win);
    }, { capture: true });

    // Facebook moving to Home by itself, or Back to a Home page. Replaced, so Back doesn't land
    // on Home again and bounce.
    router?.subscribe((route) => {
      if (enabled() && route.type === 'home') win.location.replace(MARKETPLACE);
    });
  },
};
