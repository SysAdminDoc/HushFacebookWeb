// Friend requests in Home's right column, on a switch of its own. Hush already hides the
// column's Sponsored box and, under Wider feed, Birthdays. The Friends page, the friends icon's
// count and notifications are Facebook's own and untouched: only the box on Home goes.
//
// Two layers, like the Sponsored box: the data rule (FriendingRequestsSideFeedUnit in
// ad-markers.js) takes the box out of the answer when Home is drawn again in the browser, and
// the page check (sponsored-column.js) hides the one a fresh load of Home sends already drawn,
// and every one in content mode. With Wider feed on, a column left with nothing showing folds.

import { adRule } from './ad-markers.js';
import { FRIEND_REQUESTS_CSS, FRIEND_REQUESTS_MARK, friendRequestsBoxes, watchColumnBoxes } from './sponsored-column.js';

export default {
  id: 'hideFriendRequestsColumn',
  section: 'feed',
  title: 'Hide Friend requests on Home',
  description: "Takes the Friend requests box out of Home's right column. Your requests are still on the Friends page, and the friends icon still counts new ones.",
  default: false,
  webOnly: true,
  keywords: ['friend requests', 'right column', 'sidebar'],
  css: () => FRIEND_REQUESTS_CSS,

  setup({ doc, net, router, settings, diagnostics, enabled }) {
    const changed = () => diagnostics?.changed();
    let data = 0;
    let page = 0;
    if (net) {
      net.transformResponses(adRule('hideFriendRequestsColumn', enabled, () => {
        data++;
        changed();
      }, { route: () => router?.current() }));
    }
    // Only on Home: elsewhere nothing is marked or counted, and a mark from Home stays, hiding
    // nothing until Home shows again.
    const onHome = () => doc.documentElement?.dataset.hfwRoute === 'home';
    const column = doc ? watchColumnBoxes({ doc, enabled: () => enabled() && onHome(), find: friendRequestsBoxes, mark: FRIEND_REQUESTS_MARK, onBox: () => {
      page++;
      changed();
    } }) : null;
    settings?.subscribe(() => column?.check());
    // Back on Home, a column Facebook kept from before gets checked without waiting for it to change.
    router?.subscribe(() => column?.check());
    // Counts only, so Copy report can carry them.
    diagnostics?.add('Friend requests taken out of the data', () => (net ? String(data) : "Off: the script can't reach the page's data"), { shareable: true });
    diagnostics?.add('Friend requests boxes hidden on the page', () => String(page), { shareable: true });
  },
};
