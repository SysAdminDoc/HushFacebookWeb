// Default playback quality, as Hushfacebook does on Android. Facebook's player streams videos and
// reels in DASH, and the answer that describes a video carries its manifest inline, in
// videoDeliveryResponseResult.dash_manifests[].manifest_xml (captured feed answers, 2026-10-10).
// That manifest lists the video's copies as Representations, each with an FBQualityLabel from
// 240p up, and the player moves between them as your connection allows. The script leaves only
// the copies you chose in the manifest before Facebook reads it: the best one, or nothing above
// a cap to save data. If a video has no copy under the cap, its smallest stays. Sound is left
// alone. Needs the script running in the page.
//
// The same answer lists the copies a second time for Facebook's newer player, in
// extensions.all_video_dash_prefetch_representations (by representation_id, with addresses,
// repeated on every streamed line), and each video names the copy to fetch ahead of time in
// dash_prefetch_experimental. Trimming only the manifest left the long test video at 720p under
// a 360p cap (live 2026-10-11, captures/2026-10-11-run19), so those lists are trimmed to the
// copies the manifest kept, and a prefetch of a dropped copy is moved to the best kept one. A
// video's list can come before its manifest (run21: a related video's 8 copies, then its 720p
// file fetched), and its sizes can't judge it, so it's held back until the manifest has been
// seen. The list repeats on later lines, trimmed by then.

import { walk } from '../../core/json-walk.js';

export const CHOICES = [
  { value: 'highest', label: 'The best it has' },
  { value: '1080', label: 'Up to 1080p' },
  { value: '720', label: 'Up to 720p' },
  { value: '480', label: 'Up to 480p, to save data' },
  { value: '360', label: 'Up to 360p, to save the most data' },
];
export const MARKERS = ['"manifest_xml"', '"dash_manifest"', '"all_video_dash_prefetch_representations"', '"dash_prefetch_experimental"'];
const MAX_REMEMBERED = 5000;

