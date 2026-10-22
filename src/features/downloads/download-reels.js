// Download any reel, as Hushfacebook's patch does on Android: a Download button on reels, in
// the reels viewer and in the feed (see shared.js). It needs page mode.

import { downloads, QUALITY_OPTION } from './shared.js';

export default {
  id: 'downloadReels',
  section: 'downloads',
  android: 'Download any reel',
  title: 'Download any reel',
  description: 'Shows a Download button on reels when you point at them or Tab to them. Reels save in HD when Facebook has it, or you can pick smaller files or the sharpest copy Facebook streams.',
  default: true,
  needsPage: true,
  options: [QUALITY_OPTION],

  setup(ctx) {
    downloads(ctx).add('downloadReels', { enabled: ctx.enabled, quality: () => ctx.option('quality') });
  },
};
