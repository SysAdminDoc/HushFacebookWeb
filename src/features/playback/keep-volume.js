// Remember your volume (issue #1). Facebook gives every new video and reel its own element,
// muted or at its own level, so turning the sound up on one reel is lost on the next. The script
// remembers the level and whether the sound was on, from your own changes, and gives them to each
// video as it starts.
//
// Facebook's player keeps its own mute and volume and writes both to the video whenever its state
// moves: several times as a reel starts, at each loop, after a click in the player (live
// 2026-10-12). Reels have no volume slider and always get 100%. In page mode the script steers
// those writes through the video's volume and muted setters, so a write that isn't yours lands as
// your kept values and nothing is heard in between. In content mode it can only put them back
// afterwards, three times every two seconds at most, and once more when the video has settled.
// Either way it turns the sound on or off with the player's own mute button where it finds one,
// so the button shows the truth and later writes already match.
//
// Your own changes: the level only from a player's volume slider (the slider whose top is 1; the
// seek bar's top is the length), mute from that player's mute button, a click or Enter on it, and
// when the button can't be found, a click in the player half a second or more in. Browsers only
// let a page play sound after you've clicked or typed on it, and pause a video that gets its sound
// before that, so until then a video keeps Facebook's mute and only gets the level, and your first
// click or key press gives the playing video its sound. The script never starts a video, so Tap
// to play still decides that.

export const VOLUME_KEY = 'keepVolume.state';
const INPUT_WINDOW = 2000; // ms after a click or key press
const SETTLED = 0.5; // seconds into a video before a change can be yours
const MAX_REAPPLY = 3; // put-backs per FIGHT_WINDOW, and mute-button clicks per window are 1
const FIGHT_WINDOW = 2000;
const WAKE_DELAY = 300; // ms after the first click, so a click on Unmute itself lands first
// How far up from a video a click can land and still be in its player. Live 2026-10-12: a reel's
// Unmute button shares the video's parent and its Like button joins 9 levels up; a feed video's
// mute button and volume slider join 8 up and its Like 35 up.
const PLAYER_LEVELS = 8;
// A slider drag fires volumechange for every step. Ten writes a second go straight to storage and
// the rest wait as one, so a long drag stays inside the extension's write allowance.
const WRITES_PER_SECOND = 10;
// Facebook's mute button. Its label says what a click does: "Unmute" while Facebook has it muted.
const TOGGLE = /^(mute|unmute)$/i;
const SAYS_MUTED = /^unmute$/i;

const isVideo = (node) => node?.tagName === 'VIDEO';
const clamp = (value) => Math.min(1, Math.max(0, value));
const labelOf = (node) => (node.getAttribute('aria-label') ?? '').trim();

export function readVolume(value) {
  if (!value || typeof value !== 'object' || !Number.isFinite(value.volume)) return null;
  return { volume: clamp(value.volume), muted: value.muted === true };
}

function playerOf(video, levels = PLAYER_LEVELS) {
  let box = video;
  for (let i = 0; i < levels && box.parentElement; i++) box = box.parentElement;
  return box;
}

export function inPlayer(video, target, levels = PLAYER_LEVELS) {
  if (!target || typeof target.nodeType !== 'number') return false;
  return playerOf(video, levels).contains(target);
}

// The volume slider: a slider whose top value is 1 (Facebook's seek bar tops out at the length).
export function volumeSlider(node) {
  const slider = node?.closest?.('[role="slider"], input[type="range"]');
  if (!slider) return null;
  const max = Number(slider.getAttribute('aria-valuemax') ?? slider.getAttribute('max'));
  return max > 0 && max <= 1 ? slider : null;
}

// The nearest mute button: the Reels page keeps the reels before and after this one in the page,
// each with its own button inside the same boxes further up.
export function muteToggle(video) {
  let box = video;
  for (let i = 0; i < PLAYER_LEVELS && box.parentElement; i++) {
    box = box.parentElement;
    for (const button of box.querySelectorAll('[role="button"][aria-label], button[aria-label]')) {
      if (TOGGLE.test(labelOf(button))) return button;
    }
  }
  return null;
}

