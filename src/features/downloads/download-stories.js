// Download any story, as Hushfacebook's patch does on Android: a Download button on the story
// you're watching, photo or video (see shared.js).
// The story is found by the card id in the viewer's address. It needs page mode.

import { downloads, QUALITY_OPTION } from './shared.js';

export default {
  id: 'downloadStories',
  section: 'downloads',
  android: 'Download any story',
  title: 'Download any story',
  description: "Shows a Download button on the story you're watching when you point at it or Tab to it. Videos save in the best quality Facebook offers unless you pick smaller files.",
  default: true,
  needsPage: true,
  options: [QUALITY_OPTION],

  setup(ctx) {
    downloads(ctx).add('downloadStories', { enabled: ctx.enabled, quality: () => ctx.option('quality') });
  },
};
