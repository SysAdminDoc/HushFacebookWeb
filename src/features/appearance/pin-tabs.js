// Pin tabs (#18): keeps the top bar tabs you pick on days Facebook leaves them out.
//
// Live 2026-11-25 (Home, Groups and Marketplace, the test account):
// - Facebook's server sends each account a short list of tabs, viewer.tab_bookmarks(environment:
//   "COMET", folder_id: "PRODUCT"), and changes it over time. The test account had Home, Friends
//   and Groups on 10-11, Home, Friends, Reels, Marketplace and Gaming on 11-24, and Home, Friends
//   and Groups again on 11-25. The bar draws one tab per entry, looked up by its app id in
//   CometLoggedInTargetedTabsList. The web has no setting for it.
// - An entry is {node: {unread_count, bookmarked_node: {__typename: "Application", id},
//   last_used_timestamp, id}}. The bar is in the HTML the server sends, so an entry added to the
//   data before React takes the page over makes React's copy differ from that HTML: React throws
//   error #418 and draws the page again.
// - Added to Relay's store once React has claimed the bar, through the signed-in account's own
//   environment (CometRelayEnvironmentFactory.getForActorID(CurrentUser.getID()).commitUpdate),
//   an entry draws as one of Facebook's own tabs with no error. It has its icon and link, gets
//   the blue mark while you're on its page, and stays as you move around the site.
// - Facebook's build of React leaves no fiber key on the bar's nodes, but a tab's link gets
//   __reactListeners$ and __reactHandles$ keys once React has claimed it, 1 to 3 seconds in.
//   __ext on the list item is Meta's own and is there from the start.
//
// So the switch adds the picked tabs Facebook left out, in the order Facebook uses, and only
// ever takes its own back out. Facebook's entries are never changed or moved.

import { whenModule } from '../../core/modules.js';
import { TAB_ORDER, TAB_ROWS } from './declutter-table.js';

export const FACTORY = 'CometRelayEnvironmentFactory';
export const USER = 'CurrentUser';
export const LIST_ARGS = { environment: 'COMET', folder_id: 'PRODUCT' };
const BADGE_ARGS = { bookmark_render_location: 'COMET_TOP_TAB' };
export const OURS = 'client:hfw:tab-edge:';
const NODE = 'client:hfw:tab:';
const PINNED_BY_DEFAULT = new Set(['groups', 'friends']);

const appOf = (edge) => edge?.getLinkedRecord('node')?.getLinkedRecord('bookmarked_node')?.getValue('id') ?? null;
const rank = (app) => {
  const at = TAB_ORDER.indexOf(app);
  return at === -1 ? TAB_ORDER.length : at;
};
const labelOf = (app) => TAB_ROWS.find((row) => row.app === app)?.label ?? app;

// One entry the way Facebook's own look, reusing the page's record for the app when it has one.
function tabEdge(store, app, sample) {
  const target = store.get(app) ?? store.create(app, 'Application');
  if (target.getValue('id') == null) target.setValue(app, 'id');
  const nodeId = NODE + app;
  const node = store.get(nodeId) ?? store.create(nodeId, sample?.getLinkedRecord('node')?.getType() ?? 'Bookmark');
  node.setValue(nodeId, 'id');
  node.setValue(0, 'unread_count', BADGE_ARGS);
  node.setValue(null, 'last_used_timestamp');
  node.setLinkedRecord(target, 'bookmarked_node');
  const edgeId = OURS + app;
  const edge = store.get(edgeId) ?? store.create(edgeId, sample?.getType() ?? 'TabBookmarksEdge');
  edge.setLinkedRecord(node, 'node');
  return edge;
}

// Rebuilds the list from Facebook's own entries plus each wanted app they lack, put after the
// last tab that comes before it. Returns the apps the script's entries now hold, and whether the
// list was written, or null when the store has no tab list.
export function pinEdges(store, wanted) {
  const list = store.getRoot()?.getLinkedRecord('viewer')?.getLinkedRecord('tab_bookmarks', LIST_ARGS);
  if (!list) return null;
  const edges = list.getLinkedRecords('edges') ?? [];
  const theirs = edges.filter((edge) => !edge?.getDataID().startsWith(OURS));
  const have = new Set(theirs.map(appOf));
  const sample = theirs.find((edge) => edge?.getLinkedRecord('node'));
  const next = theirs.slice();
  const pinned = [];
  for (const app of [...new Set(wanted)].sort((a, b) => rank(a) - rank(b))) {
    if (have.has(app)) continue;
    let at = 0;
    next.forEach((edge, index) => {
      if (rank(appOf(edge)) < rank(app)) at = index + 1;
    });
    next.splice(at, 0, tabEdge(store, app, sample));
    pinned.push(app);
  }
  const same = next.length === edges.length && next.every((edge, index) => edge?.getDataID() === edges[index]?.getDataID());
  if (!same) list.setLinkedRecords(next, 'edges');
  return { pinned, changed: !same };
}

