import { adRule } from '../feed/ad-markers.js';

export default {
  id: 'hideSponsoredReels',
  section: 'reels',
  android: 'Hide sponsored reels',
  title: 'Hide sponsored reels',
  description: 'Drops the ad breaks Facebook schedules inside videos and reels.',
  default: true,
  needsPage: true,

  setup({ net, enabled }) {
    net.transformResponses(adRule('hideSponsoredReels', enabled));
  },
};
