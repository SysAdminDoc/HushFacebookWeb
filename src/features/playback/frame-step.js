// Frame step, as Hushfacebook does on Android: with a video or reel paused, Back a frame and Next
// frame buttons show in its corner under the pointer or keyboard focus, in the same floating stack
// as Download and Pop out (downloads/button.js), two rows below them. On Android a tap on the
// picture's sides steps; on the web a click on the picture already plays and pauses it, so these
// are buttons, and there are no keyboard shortcuts. Facebook names no frame rate, so a frame is
// 1/30 second, the rate nearly every Facebook video has (Android's FrameStep.java). A browser
// seeks a paused video to the time asked, so there's no landing to check. Works in content mode.

import { createDownloadButton } from '../downloads/button.js';

export const FRAME = 1 / 30; // seconds
const BACK_ICON = 'M17 6l-8 6 8 6zM7 6v12';
const NEXT_ICON = 'M7 6l8 6-8 6zM17 6v12';

// Where one step from time lands, kept inside the video.
export function stepTime(time, duration, direction) {
  // A length not known yet is NaN, and a live stream's is Infinity.
  const end = duration > 0 ? duration : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(time + direction * FRAME, 0), end);
}

// Only a paused video that has its length and size yet can be stepped. The media under the
// pointer or focus is a photo or a video, and a photo is never paused.
const stoppedVideo = (media) => (media?.paused && media.readyState >= 1 ? { video: media } : null);

export function createFrameStep({ doc, win, enabled, log, onStep }) {
  const make = (direction) => {
    const words = direction < 0 ? 'Back a frame' : 'Next frame';
    return createDownloadButton({
      doc, win, log,
      name: direction < 0 ? 'frame-back' : 'frame-next',
      row: direction < 0 ? 2 : 3,
      icon: direction < 0 ? BACK_ICON : NEXT_ICON,
      text: words,
      busyText: words,
      failText: "The video couldn't move a frame",
      active: enabled,
      find: stoppedVideo,
      async run({ video }) {
        const to = stepTime(video.currentTime, video.duration, direction);
        if (to === video.currentTime) return;
        video.currentTime = to;
        onStep?.(direction);
      },
    });
  };
  const buttons = [make(-1), make(1)];
  // Media events don't bubble, but they do pass the document on their way in. A video that
  // pauses under the pointer gets the buttons without the pointer moving, and one that plays
  // loses them.
  const recheck = (event) => {
    for (const button of buttons) button.recheck(event.target);
  };
  doc.addEventListener('pause', recheck, true);
  doc.addEventListener('play', recheck, true);
  return {
    buttons,
    stop() {
      doc.removeEventListener('pause', recheck, true);
      doc.removeEventListener('play', recheck, true);
      for (const button of buttons) button.stop();
    },
  };
}

export default {
  id: 'frameStep',
  section: 'playback',
  android: 'Frame step',
  title: 'Frame step buttons',
  description: 'Pause a video or reel, then point at it or Tab to it, and Back a frame and Next frame show in its corner. Each click moves the picture one frame and leaves it paused.',
  default: false,

  setup({ doc, win, enabled, log, diagnostics }) {
    let back = 0;
    let forward = 0;
    createFrameStep({
      doc, win: win ?? doc.defaultView, enabled, log,
      onStep: (direction) => {
        if (direction < 0) back++;
        else forward++;
      },
    });
    diagnostics?.add('Frames stepped', () => `${back} back, ${forward} forward`);
  },
};
