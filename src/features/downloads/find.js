// What the Download button saves for a photo or video on the page: which switch it belongs
// to, its id, and what Facebook's data says about it (core/media-index.js).
//
// The id comes from the address when a viewer shows one thing (/reel/<id>, /watch/?v=<id>,
// /photo/?fbid=<id>, /stories/<bucket>/<card>), and otherwise from the links around the
// photo or video in its post. Those ids match the media ids in the data (34 of 34 checked
// live on 2026-10-11).

import { fileName, extensionOf } from '../../core/download.js';
import { normalizeText } from '../../core/dom/visible-text.js';

const POST = '[aria-posinset], [role="article"]';
const MAX_LEVELS = 14;
const LABELS = { downloadVideos: 'video', downloadReels: 'reel', downloadStories: 'story', downloadPhotos: 'photo' };

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
// it can't tell.
export function nearestVideoLink(element) {
  let node = element.parentElement;
  for (let level = 0; node && level < MAX_LEVELS; level++, node = node.parentElement) {
    const ids = new Map();
    for (const link of node.querySelectorAll('a[href]')) {
      const target = linkTarget(link.getAttribute('href'));
      if (target && target.kind !== 'photo' && !ids.has(target.id)) ids.set(target.id, target);
    }
    if (ids.size === 1) return [...ids.values()][0];
    if (ids.size > 1) return null;
    if (node.matches(POST)) return null;
  }
  return null;
}

// The name on the post a photo or video is in, for the file name.
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
    const near = nearestVideoLink(element);
    const target = near ?? (page && page.kind !== 'photo' ? page : null);
    const feature = (target?.kind ?? page?.kind) === 'reel' ? 'downloadReels' : 'downloadVideos';
    const id = target?.id ?? null;
    return { feature, kind: 'video', id, item: asKind(index?.get(id), 'video'), author: authorOf(element), fallback: null };
  }

  // On a photo's own page the address names the photo, but not a picture inside a comment.
  const link = element.closest('a[href]');
  const target = linkTarget(link?.getAttribute('href')) ?? (page?.kind === 'photo' && !element.closest(POST) ? page : null);
  if (target?.kind !== 'photo') return null;
  return { feature: 'downloadPhotos', kind: 'photo', id: target.id, item: asKind(index?.get(target.id), 'photo'), author: authorOf(element), fallback };
}

// The address and file name to save, or { error } saying why there's nothing to save.
// quality: 'best' or 'sd'.
export function planSave(found, { quality = 'best' } = {}) {
  const label = LABELS[found.feature] ?? 'media';
  if (found.kind === 'video') {
    const { item } = found;
    if (!item && !found.id) return { error: "Couldn't tell which video this is. Open it from its post and try again." };
    if (!item) return { error: "Facebook hasn't sent this video's file yet. Let it play for a moment, or open it, and try again." };
    const file = (quality === 'sd' ? item.files.find((f) => f.quality === 'SD') : null) ?? item.files[0];
    if (!file) {
      return { error: item.dash ? 'Facebook only streams this video in small pieces, so there is no single file to save.' : "Facebook didn't send a file for this video." };
    }
    const name = fileName([found.author, label, item.id, file.quality === 'HD' ? 'HD' : null], extensionOf(file.url, 'mp4'));
    return { url: file.url, name, quality: file.quality };
  }
  const url = found.item?.url ?? found.fallback;
  if (!url) return { error: "Couldn't find this photo's file." };
  return { url, name: fileName([found.author, label, found.id ?? found.item?.id], extensionOf(url, 'jpg')) };
}
