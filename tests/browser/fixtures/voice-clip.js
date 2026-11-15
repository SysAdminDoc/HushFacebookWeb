// Tap to play and a chat's voice message in a real engine (#14): the play button plays an
// <audio> with no controls (never drawn) or one that isn't on the page at all. The runner
// clicks and presses keys for real, so the gesture and the event targets are the browser's.
import tapToPlay from '../../../src/features/playback/tap-to-play.js';

// A tenth of a second of silence as a WAV file: 8 kHz, 8-bit, mono.
function silentWav() {
  const samples = 800;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const text = (at, value) => [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, 36 + samples, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true); view.setUint32(28, 8000, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  text(36, 'data'); view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
}

const outcomes = {};
const attempt = (name, media) => {
  outcomes[name] = 'waiting';
  media.play().then(() => { outcomes[name] = 'played'; media.pause(); }, (error) => { outcomes[name] = error.name; });
};

const BUTTON = 'style="display:inline-block;width:40px;height:40px;margin:8px;background:#3a3b3c;border-radius:20px"';
const PLAY_ICON = '<svg width="20" height="20" viewBox="0 0 20 20" style="margin:10px"><path d="M5 3l12 7-12 7z" fill="#e4e6eb"></path></svg>';

export function prepareVoiceClip() {
  const sound = silentWav();
  tapToPlay.setup({
    win: window, enabled: () => true, log: { debug() {} },
    router: { current: () => ({ type: 'messages', path: '/messages/t/1/' }), subscribe() {} },
  });
  document.body.insertAdjacentHTML('beforeend', `<div class="voice-clip">
    <div role="button" tabindex="0" aria-label="Play" id="clip-detached" ${BUTTON}>${PLAY_ICON}</div>
    <div role="button" tabindex="0" aria-label="Play" id="clip-tagged" ${BUTTON}>${PLAY_ICON}</div><audio id="clip-audio" src="${sound}"></audio>
    <div role="button" tabindex="0" aria-label="Play" id="clip-key" ${BUTTON}>${PLAY_ICON}</div>
    <div role="button" tabindex="0" id="clip-elsewhere" ${BUTTON}></div>
    <video id="clip-video" src="${sound}" style="display:block;width:200px;height:120px;background:#000"></video>
    <p id="clip-text">Some words in the chat.</p>
  </div>`);
  const tagged = document.getElementById('clip-audio');
  // Facebook's handlers start the sound from the click, the way a chat's play button does.
  document.getElementById('clip-detached').addEventListener('click', () => attempt('detached', new Audio(sound)));
  document.getElementById('clip-tagged').addEventListener('click', () => attempt('tagged', tagged));
  document.getElementById('clip-key').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') attempt('key', new Audio(sound));
  });
  document.getElementById('clip-elsewhere').addEventListener('click', () => attempt('video', document.getElementById('clip-video')));
  document.getElementById('clip-text').addEventListener('click', () => attempt('text', new Audio(sound)));
  // A sound starting with nobody touching anything.
  attempt('unprompted', new Audio(sound));
  return { box: tagged.getBoundingClientRect().height };
}

export const voiceClipState = () => ({ ...outcomes });
