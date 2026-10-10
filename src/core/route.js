// Facebook is a single-page app, so "which page am I on" changes without a load. The route
// is parsed from the URL and stamped on <html> (data-hfw-route, data-hfw-permalink) so CSS
// features can scope themselves to one kind of page. Attributes on <html> are safe; writes
// on the feed's own children are not (they've been seen to stall infinite scroll).

const ROUTE_TYPES = {
  '': 'home',
  marketplace: 'marketplace',
  groups: 'groups',
  watch: 'watch',
  reel: 'reel',
  reels: 'reel',
  stories: 'stories',
  messages: 'messages',
  notifications: 'notifications',
  search: 'search',
  friends: 'friends',
  gaming: 'gaming',
  events: 'events',
  photo: 'photo',
  'photo.php': 'photo',
  photos: 'photo',
  'permalink.php': 'post',
  'story.php': 'post',
  'profile.php': 'profile',
  settings: 'settings',
  saved: 'saved',
  hashtag: 'hashtag',
  feeds: 'feeds',
  bookmarks: 'menu',
};

export function parseRoute(href) {
  const url = new URL(href);
  const parts = url.pathname.split('/').filter(Boolean);
  const type = ROUTE_TYPES[parts[0] ?? ''] ?? 'profile';
  const permalink =
    /\/posts\/(?:\d+|pfbid0\w+)/.test(url.pathname) ||
    /^\/(?:permalink|story)\.php$/.test(url.pathname) ||
    /^\/groups\/[^/]+\/(?:posts|permalink)\/[^/]+/.test(url.pathname) ||
    url.searchParams.has('multi_permalinks') ||
    url.searchParams.get('view') === 'permalink';
  return { href: url.href, type, permalink, path: url.pathname, feed: url.searchParams.get('sk') ?? '' };
}

// In page mode history.pushState/replaceState are wrapped. A content script can't see the
// page's history calls, so it compares location.href on a timer instead.
export function createRouter({ win, pageAccess, log, pollMs = 500 }) {
  const listeners = new Set();
  let current = parseRoute(win.location.href);

  const stamp = () => {
    const root = win.document?.documentElement;
    if (!root) return;
    root.dataset.hfwRoute = current.type;
    root.dataset.hfwPermalink = String(current.permalink);
  };

  const check = () => {
    if (win.location.href === current.href) return;
    current = parseRoute(win.location.href);
    stamp();
    for (const listener of listeners) {
      try {
        listener(current);
      } catch (error) {
        log?.error('A page-change listener failed', error);
      }
    }
  };

  if (pageAccess === 'page') {
    for (const name of ['pushState', 'replaceState']) {
      const original = win.history[name];
      win.history[name] = function () {
        const result = original.apply(this, arguments);
        check();
        return result;
      };
    }
    win.addEventListener('popstate', check);
  } else {
    win.setInterval(check, pollMs);
  }
  win.addEventListener('hashchange', check);
  stamp();

  return {
    current: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