export function createVolumeKeeper({
  doc, win, storage, enabled,
  page = false,
  now = () => Date.now(),
  trusted = (event) => event.isTrusted,
  defer = (run) => win.setTimeout(run, WAKE_DELAY),
  later = (run, ms) => win.setTimeout(run, ms),
}) {
  const ours = new WeakMap(); // video -> { volume, muted } the script set
  const putBacks = new WeakMap(); // video -> recent put-back times
  const resynced = new WeakMap(); // video -> when the script last clicked its mute button
  const settled = new WeakSet();
  let lastInput = Number.NEGATIVE_INFINITY;
  let lastTarget = null;
  let lastKey = '';
  let inputSeen = false;
  let woken = false;
  // True while the script writes, so its own writes (and what Facebook does inside a click on
  // its mute button) pass. A browser queues volumechange, so by the time it arrives the video
  // holds the script's last write and matches `ours`.
  let applying = false;

  let unsaved = null; // your newest pick, while it waits for the next write
  let writeQueued = false;
  const writes = [];
  const kept = () => unsaved ?? readVolume(storage.get(VOLUME_KEY, null));
  function writeUnsaved() {
    writeQueued = false;
    if (!unsaved) return;
    const next = unsaved;
    unsaved = null;
    writes.push(now());
    storage.set(VOLUME_KEY, next);
  }
  function save(next) {
    while (writes.length && now() - writes[0] >= 1000) writes.shift();
    unsaved = next;
    if (writes.length < WRITES_PER_SECOND) writeUnsaved();
    else if (!writeQueued) {
      writeQueued = true;
      later(writeUnsaved, Math.max(0, writes[0] + 1000 - now()));
    }
  }
  // Whether the page may play sound: the browser's own answer where it gives one.
  const activated = () => win.navigator?.userActivation?.hasBeenActive ?? inputSeen;
  const mutedFor = (state, current) => (state.muted ? true : activated() ? false : current);

  function give(video) {
    const state = kept();
    if (!state) return;
    const muted = mutedFor(state, video.muted);
    const toggle = muteToggle(video);
    const resync = !!toggle && (muted || activated()) && SAYS_MUTED.test(labelOf(toggle)) !== muted
      && !(now() - (resynced.get(video) ?? Number.NEGATIVE_INFINITY) < FIGHT_WINDOW);
    if (!resync && video.volume === state.volume && video.muted === muted) return;
    ours.set(video, { volume: state.volume, muted });
    applying = true;
    try {
      if (resync) {
        // Through Facebook's own button, so its player agrees.
        resynced.set(video, now());
        toggle.click();
      }
      video.volume = state.volume;
      video.muted = muted;
    } finally {
      applying = false;
    }
  }

  const skip = (video) => applying || !isVideo(video) || !enabled();

  // What the last click or key press could have changed on this video.
  // The slider and the mute button are yours from the first frame. A click elsewhere in a player
  // whose button can't be found counts once Facebook is done starting the video. Keys count only
  // on the slider or the button (Facebook's Reels have no M key, live 2026-10-12).
  function yours(video) {
    const none = { volume: false, muted: false };
    if (now() - lastInput >= INPUT_WINDOW) return none;
    const target = lastKey ? doc.activeElement : lastTarget;
    if (!inPlayer(video, target)) return none;
    if (volumeSlider(target)) return { volume: true, muted: true };
    const toggle = muteToggle(video);
    if (toggle) return { volume: false, muted: toggle.contains(target) };
    return { volume: false, muted: !lastKey && video.currentTime >= SETTLED };
  }

  // Page mode: Facebook's writes land as your kept values unless they're yours.
  function steer(video, name, value) {
    if (skip(video)) return value;
    const state = kept();
    if (!state) return value;
    const pick = yours(video);
    if (name === 'volume') return pick.volume ? value : state.volume;
    return pick.muted ? value : mutedFor(state, value === true);
  }

  function guard() {
    const proto = win.HTMLMediaElement?.prototype;
    if (!proto) return;
    for (const name of ['volume', 'muted']) {
      const own = Object.getOwnPropertyDescriptor(proto, name);
      if (!own?.set || !own.configurable) continue;
      Object.defineProperty(proto, name, {
        ...own,
        set(value) {
          own.set.call(this, steer(this, name, value));
        },
      });
    }
  }

  function putBack(video) {
    const recent = (putBacks.get(video) ?? []).filter((at) => now() - at < FIGHT_WINDOW);
    putBacks.set(video, recent);
    if (recent.length >= MAX_REAPPLY) return;
    recent.push(now());
    give(video);
  }

  function onVolume(event) {
    const video = event.target;
    if (skip(video)) return;
    const mine = ours.get(video);
    if (mine && mine.volume === video.volume && mine.muted === video.muted) return;
    ours.delete(video);
    const before = kept();
    const pick = yours(video);
    if (!pick.volume && !pick.muted) {
      if (before) putBack(video);
      return;
    }
    const next = {
      volume: pick.volume || !before ? clamp(video.volume) : before.volume,
      muted: pick.muted ? video.muted : before?.muted ?? video.muted,
    };
    if (!before || before.volume !== next.volume || before.muted !== next.muted) save(next);
    lastInput = now(); // a slider drag goes on past the first change
    // A click on the mute button also writes Facebook's own level, which isn't a pick.
    if (video.volume !== next.volume) give(video);
  }

  function onStart(event) {
    if (skip(event.target)) return;
    give(event.target);
  }

  // Once more when a video has settled, after Facebook's writes as it starts.
  function onTime(event) {
    const video = event.target;
    if (skip(video) || settled.has(video) || video.currentTime < SETTLED) return;
    settled.add(video);
    give(video);
  }

  function wake() {
    if (!enabled()) return;
    for (const video of doc.querySelectorAll('video')) if (!video.paused) give(video);
  }

  const onInput = (event) => {
    if (!trusted(event)) return;
    lastInput = now();
    lastTarget = event.type === 'keydown' ? null : event.target;
    lastKey = event.type === 'keydown' ? String(event.key ?? '') : '';
    inputSeen = true;
    if (!woken) {
      woken = true;
      defer(wake);
    }
  };

  return {
    start() {
      if (page) guard();
      const listen = { capture: true, passive: true };
      win.addEventListener('pointerdown', onInput, listen);
      win.addEventListener('keydown', onInput, listen);
      // Media events don't bubble, but they do pass the document on their way in.
      for (const type of ['loadedmetadata', 'play', 'playing']) doc.addEventListener(type, onStart, true);
      doc.addEventListener('timeupdate', onTime, true);
      doc.addEventListener('volumechange', onVolume, true);
      // A pick still waiting when the page goes away is written then.
      win.addEventListener('pagehide', writeUnsaved);
    },
    kept,
    reset: () => {
      unsaved = null;
      storage.remove(VOLUME_KEY);
    },
  };
}

export const volumeLabel = (state) => (!state ? 'Not set yet' : state.muted ? `Muted (${Math.round(state.volume * 100)}%)` : `${Math.round(state.volume * 100)}%`);

export default {
  id: 'keepVolume',
  section: 'playback',
  android: 'Remember your volume',
  title: 'Remember your volume',
  description: "The volume you set with a video's slider, and whether the sound is on, carries over to every video and reel after it, even after a reload. Sound starts once you've clicked or typed on the page, as browsers require, and a mute you chose stays.",
  default: false,

  setup({ doc, win, net, storage, enabled, diagnostics, actions, toast }) {
    const keeper = createVolumeKeeper({ doc, win: win ?? doc.defaultView, storage, enabled, page: !!net });
    keeper.start();
    diagnostics?.add('Volume kept', () => volumeLabel(keeper.kept()));
    actions?.add('Forget my volume', () => {
      keeper.reset();
      toast?.('New videos start the way Facebook sets them again');
    });
  },
};
