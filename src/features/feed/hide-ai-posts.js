// Hide AI-detected posts, as Hushfacebook's patch does on Android: posts Facebook labels as
// made with AI come out of Home, your groups feed and search results before they're drawn,
// along with shares of them. The label is a section of the story's header in Facebook's data
// (ad-markers.js, row genai_label), so this works from the data only and needs page mode.
// A post opened from its link, a profile and a group you're browsing are left alone. One Facebook
// drew on the server stays in the data and is hidden on the page (drawn-posts.js).

import { adRule } from './ad-markers.js';
import { hideDrawnPosts } from './drawn-posts.js';

export default {
  id: 'hideAiPosts',
  section: 'feed',
  android: 'Hide AI-detected posts',
  title: 'Hide AI-detected posts',
  description: 'Hides posts Facebook labels as made with AI, and shares of them, from Home, your groups feed and search results. It goes by the AI info label, whether Facebook detected it or the author added it.',
  default: false,
  needsPage: true,

  setup({ net, router, posts, hider, settings, diagnostics, enabled }) {
    let dropped = 0;
    if (net) {
      // One word: the hider lists a post's reasons in its mark, split on spaces.
      const onDrawn = hideDrawnPosts({ posts, hider, router, settings, enabled, reason: 'AI-labeled', onHide: () => {
        dropped++;
        diagnostics?.changed();
      } });
      net.transformResponses(adRule('hideAiPosts', enabled, (fired) => {
        dropped += fired.length;
        diagnostics?.changed();
      }, { route: () => router?.current(), diagnostics, reason: 'AI label', onDrawn }));
    }
    diagnostics?.add('AI-labeled posts taken out of the data', () => (net ? String(dropped) : "Off: the script can't reach the page's data"));
  },
};
