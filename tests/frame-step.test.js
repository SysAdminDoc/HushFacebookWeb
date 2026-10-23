// Frame step: Back a frame and Next frame on a paused video, in the floating stack Download and
// Pop out use, and that stack closing up around buttons that aren't up on the same video.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { setLanguage, t } from '../src/core/i18n.js';
import frameStep, { FRAME, createFrameStep, stepTime } from '../src/features/playback/frame-step.js';
import { createDownloadButton } from '../src/features/downloads/button.js';
import { createPopOut } from '../src/features/playback/picture-in-picture.js';

const FB = 'https://www.facebook.com';
const windows = [];
const stops = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

const frame = () => new Promise((resolve) => setTimeout(resolve, 30));

// A video at (100, 50), 600 by 400, inside a player box with a control on it. The test says
// whether it's paused and whether its length has loaded, and play() and pause() fire their
// events as a browser does.
function player({ paused = true, time = 5, duration = 40, ready = 1 } = {}) {
  const win = testWindow(`${FB}/watch/?v=1234567890`);
  windows.push(win);
  const doc = win.document;
  doc.body.innerHTML = '<div class="player"><div class="box"></div><div role="button" tabindex="0" class="control">Pause</div></div>';
  const video = doc.createElement('video');
  let still = paused;
  let clock = time;
  Object.defineProperties(video, {
    paused: { get: () => still, configurable: true },
    currentTime: { get: () => clock, set: (value) => { clock = value; }, configurable: true },
    duration: { get: () => duration, configurable: true },
    readyState: { get: () => ready, configurable: true },
  });
  video.play = async () => { still = false; video.dispatchEvent(new win.Event('play')); };
  video.pause = () => { still = true; video.dispatchEvent(new win.Event('pause')); };
  video.getBoundingClientRect = () => ({ left: 100, top: 50, right: 700, bottom: 450, width: 600, height: 400 });
  doc.querySelector('.box').append(video);
  const control = doc.querySelector('.control');
  control.getBoundingClientRect = () => ({ left: 120, top: 400, right: 160, bottom: 440, width: 40, height: 40 });
  doc.elementsFromPoint = () => [video];
  return { win, doc, video, control, time: () => clock };
}

function steps(doc, win, extra = {}) {
  const stepped = [];
  const made = createFrameStep({ doc, win, enabled: () => true, onStep: (direction) => stepped.push(direction), ...extra });
  stops.push(() => made.stop());
  const [back, next] = made.buttons;
  return { back, next, stepped };
}

const point = (doc, win) => doc.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 300, clientY: 200 }));

test('a step lands one thirtieth of a second away and stays inside the video', () => {
  assert.equal(FRAME, 1 / 30);
  assert.equal(stepTime(5, 40, 1), 5 + 1 / 30);
  assert.equal(stepTime(5, 40, -1), 5 - 1 / 30);
  assert.equal(stepTime(0.01, 40, -1), 0, 'not before the start');
  assert.equal(stepTime(39.99, 40, 1), 40, 'not past the end');
  assert.equal(stepTime(5, Number.NaN, 1), 5 + 1 / 30, 'a length not known yet sets no end');
  assert.equal(stepTime(5, Number.POSITIVE_INFINITY, 1), 5 + 1 / 30, 'nor does a live stream');
});

test('on a paused video Back a frame and Next frame show in its corner and move it one frame each', async () => {
  const { win, doc, video, time } = player({ time: 5 });
  const { back, next, stepped } = steps(doc, win);
  point(doc, win);
  await frame();
  assert.deepEqual([back.state().shown, back.state().text, back.state().top], [true, 'Back a frame', '60px']);
  assert.deepEqual([next.state().shown, next.state().text, next.state().top], [true, 'Next frame', '104px']);
  assert.ok(doc.querySelector('[data-hushfacebook-web="frame-back"]') && doc.querySelector('[data-hushfacebook-web="frame-next"]'));
  next.click();
  await frame();
  next.click();
  await frame();
  assert.ok(Math.abs(time() - (5 + 2 / 30)) < 1e-9, `two frames on: ${time()}`);
  back.click();
  await frame();
  assert.ok(Math.abs(time() - (5 + 1 / 30)) < 1e-9, `one back: ${time()}`);
  assert.equal(video.paused, true, 'it stays paused');
  assert.deepEqual(stepped, [1, 1, -1]);
});

test("the floating buttons' words follow the panel's language", async () => {
  const { win, doc } = player();
  const { back } = steps(doc, win);
  setLanguage('long-test');
  stops.push(() => setLanguage('en'));
  point(doc, win);
  await frame();
  assert.deepEqual([back.state().text, back.state().text === 'Back a frame'], [t('Back a frame'), false]);
});

