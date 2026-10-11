// Hold a reel for 2x, as Hushfacebook does on Android: press and hold on a reel and it plays at
// double speed until you let go. Facebook's reel viewer shows no play button and keeps its
// controls on screen (live 2026-10-11), so a press anywhere on the picture that isn't on one of
// its buttons or the progress bar counts. The click that ends a hold is kept from Facebook, so
// letting go doesn't also pause the reel. Works in content mode.

import { HOLDING } from './keep-speed.js';

export const HOLD_MS = 350;
export const FAST = 2;
const CONTROLS = 'a, button, input, [role="button"], [role="slider"], [role="link"], [role="menu"], [role="dialog"]';
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
  let pending = null; // { video, timer }
  let held = null; // { video, rate }
  let swallowUntil = null;
  let holds = 0;

  function begin() {
    const { video } = pending;
    pending = null;
    if (!video.isConnected || video.paused) return;
    held = { video, rate: video.playbackRate };
    video[HOLDING] = true;
    video.playbackRate = FAST;
    holds++;
  }

  function release() {
    if (pending) {
      clearTimer(pending.timer);
      pending = null;
    }
    if (!held) return;
    const { video, rate } = held;
    held = null;
    video.playbackRate = rate;
    delete video[HOLDING];
    swallowUntil = now() + CLICK_GRACE;
  }

  function onDown(event) {
    if (!trusted(event) || event.button !== 0 || !enabled() || !inReels(doc)) return;
    const video = reelAt(doc, event.target, event.clientX, event.clientY);
    if (!video) return;
    release();
    pending = { video, timer: setTimer(begin, HOLD_MS) };
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
      win.addEventListener('pointerup', release, { capture: true, passive: true });
      win.addEventListener('pointercancel', release, { capture: true, passive: true });
      win.addEventListener('blur', release);
      win.addEventListener('click', onClick, { capture: true });
    },
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

  setup({ doc, win, enabled, diagnostics }) {
    const hold = createHold({ doc, win: win ?? doc.defaultView, enabled });
    hold.start();
    diagnostics?.add('Reels held for 2x', () => String(hold.state().holds));
  },
};
