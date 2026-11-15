// The People you may know rows, on a switch of their own (#16): some people like seeing a
// suggested post now and then and only want the rows of people gone. Through 0.0.22 Hide
// suggested posts covered both, and a migration in settings.js keeps it that way for anyone
// who had that switch off.
// Home and the groups feed lose the row in the data (row people_you_may_know in
// ad-markers.js, a PaginatedPeopleYouMayKnowFeedUnit edge), and one Facebook drew on the
// server stays in the data and is hidden on the page by its place. Content mode has no page
// check for Home's row yet. The friendsPages option hides the block on the Friends page and
// profiles too, on the page (pymk-boxes.js).

import { adRule } from './ad-markers.js';
import { PYMK_CSS, watchPymk } from './pymk-boxes.js';
import { hideDrawnPosts } from './drawn-posts.js';

// What the hider and Diagnostics call a hidden row. One word, since a hidden post lists its
// reasons in one attribute. Its note says the row's whole name.
export const REASON = 'People';
export const NOTE_NAME = 'People you may know';

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
    // Counts only, so Copy report can carry them.
    diagnostics?.add('People you may know rows taken out of the data', () => (net ? String(rows) : "Off: the script can't reach the page's data"), { shareable: true });
    diagnostics?.add('People you may know rows hidden on the page', () => String(drawn), { shareable: true });
  },
};
