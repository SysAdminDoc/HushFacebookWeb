import { adRule } from '../feed/ad-markers.js';

export default {
  id: 'hideSponsoredReels',
  section: 'reels',
  android: 'Hide sponsored reels',
  title: 'Hide sponsored reels',
  description: 'Drops the ad breaks Facebook schedules inside videos and reels.',
  default: true,
  needsPage: true,

  // Only the count goes to Diagnostics. A cleared schedule isn't a hidden post, and the same
  // video comes back in answer after answer, so on the decision list it would push every real
  // decision off within a few minutes of scrolling video.
  setup({ net, enabled, diagnostics }) {
    let breaks = 0;
    net.transformResponses(adRule('hideSponsoredReels', enabled, (ids) => {
      breaks += ids.length;
      diagnostics?.changed();
    }));
    diagnostics?.add('Videos cleared of ad breaks', () => String(breaks));
  },
};
