// How Hide seen posts recognizes a post again. Facebook's feed links stopped naming the post
// (live 2026-10-11: none of 60 posts on Home and the groups feed had a link with its id, even
// after hovering), and React keeps nothing on the page's elements, so a post is known by what
// it shows instead:
//   m:<id>    a photo or video in it. The id in its /photo/?fbid=, /reel/, /videos/ or
//             watch link is the media id in Facebook's data (34 of 34 checked live).
//   t:<hash>  its first words: the post text as letters and digits only, lowercased, cut to
//             48 characters and hashed, so no post text is stored. Too short a text (under 24
//             letters) gives no key, since "Happy birthday!" would match too much.
// Keys come from the page (when a post is seen) and from the data (to drop a seen post before
// it's drawn), and both sides read them the same way.

import { ownLinks } from './dom/posts.js';
import { normalizeText, visibleText } from './dom/visible-text.js';
import { storyFields } from './filters/story.js';

const TEXT_LENGTH = 48;
const MIN_LETTERS = 24;
const MEDIA_LINKS = [
  /[?&]fbid=(\d{6,})/,
  /\/photos\/[^/?#]+\/(\d{6,})/,
  /\/reels?\/(\d{6,})/,
  /\/videos\/(?:[^/?#]+\/)?(\d{6,})/,
  /\/watch\/?\?(?:[^#]*&)?v=(\d{6,})/,
];
const MEDIA_TYPES = new Set(['Photo', 'Video']);
const MESSAGE = '[data-ad-rendering-role="story_message"], [data-ad-preview="message"]';
const TITLE = '[data-ad-rendering-role="title"]';
const HEADINGS = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
const COMMENTS = '[role="article"][aria-label]';
const SKIP_KEYS = new Set(['feedback', 'comments_disabled_notice_renderer', 'tracking', 'encrypted_tracking']);

// Two FNV-1a passes with different seeds: short, and collisions don't matter at this size.
function fnv(text, seed) {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36);
}

export const squash = (text) => normalizeText(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function textKey(text) {
  const letters = squash(text);
  if (letters.length < MIN_LETTERS) return null;
  const start = letters.slice(0, TEXT_LENGTH);
  return `t:${fnv(start, 2166136261)}${fnv(start, 3735928559)}`;
}

export function mediaIdOf(href) {
  for (const re of MEDIA_LINKS) {
    const found = String(href ?? '').match(re);
    if (found) return found[1];
  }
  return null;
}

// Keys for a post drawn on the page. Links in the post text and the headings point at other
// things, and "See more" isn't part of the text.
export function pageKeys(post) {
  const keys = new Set();
  for (const a of ownLinks(post)) {
    if (a.closest(MESSAGE) || a.closest(HEADINGS)) continue;
    const id = mediaIdOf(a.getAttribute('href'));
    if (id) keys.add(`m:${id}`);
  }
  // Comments are nested role=article elements labeled "Comment by ...".
  const first = (selector) => [...post.querySelectorAll(selector)].find((element) => {
    const comment = element.closest(COMMENTS);
    return !comment || comment === post || !post.contains(comment);
  });
  const holder = first(MESSAGE) ?? first(TITLE);
  if (holder) {
    const text = visibleText(holder, (element) => !element.closest('[role="button"]'));
    const key = textKey(text);
    if (key) keys.add(key);
  }
  return [...keys];
}

const textOf = (holder) => (typeof holder?.text === 'string' && holder.text ? holder.text : null);
// A story's own words, which Facebook repeats in its message and message_container sections.
const messageOf = (story) => textOf(story?.message)
  ?? textOf(story?.comet_sections?.message?.story?.message)
  ?? textOf(story?.comet_sections?.message_container?.story?.message);

// The one text the page keys a post by (live 2026-10-11, 174 stories): the post's own words,
// under comet_sections.content.story, or for a share without any, the shared post's words
// (its attached_story), which the page then shows first. A post with neither shows the first
// title or description of what it links to. Keying only this one text keeps a friend's share
// of a post you've seen, with their own words on top, from counting as seen.
function storyText(node) {
  const content = node?.comet_sections?.content?.story ?? node;
  const own = messageOf(content) ?? messageOf(node);
  if (own) return own;
  const shared = messageOf(content?.attached_story) ?? messageOf(node?.attached_story);
  if (shared) return shared;
  return storyFields({ attachments: content?.attachments ?? node?.attachments }).text[0] ?? null;
}

// Keys for a feed story in Facebook's data: the photos and videos it carries (all of them sit
// under an attachments list, the shared post's included), and the text the page shows first.
export function storyKeys(node) {
  const keys = new Set();
  (function visit(value, depth, attached) {
    if (!value || typeof value !== 'object' || depth > 40) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1, attached);
      return;
    }
    if (attached && MEDIA_TYPES.has(value.__typename) && typeof value.id === 'string' && /^\d{6,}$/.test(value.id)) keys.add(`m:${value.id}`);
    for (const [key, child] of Object.entries(value)) {
      if (!SKIP_KEYS.has(key)) visit(child, depth + 1, attached || key === 'attachments');
    }
  })(node, 0, false);
  const key = textKey(storyText(node));
  if (key) keys.add(key);
  return [...keys];
}
