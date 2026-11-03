// Issue #1 asked for the videos Facebook suggests around the one you're watching to go away. Live
// 2026-11-03 signed in, a video opened from a Page lands on /watch/?v=<id>, the only page left that
// draws #watch_feed (/watch/ itself goes to a reel, and the Video bar's Live, Explore and Saved
// pages don't use it). Its one child holds the chosen video's section first (the player, then its
// post, comments and comment box beside it), then a section of suggested videos, one
// div[data-virtualized] post each. When the chosen video ends, Facebook scrolls down to the first
// suggestion and plays it. The chosen video's comments are data-virtualized too, so what hides is a
// later section holding them, and a section shaped any other way stays. A vertical video's page
// (/<page>/videos/<id>/) loops beside its comments and suggests nothing. CSS only, so it works in
// content mode. Live with the rule on, in both modes, the video's end leaves the page where it was,
// the one suggestion drawn stays paused at 0, and no more load since nothing scrolls them in.

export const SUGGESTIONS = '#watch_feed > div > div ~ div:has([data-virtualized])';

export default {
  id: 'hideVideoSuggestions',
  section: 'playback',
  webOnly: true,
  title: 'Hide suggested videos under a video',
  description: "When a video opens on its own page, the videos Facebook lines up under it go away, so the page stays on yours when it ends. The video, its post and comments stay.",
  default: false,
  css: `${SUGGESTIONS} { display: none !important; }`,
};
