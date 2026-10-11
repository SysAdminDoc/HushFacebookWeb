// Download any photo, as Hushfacebook's patch does on Android: a Download button on any photo
// you point at, saving the largest copy Facebook sent (see shared.js). Without the page's data
// (content mode) it saves the copy on screen.

import { downloads } from './shared.js';

export default {
  id: 'downloadPhotos',
  section: 'downloads',
  android: 'Download any photo',
  title: 'Download any photo',
  description: 'Shows a Download button on photos in posts and in the photo viewer when you point at them. It saves the largest copy Facebook sent.',
  default: true,

  setup(ctx) {
    downloads(ctx).add('downloadPhotos', { enabled: ctx.enabled });
  },
};
