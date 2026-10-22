// Photos and videos Facebook's data describes, by id, with the files that can be saved.
//
// It reads what Facebook's own JSON.parse returns, so nothing is parsed twice (live
// 2026-10-11):
//   Video  videoDeliveryResponseFragment.videoDeliveryResponseResult holds progressive_urls,
//          [{progressive_url, failure_reason, metadata: {quality: 'SD' | 'HD'}}], beside its
//          DASH manifests. All 48 full videos in captured feed answers had both an SD and an HD
//          file, and stories carry the same. Older answers had playable_url_quality_hd and
//          friends on the video itself, which are still read. A video with no file keeps what
//          its manifest offers instead (dash.js), so it can be put together from its pieces.
//   Photo  viewer_image, image or photo_image, each {uri, width, height}. viewer_image is the
//          largest and had a uri on 258 of 418 photos. The rest only had the smaller copies.
//   Story  a card is {id: 'UzpfSVNDOj...', story_card_info, attachments: [{media}]}, and its id
//          is the last part of the story viewer's address. The cards sit in their bucket's
//          unified_stories_with_notes.edges, and the bucket's story_bucket_owner.name is whose
//          story it is (a card's own actors only carry an id).

import { readManifest } from './dash.js';
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

// The short side of a progressive file, in pixels. Its address's efg parameter is base64 JSON
// whose vencode_tag names the width it was coded at ("...C2.720.dash_h264-basic-gen2_720p"),
// on 88 of 88 files in captured feed answers (2026-10-22), and the video's own size gives the
// height. HD kept the short side at 720 and SD at 360, which is the answer without a tag.
export function fileSide(file, width, height) {
  const cap = file.quality === 'HD' ? 720 : 360;
  const coded = codedWidth(file.url);
  if (coded && width && height) return Math.min(coded, Math.round((coded * height) / width));
  if (coded) return Math.min(coded, cap);
  return cap;
}

function codedWidth(url) {
  try {
    const efg = new URL(url).searchParams.get('efg').replace(/ /g, '+');
    return Number(JSON.parse(atob(efg)).vencode_tag.match(/\.C\d+\.(\d+)\./)[1]) || null;
  } catch {
    return null;
  }
}

// The manifest's picture copies sharper than a video's best file, for saving instead of it.
// The manifest's best copy is mostly a 1080p AV1 one where the HD file is 720p (2026-10-22). A
// copy larger than the video itself was blown up from it, so it doesn't count, and neither do
// copies whose size can't be estimated. Null when none are left.
const SHARPER = 1.05; // a pixel or two over the file is rounding, not more detail
function sharperCopies(manifest, file, width, height, length) {
  if (!manifest || !file) return null;
  const side = fileSide(file, width, height);
  const source = width && height ? Math.min(width, height) : Infinity;
  const sideOf = (copy) => (copy.width && copy.height ? Math.min(copy.width, copy.height) : copy.quality);
  const video = manifest.video.filter((copy) => sideOf(copy) > side * SHARPER && sideOf(copy) <= source);
  const duration = manifest.duration ?? length;
  if (!video.length || !(duration > 0) || !video.every((copy) => copy.bandwidth > 0)) return null;
  return { live: false, duration, video, audio: manifest.audio };
}

// The files a video can be saved from, HD first, whether it also streams as DASH, and what its
// manifest offers: with no file, all of it in stream (null when there's no manifest to read),
// and beside a file, the copies sharper than it in sharper. Its file entries say
// NoProgressiveUrlForLive while it's live.
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
  const xml = (Array.isArray(result?.dash_manifests) ? result.dash_manifests : []).find((m) => typeof m?.manifest_xml === 'string')?.manifest_xml ?? video?.dash_manifest;
  const manifest = readManifest(xml);
  // The video's own length when the manifest gives none.
  const length = Number(video?.playable_duration_in_ms) / 1000 || Number(video?.length_in_second) || null;
  let stream = null;
  if (!files.length) {
    const live = Array.isArray(result?.progressive_urls) && result.progressive_urls.some((entry) => /Live/.test(entry?.failure_reason?.type ?? ''));
    if (manifest || live) stream = { video: [], audio: null, ...manifest, duration: manifest?.duration ?? length, live: live || Boolean(manifest?.live) };
  }
  const { width, height } = videoSize(video);
  return { files, dash, stream, sharper: sharperCopies(manifest, files[0], width, height, length) };
}

// The video's own size, as Facebook's data gives it.
function videoSize(video) {
  return { width: Number(video?.original_width ?? video?.width) || null, height: Number(video?.original_height ?? video?.height) || null };
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
    // A video's own page asks for it by id and gets it back as the answer's data with no
    // __typename (live 2026-10-22), so its delivery fragment marks it as a video too.
    if (id && (value.__typename === 'Video' || (value.__typename === undefined && isObject(value.videoDeliveryResponseFragment)))) {
      const { files, dash, stream, sharper } = videoFiles(value);
      const old = items.get(id);
      // A bare reference to a video ({__typename, id}) carries nothing to save. A stream that
      // offers nothing (no whole copies, not live) doesn't replace one that does.
      const usable = (entry) => Boolean(entry && (entry.live || entry.video.length));
      if (files.length || dash || stream) {
        if (!(old?.kind === 'video' && (old.files.length > files.length || (!files.length && usable(old.stream) && !usable(stream))))) {
          put(items, id, { kind: 'video', id, files, dash, stream, sharper, ...videoSize(value) });
        }
      }
    } else if (id && value.__typename === 'Photo') {
      const file = photoFile(value);
      const old = items.get(id);
      // A video's still never replaces the video itself.
      if (file && old?.kind !== 'video' && !(old?.kind === 'photo' && old.width * old.height >= file.width * file.height)) {
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
