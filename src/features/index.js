// Every feature, in settings order. A feature module exports:
//   id          settings key and stable identity (never rename once shipped)
//   section     one of SECTIONS in sections.js
//   android     the Hushfacebook patch it matches (docs/feature-parity.md)
//   title, description, default
//   needsPage   true when it hooks Facebook's window (skipped in content-script mode)
//   reload      true when a change only applies after Facebook reloads
//   options     extra settings: [{ key, type: toggle|select|text|number, label, default, choices? }]
//   css         string, or (get) => string, applied while the feature is on
//   setup(ctx)  runs once at document-start
//               ctx = { win, doc, net, router, posts, hider, diagnostics, log, settings, enabled, option }
//               net is null in content mode (needsPage features never get that far)
//               diagnostics.add('Row label', () => 'value') adds a Diagnostics row (src/core/diagnostics.js)
//               posts.on('post/add' | 'post/update' | 'post/remove' | 'reset', fn) (src/core/dom/posts.js)
//               hider.hide(post.element, 'Reason', 'detail'), hider.show(element) (src/core/dom/hide.js)

import hideSponsoredPosts from './feed/hide-sponsored-posts.js';
import hideSuggestedPosts from './feed/hide-suggested-posts.js';
import hideReelsInFeed from './feed/hide-reels-in-feed.js';
import hideStoriesTray from './feed/hide-stories-tray.js';
import hideSponsoredReels from './reels/hide-sponsored-reels.js';
import anonymousStories from './stories/anonymous-stories.js';
import hideSponsoredSearch from './search/hide-sponsored-search.js';
import hideSponsoredMarketplace from './marketplace/hide-sponsored-marketplace.js';
import sanitizeLinks from './links/sanitize-links.js';
import directLinks from './links/direct-links.js';
import tapToPlay from './playback/tap-to-play.js';
import limitHdr from './playback/hdr-brightness.js';
import followingFeed from './opening/following-feed.js';

export const features = [
  hideSponsoredPosts, hideSuggestedPosts, hideReelsInFeed, hideStoriesTray,
  hideSponsoredReels, anonymousStories, hideSponsoredSearch, hideSponsoredMarketplace,
  sanitizeLinks, directLinks, tapToPlay, limitHdr, followingFeed,
];
