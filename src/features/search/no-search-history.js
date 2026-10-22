// Don't save search history. Facebook's site adds a search to your recent searches with one
// GraphQL mutation, CometAddTypeaheadRecentSearchMutation, sent as you press Enter in the top
// search bar (live 2026-10-22 on the test account, captures/2026-10-22-search: its input is your
// account, the typed text, the picked text and type, and where the search came from). With this
// on, it never leaves the page and Relay gets an empty success, the way Don't send watch history
// holds back watched reels. The results page loads the same either way.

import { EMPTY_SUCCESS } from '../reels/no-watch-history.js';

export const SEARCH_HISTORY_MUTATIONS = new Set(['CometAddTypeaheadRecentSearchMutation']);

export default {
  id: 'noSearchHistory',
  section: 'search',
  android: "Don't save search history",
  title: "Don't save search history",
  description: "Searches you make aren't added to your recent searches on Facebook. Search itself works the same.",
  default: false,
  needsPage: true,

  setup({ net, enabled, diagnostics }) {
    let held = 0;
    net.blockRequests({
      id: 'noSearchHistory',
      startupPrivacy: true,
      enabled,
      match: (ctx) => SEARCH_HISTORY_MUTATIONS.has(ctx.friendlyName),
      fakeResponse: () => {
        held++;
        diagnostics?.changed();
        return EMPTY_SUCCESS;
      },
    });
    diagnostics?.add('Searches held back', () => String(held));
  },
};
