import { adRule } from './ad-markers.js';

export default {
  id: 'hideSponsoredPosts',
  section: 'feed',
  android: 'Hide sponsored posts',
  title: 'Hide sponsored posts',
  description: 'Removes ads from the news feed before Facebook draws them.',
  default: true,
  needsPage: true,

  setup({ net, enabled }) {
    net.transformResponses(adRule('hideSponsoredPosts', enabled));
  },
};
