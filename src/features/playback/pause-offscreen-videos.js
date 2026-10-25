// Feed playback can continue after scrolling past a video. Observe only videos in tracked
// feed posts, and give each media resource a fresh second outside the viewport before pausing.
// Nothing here starts playback, including when a video returns to view.

import { CANDIDATE_SELECTOR } from '../../core/dom/posts.js';
import { resourceOf, sameResource } from './tap-to-play.js';

export const OFFSCREEN_MS = 1000;
export const inFeed = (route) => Boolean(route) && !route.permalink && (route.type === 'home' || route.type === 'groups');
const MEDIA_EVENTS = ['play', 'playing', 'pause', 'ended', 'loadstart', 'emptied'];
const PLAYER_EVENTS = ['fullscreenchange', 'webkitfullscreenchange', 'enterpictureinpicture', 'leavepictureinpicture'];

export function createOffscreenPauser({ doc, win = doc.defaultView, posts, enabled, route,
  setTimer = (fn, ms) => win.setTimeout(fn, ms), clearTimer = (id) => win.clearTimeout(id), log }) {
  const videos = new Map(); // video -> its post, resource, observer and pending pause
  const feedPosts = new Map();
  let running = false;
  let mutations = null;
  let stops = [];

  const active = () => {
    const current = route();
    // Content-mode routing polls. A changed address must stop an old timer before that poll.
    return enabled() && inFeed(current) && current.href === doc.location.href;
  };
  const owner = (node) => feedPosts.get(node?.closest?.(CANDIDATE_SELECTOR));
  const same = (video, found) => sameResource(found.resource, resourceOf(video)) && found.currentSrc === video.currentSrc;
  const exempt = (video) => {
    const full = doc.fullscreenElement ?? doc.webkitFullscreenElement;
    return doc.pictureInPictureElement === video || video.webkitDisplayingFullscreen === true ||
      Boolean(full && (full === video || full.contains(video)));
  };
  const counts = (video, post) => active() && video.isConnected && feedPosts.get(post.element) === post &&
    owner(video) === post && !video.closest('[role="dialog"], [aria-modal="true"]') && !exempt(video);

  function cancel(found) {
    if (found?.timer === null || !found) return;
    clearTimer(found.timer);
    found.timer = null;
  }

  function forget(video) {
    const found = videos.get(video);
    if (!found) return;
    cancel(found);
    found.observer.disconnect();
    videos.delete(video);
  }

  function arm(video, found) {
    if (!found.offscreen || found.timer !== null || video.paused || video.ended) return;
    const timer = setTimer(() => {
      if (videos.get(video) !== found || found.timer !== timer) return;
      // Re-entry can have a queued record whose callback hasn't run before this timer.
      const queued = found.observer.takeRecords();
      if (queued.length) read(video, found, queued);
      if (found.timer !== timer) return;
      found.timer = null;
      if (!active()) { update(); return; }
      if (!counts(video, found.post) || !same(video, found)) { track(video, found.post); return; }
      if (!found.offscreen || video.paused || video.ended) return;
      try {
        video.pause();
      } catch (error) {
        log?.error('Pausing an offscreen video failed', error);
      }
    }, OFFSCREEN_MS);
    found.timer = timer;
  }

  function read(video, found, entries) {
    if (!running || videos.get(video) !== found) return;
    if (!counts(video, found.post) || !same(video, found)) { track(video, found.post); return; }
    for (const entry of entries) {
      if (entry.target !== video) continue;
      found.offscreen = entry.intersectionRatio === 0;
      if (found.offscreen) arm(video, found);
      else cancel(found);
    }
  }

  function track(video, post) {
    if (!counts(video, post)) { forget(video); return null; }
    const previous = videos.get(video);
    if (previous?.post === post && same(video, previous)) return previous;
    forget(video);
    const found = { post, resource: resourceOf(video), currentSrc: video.currentSrc, offscreen: false, timer: null, observer: null };
    // An observer belongs to one resource. Its queued callbacks cannot affect a later video
    // loaded in the same element, even if both resources have the same address.
    found.observer = new win.IntersectionObserver((entries) => read(video, found, entries), { threshold: [0, Number.EPSILON] });
    videos.set(video, found);
    found.observer.observe(video);
    return found;
  }

  function scan(post) {
    for (const [video, found] of videos) if (found.post === post && !counts(video, post)) forget(video);
    for (const video of post.element.querySelectorAll('video')) track(video, post);
  }

  function add(post) {
    if (post.kind !== 'feed') return;
    feedPosts.set(post.element, post);
    scan(post);
  }

  function remove(post) {
    feedPosts.delete(post.element);
    for (const [video, found] of videos) if (found.post === post) forget(video);
  }

  function clear() {
    for (const video of videos.keys()) forget(video);
    feedPosts.clear();
  }

  function changed(records) {
    if (!running) return;
    if (!active()) { update(); return; }
    const affected = new Set();
    for (const record of records) {
      // Removed nodes may already be connected again when this batch is delivered.
      // Reusing the same element and source still starts a new observation interval.
      for (const root of record.removedNodes ?? []) {
        if (root.nodeType !== 1) continue;
        if (root.tagName === 'VIDEO') forget(root);
        for (const video of root.querySelectorAll('video')) forget(video);
      }
      const post = owner(record.target);
      if (post) affected.add(post);
      // An ancestor can become a dialog, or a whole tracked post can move into a new box.
      const roots = record.type === 'attributes' && !post ? [record.target] : record.addedNodes;
      for (const root of roots) {
        if (root.nodeType !== 1) continue;
        const own = owner(root);
        if (own) affected.add(own);
        for (const element of root.querySelectorAll(CANDIDATE_SELECTOR)) {
          const nested = feedPosts.get(element);
          if (nested) affected.add(nested);
        }
      }
    }
    for (const post of affected) scan(post);
    for (const [video, found] of videos) if (!counts(video, found.post)) forget(video);
  }

  function onMedia(event) {
    const video = event.target;
    if (video?.tagName !== 'VIDEO') return;
    if (event.type === 'pause' || event.type === 'ended') { cancel(videos.get(video)); return; }
    if (event.type === 'loadstart' || event.type === 'emptied') forget(video);
    const post = owner(video);
    if (!post) { forget(video); return; }
    const found = track(video, post);
    if (found && (event.type === 'play' || event.type === 'playing')) arm(video, found);
  }

  function onPlayer() {
    for (const post of feedPosts.values()) scan(post);
  }

  function stop() {
    running = false;
    mutations?.disconnect();
    mutations = null;
    for (const unsubscribe of stops) unsubscribe();
    stops = [];
    for (const type of MEDIA_EVENTS) doc.removeEventListener(type, onMedia, true);
    for (const type of PLAYER_EVENTS) doc.removeEventListener(type, onPlayer, true);
    clear();
  }

  function update() {
    if (!active()) { if (running) stop(); return; }
    if (running) return;
    running = true;
    mutations = new win.MutationObserver(changed);
    // The document exists before <html> at document-start. It also lets stop disconnect
    // everything immediately if the switch changes before the root arrives.
    mutations.observe(doc, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'role', 'aria-modal'] });
    for (const type of MEDIA_EVENTS) doc.addEventListener(type, onMedia, true);
    for (const type of PLAYER_EVENTS) doc.addEventListener(type, onPlayer, true);
    stops = [posts.on('post/add', add), posts.on('post/update', add), posts.on('post/remove', remove), posts.on('reset', clear)];
  }

  return { update, reset() { stop(); update(); }, stop };
}

export default {
  id: 'pauseOffscreenVideos',
  section: 'playback',
  webOnly: true,
  title: 'Pause feed videos after they leave view',
  description: "Pauses a video after it's fully out of view for a second on Home or a group feed. Videos you open separately keep playing. Scroll back and press play to continue.",
  default: false,

  setup({ doc, win, posts, router, settings, enabled, log, markUnavailable }) {
    const view = win ?? doc.defaultView;
    if (!posts || typeof view?.IntersectionObserver !== 'function' || typeof view?.MutationObserver !== 'function') {
      markUnavailable?.('api');
      return;
    }
    const pauser = createOffscreenPauser({ doc, win: view, posts, enabled, route: () => router?.current(), log });
    pauser.update();
    settings?.subscribe?.(() => pauser.update());
    router?.subscribe?.(() => pauser.reset());
  },
};
