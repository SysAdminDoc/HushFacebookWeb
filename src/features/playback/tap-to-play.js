// Media waits for a tap. Rather than chase Facebook's player markup, this gates
// HTMLMediaElement.play(): a call goes through when the user just pressed on that media
// (or the element still has the file they started on it), anything else is refused the same way a
// browser's own autoplay block refuses it.
//
// A fresh gesture alone isn't enough. Live (2026-10-10) Chrome reported one right after a
// page load, and any click (the Reels link, "See more") keeps it fresh for about five
// seconds, long enough for Facebook's autoplay to get through. So the press has to land
// inside the media's box, where Facebook's overlay and play button sit, or a key has to be
// pressed on a control right next to it.
//
// Reels and the story viewer are different: they show one thing at a time, and getting to it
// is always the person's own doing (a link that opened the viewer, its address, the arrows,
// the arrow keys, the wheel). Live 2026-10-12 (Matt's report): held there, the reel the Next
// arrow moved to sat frozen on its first frame with no play button, and so did the first reel
// after opening Reels from Facebook's menu, whose row isn't over the video. Facebook draws no
// play button for a reel it couldn't start, so it read as broken. In a viewer a start now
// goes ahead soon after a press, key or wheel, and so does the first reel or story the
// viewer plays after it opens (Facebook swaps /reel/?s=tab for the first reel's own address
// as it opens, so this goes by time, not address). A start with neither, like Facebook
// resuming a reel when you come back to the tab or a story moving on by itself, still waits.
//
// A start counts for the file the element was playing then, not for the element. Facebook
// reuses one video element for another video, and that next video waits like any other.

const NEARBY_LEVELS = 4;
export const VIEWER_INPUT_MS = 5000;
export const VIEWER_OPEN_MS = 15000;

export const isViewer = (route) => route?.type === 'reel' || route?.type === 'stories';

export function shouldAllowPlay({ activationActive, aimedAtMedia, userStarted, inViewer = false, sinceInput = Infinity, openedHere = false }) {
  if (userStarted === true || (activationActive === true && aimedAtMedia === true)) return true;
  return inViewer === true && (sinceInput <= VIEWER_INPUT_MS || openedHere === true);
}

export function pointInside(rect, point) {
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}

// What an element is set to play: its src, its <source> children or a stream object.
// Seeking, looping and trying again leave it the same.
export function resourceOf(media) {
  const sources = [...(media.children ?? [])].filter((child) => child.tagName === 'SOURCE').map((child) => child.getAttribute('src'));
  return { src: media.getAttribute('src'), sources: JSON.stringify(sources), object: media.srcObject ?? null };
}

export const sameResource = (a, b) => Boolean(a && b) && a.src === b.src && a.sources === b.sources && a.object === b.object;

function isNear(media, target) {
  for (let node = media, level = 0; node && level < NEARBY_LEVELS; node = node.parentElement, level++) {
    if (node.contains(target)) return true;
  }
  return false;
}

export default {
  id: 'tapToPlay',
  section: 'playback',
  android: 'Tap to play',
  title: 'Tap to play',
  description: "Videos and music wait for your tap instead of starting by themselves. In Reels and stories, the one you open or skip to plays, and nothing starts on its own.",
  default: false,

  setup({ win, router, enabled, log, now = Date.now }) {
    const proto = win.HTMLMediaElement?.prototype;
    const play = proto?.play;
    if (typeof play !== 'function') return;
    const started = new WeakMap(); // element -> what it was playing when it was allowed to start
    let lastPress = null;
    let lastInput = -Infinity;
    // The viewer that's open, when it opened, and whether its first start has played yet.
    let opened = null;
    const route = () => router?.current();
    const open = (current) => {
      opened = isViewer(current) ? { type: current.type, at: now(), played: false } : null;
    };
    open(route());
    router?.subscribe((current) => {
      // Moving from reel to reel inside the viewer isn't opening it again.
      if (!isViewer(current) || opened?.type !== current.type) open(current);
    });

    const listen = { capture: true, passive: true };
    win.addEventListener('pointerdown', (event) => {
      if (!event.isTrusted) return;
      lastPress = { point: { x: event.clientX, y: event.clientY } };
      lastInput = now();
    }, listen);
    win.addEventListener('keydown', (event) => {
      if (!event.isTrusted) return;
      lastPress = { target: event.target };
      lastInput = now();
    }, listen);
    win.addEventListener('wheel', (event) => {
      if (event.isTrusted) lastInput = now();
    }, listen);

    const aimedAt = (media) => {
      if (!lastPress) return false;
      if (lastPress.point) return pointInside(media.getBoundingClientRect(), lastPress.point);
      return isNear(media, lastPress.target);
    };

    proto.play = function () {
      if (!enabled()) return play.apply(this, arguments);
      const activationActive = win.navigator.userActivation?.isActive === true;
      const inViewer = isViewer(route());
      const first = inViewer && opened && !opened.played && now() - opened.at <= VIEWER_OPEN_MS ? opened : null;
      const resource = resourceOf(this);
      const allowed = shouldAllowPlay({
        activationActive,
        aimedAtMedia: aimedAt(this),
        userStarted: sameResource(started.get(this), resource),
        inViewer,
        sinceInput: now() - lastInput,
        openedHere: Boolean(first),
      });
      if (!allowed) {
        log.debug('Held back autoplay');
        return win.Promise.reject(new win.DOMException('Waiting for a tap (HushFacebook Web)', 'NotAllowedError'));
      }
      started.set(this, resource);
      const result = play.apply(this, arguments);
      // Once something in the viewer plays, its first start is used. A start Facebook drops
      // (a reel swapped for another copy of itself) leaves it for the next one.
      const viewer = inViewer ? opened : null;
      if (viewer && !viewer.played) result?.then?.(() => { viewer.played = true; }, () => {});
      return result;
    };
  },
};
