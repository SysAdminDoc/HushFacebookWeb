// What a filter can look at in one feed story from Facebook's data (live 2026-10-11, 137
// Home stories): its text, its authors, Facebook's alt text for its pictures, the sites it
// links to, and what kind of post it is. A shared post's attached story counts as part of the
// post. The comments under it don't.
//
//   text     message.text, title.text, description.text (message_container, attachments,
//            reels' fb_shorts_story)
//   authors  actors[].name, and to.name: the group a post was made in (81 of 137)
//   alt      media.accessibility_caption ("May be an image of ...")
//   sites    external_url, web_link.url and action_links[].url that leave Facebook
//   kinds    photo (StoryAttachmentPhotoStyleRenderer, Album, AlbumFrame), video
//            (UnifiedLightweightVideo, FBReels, Video), link (Share), colored
//            (text_format_metadata with a background), shared (an attached_story: the post
//            that was shared, on 79 of 622 Home stories in saved answers), live (a Video
//            Facebook marks as a broadcast: broadcast_status LIVE and is_live_streaming while
//            it's on, is_video_broadcast after it ends too; live 2026-10-22)

import { isOutbound, unshim } from '../url.js';

const TEXT_HOLDERS = new Set(['message', 'title', 'description', 'title_with_entities']);
const LINK_KEYS = new Set(['external_url', 'url']);
const SKIP_KEYS = new Set(['feedback', 'comments_disabled_notice_renderer', 'easy_hide_button_story', 'tracking', 'encrypted_tracking']);
const KINDS = new Map([
  ['StoryAttachmentPhotoStyleRenderer', 'photo'],
  ['StoryAttachmentAlbumStyleRenderer', 'photo'],
  ['StoryAttachmentAlbumFrameStyleRenderer', 'photo'],
  ['StoryAttachmentUnifiedLightweightVideoStyleRenderer', 'video'],
  ['StoryAttachmentFBReelsStyleRenderer', 'video'],
  ['StoryAttachmentVideoStyleRenderer', 'video'],
  ['StoryAttachmentShareStyleRenderer', 'link'],
]);
const MAX_DEPTH = 40;

export function hostOf(href) {
  const target = unshim(href) ?? href;
  if (!isOutbound(target)) return null;
  try {
    return new URL(target).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function storyFields(node) {
  const text = new Set();
  const authors = new Set();
  const alt = new Set();
  const sites = new Set();
  const kinds = new Set();

  (function visit(value, key, parentKey, depth) {
    if (!value || typeof value !== 'object' || depth > MAX_DEPTH) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, parentKey, depth + 1);
      return;
    }
    if (TEXT_HOLDERS.has(key) && typeof value.text === 'string') text.add(value.text);
    if ((key === 'actors' || key === 'to') && typeof value.name === 'string') authors.add(value.name);
    if (typeof value.accessibility_caption === 'string') alt.add(value.accessibility_caption);
    if (KINDS.has(value.__typename)) kinds.add(KINDS.get(value.__typename));
    if (key === 'attached_story') kinds.add('shared');
    if (value.__typename === 'Video' && (value.broadcast_status === 'LIVE' || value.is_live_streaming === true || value.is_video_broadcast === true)) kinds.add('live');
    if (key === 'text_format_metadata' && (value.background_color || value.preset_id || value.background_image)) kinds.add('colored');
    for (const [childKey, child] of Object.entries(value)) {
      if (SKIP_KEYS.has(childKey)) continue;
      if (typeof child === 'string') {
        if (LINK_KEYS.has(childKey) && /^https?:/i.test(child)) {
          const host = hostOf(child);
          if (host) sites.add(host);
        }
        continue;
      }
      visit(child, childKey, key, depth + 1);
    }
  })(node, null, null, 0);

  return { text: [...text], authors: [...authors], alt: [...alt], sites: [...sites], kinds };
}
