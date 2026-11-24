// Freeze last active (#17): browse with Active Status on without this page telling Facebook
// you're active, so other people's statuses keep coming in while yours isn't refreshed from here.
//
// Live 2026-11-24, from the page's own code (Home, the test account):
// - While Active Status is on, the page keeps one stream open to Facebook, PresenceUnifiedJSON,
//   through its PresenceUnifiedClient. Other people's statuses arrive on it, and the page's own
//   state goes out on it as small amendments: reportUserPresence(availability) sends
//   {availability, foregrounded: availability === ACTIVE, mutationId}.
// - Facebook's numbers for availability are ACTIVE 1, IDLE 2 and OFFLINE 3
//   (RealtimeNexusSessionDataTypes.PresenceAvailability).
// - The page calls it with ACTIVE two seconds after you move the mouse, press a key or come
//   back to the tab, and with IDLE when the window loses focus or the tab is hidden. When the
//   stream opens it sends whatever it reported last. Nothing else in the page reports presence:
//   the chat socket only listens for foreground state.
// - With Active Status off the page never opens the stream, so there's nothing to hold.
//
// So the switch changes one thing: an ACTIVE report goes out as IDLE, which is what Facebook's
// own page sends from a tab left in the background. The stream, the list of people it asks
// about and everything that comes in are left alone. What other people then see is Facebook's
// call on its servers. It can't be seen from this side, and a message you send or Facebook's
// apps on a phone may still count as activity.

import { afterModuleRuns, whenModule } from '../../core/modules.js';

export const CLIENT = 'PresenceUnifiedClient';
export const SINGLETON = 'FBPresenceUnifiedClientSingleton';
export const ACTIVE = 1;
export const IDLE = 2;

const held = new WeakMap();

// Wraps the report on Facebook's presence client, once however often it's handed over. Returns
// what the switch needs to follow a change, or null when the client isn't shaped as it was.
export function holdPresence(exports, { enabled, onHeld = () => {}, onError = () => {} }) {
  const proto = exports?.PresenceUnifiedClient?.prototype;
  if (!proto || typeof proto.reportUserPresence !== 'function') return null;
  const before = held.get(proto);
  if (before) return before;
  const report = proto.reportUserPresence;
  const clients = new Set();
  proto.reportUserPresence = function reportUserPresence(availability) {
    clients.add(this);
    if (Number(availability) !== ACTIVE || !enabled()) return report.apply(this, arguments);
    onHeld();
    return report.call(this, IDLE);
  };
  // A report of the script's own. Facebook's code answers with a promise it never lets fail,
  // and if that changes the failure is ours to note, not the page's.
  const say = (client, availability) => {
    try {
      const sent = report.call(client, availability);
      if (typeof sent?.catch === 'function') sent.catch(onError);
    } catch (error) {
      onError(error);
    }
  };
  const hold = {
    clients,
    // The client Facebook made before the wrap was in place.
    add(client) {
      if (client && typeof client === 'object') clients.add(client);
    },
    // The switch changed: say what's true now. On, that's idle whatever the page reported last.
    // Off, Facebook is told you're active again only when this page is the one in use, and its
    // own activity watch takes it from there.
    sync(inUse) {
      const on = enabled();
      if (!on && !inUse) return 0;
      for (const client of clients) say(client, on ? IDLE : ACTIVE);
      return clients.size;
    },
  };
  held.set(proto, hold);
  return hold;
}

const WAITING = "Facebook's presence code isn't loaded yet";
const CHANGED = "not held, Facebook's code has changed";

export default {
  id: 'freezeLastActive',
  section: 'people',
  webOnly: true,
  title: 'Freeze last active',
  description: "Tells Facebook you're idle while you browse, the way a tab left in the background does. Your last active time should keep counting up while Active Status stays on, and you still see who's online. Anything you send, and Facebook's apps on your phone, can still show you as active.",
  default: false,
  needsPage: true,

  setup({ win, doc, settings, diagnostics, enabled, log, markUnavailable }) {
    const state = { status: WAITING, held: 0 };
    let hold = null;
    let taken = false;
    let failed = false;
    const inUse = () => doc?.visibilityState === 'visible' && doc.hasFocus?.() === true;

    const take = (exports) => {
      if (taken) return;
      taken = true;
      hold = holdPresence(exports, {
        enabled,
        onHeld() {
          state.held++;
          diagnostics?.changed();
        },
        onError(error) {
          if (failed) return;
          failed = true;
          log?.error("Freeze last active couldn't send its own idle report", error);
        },
      });
      if (hold) {
        state.status = 'held';
      } else {
        state.status = CHANGED;
        log?.warn("Freeze last active couldn't find Facebook's presence report. Facebook's code has changed.");
        markUnavailable?.();
      }
      diagnostics?.changed();
    };

    let started = false;
    const start = () => {
      if (started || !enabled()) return;
      started = true;
      // On a page that's still loading, the wrap goes on as Facebook's own code first runs the
      // module, before any report.
      afterModuleRuns(win, CLIENT, take, { log });
      // Asking for a module runs it, and the one client Facebook makes reads an experiment
      // value as it's built, so both are only asked for once the page has loaded and has
      // those. That covers a switch turned on later, or settings that arrived after the
      // module did: the client that already said it's active is told idle right away.
      const ask = () => {
        whenModule(win, CLIENT, take, { log });
        whenModule(win, SINGLETON, (exports) => {
          if (!hold) return;
          hold.add(exports?.FBPresenceUnifiedClientSingleton);
          if (enabled()) hold.sync(inUse());
        }, { log });
      };
      if (doc?.readyState === 'complete') ask();
      else win.addEventListener?.('load', ask, { once: true });
    };

    // Facebook's modules are left alone until the switch is first turned on.
    let wasOn = false;
    const follow = () => {
      const had = hold;
      start();
      const on = enabled();
      // A hold made by this very call has already said what's true.
      if (on !== wasOn && had) had.sync(inUse());
      wasOn = on;
    };
    follow();
    settings?.subscribe(follow);

    // Only the script's own words and a count, so a report carries them.
    diagnostics?.add('Active reports sent as idle', () => {
      if (!started) return 'switch off';
      return state.status === 'held' ? String(state.held) : state.status;
    }, { shareable: true });
  },
};
