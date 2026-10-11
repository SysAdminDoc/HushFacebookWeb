import { adRule } from '../feed/ad-markers.js';

export default {
  id: 'hideSponsoredReels',
  section: 'reels',
  android: 'Hide sponsored reels',
  title: 'Hide sponsored reels',
  description: 'Drops the ad breaks Facebook schedules inside videos and reels.',
  default: true,
  needsPage: true,

  setup({ net, enabled, diagnostics }) {
    let breaks = 0;
    net.transformResponses(adRule('hideSponsoredReels', enabled, (ids) => {
      breaks += ids.length;
      diagnostics?.changed();
    }));
    diagnostics?.add('Videos cleared of ad breaks', () => String(breaks));
  },
};
