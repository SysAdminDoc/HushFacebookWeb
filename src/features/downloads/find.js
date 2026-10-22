// What the Download button saves for a photo or video on the page: which switch it belongs
// to, its id, and what Facebook's data says about it (core/media-index.js).
//
// The id comes from the address when a viewer shows one thing (/reel/<id>, /watch/?v=<id>,
// /photo/?fbid=<id>, /stories/<bucket>/<card>), and otherwise from the links around the
// photo or video in its post. Those ids match the media ids in the data (34 of 34 checked
// live on 2026-10-11). The address only names the page's own viewer, never a photo or video
// in a comment or a post below it.

import { pickCopies } from '../../core/dash.js';
import { fileName, extensionOf } from '../../core/download.js';
import { isComment } from '../../core/dom/posts.js';
import { normalizeText } from '../../core/dom/visible-text.js';

const POST = '[aria-posinset], [role="article"]';
// A link to a comment names the post or video the comment is on, not anything in the comment.
const COMMENT_LINK = /[?&](?:reply_comment_id|comment_id)=/;
const MAX_LEVELS = 14;
const LABELS = { downloadVideos: 'video', downloadReels: 'reel', downloadStories: 'story', downloadPhotos: 'photo' };
// A video put together from its pieces is held whole in the tab twice over (both copies, then
// the joined file), so a copy whose estimate runs past this steps down to a smaller one.
export const STREAM_LIMIT = 750e6;

