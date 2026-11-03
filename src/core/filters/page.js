// What a filter can look at in a post drawn on the page, for when the post didn't come
// through the data hooks (content mode, or a feed the data rule doesn't cover). The same
// fields as story.js, read from the markup:
//   text     the post text and a link preview's title and description (data-ad-rendering-role
//            story_message, title, description, or data-ad-preview="message")
//   authors  the links in the post's headings (the author, and a shared post's author)
//   alt      img alt text ("May be an image of ...")
//   sites    outbound links, through l.facebook.com or straight
//   kinds    photo (a picture linking to /photo), video (a video, or a reel or watch link),
//            link (an outbound link outside the post text), shared (a second author header:
//            on Home on 2026-10-22, 14 of 14 shares drawn had one and no other post did; a
//            shared link post has only one, so the data rule catches those), live (a video
//            with Facebook's LIVE badge, or a link to a past live video), colored (the post text
//            drawn on a box with its own inline background). The LIVE badge is English, so live
//            posts in other languages are left to the data rule.
//
// Colored, live 2026-11-03 in the groups feed: the text sits in story_message > div > a div whose
// style attribute sets background-color and background-image (a t39.10873 picture, or a plain
// gradient). 5 of 41 posts with text had one, the same 5 the data marked, and no other post,
// there or in 36 on Home, had an inline background anywhere in its text.

import { hostOf } from './story.js';
import { normalizeText, visibleText } from '../dom/visible-text.js';

const TEXT = '[data-ad-rendering-role="story_message"], [data-ad-preview="message"], [data-ad-rendering-role="title"], [data-ad-rendering-role="description"]';
const MESSAGE = '[data-ad-rendering-role="story_message"], [data-ad-preview="message"]';
const COMMENTS = '[role="article"][aria-label]';
const PHOTO = 'a[href*="/photo"] img, a[href*="/photos/"] img';
const VIDEO = 'video, a[href*="/reel/"], a[href*="/watch/"], a[href*="/videos/"]';
const HEADER = '[data-ad-rendering-role="profile_name"]';
// A past live video opens at /watch/live/?v=<id> (live 2026-10-11).
const PAST_LIVE = 'a[href*="/watch/live/"]';
const COLORED = '[style*="background"]';
// The badge on a live video is a leaf that reads LIVE (live 2026-10-22, on the Live tab's player),
// never part of what the post says. Looking at leaves only spares reading every box's text.
const liveBadge = (element) => !element.firstElementChild && element.textContent.trim() === 'LIVE' && !element.closest(MESSAGE);

// Comments are nested role=article elements labeled "Comment by ..."; nothing in them counts.
const inComment = (element, post) => {
  const comment = element.closest(COMMENTS);
  return Boolean(comment && comment !== post && post.contains(comment));
};

export function postFields(post) {
  const own = (selector) => [...post.querySelectorAll(selector)].filter((element) => !inComment(element, post));
  const text = own(TEXT).map((element) => visibleText(element)).filter(Boolean);
  const authors = own('h2 a, h3 a, h4 a, [role="heading"] a').map((a) => normalizeText(a.textContent)).filter(Boolean);
  const alt = own('img[alt]').map((img) => img.getAttribute('alt')).filter((value) => value && value.length > 3);
  const links = own('a[href]');
  const sites = [...new Set(links.map((a) => hostOf(a.href || a.getAttribute('href'))).filter(Boolean))];
  const kinds = new Set();
  if (own(PHOTO).length) kinds.add('photo');
  if (own(VIDEO).length) kinds.add('video');
  if (links.some((a) => hostOf(a.href || a.getAttribute('href')) && !a.closest(MESSAGE))) kinds.add('link');
  if (own(HEADER).length > 1) kinds.add('shared');
  if (own(MESSAGE).some((message) => message.matches(COLORED) || message.querySelector(COLORED))) kinds.add('colored');
  const badge = () => [...post.querySelectorAll('span, div')].some((element) => liveBadge(element) && !inComment(element, post));
  if (own(PAST_LIVE).length || (own('video').length && badge())) kinds.add('live');
  return { text, authors, alt, sites, kinds };
}
