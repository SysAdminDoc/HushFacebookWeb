// The People you may know rows, on a switch of their own (#16): some people like seeing a
// suggested post now and then and only want the rows of people gone. Through 0.0.22 Hide
// suggested posts covered both, and a migration in settings.js keeps it that way for anyone
// who had that switch off.
// Home and the groups feed lose the row in the data (row people_you_may_know in
// ad-markers.js, by its typename or the code Facebook draws it with), and one Facebook drew on
// the server stays in the data and is hidden on the page by its place. A row that gets drawn
// anyway is hidden on the page by its links (#5: the row still showed on 0.0.45), which works in
// any language and in content mode too. The friendsPages option hides the block on the Friends
// page and profiles too, on the page (pymk-boxes.js).

import { adRule, FEEDS } from './ad-markers.js';
import { cardPerson, PYMK_CSS, seeAllLink, watchPymk } from './pymk-boxes.js';
import { hideDrawnPosts } from './drawn-posts.js';
import { ownLinks } from '../../core/dom/posts.js';
import { watchPostChecks } from '../../core/dom/post-checks.js';
import { hasPostParts } from '../../core/filters/page.js';

// What the hider and Diagnostics call a hidden row. One word, since a hidden post lists its
// reasons in one attribute. Its note says the row's whole name.
export const REASON = 'People';
export const NOTE_NAME = 'People you may know';

// A People you may know row between posts: a feed unit drawn as nobody's post, with a See all
// link of its own to the friend suggestions page, or two people's cards linking there, the way
// the block on the Friends page is drawn (live 2026-11-03). The row in #5's picture has its See
// all too. A post that links to that page still has a post's header and text, so it stays.
export function pymkRow(unit) {
  if (hasPostParts(unit)) return false;
  const people = new Set();
  for (const link of ownLinks(unit)) {
    if (seeAllLink(link)) return true;
    const person = cardPerson(link);
    if (person && people.add(person).size >= 2) return true;
  }
  return false;
}

export default {
  id: 'hidePeopleYouMayKnow',
  section: 'feed',
  android: 'Hide suggested and promoted posts',
  title: 'Hide People you may know',
  description: 'Hides the People you may know rows Facebook puts between posts on Home and your groups feed.',
  default: true,
  options: [
    { key: 'friendsPages', type: 'toggle', label: 'Also hide People you may know on the Friends page and profiles', default: false },
  ],
  css: (get) => (get('hidePeopleYouMayKnow.friendsPages') ? PYMK_CSS : ''),

  setup({ doc, net, router, posts, hider, settings, diagnostics, enabled, option }) {
    const changed = () => diagnostics?.changed();
    const route = () => router?.current();
    let rows = 0;
    let drawn = 0;

    if (doc && router) {
      let blocks = 0;
      const pymk = watchPymk({ doc, route, active: () => enabled() && option('friendsPages') === true, onHidden: () => {
        blocks++;
        changed();
      } });
      settings?.subscribe(() => pymk.check());
      // In content mode the route can catch up after Facebook has drawn the page.
      router.subscribe?.(() => pymk.check());
      diagnostics?.add('People you may know blocks hidden on Friends pages and profiles', () => (option('friendsPages') === true ? String(blocks) : 'Off'));
    }

    if (net) {
      // A row Facebook drew on the server stays in the data and is hidden on the page.
      const onDrawn = hideDrawnPosts({ posts, hider, router, settings, enabled, reason: REASON, name: NOTE_NAME, onHide: () => {
        drawn++;
        changed();
      } });
      net.transformResponses(adRule('hidePeopleYouMayKnow', enabled, (fired) => {
        rows += fired.length;
        changed();
      }, { route, diagnostics, reason: REASON, onDrawn }));
    }

    if (posts && hider && router) {
      // Only on the feeds: on the Friends page and profiles the block is friendsPages' to hide.
      const watcher = watchPostChecks({
        posts,
        enabled,
        check(element) {
          // A post stays a post, so it's done with once its header or text is in.
          if (!FEEDS.routes(route()) || hasPostParts(element)) return true;
          if (!pymkRow(element)) return false;
          // The row the data's place already hid counts once.
          const counted = hider.isHidden?.(element) === true;
          if (hider.hide(element, REASON, undefined, undefined, NOTE_NAME) && !counted) {
            drawn++;
            changed();
          }
          return true;
        },
      });
      let on = enabled();
      settings?.subscribe(() => {
        if (enabled() === on) return;
        on = enabled();
        if (on) watcher.recheckAll();
        else hider.showAll(REASON);
      });
    }
    // Counts only, so Copy report can carry them.
    diagnostics?.add('People you may know rows taken out of the data', () => (net ? String(rows) : "Off: the script can't reach the page's data"), { shareable: true });
    diagnostics?.add('People you may know rows hidden on the page', () => String(drawn), { shareable: true });
  },
};
