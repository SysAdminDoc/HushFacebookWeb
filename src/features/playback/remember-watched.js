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
import { WATCHED_KEY, MAX_WATCHED, entryOf, entriesOf, addWatched, clearedAt } from '../../core/watched.js';
export { WATCHED_KEY, MAX_WATCHED, entryOf, entriesOf, addWatched };

export const COUNTS_AFTER = 3; // seconds of playback, or of a story card staying open
const STEP_LIMIT = 1.5; // seconds; a bigger jump in currentTime is a seek, not playback
// What a story's address carries: its bucket and card, as the address has them.
const STORY_PATH = /^\/stories\/([^/?#]+)\/([^/?#]+)/;
const STORY_PART = /^[\w.%=:-]{1,200}$/;

// The address an entry opens, on the Facebook the page is on.
export function linkOf(entry) {
  if (entry.kind === 'reel') return `/reel/${entry.id}/`;
  if (entry.kind === 'video') return `/watch/?v=${entry.id}`;
  return `/stories/${entry.bucket}/${entry.id}/`;
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

export function createWatchList({ doc, storage, enabled, href = () => doc.location.href, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, changed = () => {}, onError = () => {} }) {
  const tracked = new WeakMap(); // video -> { key, played, last, kept }
  let storyTimer = null;
  let saving = false;
  let failed = null;
  let inactive = false;
  const pending = [];

  function drain() {
    if (saving || failed || inactive || !pending.length) return;
    const job = pending[0];
    const success = () => {
      saving = false;
      if (pending[0] === job) pending.shift();
      for (const waiter of job.waiters) waiter.resolve();
      job.waiters = [];
      changed();
      drain();
    };
    const failure = (error) => {
      saving = false;
      if (inactive) return;
      failed = error;
      for (const queued of pending) {
        for (const waiter of queued.waiters) waiter.reject(error);
        queued.waiters = [];
      }
      onError(error);
      changed();
    };
    saving = true;
    try {
      const result = storage.mutate(WATCHED_KEY, { watched: job.operation }, { allowed: () => !inactive });
      if (result && typeof result.then === 'function') result.then(success, failure);
      else success();
    } catch (error) {
      failure(error);
    }
    changed();
  }

  function enqueue(operation) {
    const start = pending.findLastIndex((job) => job.operation.clear !== undefined) + 1;
    let job = operation.add && pending.find((queued, i) => i >= start && (!saving || i > 0)
      && queued.operation.add?.kind === operation.add.kind && queued.operation.add.id === operation.add.id);
    if (!job) { job = { operation, waiters: [] }; pending.push(job); }
    else if (operation.add.at > job.operation.add.at) job.operation = operation;
    const promise = new Promise((resolve, reject) => job.waiters.push({ resolve, reject }));
    // The bound applies to distinct retained watches, not the number of rewatches queued.
    const newest = pending.slice(start).filter((queued) => queued.operation.add)
      .reduce((entries, queued) => addWatched(entries, queued.operation.add), []);
    const retained = new Set(newest.map((entry) => `${entry.kind}:${entry.id}`));
    for (let i = pending.length - 1; i >= start; i--) {
      const item = pending[i];
      if (!item.operation.add || (saving && i === 0) || retained.has(`${item.operation.add.kind}:${item.operation.add.id}`)) continue;
      pending.splice(i, 1);
      for (const waiter of item.waiters) waiter.resolve();
      if (i === 0) failed = null;
    }
    drain();
    return promise;
  }

  function keep(target, extra = {}) {
    const entry = entryOf({ ...extra, ...target, at: now() });
    if (entry && !inactive) void enqueue({ add: entry }).catch(() => {});
  }

  function clear() {
    if (inactive) return Promise.reject(new Error('The Facebook account changed'));
    const before = storage.get(WATCHED_KEY, []);
    if (inactive) return Promise.reject(new Error('The Facebook account changed'));
    const at = Math.max(now(), clearedAt(before), ...entriesOf(before).map((entry) => entry.at), ...pending.map((job) => job.operation.add?.at ?? job.operation.clear ?? 0));
    for (let i = pending.length - 1; i >= (saving ? 1 : 0); i--) {
      for (const waiter of pending[i].waiters) waiter.resolve();
      pending.splice(i, 1);
    }
    failed = null;
    return enqueue({ clear: at });
  }

  function retry() {
    if (inactive) return Promise.reject(new Error('The Facebook account changed'));
    if (!pending.length) return Promise.resolve();
    const result = new Promise((resolve, reject) => pending[pending.length - 1].waiters.push({ resolve, reject }));
    failed = null;
    drain();
    return result;
  }

  storage.onAccountChange?.(() => {
    inactive = true;
    saving = false;
    for (const job of pending.splice(0)) for (const waiter of job.waiters) waiter.reject(new Error('The Facebook account changed'));
    failed = null;
    changed();
  });

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
      doc.addEventListener('visibilitychange', () => { if (!inactive && doc.visibilityState === 'visible') changed(); });
      storage.onChange?.(WATCHED_KEY, () => { if (!inactive) changed(); });
      router?.subscribe?.(onPage);
      onPage();
    },
    entries: () => entriesOf(storage.get(WATCHED_KEY, [])),
    clear,
    retry,
    failed: () => Boolean(failed),
    status: () => failed ? t("Some watched history hasn't saved. Use Retry saving the watched list.") : saving || pending.length ? t('Saving watched history.') : '',
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

  setup({ doc, router, storage, enabled, toast, diagnostics, actions, log, markUnavailable }) {
    if (storage.watchedSupported === false) { markUnavailable?.('api'); return; }
    const list = createWatchList({ doc, storage, enabled, changed: () => diagnostics?.changed(),
      onError: (error) => log?.error("Couldn't save the watched list. Retry saving is in Playback", error),
    });
    list.start(router);
    diagnostics?.add('Watched list', () => String(list.entries().length));
    diagnostics?.status('rememberWatched', list.status);
    actions?.links(() => {
      const now = Date.now();
      return list.entries().map((entry) => describe(entry, now, language().lang));
    }, 'Nothing watched yet.');
    actions?.add(() => (list.failed() ? 'Retry saving the watched list' : ''), () => list.retry());
    actions?.add(() => (list.entries().length ? 'Clear the list' : ''), async () => {
      await list.clear();
      toast?.(t('Cleared the watched list'));
    });
  },
};
