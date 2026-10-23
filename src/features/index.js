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
//               ctx = { win, doc, net, router, posts, hider, diagnostics, actions, storage, log, toast, openSettings,
//                       settings, enabled, option }
//               net is null in content mode (needsPage features never get that far)
//               diagnostics.add('Row label', () => 'value') adds a Diagnostics row (src/core/diagnostics.js)
//               actions.add('Button label', run) puts a button on the feature's card (src/core/actions.js)
//               actions.links(get, 'Shown when empty') lists links on the card
//               storage.get(key, fallback) / storage.set(key, value): GM storage beside the settings.
//               Keys in ACTIVITY_KEYS (src/core/activity.js) are kept for each account
//               toast('Message', { tone: 'error' }): a short note at the bottom of the page
//               openSettings(sectionId?): opens the settings panel, at that section if given
//               posts.on('post/add' | 'post/update' | 'post/remove' | 'reset', fn) (src/core/dom/posts.js)
//               hider.hide(post.element, 'Reason', 'detail'), hider.show(element) (src/core/dom/hide.js)

import hideSponsoredPosts from './feed/hide-sponsored-posts.js';
import hideSuggestedPosts from './feed/hide-suggested-posts.js';
import hideReelsInFeed from './feed/hide-reels-in-feed.js';
import hideStoriesTray from './feed/hide-stories-tray.js';
import hidePostsByWords from './feed/filters.js';
import hideSeenPosts from './feed/hide-seen-posts.js';
import hideAiPosts from './feed/hide-ai-posts.js';
import keepPostDates from './feed/post-dates.js';
import keepFeedPlace from './feed/keep-feed-place.js';
import hideFollowButtons from './feed/hide-follow-buttons.js';
import hideCounts from './feed/hide-counts.js';
import expandLongPosts from './feed/expand-long-posts.js';
import holdBackLogs from './privacy/usage-logs.js';
import hideSponsoredReels from './reels/hide-sponsored-reels.js';
import noWatchHistory from './reels/no-watch-history.js';
import cleanUpReels from './reels/clean-up-reels.js';
import anonymousStories from './stories/anonymous-stories.js';
import stopStoryAdvance from './stories/stop-advance.js';
import hideSponsoredSearch from './search/hide-sponsored-search.js';
import noSearchHistory from './search/no-search-history.js';
import hideSponsoredMarketplace from './marketplace/hide-sponsored-marketplace.js';
import sellerProfileLink from './marketplace/seller-profile.js';
import hideReadReceipts from './chats/hide-read-receipts.js';
import hideTyping from './chats/hide-typing.js';
import hideNotificationKinds from './notifications/hide-kinds.js';
import commentOrder from './comments/comment-order.js';
import showAllReplies from './comments/show-all-replies.js';
import hideCommentStickers from './comments/hide-comment-stickers.js';
import hideVideoCommentBox from './comments/hide-video-comment-box.js';
import hideCommentTyping from './comments/hide-comment-typing.js';
import hideIncomingCommentTyping from './comments/hide-incoming-typing.js';
import tagsAfterAt from './comments/tags-after-at.js';
import commentsAsWritten from './comments/comments-as-written.js';
import sanitizeLinks from './links/sanitize-links.js';
import directLinks from './links/direct-links.js';
import shareSheet from './links/share-sheet.js';
import tapToPlay from './playback/tap-to-play.js';
import limitHdr from './playback/hdr-brightness.js';
import resumeVideos from './playback/resume-videos.js';
import keepSpeed from './playback/keep-speed.js';
import keepVolume from './playback/keep-volume.js';
import rememberWatched from './playback/remember-watched.js';
import holdForSpeed from './playback/hold-for-speed.js';
import pictureInPicture from './playback/picture-in-picture.js';
import frameStep from './playback/frame-step.js';
import keepControls from './playback/keep-controls.js';
import videoQuality from './playback/video-quality.js';
import marketplaceOnly from './opening/marketplace-only.js';
import openOnTab from './opening/open-on-tab.js';
import followingFeed from './opening/following-feed.js';
import messengerPage from './opening/messenger-page.js';
import downloadPhotos from './downloads/download-photos.js';
import downloadVideos from './downloads/download-videos.js';
import downloadReels from './downloads/download-reels.js';
import downloadStories from './downloads/download-stories.js';
import forceDarkMode from './appearance/force-dark.js';
import amoledTheme from './appearance/amoled.js';
import accentColor from './appearance/accent.js';
import systemFont from './appearance/system-font.js';
import systemEmoji from './appearance/system-emoji.js';
import noTransitions from './appearance/no-transitions.js';
import hideTabs from './appearance/hide-tabs.js';
import hideTabBadges from './appearance/hide-tab-badges.js';
import hideNewMessageButton from './appearance/hide-new-message.js';
import screenshotMode from './appearance/screenshot-mode.js';
import hideMenuPromotions from './menu/hide-menu-promotions.js';
import menuEntry from './menu/menu-entry.js';
import hideMetaUpsells from './meta/hide-meta-upsells.js';
import hidePromotions from './meta/hide-promotions.js';
import customCss from './appearance/custom-css.js';
import blockInstantGamesAds from './games/block-ads.js';

export const features = [
  hideSponsoredPosts, hideSuggestedPosts, hideReelsInFeed, hideStoriesTray, hidePostsByWords, hideSeenPosts, hideAiPosts, keepPostDates, keepFeedPlace, hideFollowButtons, hideCounts, expandLongPosts,
  hideSponsoredReels, noWatchHistory, cleanUpReels, anonymousStories, stopStoryAdvance, hideSponsoredSearch, noSearchHistory, hideSponsoredMarketplace, sellerProfileLink, hideReadReceipts, hideTyping, hideNotificationKinds, holdBackLogs,
  commentOrder, showAllReplies, hideCommentStickers, hideVideoCommentBox, hideCommentTyping, hideIncomingCommentTyping, tagsAfterAt, commentsAsWritten, sanitizeLinks, directLinks, shareSheet, downloadPhotos, downloadVideos, downloadReels, downloadStories, tapToPlay, limitHdr, resumeVideos,
  keepSpeed, keepVolume, holdForSpeed, pictureInPicture, frameStep, keepControls, videoQuality, rememberWatched,
  forceDarkMode, amoledTheme, accentColor, systemFont, systemEmoji, noTransitions, hideTabs, hideTabBadges, hideNewMessageButton, screenshotMode,
  menuEntry, hideMenuPromotions, hideMetaUpsells, hidePromotions, blockInstantGamesAds,
  // In this order: the first to claim a Home load redirects it (opening/start.js).
  marketplaceOnly, openOnTab, followingFeed, messengerPage,
  // Last, so its rules come after every built-in style.
  customCss,
];
