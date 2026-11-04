// Where the settings gear sits: in Facebook's top bar, at the near end of the round buttons on
// the right (Facebook menu, Messenger, Notifications, your account), the same size and spacing as
// they are. A page without that bar gets it in the bottom-left corner instead.
//
// The gear is the panel's own fixed button, placed over the bar from where the buttons are, never
// a node inside Facebook's bar, so React's hydration and redraws never meet it.
//
// Live 2026-11-04 at 1600, 1100 and 800 px wide:
// - The round buttons share a [role=navigation] in [role=banner]: 40 px circles 8 px apart,
//   centered in the 56 px bar. The tabs are a second navigation as wide as the bar. Labels come in
//   Facebook's language, so the row is found by shape: the banner's navigation with pop-up
//   buttons that isn't the tab row.
// - The row drops its Find friends link on narrow windows and while a post is open, which moves
//   its near edge. The element stays the same.
// - An open post dims the page and most of the bar, but Facebook keeps the round buttons above
//   the dimming, so the gear stays lit beside them.
// - At 800 px the tabs end 94 px before the row. Something clickable on the gear's spot (a
//   narrower window, another layout) sends the gear to the corner rather than over it.

const SIZE = 40;
const GAP = 8;
// How long a fresh page has to draw its bar before the gear shows in the corner instead.
const GRACE_MS = 4000;
// How often a missing or replaced row is looked for.
const POLL_MS = 1500;
const CLICKABLE = 'a[href], button, input, select, textarea, [role=button], [role=link], [role=tab], [role=combobox], [role=textbox], [role=search]';

// The round buttons' row in Facebook's top bar, or null.
export function accountRow(doc) {
  const width = doc.defaultView.innerWidth;
  for (const nav of doc.querySelectorAll('[role=banner] [role=navigation]')) {
    if (!nav.querySelector('[aria-haspopup]')) continue;
    const box = nav.getBoundingClientRect();
    if (box.width > 0 && box.height > 0 && box.width < width / 2) return nav;
  }
  return null;
}

// The gear's top left beside the row, in viewport px, or null when it doesn't fit there. host is
// the panel's element on the page, skipped when looking at what's on the spot.
export function barSpot(row, doc, host) {
  const width = doc.defaultView.innerWidth;
  const box = row.getBoundingClientRect();
  if (!box.width || !box.height) return null;
  // The near end is the left one when the row sits on the right, as it does left to right.
  const left = Math.round(box.left + box.width / 2 >= width / 2 ? box.left - GAP - SIZE : box.right + GAP);
  const top = Math.round(box.top + (box.height - SIZE) / 2);
  if (left < 0 || top < 0 || left + SIZE > width) return null;
  for (const x of [left + 2, left + SIZE / 2, left + SIZE - 2]) {
    const above = (doc.elementsFromPoint?.(x, top + SIZE / 2) ?? []).find((el) => el !== host);
    if (above?.closest?.(CLICKABLE)) return null;
  }
  return { left, top };
}

// Keeps button (position: fixed) beside the row while Facebook redraws, resizes and moves between
// pages. button.dataset.place says where it is: bar, corner, or wait while a fresh page is still
// in its grace time.
export function trackLauncherSpot({ button, host, doc, router, graceMs = GRACE_MS, pollMs = POLL_MS, now = Date.now }) {
  const win = doc.defaultView;
  const started = now();
  let row = null;
  const resized = win.ResizeObserver ? new win.ResizeObserver(() => place()) : null;

  const set = (place, left = '', top = '') => {
    if (button.dataset.place !== place) button.dataset.place = place;
    if (button.style.left !== left) button.style.left = left;
    if (button.style.top !== top) button.style.top = top;
  };

  // The banner is watched with the row: it is as wide as the page, so it reports a scroll bar
  // coming or going, which moves the row without resizing it.
  const follow = (found) => {
    if (found === row) return;
    row = found;
    resized?.disconnect();
    for (const el of row ? [row, row.closest('[role=banner]')] : []) if (el) resized?.observe(el);
  };

  function place() {
    if (button.hidden) return;
    if (!row?.isConnected) follow(accountRow(doc));
    const spot = row && barSpot(row, doc, host);
    if (spot) set('bar', `${spot.left}px`, `${spot.top}px`);
    else set(now() - started < graceMs ? 'wait' : 'corner');
  }

  const later = () => win.setTimeout(place, 0);
  const grace = win.setTimeout(place, graceMs);
  const poll = win.setInterval(() => {
    if (!button.hidden && !row?.isConnected) place();
  }, pollMs);
  win.addEventListener('resize', place, { passive: true });
  const unsubscribe = router?.subscribe?.(later);
  place();

  return {
    update: place,
    stop() {
      win.clearTimeout(grace);
      win.clearInterval(poll);
      win.removeEventListener('resize', place);
      resized?.disconnect();
      if (typeof unsubscribe === 'function') unsubscribe();
    },
  };
}
