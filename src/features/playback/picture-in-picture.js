// Picture-in-picture, as Hushfacebook does on Android: a Pop out button on the video or reel
// under the pointer or keyboard focus, in the same floating button as Download (downloads/button.js), one row
// below it. Facebook doesn't turn the browser's picture-in-picture off on its videos (live
// 2026-10-11, no disablepictureinpicture on any player), so the button only has to ask for it.
// Browsers without the picture-in-picture API, like Firefox, have their own button on videos,
// and there the switch shows as unavailable. Works in content mode.

import { createDownloadButton } from '../downloads/button.js';

const POP_OUT_ICON = 'M4 5h16v14H4zM12 12h6v5h-6z';

export function createPopOut({ doc, win, enabled, log, onPopOut }) {
  const button = createDownloadButton({
    doc, win, log,
    name: 'picture-in-picture',
    row: 1,
    icon: POP_OUT_ICON,
    text: (video) => (video && doc.pictureInPictureElement === video ? 'Back to the page' : 'Pop out'),
    busyText: 'Opening',
    failText: "The video couldn't pop out",
    active: enabled,
    find: (media) => (media?.tagName === 'VIDEO' && !media.disablePictureInPicture ? { video: media } : null),
    async run({ video }) {
      if (doc.pictureInPictureElement === video) {
        await doc.exitPictureInPicture();
        return;
      }
      await video.requestPictureInPicture();
      onPopOut?.();
    },
  });
  // The small window can be closed from its own X, so the words follow it.
  doc.addEventListener('enterpictureinpicture', () => button.refresh(), true);
  doc.addEventListener('leavepictureinpicture', () => button.refresh(), true);
  return button;
}

export default {
  id: 'pictureInPicture',
  section: 'playback',
  android: 'Picture-in-picture',
  title: 'Picture-in-picture button',
  description: 'Point at a video or reel, or Tab to it, and a Pop out button shows in its corner. Click it and the video keeps playing in a small window that stays on top while you use other tabs and apps.',
  default: false,

  setup({ doc, win, enabled, log, diagnostics, markUnavailable }) {
    if (!doc.pictureInPictureEnabled || typeof doc.exitPictureInPicture !== 'function') {
      markUnavailable?.('api');
      return;
    }
    let popped = 0;
    createPopOut({ doc, win: win ?? doc.defaultView, enabled, log, onPopOut: () => { popped++; } });
    diagnostics?.add('Videos popped out', () => String(popped));
  },
};
