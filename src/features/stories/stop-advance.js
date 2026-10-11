// Stop Story auto-advance, as Hushfacebook does on Android. The story viewer moves to the next
// card when a video card's progress reaches its end, and that progress follows the video: a
// paused video holds the card, while keeping the video's ended event from Facebook doesn't
// (live 2026-10-11, captures/2026-10-11-run4 story-hold and story-rewind, and the story-advance
// runs before them). So just before a story video ends, the script pauses it, or sends it back to
// the start to play again. Photo cards run on a timer the page doesn't show, so they still move
// on by themselves.
//
// Playing a held card again lets it finish and move on, and the Next arrow works as always. It
// only touches the video element, so it works in content mode too.

export const END_MARGIN = 0.5; // seconds before the end
const SHORTEST = 1; // seconds; anything shorter is left alone

const isVideo = (node) => node?.tagName === 'VIDEO';
const sameCard = (video, mark) => mark && mark.src === video.currentSrc && mark.duration === video.duration;

export function createStoryHold({ doc, enabled, mode, inViewer, onChange }) {
  const held = new WeakMap(); // video -> the card it was held on
  const released = new WeakMap(); // video -> the card its viewer played again after a hold
  let holds = 0;
  let replays = 0;

  const cardOf = (video) => ({ src: video.currentSrc, duration: video.duration });

  function onTime(event) {
    const video = event.target;
    if (!isVideo(video) || !enabled() || !inViewer()) return;
    const { duration, currentTime } = video;
    if (!Number.isFinite(duration) || duration < SHORTEST || video.loop) return;
    if (currentTime < duration - END_MARGIN) return;
    if (mode() === 'replay') {
      video.currentTime = 0;
      replays++;
      onChange?.();
      return;
    }
    if (video.paused || sameCard(video, released.get(video))) return;
    held.set(video, cardOf(video));
    video.pause();
    holds++;
    onChange?.();
  }

  // A play on a card the script held is the viewer's choice to go on, and so is a play right at
  // the end of a card they paused there by hand. A play anywhere else (a card starting, or the
  // same card seen again later) means the end gets held again.
  function onPlay(event) {
    const video = event.target;
    if (!isVideo(video)) return;
    const atEnd = Number.isFinite(video.duration) && video.currentTime >= video.duration - END_MARGIN;
    if (sameCard(video, held.get(video)) || atEnd) {
      held.delete(video);
      released.set(video, cardOf(video));
    } else {
      released.delete(video);
    }
  }

  return {
    start() {
      // Media events don't bubble, but they do pass the document on their way in.
      doc.addEventListener('timeupdate', onTime, true);
      doc.addEventListener('play', onPlay, true);
    },
    stop() {
      doc.removeEventListener('timeupdate', onTime, true);
      doc.removeEventListener('play', onPlay, true);
    },
    state: () => ({ holds, replays }),
  };
}

export const inStoryViewer = (doc) => /^\/stories\//.test(doc.location?.pathname ?? '');

export default {
  id: 'stopStoryAdvance',
  section: 'stories',
  android: 'Stop Story auto-advance',
  title: 'Stop stories moving on',
  description: "A video story stays on screen when it ends instead of moving to the next one, so you go on when you're ready with the arrow. You can have it play again instead. Photo stories still move on by themselves for now.",
  default: false,
  options: [
    {
      key: 'atEnd', type: 'select', label: 'When a story ends', default: 'hold',
      choices: [
        { value: 'hold', label: 'Stay on its last moment' },
        { value: 'replay', label: 'Play it again' },
      ],
    },
  ],

  setup({ doc, enabled, option, diagnostics }) {
    const hold = createStoryHold({
      doc, enabled,
      mode: () => option('atEnd'),
      inViewer: () => inStoryViewer(doc),
      onChange: () => diagnostics?.changed(),
    });
    hold.start();
    diagnostics?.add('Stories held at the end', () => String(hold.state().holds));
    diagnostics?.add('Stories played again', () => String(hold.state().replays));
  },
};
