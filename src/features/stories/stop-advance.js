// Stop Story auto-advance, as Hushfacebook does on Android. The story viewer moves to the next
// card when a video card's progress reaches its end, and that progress follows the video: a
// paused video holds the card, while keeping the video's ended event from Facebook doesn't
// (live 2026-10-11, captures/2026-10-11-run4 story-hold and story-rewind, and the story-advance
// runs before them). So just before a story video ends, the script pauses it, or sends it back to
// the start to play again. Photo cards run on a timer the page doesn't show, so they still move
// on by themselves.
//
// Playing a held card again lets it finish and move on, and the Next arrow works as always. A
// play only counts as that when it comes right after a click on a button or a play key, so
// Facebook starting the video again by itself doesn't let the card go, and neither does it
// starting the video when you leave the reply box or a menu. It only touches the video element,
// so it works in content mode too.

export const END_MARGIN = 0.5; // seconds before the end
const SHORTEST = 1; // seconds; anything shorter is left alone
export const INPUT_WINDOW = 1500; // ms after a click or key press that a play counts as the viewer's

const isVideo = (node) => node?.tagName === 'VIDEO';
const sameCard = (video, mark) => mark && mark.src === video.currentSrc && mark.duration === video.duration;

// Typing a reply, or picking from a menu, isn't asking the story to play.
const WRITING = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="combobox"], [role="searchbox"]';
const MENU = '[role="menu"], [role="menuitem"], [role="menuitemradio"], [role="listbox"], [role="option"]';
const PLAY_KEYS = new Set([' ', 'k', 'K', 'Enter']);

// The reply bar's Send and quick reaction buttons sit in the same row as its text field, and
// Facebook plays the story again after a reply, so a button level with a text field doesn't
// count. The Play button is at the top of the card, well away from it.
const ROW_SLACK = 8; // px
const inReplyBar = (button) => {
  const box = button.getBoundingClientRect?.();
  if (!box?.height) return false;
  const middle = box.top + box.height / 2;
  for (const field of button.ownerDocument?.querySelectorAll(WRITING) ?? []) {
    const row = field.getBoundingClientRect();
    if (row.height && middle >= row.top - ROW_SLACK && middle <= row.bottom + ROW_SLACK) return true;
  }
  return false;
};

// A click on a button (Play, or the card's own controls) or a play key, outside a text field
// and a menu. Clicking into the reply box, away from it, or on its Send button doesn't count.
export function asksToPlay(event) {
  const start = event.composedPath?.()[0] ?? event.target;
  const element = typeof start?.closest === 'function' ? start : start?.parentElement ?? null;
  if (event.type === 'keydown') {
    if (!PLAY_KEYS.has(event.key)) return false;
    return !element?.closest?.(WRITING) && !element?.closest?.(MENU);
  }
  if (!element || element.closest(WRITING) || element.closest(MENU)) return false;
  const button = element.closest('button, [role="button"]');
  return Boolean(button) && !inReplyBar(button);
}

export function createStoryHold({ doc, win = doc.defaultView, enabled, mode, inViewer, onChange, trusted = (event) => event.isTrusted, now = () => Date.now() }) {
  const held = new WeakMap(); // video -> the card it was held on
  const released = new WeakMap(); // video -> the card its viewer played again after a hold
  let holds = 0;
  let replays = 0;
  let lastInput = Number.NEGATIVE_INFINITY;

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
    // Held again after Facebook played it by itself: still the one hold.
    if (!sameCard(video, held.get(video))) holds++;
    held.set(video, cardOf(video));
    video.pause();
    onChange?.();
  }

  // A play on a card the script held is the viewer's choice to go on, and so is a play right at
  // the end of a card they paused there by hand, when a button click or play key came just
  // before it.
  // A play anywhere else (a card starting, or the same card seen again later) means the end
  // gets held again.
  function onPlay(event) {
    const video = event.target;
    if (!isVideo(video)) return;
    const atEnd = Number.isFinite(video.duration) && video.currentTime >= video.duration - END_MARGIN;
    const goOn = sameCard(video, held.get(video)) || atEnd;
    if (!goOn) released.delete(video);
    else if (now() - lastInput < INPUT_WINDOW) {
      held.delete(video);
      released.set(video, cardOf(video));
    }
  }

  // Any other click or key ends the window, so a play after it isn't counted.
  const onInput = (event) => {
    if (!trusted(event) || !enabled() || !inViewer()) return;
    lastInput = asksToPlay(event) ? now() : Number.NEGATIVE_INFINITY;
  };
  const listen = { capture: true, passive: true };

  return {
    start() {
      // Media events don't bubble, but they do pass the document on their way in.
      doc.addEventListener('timeupdate', onTime, true);
      doc.addEventListener('play', onPlay, true);
      win?.addEventListener('pointerdown', onInput, listen);
      win?.addEventListener('keydown', onInput, listen);
    },
    stop() {
      doc.removeEventListener('timeupdate', onTime, true);
      doc.removeEventListener('play', onPlay, true);
      win?.removeEventListener('pointerdown', onInput, listen);
      win?.removeEventListener('keydown', onInput, listen);
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

  setup({ doc, win, enabled, option, diagnostics }) {
    const hold = createStoryHold({
      doc, win: win ?? doc.defaultView, enabled,
      mode: () => option('atEnd'),
      inViewer: () => inStoryViewer(doc),
      onChange: () => diagnostics?.changed(),
    });
    hold.start();
    diagnostics?.add('Stories held at the end', () => String(hold.state().holds));
    diagnostics?.add('Stories played again', () => String(hold.state().replays));
  },
};
