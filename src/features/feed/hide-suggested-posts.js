// Posts Facebook mixes into Home and the groups feed from Pages, people and groups you don't
// follow. Two layers, like Hide sponsored posts. The data rules (ad-markers.js, rows
// follow_button and group_join, and suggested category for the ones Facebook files as
// ENGAGEMENT with no button) drop them before Facebook draws them, and only on those two
// feeds, since search results and a Page's own timeline carry the same buttons. The page
// check hides one that gets drawn anyway, by the Follow or Join button after the author's
// name (live 2026-10-11: h4 > ... > div[role=button] > span "Follow"), English first.
// The People you may know and group suggestion rows go by data only (rows
// people_you_may_know and group_suggestions); content mode has no page check for them yet.
// A post from a group you're in that Facebook files as ORGANIC keeps its Join button now and
// then. The data rows leave it, and ownGroupsRule passes its group to the page check, which
// leaves a post whose heading links to that group. Feed posts carry no post id at rest, so
// the group it links to is what the two layers share. The groups are never in Diagnostics.

import { adRule, FEEDS, groupInHref, ownGroupsRule } from './ad-markers.js';
import { CANDIDATE_SELECTOR } from '../../core/dom/posts.js';
import { watchPostChecks } from '../../core/dom/post-checks.js';
import { normalizeText, visibleText } from '../../core/dom/visible-text.js';

const BUTTONS = new Map([['follow', 'Follow'], ['join', 'Join']]);
// Your groups the data showed with a Join button, the most recent ones.
const OWN_GROUPS_KEPT = 200;

// The post's own author heading. Only the first heading counts: a shared post's header comes
// after its sharer's.
const authorHeading = (post) => [...post.querySelectorAll('h2, h3, h4, [role="heading"]')].find((h) => h.closest(CANDIDATE_SELECTOR) === post) ?? null;

// The Follow or Join button in the post's own author heading, or null.
export function suggestionButton(post) {
  const heading = authorHeading(post);
  if (!heading) return null;
  for (const button of heading.querySelectorAll('[role="button"], button')) {
    const name = BUTTONS.get(normalizeText(visibleText(button)).toLowerCase());
    if (name) return name;
  }
  return null;
}

// The groups the post's author heading links to.
export function headingGroups(post) {
  const heading = authorHeading(post);
  if (!heading) return [];
  return [...heading.querySelectorAll('a[href]')].map((a) => groupInHref(a.getAttribute('href'))).filter(Boolean);
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
    const ownGroups = new Set();
    const own = { data: 0, page: 0 };
    const changed = () => diagnostics?.changed();
    const route = () => router?.current();

    if (net) {
      net.transformResponses(adRule('hideSuggestedPosts', enabled, (fired) => {
        for (const id of fired) tally(data, id);
        changed();
      }, { route, diagnostics, reason: 'Suggested' }));
      net.transformResponses(ownGroupsRule('hideSuggestedPosts-own-groups', enabled, (groups) => {
        own.data++;
        for (const group of groups) {
          ownGroups.delete(group);
          ownGroups.add(group);
        }
        while (ownGroups.size > OWN_GROUPS_KEPT) ownGroups.delete(ownGroups.values().next().value);
        changed();
      }, { route }));
    }
    // Rule ids and the script's own button names, so Copy report can carry them.
    diagnostics?.add('Suggested posts taken out of the data', () => (net ? summary(data) : "Off: the script can't reach the page's data"), { shareable: true });
    diagnostics?.add('Suggested posts hidden on the page', () => summary(page), { shareable: true });
    diagnostics?.add('Posts from your groups kept despite a Join button', () => `${own.data} in the data, ${own.page} on the page`, { shareable: true });
    if (!posts || !hider) return;

    const watcher = watchPostChecks({
      posts,
      enabled,
      check(element) {
        if (!FEEDS.routes(route())) return true;
        const button = suggestionButton(element);
        if (!button) return false;
        if (button === 'Join' && headingGroups(element).some((group) => ownGroups.has(group))) {
          own.page++;
          changed();
          return true;
        }
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
