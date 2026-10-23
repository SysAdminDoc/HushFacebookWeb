// Remember what you watch, as Hushfacebook does on Android: a list of the reels, videos and
// stories you watched, newest first, so one that went away when the feed refreshed can be opened
// again. With Don't send watch history on, Facebook's own list stays empty, so this one is the
// only record. It's kept in script storage for each account (core/activity.js), never in
// localStorage, and Copy report never reads it.
//
// A reel or video counts once it's played three seconds under the same id. One on its own page
// counts muted too, but one in the feed has to have played with sound, so a video that starts by
// itself while you scroll past isn't listed. Stories count by the address: a card still open
// three seconds after it showed, which takes in photo stories, since they have no video.
// Watching one again moves it to the top.

import { language, t } from '../../core/i18n.js';
import { authorOf, pageTarget, videoTarget } from '../downloads/find.js';

export const WATCHED_KEY = 'rememberWatched.list';
export const MAX_WATCHED = 50; // core/activity.js and extension/isolated.js take the same limit
export const COUNTS_AFTER = 3; // seconds of playback, or of a story card staying open
const STEP_LIMIT = 1.5; // seconds; a bigger jump in currentTime is a seek, not playback
const KINDS = ['reel', 'video', 'story'];
// What a story's address carries: its bucket and card, as the address has them.
const STORY_PATH = /^\/stories\/([^/?#]+)\/([^/?#]+)/;
const STORY_PART = /^[\w.%=:-]{1,200}$/;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// An entry as it's kept, or null when it isn't one: { kind, id, at } and, when known, the
// poster's name (owner), the video's length in seconds (length) and a story's bucket.
export function entryOf(value) {
  if (!isRecord(value) || !KINDS.includes(value.kind) || typeof value.id !== 'string' || !Number.isFinite(value.at) || value.at <= 0) return null;
  const story = value.kind === 'story';
  if (story ? !(STORY_PART.test(value.id) && typeof value.bucket === 'string' && STORY_PART.test(value.bucket)) : !/^\d{6,30}$/.test(value.id)) return null;
  const entry = { kind: value.kind, id: value.id, at: value.at };
  if (story) entry.bucket = value.bucket;
  if (typeof value.owner === 'string' && value.owner.trim() && value.owner.length <= 80) entry.owner = value.owner;
  if (Number.isFinite(value.length) && value.length > 0) entry.length = Math.round(value.length);
  return entry;
}

// The kept list, newest first, without anything that isn't an entry.
export const entriesOf = (value) => (Array.isArray(value) ? value.map(entryOf).filter(Boolean) : []);

// The address an entry opens, on the Facebook the page is on.
export function linkOf(entry) {
  if (entry.kind === 'reel') return `/reel/${entry.id}/`;
  if (entry.kind === 'video') return `/watch/?v=${entry.id}`;
  return `/stories/${entry.bucket}/${entry.id}/`;
}

// The list with entry at the top, one entry for each reel, video or story, and the oldest gone
// past the limit.
export function addWatched(list, entry) {
  const same = (other) => other.kind === entry.kind && other.id === entry.id;
  return [entry, ...entriesOf(list).filter((other) => !same(other))].slice(0, MAX_WATCHED);
}

export function storyOf(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const found = url.pathname.match(STORY_PATH);
  return found && STORY_PART.test(found[1]) && STORY_PART.test(found[2]) ? { kind: 'story', bucket: found[1], id: found[2] } : null;
}

export function createWatchList({ doc, storage, enabled, href = () => doc.location.href, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  const tracked = new WeakMap(); // video -> { key, played, last, kept }
  let storyTimer = null;

  function keep(target, extra = {}) {
    const entry = entryOf({ ...extra, ...target, at: now() });
    if (entry) storage.set(WATCHED_KEY, addWatched(storage.get(WATCHED_KEY, []), entry));
  }

  // The reel or video a video element plays, and whether it's the page's own player.
  function targetOf(video) {
    const page = pageTarget(href());
    if (page?.kind === 'story') return null;
    const target = videoTarget(video, page);
    if (target?.kind !== 'reel' && target?.kind !== 'video') return null;
    const own = (page?.kind === 'reel' || page?.kind === 'video') && page.id === target.id;
    return { target: { kind: target.kind, id: target.id }, own };
  }

  // Facebook can reuse one video element for the next reel, so the count follows the id.
  function onTime(event) {
    const video = event.target;
    if (video?.tagName !== 'VIDEO' || !enabled()) return;
    const found = targetOf(video);
    if (!found) return;
    const key = `${found.target.kind}:${found.target.id}`;
    let state = tracked.get(video);
    if (!state || state.key !== key) {
      state = { key, played: 0, last: video.currentTime, kept: false };
      tracked.set(video, state);
      return;
    }
    const step = video.currentTime - state.last;
    state.last = video.currentTime;
    if (state.kept || video.paused || !(step > 0 && step <= STEP_LIMIT)) return;
    if (!found.own && (video.muted || !(video.volume > 0))) return;
    state.played += step;
    if (state.played < COUNTS_AFTER) return;
    state.kept = true;
    const length = Number.isFinite(video.duration) ? video.duration : undefined;
    keep(found.target, { owner: authorOf(video) ?? undefined, length });
  }

  // A story card counts once it's still the one open a few seconds later, in a tab you can see.
  function onPage() {
    const story = storyOf(href());
    if (storyTimer !== null) clearTimer(storyTimer);
    storyTimer = null;
    if (!story) return;
    const at = href();
    storyTimer = setTimer(() => {
      storyTimer = null;
      if (!enabled() || href() !== at || doc.visibilityState === 'hidden') return;
      keep(story);
    }, COUNTS_AFTER * 1000);
  }

  return {
    start(router) {
      // Media events don't bubble, but they do pass the document on their way in.
      doc.addEventListener('timeupdate', onTime, true);
      router?.subscribe?.(onPage);
      onPage();
    },
    entries: () => entriesOf(storage.get(WATCHED_KEY, [])),
    clear: () => storage.remove(WATCHED_KEY),
  };
}

const kindLabel = (kind) => (kind === 'reel' ? t('Reel') : kind === 'video' ? t('Video') : t('Story'));

function clock(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// How long ago, in the panel's language: "5 minutes ago", "yesterday".
export function ago(at, now, lang = 'en') {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  const steps = [[60, 'second', 1], [3600, 'minute', 60], [86400, 'hour', 3600], [604800, 'day', 86400], [Infinity, 'week', 604800]];
  const [, unit, size] = steps.find(([limit]) => seconds < limit);
  try {
    return new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }).format(-Math.floor(seconds / size), unit);
  } catch {
    return new Date(at).toLocaleString();
  }
}

// What the card shows for an entry: the poster's name when it's known, or its kind, then its
// kind, length and when.
export function describe(entry, now, lang) {
  const kind = kindLabel(entry.kind);
  const parts = [entry.owner ? kind : null, entry.length ? clock(entry.length) : null, ago(entry.at, now, lang)].filter(Boolean);
  return { label: entry.owner ?? kind, detail: parts.join(' · '), href: linkOf(entry) };
}

export default {
  id: 'rememberWatched',
  section: 'playback',
  android: 'Remember what you watch',
  title: 'Remember what you watch',
  description: "Lists the last 50 reels, videos and stories you watched, so one the feed took away is easy to open again. A video in the feed counts once it's played with sound. The list stays in this browser for each Facebook account, and Copy report leaves it out.",
  default: false,

  setup({ doc, router, storage, enabled, toast, diagnostics, actions }) {
    const list = createWatchList({ doc, storage, enabled });
    list.start(router);
    diagnostics?.add('Watched list', () => String(list.entries().length));
    actions?.links(() => {
      const now = Date.now();
      return list.entries().map((entry) => describe(entry, now, language().lang));
    }, 'Nothing watched yet.');
    actions?.add(() => (list.entries().length ? 'Clear the list' : ''), () => {
      list.clear();
      toast?.(t('Cleared the watched list'));
    });
  },
};