test('a step at the very start or end does nothing and counts nothing', async () => {
  const { win, doc, time } = player({ time: 0, duration: 40 });
  const { back, stepped } = steps(doc, win);
  point(doc, win);
  await frame();
  back.click();
  await frame();
  assert.deepEqual([time(), stepped], [0, []]);
});

test('a playing video gets no buttons; pausing brings them without moving the pointer, and playing takes them away', async () => {
  const { win, doc, video } = player({ paused: false });
  const { back, next } = steps(doc, win);
  point(doc, win);
  await frame();
  assert.deepEqual([back.state().shown, next.state().shown], [false, false]);
  video.pause();
  await frame();
  assert.deepEqual([back.state().shown, next.state().shown], [true, true], 'the pause alone brings them');
  await video.play();
  await new Promise((resolve) => setTimeout(resolve, 520));
  assert.deepEqual([back.state().shown, next.state().shown], [false, false], 'playing again takes them away');
});

test('a video that starts playing with the pointer resting on a frame button takes that one away too', async () => {
  const { win, doc, video } = player();
  const { back, next } = steps(doc, win);
  point(doc, win);
  await frame();
  const host = doc.querySelector('[data-hushfacebook-web="frame-back"]');
  doc.elementsFromPoint = () => [host, video];
  point(doc, win);
  await frame();
  assert.deepEqual([back.state().shown, next.state().shown], [true, true], 'resting on Back a frame');
  video.pause();
  await new Promise((resolve) => setTimeout(resolve, 520));
  assert.equal(back.state().shown, true, 'still paused, so it stays');
  await video.play();
  await new Promise((resolve) => setTimeout(resolve, 520));
  assert.deepEqual([back.state().shown, next.state().shown], [false, false]);
});

test('a video still loading its length gets no buttons, and neither does any with the switch off', async () => {
  const { win, doc } = player({ ready: 0 });
  const { back } = steps(doc, win);
  point(doc, win);
  await frame();
  assert.equal(back.state().shown, false);

  const off = player();
  const { next } = steps(off.doc, off.win, { enabled: () => false });
  point(off.doc, off.win);
  await frame();
  assert.equal(next.state().shown, false);
});

test('another video pausing elsewhere leaves the buttons where they are', async () => {
  const { win, doc, video } = player();
  const { next } = steps(doc, win);
  point(doc, win);
  await frame();
  const other = doc.createElement('video');
  doc.body.append(other);
  other.dispatchEvent(new win.Event('play'));
  await frame();
  assert.deepEqual([next.state().shown, next.state().top], [true, '104px']);
  assert.equal(video.paused, true);
});

test('from the keyboard, pausing the player brings the buttons to the control focus is on', async () => {
  const { win, doc, video, control } = player({ paused: false });
  const { back, next } = steps(doc, win);
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Tab' }));
  control.focus();
  await frame();
  assert.equal(back.state().shown, false, 'playing, so nothing yet');
  video.pause();
  await frame();
  assert.deepEqual([back.state().shown, next.state().shown], [true, true]);
  const tab = new win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  control.dispatchEvent(tab);
  assert.ok(doc.activeElement === doc.querySelector('[data-hushfacebook-web="frame-back"]'), 'Tab steps onto Back a frame');
  await video.play();
  await frame();
  assert.deepEqual([back.state().shown, next.state().shown], [false, false], 'playing again takes them away at once, focus on a button or not');
});

test('a play or pause on some other video looks nothing up again', async () => {
  const { win, doc, video } = player();
  let asked = 0;
  const button = createDownloadButton({ doc, win, find: (media) => (asked++, media === video ? { video } : null), run: async () => {}, active: () => true });
  stops.push(() => button.stop());
  point(doc, win);
  await frame();
  assert.deepEqual([button.state().shown, asked], [true, 1]);
  const other = doc.createElement('video');
  doc.body.append(other);
  button.recheck(other);
  await frame();
  assert.equal(asked, 1, 'a feed video starting elsewhere costs nothing');
  button.recheck(video);
  await frame();
  assert.deepEqual([button.state().shown, asked], [true, 2], 'its own video is asked again');
});

test('while a click is still running on its video, a pause or play there looks nothing up', async () => {
  const { win, doc, video } = player();
  let asked = 0;
  let finish = null;
  const button = createDownloadButton({
    doc, win, active: () => true, busyText: 'Saving',
    find: () => (asked++, { video }),
    run: () => new Promise((resolve) => { finish = resolve; }),
  });
  stops.push(() => button.stop());
  point(doc, win);
  await frame();
  button.click();
  await frame();
  const before = asked;
  button.recheck(video);
  await frame();
  assert.deepEqual([asked, button.state().text], [before, 'Saving']);
  finish();
});

