// Hide AI-detected posts, as Hushfacebook's patch does on Android: posts Facebook labels as
// made with AI come out of Home, your groups feed and search results before they're drawn,
// along with shares of them. The label is a section of the story's header in Facebook's data
// (ad-markers.js, row genai_label), so this works from the data only and needs page mode.
// A post opened from its link, a profile and a group you're browsing are left alone.

import { adRule } from './ad-markers.js';

export default {
  id: 'hideAiPosts',
  section: 'feed',
  android: 'Hide AI-detected posts',
  title: 'Hide AI-detected posts',
  description: 'Hides posts Facebook labels as made with AI, and shares of them, from Home, your groups feed and search results. It goes by the AI info label, whether Facebook detected it or the author added it.',
  default: false,
  needsPage: true,

  setup({ net, router, diagnostics, enabled }) {
    let dropped = 0;
    if (net) {
      net.transformResponses(adRule('hideAiPosts', enabled, (fired) => {
        dropped += fired.length;
        diagnostics?.changed();
      }, { route: () => router?.current() }));
    }
    diagnostics?.add('AI-labeled posts taken out of the data', () => (net ? String(dropped) : "Off: the script can't reach the page's data"));
  },
};
