// Home opens on Facebook's own "most recent" feed. Same approach Social Fixer took: a
// redirect when Facebook opens on the plain Home URL, and Home links rewritten on click,
// since Facebook's router would otherwise draw the ranked feed in place.
//
// Confidence: ?sk=h_chr and the filter= values were documented working in 2025-02. They
// need a check on today's Facebook.

import { claimHomeRedirect, isPlainHome } from './start.js';

export { isPlainHome };

const GUARD_KEY = 'hfw:followingFeedRedirect';
const GUARD_MS = 15000;

export function followingFeedUrl(filter) {
  return `/?filter=${encodeURIComponent(filter)}&sk=h_chr`;
}

export default {
  id: 'followingFeed',
  section: 'opening',
  android: 'Following feed on Home',
  title: 'Following feed on Home',
  description: "Home shows the newest posts from the friends, groups and Pages you follow instead of Facebook's ranked feed.",
  default: false,
  options: [
    {
      key: 'filter',
      type: 'select',
      label: 'Show posts from',
      default: 'all',
      choices: [
        { value: 'all', label: 'Everyone you follow' },
        { value: 'friends', label: 'Friends' },
        { value: 'favorites', label: 'Favorites' },
        { value: 'groups', label: 'Groups' },
        { value: 'pages', label: 'Pages' },
      ],
    },
  ],

  setup({ win, enabled, option, log }) {
    const target = () => followingFeedUrl(option('filter'));

    // A guard in sessionStorage stops a redirect loop if Facebook ever sends us back to "/".
    // Marketplace only and Open on a chosen tab come first when they send this load elsewhere.
    if (enabled() && isPlainHome(win.location.href) && claimHomeRedirect(win, 'followingFeed')) {
      let recent;
      try {
        recent = Date.now() - Number(win.sessionStorage.getItem(GUARD_KEY) ?? 0) < GUARD_MS;
        win.sessionStorage.setItem(GUARD_KEY, String(Date.now()));
      } catch {
        recent = false;
      }
      if (recent) log.warn('Facebook sent Home back to its ranked feed, so the Following feed redirect stopped to avoid a loop');
      else win.location.replace(target());
    }

    win.addEventListener(
      'click',
      (event) => {
        if (!enabled() || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        const anchor = event.composedPath().find((node) => node?.tagName === 'A' && node.hasAttribute?.('href'));
        if (!anchor || !isPlainHome(anchor.href)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        win.location.assign(target());
      },
      { capture: true },
    );
  },
};
