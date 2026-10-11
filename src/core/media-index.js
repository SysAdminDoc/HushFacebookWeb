// Photos and videos Facebook's data describes, by id, with the files that can be saved.
//
// It reads what Facebook's own JSON.parse returns, so nothing is parsed twice (live
// 2026-10-11):
//   Video  videoDeliveryResponseFragment.videoDeliveryResponseResult holds progressive_urls,
//          [{progressive_url, failure_reason, metadata: {quality: 'SD' | 'HD'}}], beside its
//          DASH manifests. All 48 full videos in captured feed answers had both an SD and an HD
//          file, and stories carry the same. Older answers had playable_url_quality_hd and
//          friends on the video itself, which are still read.
//   Photo  viewer_image, image or photo_image, each {uri, width, height}. viewer_image is the
//          largest and had a uri on 258 of 418 photos. The rest only had the smaller copies.
//   Story  a card is {id: 'UzpfSVNDOj...', story_card_info, attachments: [{media}]}, and its id
//          is the last part of the story viewer's address. The cards sit in their bucket's
//          unified_stories_with_notes.edges, and the bucket's story_bucket_owner.name is whose
//          story it is (a card's own actors only carry an id).

import { walk } from './json-walk.js';

const MAX_ITEMS = 4000;
const PHOTO_IMAGES = ['viewer_image', 'image', 'photo_image', 'previewImage', 'large_image'];
const LEGACY_VIDEO = [
  ['playable_url_quality_hd', 'HD'],
  ['browser_native_hd_url', 'HD'],
  ['playable_url', 'SD'],
  ['browser_native_sd_url', 'SD'],
];

// Prefilter for the JSON.parse rule: a line without any of these has nothing to index.
export const MEDIA_MARKERS = ['"progressive_url"', '"playable_url', '"browser_native_', '"viewer_image"', '"photo_image"', '"image":{"uri"', '"story_card_info"'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isUrl = (value) => typeof value === 'string' && /^https:\/\//.test(value);

// The files a video can be saved from, HD first, and whether it also streams as DASH.
export function videoFiles(video) {
  const result = video?.videoDeliveryResponseFragment?.videoDeliveryResponseResult;
  const files = [];
  const seen = new Set();
  const add = (url, quality) => {
    if (!isUrl(url) || seen.has(url)) return;
    seen.add(url);
    files.push({ url, quality });
  };
  for (const entry of Array.isArray(result?.progressive_urls) ? result.progressive_urls : []) {
    if (entry?.failure_reason) continue;
    add(entry?.progressive_url, entry?.metadata?.quality === 'HD' ? 'HD' : 'SD');
  }
  for (const source of [video, video?.videoDeliveryLegacyFields]) {
    for (const [key, quality] of LEGACY_VIDEO) add(source?.[key], quality);
  }
  files.sort((a, b) => (a.quality === b.quality ? 0 : a.quality === 'HD' ? -1 : 1));
  const dash = Boolean(result?.dash_manifests?.length || result?.dash_manifest_urls?.length || result?.hls_playlist_urls?.length
    || video?.dash_manifest || video?.playlist);
  return { files, dash };
}

// The largest copy of a photo that has an address.
export function photoFile(photo) {
  let best = null;
  for (const key of PHOTO_IMAGES) {
    const image = photo?.[key];
    if (!isObject(image) || !isUrl(image.uri)) continue;
    const width = Number(image.width) || 0;
    const height = Number(image.height) || 0;
    if (!best || width * height > best.width * best.height) best = { url: image.uri, width, height };
  }
  return best;
}

export function createMediaIndex({ max = MAX_ITEMS } = {}) {
  const items = new Map(); // media id -> { kind, id, ... }
  const cards = new Map(); // story card id -> media id
  const owners = new Map(); // story card id -> whose story it is

  // Newest last, and the oldest go once there are too many.
  const put = (map, key, value) => {
    map.delete(key);
    map.set(key, value);
    if (map.size > max) map.delete(map.keys().next().value);
  };

  function record(value) {
    const id = typeof value.id === 'string' ? value.id : null;
    if (id && value.__typename === 'Video') {
      const { files, dash } = videoFiles(value);
      const old = items.get(id);
      // A bare reference to a video ({__typename, id}) carries nothing to save.
      if (files.length || dash) {
        if (!(old?.kind === 'video' && old.files.length > files.length)) {
          put(items, id, {
            kind: 'video', id, files, dash,
            width: Number(value.original_width ?? value.width) || null,
            height: Number(value.original_height ?? value.height) || null,
          });
        }
      }
    } else if (id && value.__typename === 'Photo') {
      const file = photoFile(value);
      const old = items.get(id);
      if (file && !(old?.kind === 'photo' && old.width * old.height >= file.width * file.height)) {
        put(items, id, { kind: 'photo', id, ...file });
      }
    }
    if (id && 'story_card_info' in value && Array.isArray(value.attachments)) {
      const media = value.attachments.map((attachment) => attachment?.media).find((m) => typeof m?.id === 'string');
      if (media) put(cards, id, media.id);
    }
    const owner = value.story_bucket_owner?.name;
    if (typeof owner === 'string' && Array.isArray(value.unified_stories_with_notes?.edges)) {
      for (const edge of value.unified_stories_with_notes.edges) {
        if (typeof edge?.node?.id === 'string') put(owners, edge.node.id, owner);
      }
    }
  }

  return {
    // Reads every photo, video and story card in a parsed answer.
    scan(doc) {
      walk(doc, (value) => {
        if (!Array.isArray(value)) record(value);
      });
    },
    get: (id) => (id === null || id === undefined ? null : items.get(String(id)) ?? null),
    // What a story card shows, by the id in the story viewer's address, and whose it is.
    card: (cardId) => {
      const item = items.get(cards.get(cardId));
      return item ? { ...item, author: owners.get(cardId) ?? null } : null;
    },
    size: () => items.size,
  };
}
