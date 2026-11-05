// Keep your Notifications filter. The list under the bell and the Notifications page both have
// All and Unread at the top, and Facebook goes back to All every time a page loads. So the script
// remembers the one you pick and presses it again when the list shows the other.
//
// Live 2026-11-04, signed in:
// - All and Unread are role=button with aria-pressed, All first, in a role=toolbar inside the
//   list of notifications (role=list). Under the bell that list is in a dialog in the banner,
//   there from the start and hidden until you open it. The Notifications page has no role=main,
//   just the list. The page and the bell share one pick until the page loads again.
// - Unread asks for the list with one query (CometNotificationsListPaginationQuery), no
//   mutation, and a script's click() on it works like yours.
// The toolbar is found by its shape, not its words: two buttons that are pressed or not, in a
// list with notification links. Once found it stays known, even when Unread empties the list.
// Only a list on screen gets pressed, so nothing is asked of Facebook before you open one.
// Works in content mode.

import { whenBodyReady } from '../../core/env.js';
import { t } from '../../core/i18n.js';

export const PICK_KEY = 'keepNotificationsFilter.pick';
export const PICKS = ['all', 'unread'];
const BUTTONS = '[role="button"][aria-pressed]';
const LINKS = 'a[href*="notif_t="]';
const DELAY = 120;
// After a click, key or page change that may have shown a list, which draws over the next second.
const LOOKS = [100, 400, 1000];
// And a list that fills in later than that, on a slow connection say, is looked at as it changes
// for this long after.
const WATCH_MS = 4000;
// Per list, until you do something again, so the script can't go back and forth with Facebook.
const MAX_PRESSES = 3;
// Space and Enter typed in these are words, not a press that could open the bell.
const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

const buttonsOf = (bar) => [...bar.querySelectorAll(BUTTONS)];
const drawn = (element) => element.checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) ?? true;

export function createFilterKeeper({ doc, storage, enabled, onPage = () => false, trusted = (event) => event.isTrusted, setTimer = (fn, ms) => setTimeout(fn, ms), now = () => Date.now() }) {
  const known = new WeakSet();
  let presses = new WeakMap(); // toolbar -> times the script pressed in it since your last input
  let timer = null;
  let watchUntil = 0;

  const kept = () => {
    const pick = storage.get(PICK_KEY, null);
    return PICKS.includes(pick) ? pick : null;
  };

  function isFilter(bar) {
    if (known.has(bar)) return true;
    if (buttonsOf(bar).length !== 2 || !bar.closest('[role="list"]')?.querySelector(LINKS)) return false;
    known.add(bar);
    return true;
  }

  function apply() {
    const pick = kept();
    if (!enabled() || !pick) return;
    for (const bar of doc.querySelectorAll('[role="toolbar"]')) {
      if (!isFilter(bar) || !drawn(bar)) continue;
      const wanted = buttonsOf(bar)[PICKS.indexOf(pick)];
      if (!wanted || wanted.getAttribute('aria-pressed') === 'true') continue;
      const times = presses.get(bar) ?? 0;
      if (times >= MAX_PRESSES) continue;
      presses.set(bar, times + 1);
      wanted.click();
    }
  }

  const schedule = () => {
    timer ??= setTimer(() => {
      timer = null;
      apply();
    }, DELAY);
  };

  // The bell's list stays in the page all along, so each look gets fresh presses.
  function lookSoon() {
    if (!enabled() || !kept()) return;
    presses = new WeakMap();
    watchUntil = now() + WATCH_MS;
    for (const ms of LOOKS) setTimer(apply, ms);
  }

  // Your own click, or Enter or Space, on All or Unread is the pick. The script's click() comes
  // in untrusted, and it only ever presses the pick already kept. Any other click or key of yours
  // may have opened the bell's list, so it gets looked at as it draws.
  function onInput(event) {
    if (!enabled() || !trusted(event)) return;
    if (event.type === 'keydown' && ((event.key !== 'Enter' && event.key !== ' ') || event.target?.closest?.(TYPING))) return;
    const button = event.target?.closest?.(BUTTONS);
    const bar = button?.closest('[role="toolbar"]');
    if (bar && isFilter(bar)) {
      const pick = PICKS[buttonsOf(bar).indexOf(button)];
      if (pick && pick !== kept()) storage.set(PICK_KEY, pick);
      return;
    }
    lookSoon();
  }

  return {
    start() {
      doc.addEventListener('click', onInput, true);
      doc.addEventListener('keydown', onInput, true);
      // The Notifications page draws its list on its own, with no click to wait for, and the
      // bell's list gets the same for a few seconds after a click.
      const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
      new Observer(() => {
        if (enabled() && (onPage() || now() < watchUntil) && kept()) schedule();
      }).observe(doc.body, { childList: true, subtree: true });
      apply();
    },
    apply,
    lookSoon,
    kept,
    reset: () => storage.remove(PICK_KEY),
  };
}

export const pickLabel = (pick) => ({ all: 'All', unread: 'Unread' })[pick] ?? 'Not picked yet';

export default {
  id: 'keepNotificationsFilter',
  section: 'notifications',
  title: 'Keep your Notifications filter',
  description: 'The Notifications list under the bell and the Notifications page open on All or Unread, whichever you picked last, instead of going back to All every time Facebook loads.',
  default: false,
  webOnly: true,

  setup({ doc, router, storage, settings, enabled, diagnostics, actions, toast }) {
    if (!doc) return;
    const keeper = createFilterKeeper({ doc, storage, enabled, onPage: () => router?.current()?.type === 'notifications' });
    whenBodyReady(() => keeper.start(), doc);
    // Back or Forward onto the Notifications page may draw it before the route says so.
    router?.subscribe?.(() => keeper.lookSoon());
    settings?.subscribe?.(() => keeper.apply());
    diagnostics?.add('Notifications filter kept', () => pickLabel(keeper.kept()));
    actions?.add('Open Notifications on All again', () => {
      keeper.reset();
      toast?.(t('Notifications open on All again'));
    });
  },
};
