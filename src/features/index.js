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
//               ctx = { win, net, router, log, settings, enabled, option }

import hideSponsoredPosts from './feed/hide-sponsored-posts.js';
import anonymousStories from './stories/anonymous-stories.js';
import sanitizeLinks from './links/sanitize-links.js';
import directLinks from './links/direct-links.js';
import tapToPlay from './playback/tap-to-play.js';
import limitHdr from './playback/hdr-brightness.js';
import followingFeed from './opening/following-feed.js';

export const features = [hideSponsoredPosts, anonymousStories, sanitizeLinks, directLinks, tapToPlay, limitHdr, followingFeed];
