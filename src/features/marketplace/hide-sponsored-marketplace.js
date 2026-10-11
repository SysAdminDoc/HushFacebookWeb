import { adRule } from '../feed/ad-markers.js';

export default {
  id: 'hideSponsoredMarketplace',
  section: 'marketplace',
  android: 'Hide sponsored Marketplace listings',
  title: 'Hide sponsored Marketplace listings',
  description: 'Takes ad cards out of Marketplace before Facebook draws them. The listings around them stay where they are.',
  default: true,
  needsPage: true,

  setup({ net, enabled }) {
    net.transformResponses(adRule('hideSponsoredMarketplace', enabled));
  },
};
