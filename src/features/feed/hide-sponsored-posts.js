// Two layers. The data rules (ad-markers.js) take ads out of Facebook's data before it draws
// anything; they need the page, so they're off in content mode. The page check
// (sponsored-dom.js) hides whatever ad still gets drawn: a shape the data rules don't know,
// or everything in content mode.

import { adRule } from './ad-markers.js';
import { createLabelCache } from '../../core/dom/label-cache.js';
import { watchSponsoredPosts } from './sponsored-dom.js';

const ROWS_PER_SIGNAL_SHOWN = 5;
// Posts with an ad button and no readable label, before Diagnostics says the label check
// may be broken.
const UNREAD_BUTTONS_BEFORE_WARNING = 3;

function summary(counts) {
  const parts = [...counts].slice(0, ROWS_PER_SIGNAL_SHOWN).map(([name, n]) => `${name} ${n}`);
  return parts.length ? parts.join(', ') : 'None yet';
}

export default {
  id: 'hideSponsoredPosts',
  section: 'feed',
  android: 'Hide sponsored posts',
  title: 'Hide sponsored posts',
  description: 'Removes ads from the news feed before Facebook draws them, and hides any that get drawn anyway.',
  default: true,

  setup({ doc, net, posts, hider, log, settings, diagnostics, enabled }) {
    const data = new Map();
    const page = new Map();
    const unread = new WeakSet();
    let unreadCount = 0;
    let warnedPast = false;
    let warnedUnread = false;
    const changed = () => diagnostics?.changed();

    if (net) {
      net.transformResponses(adRule('hideSponsoredPosts', enabled, (fired) => {
        for (const id of fired) data.set(id, (data.get(id) ?? 0) + 1);
        changed();
      }, { diagnostics, reason: 'Sponsored' }));
    }
    if (!posts || !hider) return;

    // The cache watches the whole page, so it only runs while the switch is on.
    const labelCache = createLabelCache({ doc });
    if (enabled()) labelCache.start();
    const watcher = watchSponsoredPosts({
      posts,
      hider,
      enabled,
      labelCache,
      onAd({ signal, corroborated }) {
        page.set(signal, (page.get(signal) ?? 0) + 1);
        if (net && !warnedPast) {
          warnedPast = true;
          log.warn(`An ad got past the data rules and was hidden on the page instead (${signal}${corroborated ? ', with an ad button' : ''}). The data rules may need an update.`);
        }
        changed();
      },
      onAdButton(element) {
        if (unread.has(element)) return;
        unread.add(element);
        unreadCount++;
        if (!warnedUnread && unreadCount >= UNREAD_BUTTONS_BEFORE_WARNING && page.size === 0) {
          warnedUnread = true;
          log.warn(`${unreadCount} posts had an ad button but no ad label the script could read. Facebook may have changed how it marks ads.`);
        }
        changed();
      },
    });

    let on = enabled();
    settings.subscribe(() => {
      if (enabled() === on) return;
      on = enabled();
      if (on) {
        labelCache.start();
        watcher.recheckAll();
      } else {
        labelCache.stop();
        hider.showAll('Sponsored');
      }
    });

    // Rule ids and the script's own signal names, so Copy report can carry them.
    diagnostics?.add('Ads taken out of the data', () => (net ? summary(data) : "Off: the script can't reach the page's data"), { shareable: true });
    diagnostics?.add('Ads hidden on the page', () => summary(page), { shareable: true });
    diagnostics?.add('Posts with an ad button and no readable label', () => String(unreadCount));
  },
};
