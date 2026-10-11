// Open on a chosen tab, as on Android: Facebook opens on the page you pick when you start it, so
// you can skip the feed. Starting means the first Facebook page in a browser tab, and only when
// that page is Home. A link into Facebook opens where it leads, and a reload, Back or a click on
// Home later in the visit finds Home as usual. Works in content mode.
//
// Every address was loaded live on 2026-10-11 (captures/2026-10-11-run3). Messages isn't a
// choice, since Facebook can open the newest chat there.

import { followingFeedUrl } from './following-feed.js';
import { claimHomeRedirect, isPlainHome, isVisitStart } from './start.js';

export const TABS = [
  { value: 'marketplace', label: 'Marketplace', path: '/marketplace/' },
  { value: 'feeds', label: 'Feeds, newest posts first', path: followingFeedUrl('all') },
  { value: 'video', label: 'Video', path: '/watch/' },
  { value: 'friends', label: 'Friends', path: '/friends/' },
  { value: 'groups', label: 'Your groups feed', path: '/groups/feed/' },
  { value: 'notifications', label: 'Notifications', path: '/notifications/' },
  { value: 'menu', label: 'Menu', path: '/bookmarks/' },
];

// Feeds follows Following feed on Home's choice of posts while that's on.
export function startPath(tab, settings) {
  if (tab === 'feeds' && settings?.enabled('followingFeed')) return followingFeedUrl(settings.get('followingFeed.filter') ?? 'all');
  return (TABS.find((entry) => entry.value === tab) ?? TABS[0]).path;
}

export default {
  id: 'openOnTab',
  section: 'opening',
  android: 'Open on a chosen tab',
  title: 'Open on a chosen tab',
  description: 'Facebook opens on the page you pick instead of Home when you start it in a new tab, so you can skip the feed. Links into Facebook still open where they lead, and Home is still there when you click it.',
  default: false,
  options: [
    { key: 'tab', type: 'select', label: 'Open on', default: 'marketplace', choices: TABS.map(({ value, label }) => ({ value, label })) },
  ],

  setup({ win, settings, enabled, option, log }) {
    // Asked on every load, so the visit is marked even while the switch is off.
    const start = isVisitStart(win);
    if (!start || !enabled() || !isPlainHome(win.location.href) || !claimHomeRedirect(win, 'openOnTab')) return;
    const path = startPath(option('tab'), settings);
    log?.info(`Open on a chosen tab: this visit starts on ${path}`);
    win.location.replace(path);
  },
};
