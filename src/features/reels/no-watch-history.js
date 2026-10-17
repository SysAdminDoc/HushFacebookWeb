// Don't send reel watch history, as Hushfacebook does on Android. Facebook's site reports each
// reel you watch with one GraphQL mutation, FBUnifiedVideoSeenStateMutation, whose input is just
// the video's id and yours (live 2026-10-11, captures/2026-10-11-run17: one per reel over six
// reels, and one for a long video played with sound on its own page, none for a muted feed
// autoplay). With this on, it never leaves the page, and Relay gets an empty success, the way
// View stories anonymously holds back story views. Reels kept moving on and the video kept
// playing with it on.

export const HISTORY_MUTATIONS = new Set(['FBUnifiedVideoSeenStateMutation']);
export const EMPTY_SUCCESS = '{"data":{},"errors":[]}';

export default {
  id: 'noWatchHistory',
  section: 'reels',
  android: "Don't send reel watch history",
  title: "Don't send watch history",
  description: "Facebook isn't told which reels and videos you've watched, so they don't shape what it shows you next. Ones you've already seen can come around again.",
  default: false,
  needsPage: true,

  setup({ net, enabled, diagnostics }) {
    let held = 0;
    net.blockRequests({
      id: 'noWatchHistory',
      startupPrivacy: true,
      enabled,
      match: (ctx) => HISTORY_MUTATIONS.has(ctx.friendlyName),
      fakeResponse: () => {
        held++;
        diagnostics?.changed();
        return EMPTY_SUCCESS;
      },
    });
    diagnostics?.add('Watch reports held back', () => String(held));
  },
};