test('a button left up on one video for a moment takes no row from the stack on the next', async () => {
  const { win, doc, video } = player();
  const second = doc.createElement('video');
  Object.defineProperties(second, {
    paused: { get: () => true },
    readyState: { get: () => 1 },
    duration: { get: () => 40 },
  });
  second.getBoundingClientRect = () => ({ left: 100, top: 300, right: 700, bottom: 700, width: 600, height: 400 });
  doc.body.append(second);
  // Only the first video has a download, so Download stays on it while it fades.
  const download = createDownloadButton({ doc, win, find: (media) => (media === video ? { video } : null), run: async () => {}, active: () => true });
  stops.push(() => download.stop());
  const { back, next } = steps(doc, win);
  point(doc, win);
  await frame();
  assert.deepEqual([download, back, next].map((button) => button.state().top), ['60px', '104px', '148px']);
  doc.elementsFromPoint = () => [second];
  doc.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 300, clientY: 500 }));
  await frame();
  assert.deepEqual([download.state().shown, download.state().top, back.state().top, next.state().top], [true, '60px', '310px', '354px']);
});

test('buttons made in any order still stack in row order as others come and go', async () => {
  const { win, doc, video, control } = player();
  // Frame step first, so its buttons place themselves before Download is up.
  const { back, next } = steps(doc, win);
  let downloads = true;
  const download = createDownloadButton({ doc, win, find: () => ({ video }), run: async () => {}, active: () => downloads });
  stops.push(() => download.stop());
  point(doc, win);
  await frame();
  assert.deepEqual([download, back, next].map((button) => button.state().top), ['60px', '104px', '148px']);
  downloads = false;
  point(doc, win);
  await frame();
  assert.deepEqual([download.state().shown, back.state().top, next.state().top], [false, '60px', '104px'], 'the gap Download left closes');
  // From the keyboard too.
  downloads = true;
  doc.dispatchEvent(new win.PointerEvent('pointermove', { clientX: 900, clientY: 900 }));
  doc.elementsFromPoint = () => [];
  await new Promise((resolve) => setTimeout(resolve, 520));
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Tab' }));
  control.focus();
  await frame();
  assert.deepEqual([download, back, next].map((button) => button.state().top), ['60px', '104px', '148px']);
});

test('the corner stack closes up: only buttons up on the same video take a row', async () => {
  const { win, doc, video } = player();
  let downloads = true;
  const download = createDownloadButton({ doc, win, find: () => ({ video }), run: async () => {}, active: () => downloads });
  const popOut = createPopOut({ doc, win, enabled: () => true });
  stops.push(() => download.stop(), () => popOut.stop());
  const { back, next } = steps(doc, win);
  point(doc, win);
  await frame();
  assert.deepEqual([download, popOut, back, next].map((button) => button.state().top), ['60px', '104px', '148px', '192px'], 'all four, in row order');
  // Downloads switched off: the rest move up a row.
  downloads = false;
  point(doc, win);
  await frame();
  assert.deepEqual([download.state().shown, popOut.state().top, back.state().top, next.state().top], [false, '60px', '104px', '148px']);
  // The video plays: Frame step goes and Pop out stays on top.
  await video.play();
  await new Promise((resolve) => setTimeout(resolve, 520));
  assert.deepEqual([popOut.state().shown, popOut.state().top, back.state().shown], [true, '60px', false]);
});

test('Frame step is off by default and counts steps each way for Diagnostics', async () => {
  assert.equal(frameStep.id, 'frameStep');
  assert.equal(frameStep.section, 'playback');
  assert.equal(frameStep.android, 'Frame step');
  assert.equal(frameStep.default, false);
  const { win, doc } = player();
  // The buttons' shadow roots are closed. Kept open here so the test can reach the buttons.
  const attach = win.HTMLElement.prototype.attachShadow;
  win.HTMLElement.prototype.attachShadow = function (init) {
    return attach.call(this, { ...init, mode: 'open' });
  };
  const rows = {};
  frameStep.setup({ doc, win, enabled: () => true, diagnostics: { add: (name, value) => { rows[name] = value; } } });
  point(doc, win);
  await frame();
  win.HTMLElement.prototype.attachShadow = attach;
  const press = async (name) => {
    doc.querySelector(`[data-hushfacebook-web="${name}"]`).shadowRoot.querySelector('button').click();
    await frame();
  };
  assert.equal(rows['Frames stepped'](), '0 back, 0 forward');
  await press('frame-next');
  await press('frame-next');
  await press('frame-back');
  assert.equal(rows['Frames stepped'](), '1 back, 2 forward');
});
