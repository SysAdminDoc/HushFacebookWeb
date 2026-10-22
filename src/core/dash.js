// The copies a video's DASH manifest offers, for saving a video Facebook sends no single file
// for. A manifest for a video that has ended is static and lists each copy as one whole file
// (a BaseURL with a SegmentBase byte index), the picture and the sound apart: 176 of 176 in
// captured feed answers (2026-10-22), with AV1 or VP9 pictures from 240p up to 1440p and
// HE-AAC sound, and no sound set at all on a silent video. A live video's manifest is dynamic,
// a template of two-second pieces that only covers the last few seconds, and its file
// entries say NoProgressiveUrlForLive. Those were the only videos with no file to save.

const SET = /<AdaptationSet\b[^>]*?(?:\/>|>[\s\S]*?<\/AdaptationSet>)/g;
const REPRESENTATION = /<Representation\b[^>]*?(?:\/>|>[\s\S]*?<\/Representation>)/g;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const attribute = (tag, name) => tag.match(new RegExp(`^<[A-Za-z]+\\b[^>]*?\\s${name}="([^"]*)"`))?.[1] ?? null;
const unescape = (text) => text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ENTITIES[name]);

// PT1H2M3.5S as seconds, or null.
export function durationOf(text) {
  const found = String(text ?? '').match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!found || found[0] === 'PT') return null;
  return Number(found[1] ?? 0) * 3600 + Number(found[2] ?? 0) * 60 + Number(found[3] ?? 0);
}

function kindOf(set, representation) {
  const mime = attribute(representation, 'mimeType') ?? attribute(set, 'mimeType') ?? '';
  const content = attribute(set, 'contentType') ?? mime.split('/')[0];
  return content === 'video' || content === 'audio' ? content : null;
}

// A copy's whole file: its one absolute BaseURL, and a byte index rather than a template.
function fileOf(representation) {
  if (!/<SegmentBase\b/.test(representation) || /<SegmentTemplate\b|<SegmentList\b/.test(representation)) return null;
  const bases = [...representation.matchAll(/<BaseURL\b[^>]*>([^<]*)<\/BaseURL>/g)];
  if (bases.length !== 1) return null;
  const url = unescape(bases[0][1].trim());
  return /^https:\/\//.test(url) ? url : null;
}

// { live, duration, video, audio } where video is every whole-file picture copy, best first, and
// audio the best sound copy or null. Null for anything that isn't a DASH manifest.
export function readManifest(xml) {
  if (typeof xml !== 'string') return null;
  const mpd = xml.match(/<MPD\b[^>]*>/)?.[0];
  if (!mpd) return null;
  const live = attribute(mpd, 'type') === 'dynamic';
  const video = [];
  const audio = [];
  for (const [set] of xml.matchAll(SET)) {
    // An encrypted copy would join into a file nothing can play. None turned up in captures.
    if (/<ContentProtection\b/.test(set)) continue;
    const head = set.match(/^<AdaptationSet\b[^>]*>/)[0];
    for (const [representation] of set.matchAll(REPRESENTATION)) {
      const tag = representation.match(/^<Representation\b[^>]*>/)[0];
      const kind = kindOf(head, tag);
      const url = live ? null : fileOf(representation);
      if (!kind || !url) continue;
      const width = Number(attribute(tag, 'width')) || null;
      const height = Number(attribute(tag, 'height')) || null;
      const label = Number(attribute(tag, 'FBQualityLabel')?.match(/^(\d+)p/)?.[1]);
      const copy = { url, codecs: attribute(tag, 'codecs'), bandwidth: Number(attribute(tag, 'bandwidth')) || 0 };
      if (kind === 'video') video.push({ ...copy, width, height, quality: label || (width && height ? Math.min(width, height) : 0) });
      else audio.push(copy);
    }
  }
  video.sort((a, b) => b.quality - a.quality || b.bandwidth - a.bandwidth);
  audio.sort((a, b) => b.bandwidth - a.bandwidth);
  // A static manifest gives its length on the MPD or, failing that, on its Period.
  const period = xml.match(/<Period\b[^>]*>/)?.[0];
  const duration = durationOf(attribute(mpd, 'mediaPresentationDuration')) ?? (period ? durationOf(attribute(period, 'duration')) : null);
  return { live, duration, video, audio: audio[0] ?? null };
}

// The picture copy to save: the best one, or for 'sd' the best at 480p or under (the smallest
// when there's none), stepping down while the estimate is over limit bytes. Returns
// { video, audio, bytes } or { tooBig: bytes } with the smallest copy's estimate. With no
// length or a copy with no bandwidth there's no estimate, so it takes the 'sd' copy and bytes
// is null.
export function pickCopies(manifest, { quality = 'best', limit = Infinity } = {}) {
  const known = manifest.duration > 0 && manifest.video.every((copy) => copy.bandwidth > 0);
  const sizeOf = (copy) => Math.ceil(((copy.bandwidth + (manifest.audio?.bandwidth ?? 0)) / 8) * manifest.duration);
  let choices = manifest.video;
  if (!choices.length) return null;
  if (quality === 'sd' || !known) {
    const small = choices.filter((copy) => copy.quality <= 480);
    choices = small.length ? small : choices.slice(-1);
  }
  if (!known) return { video: choices[0], audio: manifest.audio, bytes: null };
  const fits = choices.find((copy) => sizeOf(copy) <= limit);
  if (!fits) return { tooBig: sizeOf(choices[choices.length - 1]) };
  return { video: fits, audio: manifest.audio, bytes: sizeOf(fits) };
}
