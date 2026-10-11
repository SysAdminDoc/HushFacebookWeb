// Resume long videos, as Hushfacebook does on Android: a long video you stop partway through
// starts where you left it the next time you play it. Positions are kept by the video's id,
// taken from the video's link in its post or from the address on its own page, the same way the
// Download button knows a video (downloads/find.js). Only videos at least as long as the chosen
// length count, and reels and stories are left alone. Works in content mode.
//
// A spot is only kept for a video that has played with sound, so a feed video playing muted
// on its own while you scroll past doesn't leave one behind. Going back to the first half
// minute of a video you were watching forgets its spot, since you started it over.

import { nearestVideoLink, pageTarget } from '../downloads/find.js';

export const POSITIONS_KEY = 'resumeVideos.positions';
export const LENGTHS = [2, 5, 10, 20]; // minutes
const MAX_KEPT = 200;
const SAVE_EVERY = 5; // seconds of playback between saves
export const START_AFTER = 30; // seconds; before this there's nothing worth picking up
export const DONE_WITHIN = 20; // seconds from the end counts as watched
export const STEP_BACK = 3; // seconds played again before the spot, to find your place
const SAME_LENGTH = 2; // seconds of difference allowed between two loads of one video

const isVideo = (node) => node?.tagName === 'VIDEO';

// The id a video's position is kept under, or null for reels, stories and videos the script
// can't name.
export function videoId(video, href) {
  const page = pageTarget(href);
  if (page?.kind === 'story' || page?.kind === 'reel') return null;
  const target = nearestVideoLink(video) ?? (page?.kind === 'video' ? page : null);
  return target?.kind === 'video' ? target.id : null;
}

export function clock(seconds) {
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function createResumer({ doc, storage, enabled, minSeconds, href = () => doc.location.href, now = () => Date.now(), onResume }) {
  const tracked = new WeakMap(); // video -> { id, resumed, saved, done }
  let resumes = 0;

  const kept = () => storage.get(POSITIONS_KEY, {}) ?? {};

  function write(id, seconds, duration) {
    const all = kept();
    if (seconds === null) {
      if (!(id in all)) return;
      delete all[id];
    } else {
      all[id] = { t: Math.floor(seconds), d: Math.round(duration), at: now() };
      const ids = Object.keys(all);
      if (ids.length > MAX_KEPT) {
        for (const old of ids.sort((a, b) => all[a].at - all[b].at).slice(0, ids.length - MAX_KEPT)) delete all[old];
      }
    }
    storage.set(POSITIONS_KEY, all);
  }

  // Facebook can reuse one video element for another video, so the entry follows the id.
  function entry(video) {
    const id = videoId(video, href());
    let found = tracked.get(video);
    if (!found || found.id !== id) {
      found = { id, resumed: false, heard: false, saved: Number.NEGATIVE_INFINITY, done: false, cleared: false };
      tracked.set(video, found);
    }
    return found;
  }

  const long = (video) => Number.isFinite(video.duration) && video.duration >= minSeconds();
  const watching = (event) => isVideo(event.target) && enabled() && long(event.target);
  const audible = (video) => !video.muted && video.volume > 0;

  function onPlaying(event) {
    if (!watching(event)) return;
    const video = event.target;
    const found = entry(video);
    if (!found.id || found.resumed) return;
    found.resumed = true;
    const spot = kept()[found.id];
    if (!spot || Math.abs(spot.d - video.duration) > SAME_LENGTH) return;
    if (spot.t < START_AFTER || spot.t > video.duration - DONE_WITHIN || video.currentTime >= spot.t) return;
    // Never back into the first half minute, which would read as starting over.
    video.currentTime = Math.max(START_AFTER, spot.t - STEP_BACK);
    resumes++;
    onResume?.(spot.t);
  }

  function remember(video, force) {
    const found = entry(video);
    if (!found.id || !found.resumed) return;
    if (!found.heard) {
      if (!audible(video)) return;
      found.heard = true;
    }
    const at = video.currentTime;
    if (at > video.duration - DONE_WITHIN) {
      if (!found.done) write(found.id, null);
      found.done = true;
      return;
    }
    found.done = false;
    if (at < START_AFTER) {
      if (!found.cleared) write(found.id, null);
      found.cleared = true;
      found.saved = Number.NEGATIVE_INFINITY;
      return;
    }
    found.cleared = false;
    if (!force && Math.abs(at - found.saved) < SAVE_EVERY) return;
    found.saved = at;
    write(found.id, at, video.duration);
  }

  const onTime = (event) => watching(event) && remember(event.target, false);
  const onPause = (event) => watching(event) && remember(event.target, true);

  return {
    start() {
      // Media events don't bubble, but they do pass the document on their way in.
      doc.addEventListener('playing', onPlaying, true);
      doc.addEventListener('timeupdate', onTime, true);
      doc.addEventListener('pause', onPause, true);
    },
    forget: () => storage.remove(POSITIONS_KEY),
    count: () => Object.keys(kept()).length,
    resumes: () => resumes,
  };
}

export default {
  id: 'resumeVideos',
  section: 'playback',
  android: 'Resume long videos',
  title: 'Resume long videos',
  description: "A long video you stopped partway through starts where you left it the next time you play it, a few seconds early so you can find your place. Reels and stories aren't kept.",
  default: false,
  options: [
    {
      key: 'minutes', type: 'select', label: 'Count videos longer than', default: 5,
      choices: LENGTHS.map((n) => ({ value: n, label: `${n} minutes` })),
    },
  ],

  setup({ doc, storage, enabled, option, toast, diagnostics, actions }) {
    const resumer = createResumer({
      doc, storage, enabled,
      minSeconds: () => Number(option('minutes') ?? 5) * 60,
      onResume: (seconds) => toast?.(`Picked up where you left off, at ${clock(seconds)}`),
    });
    resumer.start();
    diagnostics?.add('Video spots kept', () => String(resumer.count()));
    diagnostics?.add('Videos picked up', () => String(resumer.resumes()));
    actions?.add('Forget every spot', () => {
      resumer.forget();
      toast?.('Forgot every video spot');
    });
  },
};
