// Facebook learns a story was seen from one GraphQL mutation. It never leaves the page;
// Relay gets an empty success instead, the same reply the open source
// anonymous-facebook-story-seen extension gives.

export const SEEN_MUTATIONS = new Set(['storiesUpdateSeenStateMutation']);

export default {
  id: 'anonymousStories',
  section: 'stories',
  android: 'View stories anonymously',
  title: 'View stories anonymously',
  description: "Keeps you off the viewer list of stories you watch, because Facebook isn't told which ones you've seen. Replying or reacting still shows you.",
  default: false,
  needsPage: true,

  setup({ net, enabled }) {
    net.blockRequests({
      id: 'anonymousStories',
      startupPrivacy: true,
      enabled,
      match: (ctx) => SEEN_MUTATIONS.has(ctx.friendlyName),
      fakeResponse: () => '{"data":{},"errors":[]}',
    });
  },
};