const SET = /<AdaptationSet\b[^>]*>[\s\S]*?<\/AdaptationSet>/g;
const REPRESENTATION = /<Representation\b[^>]*?(?:\/>|>[\s\S]*?<\/Representation>)/g;
const isVideoSet = (set) => /^<AdaptationSet\b[^>]*\bcontentType="video"/.test(set) || /^<AdaptationSet\b[^>]*\bmimeType="video\//.test(set)
  || (!/^<AdaptationSet\b[^>]*\bcontentType=/.test(set) && /<Representation\b[^>]*\bmimeType="video\//.test(set));

// A copy's quality in lines (360 for 360p): Facebook's own label, else the short side of its
// picture. Null when it says neither.
export function qualityOf(representation) {
  const label = representation.match(/\bFBQualityLabel="(\d+)p/);
  if (label) return Number(label[1]);
  const width = Number(representation.match(/\bwidth="(\d+)"/)?.[1]);
  const height = Number(representation.match(/\bheight="(\d+)"/)?.[1]);
  return width && height ? Math.min(width, height) : null;
}

// Which of a video's copies to keep, by their qualities.
export function keepQualities(qualities, choice) {
  const known = qualities.filter((quality) => quality !== null);
  if (!known.length) return qualities.map(() => true);
  if (choice === 'highest') {
    const best = Math.max(...known);
    return qualities.map((quality) => quality === best);
  }
  const cap = Number(choice);
  if (!Number.isFinite(cap)) return qualities.map(() => true);
  const under = known.filter((quality) => quality <= cap);
  const allowed = under.length ? (quality) => quality !== null && quality <= cap : (quality) => quality === Math.min(...known);
  return qualities.map(allowed);
}

const copyId = (representation) => representation.match(/^<Representation\b[^>]*?\bid="([^"]+)"/)?.[1] ?? null;

// What the manifests did with each video copy, by representation id: kept, or dropped with the
// kept copy to fetch instead (the best one left in its set). One book lasts the whole page,
// since a video's prefetch list repeats on every streamed line after its manifest (captured
// feed answer, 2026-10-10).
export function createCopyBook() {
  const kept = new Set();
  const instead = new Map();
  const roomFor = () => {
    if (kept.size + instead.size < MAX_REMEMBERED) return;
    kept.clear();
    instead.clear();
  };
  return {
    instead: (id) => instead.get(id) ?? null,
    known: (id) => kept.has(id) || instead.has(id),
    keep(id) {
      if (!id || kept.has(id)) return;
      roomFor();
      kept.add(id);
      instead.delete(id);
    },
    replace(id, best) {
      if (!id || !best) return;
      roomFor();
      instead.set(id, best);
      kept.delete(id);
    },
  };
}

// The manifest with only the chosen copies in each video set, or the same string when nothing
// had to go. Every video copy goes in the book, kept or dropped.
export function capManifest(xml, choice, book = createCopyBook()) {
  if (typeof xml !== 'string' || !xml.includes('<Representation')) return xml;
  return xml.replace(SET, (set) => {
    if (!isVideoSet(set)) return set;
    const copies = set.match(REPRESENTATION) ?? [];
    const keep = copies.length < 2 ? copies.map(() => true) : keepQualities(copies.map(qualityOf), choice);
    const kept = copies.filter((_, i) => keep[i]);
    const best = copyId(kept[kept.length - 1] ?? '');
    copies.forEach((copy, i) => {
      if (keep[i]) book.keep(copyId(copy));
      else book.replace(copyId(copy), best);
    });
    if (keep.every(Boolean)) return set;
    let index = 0;
    return set.replace(REPRESENTATION, (copy) => (keep[index++] ? copy : ''));
  });
}

const isVideoCopy = (copy) => /^video\//.test(copy?.mime_type ?? '');

// Whether a newer player's list of one video's copies can be judged yet: its manifest has been
// seen. Their width and height can't do it (most copies of a 1080p video say 720x1280).
export function prefetchKnown(entry, book) {
  const video = (entry?.representations ?? []).filter(isVideoCopy);
  return !video.length || video.some((copy) => book.known(copy.representation_id));
}

// That list without the copies its manifest dropped. True when it changed.
export function capPrefetch(entry, book) {
  if (!Array.isArray(entry?.representations)) return false;
  const dropped = (id) => book.instead(id) !== null;
  const before = entry.representations.length;
  entry.representations = entry.representations.filter((copy) => !dropped(copy?.representation_id));
  if (Array.isArray(entry.initial_representation_ids)) {
    entry.initial_representation_ids = entry.initial_representation_ids.map((id) => book.instead(id) ?? id);
  }
  return entry.representations.length !== before;
}

// Every manifest in an answer capped in place, then the prefetch lists and picks that go with
// them. How many manifests changed, and whether anything did.
export function capAnswer(data, choice, book = createCopyBook()) {
  let videos = 0;
  let changed = false;
  const cap = (holder, key) => {
    const before = holder[key];
    const after = capManifest(before, choice, book);
    if (after !== before) {
      holder[key] = after;
      videos++;
      changed = true;
    }
  };
  walk(data, (value) => {
    if (Array.isArray(value.dash_manifests)) {
      for (const entry of value.dash_manifests) if (entry && typeof entry.manifest_xml === 'string') cap(entry, 'manifest_xml');
    }
    if (typeof value.dash_manifest === 'string') cap(value, 'dash_manifest');
  });
  walk(data, (value) => {
    const list = value.all_video_dash_prefetch_representations;
    if (Array.isArray(list)) {
      const ready = list.filter((entry) => prefetchKnown(entry, book));
      if (ready.length !== list.length) {
        value.all_video_dash_prefetch_representations = ready;
        changed = true;
      }
      for (const entry of ready) if (capPrefetch(entry, book)) changed = true;
    }
    const picks = value.dash_prefetch_experimental;
    if (Array.isArray(picks) && picks.some((id) => book.instead(id) !== null)) {
      value.dash_prefetch_experimental = picks.map((id) => book.instead(id) ?? id);
      changed = true;
    }
  });
  return { videos, changed };
}

export default {
  id: 'videoQuality',
  section: 'playback',
  android: 'Default playback quality',
  title: 'Default video quality',
  description: "Videos and reels play at the quality you pick instead of the one Facebook picks for your connection. A video with nothing under your cap plays its smallest copy. It applies to videos Facebook loads after you change it.",
  default: false,
  needsPage: true,
  options: [{ key: 'quality', type: 'select', label: 'Play videos at', default: 'highest', choices: CHOICES }],

  setup({ net, enabled, option, diagnostics }) {
    let videos = 0;
    let book = createCopyBook();
    let bookFor = null;
    net.transformResponses({
      id: 'videoQuality',
      enabled,
      markers: MARKERS,
      // Facebook's own JSON.parse sees every answer and the page's inline data, so one place
      // covers them all.
      match: (ctx) => ctx.transport === 'json-parse',
      transform(data) {
        const choice = option('quality') ?? 'highest';
        // A new choice starts a new book, so copies dropped under the old one come back.
        if (choice !== bookFor) {
          book = createCopyBook();
          bookFor = choice;
        }
        const result = capAnswer(data, choice, book);
        videos += result.videos;
        if (result.videos) diagnostics?.changed();
        return result.changed;
      },
    });
    diagnostics?.add('Videos set to your quality', () => String(videos));
  },
};
