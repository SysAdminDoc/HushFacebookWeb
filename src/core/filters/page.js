// What a filter can look at in a post drawn on the page, for when the post didn't come
// through the data hooks (content mode, or a feed the data rule doesn't cover). The same
// fields as story.js, read from the markup:
//   text     the post text and a link preview's title and description (data-ad-rendering-role
//            story_message, title, description, or data-ad-preview="message")
//   authors  the links in the post's headings (the author, and a shared post's author), and in a
//            group post the member who posted (posterOf)
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
//
// Group posts, in organic-posts.jsonl.gz (2026-11-03, 73 of 100 posts, in the groups feed and on
// Home): the heading link is the group (/groups/<id>/), and the member who posted is a link of its
// own outside the headings (/groups/<id>/user/<id>/), after an avatar link with no words. Every
// one of the 73 had it, above the post text and above a shared post's header. story.js reads that
// member as the post's actor and the group as where it went, so the page check reads them the
// same way. A member link further down is someone else's (a shared post's poster, or a name in
// the text), so a post with none above (posted anonymously or as the group) names nobody.

import { hostOf } from './story.js';
import { normalizeText, visibleText } from '../dom/visible-text.js';

const TEXT = '[data-ad-rendering-role="story_message"], [data-ad-preview="message"], [data-ad-rendering-role="title"], [data-ad-rendering-role="description"]';
const MESSAGE = '[data-ad-rendering-role="story_message"], [data-ad-preview="message"]';
const COMMENTS = '[role="article"][aria-label]';
const PHOTO = 'a[href*="/photo"] img, a[href*="/photos/"] img';
const VIDEO = 'video, a[href*="/reel/"], a[href*="/watch/"], a[href*="/videos/"]';
const HEADER = '[data-ad-rendering-role="profile_name"]';
const HEADINGS = 'h2 a, h3 a, h4 a, [role="heading"] a';
const MEMBER = 'a[href*="/groups/"][href*="/user/"]';
const isGroup = (a) => {
  const href = a.getAttribute('href') ?? '';
  return href.includes('/groups/') && !href.includes('/user/');
};
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

const ownOf = (post) => (selector) => [...post.querySelectorAll(selector)].filter((element) => !inComment(element, post));

// Facebook draws an emoji as <img alt="✨"> from /images/emoji.php/ (system-emoji.js, which keeps
// the alt when it swaps the picture), and textContent leaves it out. A name keeps its emoji, as
// it is in the data and in a name list.
const EMOJI = 'img[src*="/images/emoji.php/"], img[data-hfw-emoji]';
const nameOf = (link) => {
  if (!link.querySelector(EMOJI)) return normalizeText(link.textContent);
  let text = '';
  const walker = link.ownerDocument.createTreeWalker(link, 1 | 4 /* NodeFilter.SHOW_ELEMENT | SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 3) text += node.nodeValue;
    else if (node.matches(EMOJI)) text += node.getAttribute('alt') ?? '';
  }
  return normalizeText(text);
};
const named = (links) => links.find((a) => nameOf(a));

// Who posted, by name, or null: the first named link in the post's first header (or its headings
// when it has no header). When that's a group, the member who posted it instead, never the group,
// and null when the member can't be found.
export function posterOf(post) {
  const own = ownOf(post);
  const header = own(HEADER)[0];
  const first = named(header ? [...header.querySelectorAll('a[href]')] : own(HEADINGS));
  if (!first) return null;
  if (!isGroup(first)) return nameOf(first);
  // Node.DOCUMENT_POSITION_FOLLOWING: the link comes before the text and the second header.
  const stops = [own(TEXT)[0], own(HEADER)[1]].filter(Boolean);
  const member = named(own(MEMBER).filter((a) => stops.every((stop) => a.compareDocumentPosition(stop) & 4)));
  return member ? nameOf(member) : null;
}

export function authorsOf(post) {
  const authors = ownOf(post)(HEADINGS).map(nameOf).filter(Boolean);
  const poster = posterOf(post);
  if (poster && !authors.includes(poster)) authors.push(poster);
  return authors;
}

// Whether the post is drawn as somebody's post yet: a header, a name in its headings or text of
// its own. A feed row that isn't a post (People you may know, group suggestions) names nobody in
// the data.
export function isPost(post) {
  const own = ownOf(post);
  return own(HEADER).length > 0 || own(TEXT).length > 0 || authorsOf(post).length > 0;
}

// A comment as Facebook drew it on 2026-11-04 (three Page post permalinks): a div[role=article]
// labeled "Comment by ..." (posts.js isComment), never inside another one. Its own links come
// avatar (a picture with no words), name, then the timestamp, and its words are in a
// [dir=auto][lang] box, where a link to someone mentioned sits too. None of the
// data-ad-rendering-role boxes a post has are there.
const COMMENT_TEXT = '[dir="auto"][lang]';

// The same fields for a comment: its words, who wrote it, its pictures' alt text and the sites
// it links to. No kinds, since those name kinds of posts.
export function commentFields(comment) {
  const own = ownOf(comment);
  const text = own(COMMENT_TEXT).map((element) => visibleText(element)).filter(Boolean);
  const writer = named(own('a[href]').filter((a) => !a.closest(COMMENT_TEXT)));
  const alt = own('img[alt]').map((img) => img.getAttribute('alt')).filter((value) => value && value.length > 3);
  const sites = [...new Set(own('a[href]').map((a) => hostOf(a.href || a.getAttribute('href'))).filter(Boolean))];
  return { text, authors: writer ? [nameOf(writer)] : [], alt, sites, kinds: new Set() };
}

export function postFields(post) {
  const own = ownOf(post);
  const text = own(TEXT).map((element) => visibleText(element)).filter(Boolean);
  const authors = authorsOf(post);
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