// What a link or address points at: a reel, a video or a photo, with its id.
export function linkTarget(href) {
  const text = String(href ?? '');
  let found = text.match(/\/reels?\/(\d{6,})/);
  if (found) return { kind: 'reel', id: found[1] };
  // A past live video opens at /watch/live/?v=<id> (live 2026-10-11).
  found = text.match(/\/videos\/(?:[^/?#]+\/)?(\d{6,})/) ?? text.match(/\/(?:watch(?:\/live)?|video\.php)\/?\?(?:[^#]*&)?v=(\d{6,})/);
  if (found) return { kind: 'video', id: found[1] };
  found = text.match(/\/photo(?:\.php)?\/?\?(?:[^#]*&)?fbid=(\d{6,})/) ?? text.match(/\/photos\/[^/?#]+\/(\d{6,})/);
  if (found) return { kind: 'photo', id: found[1] };
  return null;
}

export function pageTarget(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const story = url.pathname.match(/^\/stories\/[^/]+\/([^/?#]+)/);
  if (story) {
    try {
      return { kind: 'story', card: decodeURIComponent(story[1]) };
    } catch {
      return { kind: 'story', card: story[1] };
    }
  }
  return linkTarget(url.pathname + url.search);
}

// The video or reel link nearest a video in its post. Each step out takes in more of the
// post. The first step that reaches any such link decides, and two different ids there mean
// it can't tell. Only the post's own links count, not ones in its comments or a post inside
// it, and for a video in no post, only links in no post either.
export function nearestVideoLink(element) {
  // Links in a comment or another post are about that one.
  const home = element.closest(POST);
  let node = element.parentElement;
  for (let level = 0; node && level < MAX_LEVELS; level++, node = node.parentElement) {
    const ids = new Map();
    for (const link of node.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href');
      if (COMMENT_LINK.test(href) || link.closest(POST) !== home) continue;
      const target = linkTarget(href);
      if (target && target.kind !== 'photo' && !ids.has(target.id)) ids.set(target.id, target);
    }
    if (ids.size === 1) return [...ids.values()][0];
    if (ids.size > 1) return null;
    if (node.matches(POST)) return null;
  }
  return null;
}

// Whether a video is the page's own player, which the address names. A video in a feed post
// or a comment is some other video, even on a video's own page, so it never gets that id.
function pagePlayer(element) {
  if (element.closest('[aria-posinset]')) return false;
  const article = element.closest('[role="article"]');
  return !article || (!isComment(article) && !article.parentElement?.closest('[role="article"]'));
}

// The video or reel a video element plays: the nearest link in its post, or on a video or
// reel's own page the address, for that page's player only. Download and Resume long videos
// both name videos this way.
export function videoTarget(element, page) {
  const near = nearestVideoLink(element);
  if (near) return near;
  return (page?.kind === 'video' || page?.kind === 'reel') && pagePlayer(element) ? page : null;
}

// The name on the post a photo or video is in, for the file name. A video's own page has no
// post around its player, so its file is named after the video's owner instead (findMedia).
export function authorOf(element) {
  const post = element.closest(POST);
  if (!post) return null;
  const heading = [...post.querySelectorAll('h2, h3, h4')].find((h) => h.closest(POST) === post);
  const name = heading?.querySelector('a, strong, span') ?? heading;
  const text = normalizeText(name?.textContent ?? '');
  return text && text.length <= 80 ? text : null;
}

// The largest address the page itself has for an image.
export function imageSource(img) {
  let best = null;
  for (const part of (img.getAttribute('srcset') ?? '').split(',')) {
    const [url, size] = part.trim().split(/\s+/);
    const width = Number.parseFloat(size) || 0;
    if (url && (!best || width > best.width)) best = { url, width };
  }
  return best?.url ?? img.currentSrc ?? img.getAttribute('src') ?? null;
}

const asKind = (item, kind) => (item?.kind === kind ? item : null);

// { feature, kind: 'video' | 'photo', id, item, author, fallback } or null when it isn't
// something the switches save (a profile picture, a link preview, an emoji).
export function findMedia(element, { href, index }) {
  const tag = element?.tagName;
  if (tag !== 'VIDEO' && tag !== 'IMG') return null;
  const page = pageTarget(href);
  const fallback = tag === 'IMG' ? imageSource(element) : null;

  if (page?.kind === 'story') {
    const item = index?.card(page.card) ?? null;
    const kind = item?.kind ?? (tag === 'VIDEO' ? 'video' : 'photo');
    return { feature: 'downloadStories', kind, id: item?.id ?? null, item, author: item?.author ?? null, fallback };
  }

  if (tag === 'VIDEO') {
    const target = videoTarget(element, page);
    const feature = (target?.kind ?? page?.kind) === 'reel' ? 'downloadReels' : 'downloadVideos';
    const id = target?.id ?? null;
    const author = authorOf(element) ?? index?.ownerName(id) ?? null;
    return { feature, kind: 'video', id, item: asKind(index?.get(id), 'video'), author, fallback: null };
  }

  // On a photo's own page the address names the photo, but not a picture inside a comment.
  const link = element.closest('a[href]');
  const target = linkTarget(link?.getAttribute('href')) ?? (page?.kind === 'photo' && !element.closest(POST) ? page : null);
  if (target?.kind !== 'photo') return null;
  return { feature: 'downloadPhotos', kind: 'photo', id: target.id, item: asKind(index?.get(target.id), 'photo'), author: authorOf(element), fallback };
}

// A video put together from a picture copy and its sound, or the picture alone when it's silent.
function joinedPlan(found, label, item, pick) {
  const name = fileName([found.author, label, item.id, `${pick.video.quality}p`], 'mp4');
  const plan = { name, quality: `${pick.video.quality}p` };
  return pick.audio ? { ...plan, parts: [pick.video.url, pick.audio.url] } : { ...plan, url: pick.video.url };
}

// The address and file name to save, or { error, params } saying why there's nothing to save.
// A video Facebook only streams comes as parts instead of an address: its picture and its
// sound, to be joined. quality: 'best', 'sd', or 'sharpest', which joins a streamed copy
// sharper than the HD file when there's one that fits, and otherwise is 'best'.
export function planSave(found, { quality = 'best', limit = STREAM_LIMIT } = {}) {
  const label = LABELS[found.feature] ?? 'media';
  if (found.kind === 'video') {
    const { item } = found;
    if (!item && !found.id) return { error: "Couldn't tell which video this is. Open it from its post and try again." };
    if (!item) return { error: "Facebook hasn't sent this video's file yet. Let it play for a moment, or open it, and try again." };
    if (quality === 'sharpest' && item.sharper) {
      const pick = pickCopies(item.sharper, { limit });
      if (pick?.video) return joinedPlan(found, label, item, pick);
    }
    const file = (quality === 'sd' ? item.files.find((f) => f.quality === 'SD') : null) ?? item.files[0];
    if (!file) {
      const { stream } = item;
      if (stream?.live) return { error: 'This video is live. Facebook has a file to save once it ends.' };
      const pick = stream ? pickCopies(stream, { quality, limit }) : null;
      if (pick?.tooBig) return { error: "This video is too long to put together in the browser (about {size} MB at its smallest).", params: { size: Math.round(pick.tooBig / 1e6) } };
      if (pick) return joinedPlan(found, label, item, pick);
      return { error: item.dash ? 'Facebook only streams this video in small pieces, so there is no single file to save.' : "Facebook didn't send a file for this video." };
    }
    const name = fileName([found.author, label, item.id, file.quality === 'HD' ? 'HD' : null], extensionOf(file.url, 'mp4'));
    return { url: file.url, name, quality: file.quality };
  }
  const url = found.item?.url ?? found.fallback;
  if (!url) return { error: "Couldn't find this photo's file." };
  return { url, name: fileName([found.author, label, found.id ?? found.item?.id], extensionOf(url, 'jpg')) };
}
