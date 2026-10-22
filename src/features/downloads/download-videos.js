// Download any video, as Hushfacebook's patch does on Android: a Download button on videos in
// the feed, in Watch and on a video's own page. It saves the file Facebook's data lists for
// that video (see shared.js), so it needs page mode.

import { downloads, QUALITY_OPTION } from './shared.js';

export default {
  id: 'downloadVideos',
  section: 'downloads',
  android: 'Download any video',
  title: 'Download any video',
  description: 'Shows a Download button on videos in the feed and in Watch when you point at them or Tab to them. Videos save in HD when Facebook has it, or you can pick smaller files or the sharpest copy Facebook streams.',
  default: false,
  needsPage: true,
  options: [QUALITY_OPTION],

  setup(ctx) {
    downloads(ctx).add('downloadVideos', { enabled: ctx.enabled, quality: () => ctx.option('quality') });
  },
};
