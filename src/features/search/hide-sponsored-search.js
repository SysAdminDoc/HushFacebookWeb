import { adRule } from '../feed/ad-markers.js';

export default {
  id: 'hideSponsoredSearch',
  section: 'ads',
  android: 'Hide sponsored search results',
  title: 'Hide sponsored search results',
  description: 'Takes the ads out of search results before Facebook draws them.',
  default: true,
  needsPage: true,

  setup({ net, enabled, diagnostics }) {
    net.transformResponses(adRule('hideSponsoredSearch', enabled, undefined, { diagnostics, reason: 'Sponsored result' }));
  },
};
