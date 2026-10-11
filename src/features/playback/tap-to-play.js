// Media waits for a tap. Rather than chase Facebook's player markup, this gates
// HTMLMediaElement.play(): a call goes through when the user just pressed on that media
// (or the element is one they already started), anything else is refused the same way a
// browser's own autoplay block refuses it.
//
// A fresh gesture alone isn't enough. Live (2026-10-10) Chrome reported one right after a
// page load, and any click (the Reels link, "See more") keeps it fresh for about five
// seconds, long enough for Facebook's autoplay to get through. So the press has to land
// inside the media's box, where Facebook's overlay and play button sit, or a key has to be
// pressed on a control right next to it.

const NEARBY_LEVELS = 4;

export function shouldAllowPlay({ activationActive, aimedAtMedia, userStarted }) {
  return userStarted === true || (activationActive === true && aimedAtMedia === true);
}

export function pointInside(rect, point) {
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}

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
  description: 'Videos, reels, stories and music wait for your tap instead of starting by themselves.',
  default: false,

  setup({ win, enabled, log }) {
    const proto = win.HTMLMediaElement?.prototype;
    const play = proto?.play;
    if (typeof play !== 'function') return;
    const started = new WeakSet();
    let lastPress = null;

    const listen = { capture: true, passive: true };
    win.addEventListener('pointerdown', (event) => {
      if (event.isTrusted) lastPress = { point: { x: event.clientX, y: event.clientY } };
    }, listen);
    win.addEventListener('keydown', (event) => {
      if (event.isTrusted) lastPress = { target: event.target };
    }, listen);

    const aimedAt = (media) => {
      if (!lastPress) return false;
      if (lastPress.point) return pointInside(media.getBoundingClientRect(), lastPress.point);
      return isNear(media, lastPress.target);
    };

    proto.play = function () {
      if (!enabled()) return play.apply(this, arguments);
      const activationActive = win.navigator.userActivation?.isActive === true;
      if (!shouldAllowPlay({ activationActive, aimedAtMedia: aimedAt(this), userStarted: started.has(this) })) {
        log.debug('Held back autoplay');
        return win.Promise.reject(new win.DOMException('Waiting for a tap (HushFacebook Web)', 'NotAllowedError'));
      }
      started.add(this);
      return play.apply(this, arguments);
    };
  },
};
