// Keep the progress bar, as Hushfacebook does on Android. On facebook.com a feed or Watch video
// fades its controls out a moment after the pointer leaves (live 2026-10-11: the position
// slider and the Pause, Settings and fullscreen buttons drop to 1% opacity), while reels keep
// theirs. The script finds the video's position slider, a role=slider whose largest value is the
// video's length in seconds, so any language works, and keeps the layers between it and the
// video from fading. Works in content mode.

export const KEEP = 'data-hfw-keep-controls';
const CHECK_EVERY = 1000; // ms per video
const MAX_LEVELS = 12;

export const KEEP_CONTROLS_CSS = `[${KEEP}] { opacity: 1 !important; visibility: visible !important; }`;

const isVideo = (node) => node?.tagName === 'VIDEO';

const TRACKS = 2; // seconds between a slider's value and the video's time for it to follow the video

// The position slider that belongs to a video: inside the nearest box around the video that has
// one, with the video's length as its largest value. A video about 100 seconds long can match a
// volume slider too, and then only a slider whose value follows the video's time counts.
export function positionSlider(video) {
  const length = Math.round(video.duration);
  if (!Number.isFinite(length) || length <= 0) return null;
  let node = video.parentElement;
  for (let level = 0; node && level < MAX_LEVELS; level++, node = node.parentElement) {
    const sliders = [...node.querySelectorAll('[role="slider"]')];
    if (!sliders.length) continue;
    const fits = sliders.filter((slider) => Math.abs(Number(slider.getAttribute('aria-valuemax')) - length) <= 1);
    if (fits.length <= 1) return fits[0] ?? null;
    return fits.find((slider) => Math.abs(Number(slider.getAttribute('aria-valuenow') ?? Number.NaN) - video.currentTime) <= TRACKS) ?? null;
  }
  return null;
}

// Marks every faded layer from the slider up to the box it shares with the video. True when one
// was marked.
export function keepShown(video, slider, styleOf) {
  let marked = false;
  for (let node = slider; node && !node.contains(video); node = node.parentElement) {
    if (node.hasAttribute(KEEP)) continue;
    const style = styleOf(node);
    if (Number(style.opacity) < 1 || style.visibility === 'hidden') {
      node.setAttribute(KEEP, '');
      marked = true;
    }
  }
  return marked;
}

export function createControlsKeeper({ doc, enabled, now = () => Date.now(), styleOf = (node) => doc.defaultView.getComputedStyle(node), inReelsOrStories = () => /^\/(?:reels?|stories)\//.test(doc.location?.pathname ?? '') }) {
  const checked = new WeakMap(); // video -> last check time
  let kept = 0;

  function check(video) {
    if (!isVideo(video) || !enabled() || inReelsOrStories()) return;
    const time = now();
    if (time - (checked.get(video) ?? Number.NEGATIVE_INFINITY) < CHECK_EVERY) return;
    checked.set(video, time);
    const slider = positionSlider(video);
    if (slider && keepShown(video, slider, styleOf)) kept++;
  }

  return {
    start() {
      // Media events don't bubble, but they do pass the document on their way in.
      doc.addEventListener('timeupdate', (event) => check(event.target), true);
      doc.addEventListener('pause', (event) => check(event.target), true);
    },
    check,
    // Switched off: the CSS stops applying, and the marks go too so nothing is left behind.
    clear() {
      for (const node of doc.querySelectorAll(`[${KEEP}]`)) node.removeAttribute(KEEP);
    },
    kept: () => kept,
  };
}

export default {
  id: 'keepControls',
  section: 'playback',
  android: 'Keep the progress bar',
  title: 'Keep video controls on screen',
  description: "A video's progress bar and buttons stay on screen instead of fading out when you move the mouse away. Reels already keep theirs.",
  default: false,
  css: KEEP_CONTROLS_CSS,

  setup({ doc, enabled, settings, diagnostics }) {
    const keeper = createControlsKeeper({ doc, enabled });
    keeper.start();
    settings?.subscribe(() => {
      if (!enabled()) keeper.clear();
    });
    diagnostics?.add('Video controls kept on screen', () => String(keeper.kept()));
  },
};
