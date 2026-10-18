// Keep the reel speed, as Hushfacebook does on Android, for every video. Facebook's player has a
// Playback speed choice in its Settings menu (live 2026-10-11), but each video and reel gets a
// new video element at normal speed (the next reel after one set to 1.5 played at 1). So the
// script remembers the speed you pick and gives it to each video as it starts.
//
// A speed counts as your pick when it changes while a video is already playing, right after you
// clicked or pressed a key. A change with no input behind it is Facebook setting its own speed
// back, and the kept speed goes on again, a few times at most per video. Stories and live
// broadcasts keep their own pace, and so does a reel while it's held for 2x. Works in content
// mode.

import { t } from '../../core/i18n.js';

export const SPEED_KEY = 'keepSpeed.rate';
// Set on a video while Hold a reel for 2x speeds it up, so that change isn't kept.
export const HOLDING = Symbol.for('hushfacebook-web.holding-speed');
const INPUT_WINDOW = 2000; // ms after a click or key press
const SETTLED = 1; // seconds into a video before a change can be a pick
const MAX_REAPPLY = 3;
const MIN_RATE = 0.25;
const MAX_RATE = 4;

const isVideo = (node) => node?.tagName === 'VIDEO';

export function createSpeedKeeper({ doc, win, storage, enabled, now = () => Date.now(), trusted = (event) => event.isTrusted, inStories = () => /^\/stories\//.test(doc.location?.pathname ?? '') }) {
  const ours = new WeakMap(); // video -> the rate the script set
  const reapplied = new WeakMap(); // video -> times put back
  let lastInput = Number.NEGATIVE_INFINITY;

  const kept = () => {
    const rate = Number(storage.get(SPEED_KEY, 1));
    return rate >= MIN_RATE && rate <= MAX_RATE ? rate : 1;
  };

  function give(video) {
    const rate = kept();
    if (video.playbackRate === rate) return;
    ours.set(video, rate);
    video.playbackRate = rate;
  }

  // A live broadcast plays at the speed it's sent, and stays that way even if its length later
  // reads as a number for a moment.
  const wasLive = new WeakMap(); // video -> the source it was live on
  const isLive = (video) => video.duration === Number.POSITIVE_INFINITY || (wasLive.has(video) && wasLive.get(video) === video.currentSrc);
  const skip = (video) => !isVideo(video) || !enabled() || inStories() || video[HOLDING] || isLive(video);

  function onStart(event) {
    if (skip(event.target)) return;
    give(event.target);
  }

  // Played before its length was known, then found to be live: the speed the script gave it
  // comes off again. Only that: a new length is no reason to give a speed again.
  function onLength(event) {
    const video = event.target;
    if (!isVideo(video) || video.duration !== Number.POSITIVE_INFINITY) return;
    wasLive.set(video, video.currentSrc);
    if (!ours.has(video)) return;
    if (video.playbackRate === ours.get(video)) video.playbackRate = 1;
    ours.delete(video);
  }

  function onRate(event) {
    const video = event.target;
    if (skip(video)) return;
    const rate = video.playbackRate;
    if (ours.get(video) === rate) return;
    ours.delete(video);
    const picked = now() - lastInput < INPUT_WINDOW && video.currentTime >= SETTLED;
    if (picked) {
      if (rate >= MIN_RATE && rate <= MAX_RATE && rate !== kept()) storage.set(SPEED_KEY, rate);
      return;
    }
    const times = reapplied.get(video) ?? 0;
    if (times >= MAX_REAPPLY) return;
    reapplied.set(video, times + 1);
    give(video);
  }

  const onInput = (event) => {
    if (trusted(event)) lastInput = now();
  };

  return {
    start() {
      const listen = { capture: true, passive: true };
      win.addEventListener('pointerdown', onInput, listen);
      win.addEventListener('keydown', onInput, listen);
      // Media events don't bubble, but they do pass the document on their way in.
      doc.addEventListener('play', onStart, true);
      doc.addEventListener('loadedmetadata', onLength, true);
      doc.addEventListener('loadedmetadata', onStart, true);
      doc.addEventListener('durationchange', onLength, true);
      doc.addEventListener('ratechange', onRate, true);
    },
    kept,
    reset: () => storage.remove(SPEED_KEY),
  };
}

export const speedLabel = (rate) => (rate === 1 ? 'Normal' : `${rate}x`);

export default {
  id: 'keepSpeed',
  section: 'playback',
  android: 'Keep the reel speed',
  title: 'Keep your video speed',
  description: "The speed you pick in a video's Settings menu stays for every video and reel after it, even after a reload, instead of going back to normal each time. Stories keep their own pace.",
  default: false,

  setup({ doc, win, storage, enabled, diagnostics, actions, toast }) {
    const keeper = createSpeedKeeper({ doc, win: win ?? doc.defaultView, storage, enabled });
    keeper.start();
    diagnostics?.add('Video speed kept', () => speedLabel(keeper.kept()));
    actions?.add('Back to normal speed', () => {
      keeper.reset();
      toast?.(t('New videos play at normal speed again'));
    });
  },
};
