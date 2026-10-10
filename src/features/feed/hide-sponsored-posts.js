import { SPONSORED_MARKERS, pruneSponsoredEdges } from './sponsored.js';

export default {
  id: 'hideSponsoredPosts',
  section: 'feed',
  android: 'Hide sponsored posts',
  title: 'Hide sponsored posts',
  description: 'Removes sponsored and promoted posts from the news feed, with no gap left behind.',
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
