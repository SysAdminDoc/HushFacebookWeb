// Hold a reel for 2x, as Hushfacebook does on Android: press and hold on a reel and it plays at
// double speed until you let go. Facebook's reel viewer shows no play button and keeps its
// controls on screen (live 2026-10-11), so a press anywhere on the picture that isn't on one of
// its buttons or the progress bar counts. The click that ends a hold is kept from Facebook, so
// letting go doesn't also pause the reel. Works in content mode.
//
// Switching it off, Pause (here or in another tab), leaving Reels and the next reel loading in
// the same player all end a hold, or one about to start. Ending puts back the speed the reel
// had only while it's still at the hold's 2x, so a speed picked in the meantime stays.

import { HOLDING } from './keep-speed.js';

export const HOLD_MS = 350;
export const FAST = 2;
// Facebook's controls, and the script's own buttons and panel. The page's root carries the same
// attribute as a running flag, so it's left out.
const CONTROLS = 'a, button, input, [role="button"], [role="slider"], [role="link"], [role="menu"], [role="dialog"], [data-hushfacebook-web]:not(html)';
const CLICK_GRACE = 600; // ms after letting go when the ending click arrives

export const inReels = (doc) => /^\/reels?\//.test(doc.location?.pathname ?? '');

// The reel video under a point, when the press didn't land on a control.
export function reelAt(doc, target, x, y) {
  if (!target || target.closest?.(CONTROLS)) return null;
  for (const video of doc.querySelectorAll('video')) {
    const rect = video.getBoundingClientRect();
    if (rect.width > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return video;
  }
  return null;
}

export function createHold({ doc, win, enabled, trusted = (event) => event.isTrusted, setTimer = (fn, ms) => win.setTimeout(fn, ms), clearTimer = (id) => win.clearTimeout(id), now = () => Date.now() }) {
  let pending = null; // { video, source, timer }
  let held = null; // { video, source, rate }
  let swallowUntil = null;
  let holds = 0;

  const sourceOf = (video) => video.currentSrc || video.getAttribute('src') || '';
  // Whether a press or a hold still counts: switched on and not paused, on Reels, and the
  // same reel in the player.
  const counts = ({ video, source }) => enabled() && inReels(doc) && video.isConnected && sourceOf(video) === source;

  function begin() {
    const press = pending;
    pending = null;
    if (!counts(press) || press.video.paused) return;
    const { video, source } = press;
    held = { video, source, rate: video.playbackRate };
    video[HOLDING] = true;
    video.playbackRate = FAST;
    video.addEventListener('loadstart', recheck);
    video.addEventListener('emptied', recheck);
    holds++;
  }

  // Letting go of the mouse ends a hold with a click, which is kept from Facebook. A hold that
  // ends because the window lost focus or the press was taken over has no click to keep.
  function release(letGo) {
    if (pending) {
      clearTimer(pending.timer);
      pending = null;
    }
    if (!held) return;
    const { video, rate } = held;
    held = null;
    video.removeEventListener('loadstart', recheck);
    video.removeEventListener('emptied', recheck);
    if (video.playbackRate === FAST) video.playbackRate = rate;
    delete video[HOLDING];
    swallowUntil = letGo ? now() + CLICK_GRACE : null;
  }

  // A change to the settings, the page or the reel in the player.
  function recheck() {
    if ((pending && !counts(pending)) || (held && !counts(held))) release(false);
  }

  function onDown(event) {
    if (!trusted(event) || event.button !== 0 || !enabled() || !inReels(doc)) return;
    const video = reelAt(doc, event.target, event.clientX, event.clientY);
    if (!video) return;
    release(false);
    pending = { video, source: sourceOf(video), timer: setTimer(begin, HOLD_MS) };
  }

  function onClick(event) {
    if (swallowUntil === null || now() > swallowUntil) return;
    swallowUntil = null;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  return {
    start() {
      win.addEventListener('pointerdown', onDown, { capture: true, passive: true });
      win.addEventListener('pointerup', () => release(true), { capture: true, passive: true });
      win.addEventListener('pointercancel', () => release(false), { capture: true, passive: true });
      win.addEventListener('blur', () => release(false));
      win.addEventListener('click', onClick, { capture: true });
    },
    recheck,
    state: () => ({ holding: Boolean(held), holds }),
  };
}

export default {
  id: 'holdForSpeed',
  section: 'reels',
  android: 'Hold a reel for 2x',
  title: 'Hold a reel for 2x',
  description: 'Press and hold the mouse on a reel and it plays at double speed until you let go. A quick click still works as before.',
  default: false,

  setup({ doc, win, router, settings, enabled, diagnostics }) {
    const hold = createHold({ doc, win: win ?? doc.defaultView, enabled });
    hold.start();
    settings?.subscribe?.(() => hold.recheck());
    router?.subscribe?.(() => hold.recheck());
    diagnostics?.add('Reels held for 2x', () => String(hold.state().holds));
  },
};
