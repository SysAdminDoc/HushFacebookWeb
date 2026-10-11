import { AD_MARKER_TEXT, pruneAds } from './ad-markers.js';

export default {
  id: 'hideSponsoredPosts',
  section: 'feed',
  android: 'Hide sponsored posts',
  title: 'Hide sponsored posts',
  description: 'Removes ads from the news feed, Marketplace and search results before Facebook draws them.',
  default: true,
  needsPage: true,

  setup({ net, enabled }) {
    net.transformResponses({
      id: 'hideSponsoredPosts',
      enabled,
      markers: AD_MARKER_TEXT,
      match: (ctx) => ctx.transport === 'json-parse' || ctx.path.startsWith('/api/graphql'),
      transform: (doc) => pruneAds(doc).length > 0,
    });
  },
};
