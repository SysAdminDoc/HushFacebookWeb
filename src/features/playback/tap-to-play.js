// Media waits for a tap. Rather than chase Facebook's player markup, this gates
// HTMLMediaElement.play(): a call made while the page has a fresh user gesture (or on an
// element the user already started) goes through, anything else is refused the same way
// a browser's own autoplay block refuses it.

export function shouldAllowPlay({ activationActive, userStarted }) {
  return activationActive === true || userStarted === true;
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

    proto.play = function () {
      if (!enabled()) return play.apply(this, arguments);
      const activationActive = win.navigator.userActivation?.isActive === true;
      if (!shouldAllowPlay({ activationActive, userStarted: started.has(this) })) {
        log.debug('Held back autoplay');
        return win.Promise.reject(new win.DOMException('Waiting for a tap (HushFacebook Web)', 'NotAllowedError'));
      }
      started.add(this);
      return play.apply(this, arguments);
    };
  },
};
