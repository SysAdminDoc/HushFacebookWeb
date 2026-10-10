import { SPONSORED_MARKERS, pruneSponsoredEdges } from './sponsored.js';

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
      markers: SPONSORED_MARKERS,
      match: (ctx) => ctx.transport === 'json-parse' || ctx.path.startsWith('/api/graphql'),
      transform: (doc) => pruneSponsoredEdges(doc),
    });
  },
};
