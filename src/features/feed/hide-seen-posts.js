// Hide seen posts, as Hushfacebook's patch does on Android: posts you've already scrolled past
// on Home and in your groups feed stay away for the days you pick.
//
// A post counts as seen once it's been on screen for a second and then leaves (see
// core/dom/seen-watch.js). It's remembered by its photo or video, or by its first words (see
// core/seen-keys.js), in the manager's storage (see core/seen-store.js). Posts you see during
// a visit stay where they are, so nothing vanishes when you scroll back up. From the next
// visit on they're taken out of Facebook's data before they're drawn in page mode, and hidden
// on the page otherwise. "Show seen posts in this tab" lets them all back for the tab.

import { walk, SKIP } from '../../core/json-walk.js';
import { watchPostChecks } from '../../core/dom/post-checks.js';
import { watchSeen } from '../../core/dom/seen-watch.js';
import { pageKeys, storyKeys } from '../../core/seen-keys.js';
import { createSeenStore } from '../../core/seen-store.js';
import { inScope } from './ad-markers.js';
import { FILTERED } from './filters.js';

const DAY = 24 * 60 * 60 * 1000;
const DAYS = [1, 3, 7, 30];
export const SHOW_KEY = 'hfw.showSeen';

// What a seen key says matched, for the Diagnostics decision list.
const matchedBy = (key) => (key.startsWith('m:') ? 'same photo or video' : 'same text');

// Drops every feed story in doc that has a seen key. Returns how many went. report(story,
// key) hears each one, with the key that matched, before it goes.
export function pruneSeen(doc, isSeen, report) {
  let dropped = 0;
  walk(doc, (value) => {
    if (Array.isArray(value) || !('cursor' in value) || !value.node || typeof value.node !== 'object') return undefined;
    if (value.node.__typename !== 'Story' && !value.node.__isFeedUnit) return undefined;
    const key = storyKeys(value.node).find(isSeen);
    if (key === undefined) return SKIP;
    report?.(value.node, key);
    delete value.node;
    delete value.rendering_strategy;
    dropped++;
    return SKIP;
  });
  return dropped;
}

// "Show seen posts in this tab" lasts as long as the tab, reloads included.
function tabFlag(win) {
  return {
    get() {
      try {
        return win?.sessionStorage?.getItem(SHOW_KEY) === '1';
      } catch {
        return false;
      }
    },
    set(on) {
      try {
        if (on) win.sessionStorage.setItem(SHOW_KEY, '1');
        else win.sessionStorage.removeItem(SHOW_KEY);
      } catch {
        // No session storage (a locked-down window): it lasts until the page reloads instead.
      }
    },
  };
}

export default {
  id: 'hideSeenPosts',
  section: 'feed',
  android: 'Hide seen posts',
  title: 'Hide seen posts',
  description: "Hides posts on Home and in your groups feed that you've already scrolled past. A post counts as seen after a second on screen, and it's recognized by its photo or video, or by its first words.",
  default: false,
  options: [
    {
      key: 'days', type: 'select', label: 'Keep seen posts hidden for', default: 7,
      choices: DAYS.map((n) => ({ value: n, label: n === 1 ? '1 day' : `${n} days` })),
    },
  ],

  setup({ win, net, router, posts, hider, storage, actions, diagnostics, settings, log, enabled, option, now = Date.now }) {
    const store = createSeenStore({ storage, log, now });
    const flag = tabFlag(win);
    const route = () => router?.current();
    const changed = () => diagnostics?.changed();
    const days = () => (DAYS.includes(Number(option('days'))) ? Number(option('days')) : 7);
    let showing = flag.get();
    // What counts as seen right now: posts seen before this visit, or before you last came
    // back to Home from somewhere else, within the days you picked. Changing the days keeps
    // that same moment, so the posts you're reading now don't vanish.
    let before = new Set();
    let until = now();
    const refresh = (moment = now()) => {
      until = moment;
      before = store.since(now() - days() * DAY, until);
    };
    refresh();
    const isSeen = (key) => before.has(key);
    const hiding = () => enabled() && !showing && before.size > 0;
    let dropped = 0;
    let hidden = 0;

    if (net) {
      const scope = { scope: FILTERED };
      net.transformResponses({
        id: 'hideSeenPosts',
        enabled: hiding,
        markers: ['"__isFeedUnit"'],
        match: (ctx) => ctx.transport === 'json-parse' || ctx.path.startsWith('/api/graphql'),
        transform(doc, ctx) {
          if (!inScope(scope, ctx, route)) return false;
          const count = pruneSeen(doc, isSeen, (story, key) => diagnostics?.decide({ post: story.post_id ?? story.id, rule: 'Seen', signal: matchedBy(key), layer: 'data' }));
          if (count) {
            dropped += count;
            changed();
          }
          return count > 0;
        },
      });
    }

    diagnostics?.add('Seen posts remembered', () => String(store.size()));
    diagnostics?.add('Seen posts hidden', () => {
      if (showing) return 'None: showing them in this tab';
      return net ? `${dropped} taken out of the data, ${hidden} hidden on the page` : `${hidden} hidden on the page`;
    });

    let watcher = null;
    if (posts && win) {
      watchSeen({
        posts,
        win,
        active: () => enabled() && FILTERED.routes(route()),
        now,
        // Read when the post starts showing, in case Facebook puts another story in its place.
        snapshot: (post) => pageKeys(post.element),
        onSeen(post, keys) {
          if (store.add(keys?.length ? keys : pageKeys(post.element))) changed();
        },
      });
      // After seen-watch's own pagehide listener, so the posts it counts get written.
      win.addEventListener?.('pagehide', () => store.flush());
    }

    if (posts && hider) {
      watcher = watchPostChecks({
        posts,
        enabled: hiding,
        check(element) {
          if (!FILTERED.routes(route())) return true;
          // Not seen yet, or not filled in yet: look again on the next retry.
          const key = pageKeys(element).find(isSeen);
          if (key === undefined) return false;
          if (hider.hide(element, 'Seen', undefined, matchedBy(key))) {
            hidden++;
            changed();
          }
          return true;
        },
      });
    }

    // Coming back to Home from another page counts what you saw since as seen.
    let inFeed = FILTERED.routes(route());
    router?.subscribe?.((current) => {
      const inside = FILTERED.routes(current);
      if (inside && !inFeed) {
        refresh();
        if (hiding()) watcher?.recheckAll();
      }
      inFeed = inside;
    });

    actions?.add(() => (showing ? 'Hide seen posts again' : 'Show seen posts in this tab'), () => {
      showing = !showing;
      flag.set(showing);
      if (showing) {
        hider?.showAll('Seen');
      } else {
        refresh();
        watcher?.recheckAll();
      }
      changed();
    });
    actions?.add('Forget all seen posts', () => {
      store.clear();
      before = new Set();
      hider?.showAll('Seen');
      changed();
    });

    const state = () => JSON.stringify([enabled(), days()]);
    let last = state();
    settings?.subscribe(() => {
      const next = state();
      if (next === last) return;
      last = next;
      refresh(until);
      hider?.showAll('Seen');
      if (hiding()) watcher?.recheckAll();
    });
  },
};