// React has taken the bar over once its first tab link carries React's own keys.
export function barHydrated(doc) {
  const link = doc?.querySelector?.('[role="banner"] li a');
  return Boolean(link) && Object.getOwnPropertyNames(link).some((key) => key.startsWith('__reactListeners$') || key.startsWith('__reactHandles$'));
}

const OFF = 'switch off';
const WAITING = "waiting for Facebook's top bar";
const NO_LIST = 'no tab list on this page';
const CHANGED = "not pinned, Facebook's code has changed";
const POLL_MS = 250;
// 20 seconds of looks. A build that names React's keys differently still gets its tabs then.
const LOOKS = 80;
// Facebook may send the list again as a page change settles.
const AGAIN_MS = [1500, 5000];

export default {
  id: 'pinTabs',
  section: 'layout',
  webOnly: true,
  title: 'Pin tabs',
  description: 'Keeps the tabs you pick in the top bar on days Facebook leaves them out. Facebook gives each account a few tabs and changes them now and then. A pinned tab stays even when Hide tabs is set to take it off.',
  default: false,
  needsPage: true,
  options: TAB_ROWS.map(({ option, label }) => ({ key: option, type: 'toggle', label: `Pin ${label}`, default: PINNED_BY_DEFAULT.has(option) })),

  setup({ win, doc, settings, router, diagnostics, enabled, option, log, markUnavailable }) {
    let status = OFF;
    let env = null;
    let asked = false;
    let looking = false;
    let ready = false;
    let ours = false;
    let broken = false;

    const say = (next) => {
      if (next === status) return;
      status = next;
      diagnostics?.changed();
    };
    const wanted = () => (enabled() ? TAB_ROWS.filter((row) => option(row.option) === true).map((row) => row.app) : []);

    const fail = (error) => {
      if (broken) return;
      broken = true;
      if (error) log?.error("Pin tabs couldn't change Facebook's tab list", error);
      else log?.warn("Pin tabs couldn't find Facebook's tab list code. Facebook's code has changed.");
      say(CHANGED);
      markUnavailable?.();
    };

    const apply = () => {
      if (!env || broken) return;
      const want = wanted();
      if (!want.length && !ours) {
        say(enabled() ? 'none picked' : OFF);
        return;
      }
      let result = null;
      try {
        env.commitUpdate((store) => {
          result = pinEdges(store, want);
        });
      } catch (error) {
        fail(error);
        return;
      }
      if (!result) {
        say(enabled() ? NO_LIST : OFF);
        return;
      }
      ours = result.pinned.length > 0;
      if (!enabled()) say(OFF);
      else say(ours ? result.pinned.map(labelOf).join(', ') : 'none needed');
    };

    // The page's modules are asked for only once the bar is React's, when the page already has them.
    const go = () => {
      if (env) {
        apply();
        return;
      }
      if (asked) return;
      asked = true;
      whenModule(win, FACTORY, (factory) => {
        whenModule(win, USER, (user) => {
          let found;
          try {
            const id = typeof user?.getID === 'function' ? user.getID() : null;
            found = id && typeof factory?.getForActorID === 'function' ? factory.getForActorID(id) : null;
          } catch (error) {
            fail(error);
            return;
          }
          if (typeof found?.commitUpdate !== 'function') {
            fail();
            return;
          }
          env = found;
          apply();
        }, { log });
      }, { log });
    };

    const whenReady = () => {
      if (ready || looking) return;
      looking = true;
      say(WAITING);
      let looks = 0;
      const look = () => {
        if (barHydrated(doc) || looks >= LOOKS) {
          looking = false;
          ready = true;
          go();
          return;
        }
        looks++;
        win.setTimeout(look, POLL_MS);
      };
      if (doc?.readyState === 'loading') doc.addEventListener('DOMContentLoaded', look, { once: true });
      else look();
    };

    // Facebook's code and data are left alone until the switch is first turned on.
    const follow = () => {
      if (ready && (enabled() || ours)) go();
      else if (enabled()) whenReady();
      else say(OFF);
    };
    follow();
    settings?.subscribe(follow);
    router?.subscribe(() => {
      if (!ready || (!enabled() && !ours)) return;
      go();
      for (const ms of AGAIN_MS) win.setTimeout(() => {
        if (enabled() || ours) go();
      }, ms);
    });

    // Only the script's own words and tab names, so a report carries them.
    diagnostics?.add('Tabs added by Pin tabs', () => status, { shareable: true });
  },
};
