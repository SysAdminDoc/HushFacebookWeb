// Posts Facebook mixes into Home and the groups feed from Pages, people and groups you don't
// follow. Two layers, like Hide sponsored posts. The data rules (ad-markers.js, rows
// follow_button and group_join) drop them before Facebook draws them, and only on those two
// feeds, since search results and a Page's own timeline carry the same buttons. The page
// check hides one that gets drawn anyway, by the Follow or Join button after the author's
// name (live 2026-10-11: h4 > ... > div[role=button] > span "Follow"), English first.
// The People you may know and group suggestion rows go by data only (rows
// people_you_may_know and group_suggestions); content mode has no page check for them yet.

import { adRule, FEEDS } from './ad-markers.js';
import { CANDIDATE_SELECTOR } from '../../core/dom/posts.js';
import { watchPostChecks } from '../../core/dom/post-checks.js';
import { normalizeText, visibleText } from '../../core/dom/visible-text.js';

const BUTTONS = new Map([['follow', 'Follow'], ['join', 'Join']]);

// The Follow or Join button in the post's own author heading, or null. Only the first
// heading counts: a shared post's header comes after its sharer's.
export function suggestionButton(post) {
  const heading = [...post.querySelectorAll('h2, h3, h4, [role="heading"]')].find((h) => h.closest(CANDIDATE_SELECTOR) === post);
  if (!heading) return null;
  for (const button of heading.querySelectorAll('[role="button"], button')) {
    const name = BUTTONS.get(normalizeText(visibleText(button)).toLowerCase());
    if (name) return name;
  }
  return null;
}

const tally = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const summary = (map) => (map.size ? [...map].map(([name, n]) => `${name} ${n}`).join(', ') : 'None yet');

export default {
  id: 'hideSuggestedPosts',
  section: 'feed',
  android: 'Hide suggested and promoted posts',
  title: 'Hide suggested posts',
  description: "Hides posts from Pages, people and groups you don't follow that Facebook mixes into Home and your groups feed, plus the People you may know and group suggestion rows on Home.",
  default: true,

  setup({ net, router, posts, hider, settings, diagnostics, enabled }) {
    const data = new Map();
    const page = new Map();
    const changed = () => diagnostics?.changed();
    const route = () => router?.current();

    if (net) {
      net.transformResponses(adRule('hideSuggestedPosts', enabled, (fired) => {
        for (const id of fired) tally(data, id);
        changed();
      }, { route, diagnostics, reason: 'Suggested' }));
    }
    // Rule ids and the script's own button names, so Copy report can carry them.
    diagnostics?.add('Suggested posts taken out of the data', () => (net ? summary(data) : "Off: the script can't reach the page's data"), { shareable: true });
    diagnostics?.add('Suggested posts hidden on the page', () => summary(page), { shareable: true });
    if (!posts || !hider) return;

    const watcher = watchPostChecks({
      posts,
      enabled,
      check(element) {
        if (!FEEDS.routes(route())) return true;
        const button = suggestionButton(element);
        if (!button) return false;
        if (hider.hide(element, 'Suggested')) {
          tally(page, button);
          changed();
        }
        return true;
      },
    });

    let on = enabled();
    settings.subscribe(() => {
      if (enabled() === on) return;
      on = enabled();
      if (on) watcher.recheckAll();
      else hider.showAll('Suggested');
    });
  },
};
