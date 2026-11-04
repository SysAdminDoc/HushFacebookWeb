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
// After a click that may have opened the bell's list, which draws over the next second.
const AFTER_CLICK = [100, 400, 1000];
const MAX_PRESSES = 3;

const buttonsOf = (bar) => [...bar.querySelectorAll(BUTTONS)];
const drawn = (element) => element.checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) ?? true;

export function createFilterKeeper({ doc, storage, enabled, onPage = () => false, trusted = (event) => event.isTrusted, setTimer = (fn, ms) => setTimeout(fn, ms) }) {
  const known = new WeakSet();
  const presses = new WeakMap(); // toolbar -> times the script pressed in it
  let timer = null;

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

  // Your own click, or Enter or Space, on All or Unread is the pick. The script's click() comes
  // in untrusted, and it only ever presses the pick already kept. Any other click of yours may
  // have opened the bell's list, so it gets looked at as it draws.
  function onInput(event) {
    if (!enabled() || !trusted(event)) return;
    if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
    const button = event.target?.closest?.(BUTTONS);
    const bar = button?.closest('[role="toolbar"]');
    if (bar && isFilter(bar)) {
      const pick = PICKS[buttonsOf(bar).indexOf(button)];
      if (pick && pick !== kept()) storage.set(PICK_KEY, pick);
      return;
    }
    if (event.type === 'click' && kept()) for (const ms of AFTER_CLICK) setTimer(apply, ms);
  }

  return {
    start() {
      doc.addEventListener('click', onInput, true);
      doc.addEventListener('keydown', onInput, true);
      // The Notifications page draws its list on its own, with no click to wait for.
      const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
      new Observer(() => {
        if (enabled() && onPage() && kept()) schedule();
      }).observe(doc.body, { childList: true, subtree: true });
      apply();
    },
    apply,
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
    settings?.subscribe?.(() => keeper.apply());
    diagnostics?.add('Notifications filter kept', () => pickLabel(keeper.kept()));
    actions?.add('Open Notifications on All again', () => {
      keeper.reset();
      toast?.(t('Notifications open on All again'));
    });
  },
};
