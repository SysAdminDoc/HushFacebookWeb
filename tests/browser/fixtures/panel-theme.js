import { createDiagnostics } from '../../../src/core/diagnostics.js';
import { createHider, hideCss, MARK } from '../../../src/core/dom/hide.js';
import { createLog } from '../../../src/core/log.js';
import { createSettings } from '../../../src/core/settings.js';
import { createMemoryStorage } from '../../../src/core/storage.js';
import { features } from '../../../src/features/index.js';
import { featureKeys, SEEN_SETTINGS_KEY } from '../../../src/ui/new-dots.js';
import { mountPanel } from '../../../src/ui/panel.js';
import { check } from './helpers.js';

const CLASSES = { light: '__fb-light-mode', dark: '__fb-dark-mode' };
const PAGE = { light: '#f0f2f5', dark: '#18191a' };
// The panel's base and the note's text in each mode (styles.js, note-colors.js).
const BASE = { light: 'rgb(255, 255, 255)', dark: 'rgb(21, 25, 31)' };
const NOTE = { light: 'rgb(91, 60, 196)', dark: 'rgb(196, 176, 255)' };
const frame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));

const channels = (color) => color.match(/[\d.]+/g).slice(0, 3).map(Number);
const luminance = (color) => {
  const [r, g, b] = channels(color).map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};
const post = (n) => `<div aria-posinset="${n}"><div class="inner"><a href="/someone">Someone ${n}</a><p>Post number ${n}</p></div></div>`;

function setTheme(theme) {
  const html = document.documentElement;
  html.classList.remove(...Object.values(CLASSES));
  html.classList.add(CLASSES[theme]);
  document.body.style.background = PAGE[theme];
}

// The panel, its toasts and a hidden post's note on Facebook's light or dark mode. Each follows
// the class on <html>, switches while the panel is open, and a note inside one of Facebook's
// islands of the other mode follows the island. Ends in `theme` for the screenshot.
export async function panelTheme({ theme }) {
  const other = theme === 'light' ? 'dark' : 'light';
  setTheme(theme);
  const rules = document.createElement('style');
  rules.textContent = hideCss({ notes: true });
  document.head.append(rules);
  const feed = document.createElement('main');
  feed.innerHTML = `${post(1)}<div class="${CLASSES[other]}">${post(2)}</div>`;
  document.body.append(feed);
  const log = createLog({ sink: { info() {}, warn() {}, error() {} } });
  const storage = createMemoryStorage();
  const settings = createSettings({ storage, features, log });
  const hider = createHider({ doc: document, log, notesShown: () => true });
  const [own, island] = [...feed.querySelectorAll('[aria-posinset]')];
  check(hider.hide(own, 'Sponsored') && hider.hide(island, 'Sponsored'), 'The posts were not hidden');
  let shadow;
  const attach = HTMLElement.prototype.attachShadow;
  HTMLElement.prototype.attachShadow = function (init) {
    const found = attach.call(this, init);
    if (this.dataset.hushfacebookWeb === 'ui') shadow = found;
    return found;
  };
  const now = Date.now();
  const panel = mountPanel({
    settings, features, log, hider, diagnostics: createDiagnostics(), actions: null, unavailable: new Map(),
    environment: {
      version: __HFW_VERSION__, manager: 'Local fixture', managerVersion: '1', mode: 'page', pageAccess: 'page', storage,
      update: () => ({ state: 'current', update: null, checking: false, checkedAt: now, triedAt: now, nextAt: now + 86400000 }),
    },
  });
  HTMLElement.prototype.attachShadow = attach;
  panel.open('feed');
  panel.toast('Saved.');
  await frame();

  // A row's help opens in place with More, and the opened row still fits its box.
  const more = shadow.querySelector('.settings-group .more');
  check(more !== null, 'No row keeps its help behind More');
  const rest = shadow.getElementById(more.getAttribute('aria-controls'));
  const closedHeight = more.closest('.card').getBoundingClientRect().height;
  more.click();
  await frame();
  check(more.getAttribute('aria-expanded') === 'true' && !rest.hidden && rest.getBoundingClientRect().height > 0, 'More did not show the rest');
  check(more.closest('.card').getBoundingClientRect().height > closedHeight, 'The row did not grow to show the rest');
  check(rest.getBoundingClientRect().right <= more.closest('.card').getBoundingClientRect().right + 1, 'The rest runs out of its row');

  const dialog = shadow.querySelector('.dialog');
  const noteColor = (element) => getComputedStyle(element.querySelector(`[${MARK}]`), '::before').color;
  const look = (mode) => {
    check(getComputedStyle(dialog).backgroundColor === BASE[mode], `The panel is not ${mode} (${getComputedStyle(dialog).backgroundColor})`);
    check(noteColor(own) === NOTE[mode], `The note is not ${mode} (${noteColor(own)})`);
    // The island keeps its own mode whichever way the page goes.
    check(noteColor(island) === NOTE[other], `A note in a ${other} island did not follow it (${noteColor(island)})`);
    // Every row's words against the box they sit in.
    const group = shadow.querySelector('.settings-group');
    const box = getComputedStyle(group).backgroundColor;
    for (const selector of ['.title', '.desc', '.more']) {
      const ratio = contrast(getComputedStyle(group.querySelector(selector)).color, box);
      check(ratio >= 4.5, `${selector} reads at ${ratio.toFixed(2)}:1 in ${mode}`);
    }
    const toast = shadow.querySelector('.toast');
    const toastRatio = contrast(getComputedStyle(toast).color, getComputedStyle(toast).backgroundColor);
    check(toastRatio >= 4.5, `The toast reads at ${toastRatio.toFixed(2)}:1 in ${mode}`);
  };
  look(theme);
  // Facebook (or Force dark mode) switching while the panel is open.
  setTheme(other);
  await frame();
  look(other);
  setTheme(theme);
  await frame();
  look(theme);
  return { base: getComputedStyle(dialog).backgroundColor, note: noteColor(own) };
}

// A color with its alpha, and one laid over another.
const rgba = (color) => {
  const [r, g, b, a = 1] = color.match(/[\d.]+/g).map(Number);
  return [r, g, b, a];
};
const over = ([r, g, b, a], [br, bg, bb]) => [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1];
const css = ([r, g, b]) => `rgb(${r}, ${g}, ${b})`;
// What an element's words sit on: the backgrounds behind it, laid over each other down to the
// first solid one.
const behind = (element) => {
  const layers = [];
  for (let el = element; el; el = el.parentElement) {
    const layer = rgba(getComputedStyle(el).backgroundColor);
    if (layer[3] > 0) layers.push(layer);
    if (layer[3] >= 1) break;
  }
  return layers.reverse().reduce((under, layer) => over(layer, under), [255, 255, 255, 1]);
};

// The panel's own pages on Facebook's light or dark mode: Appearance with what an update added
// (new-dots) and an option open, or Diagnostics with hide decisions, warnings in the log and
// the notice Copy report puts up. Every word that shows reads at 4.5:1 or better on what it
// sits on (3:1 for large words), and nothing runs off sideways. end: scrolled to the bottom.
export async function panelPages({ theme, view, end = false }) {
  setTheme(theme);
  const log = createLog({ sink: { info() {}, warn() {}, error() {} } });
  log.info('Feed posts found: 12');
  log.warn('A post had no marker yet, checking again when it fills in');
  log.error("Couldn't read a post's data", new Error('Unexpected end of JSON input'));
  const storage = createMemoryStorage();
  const unseen = ['amoledTheme', 'amoledTheme.lines', 'systemFont'];
  storage.set(SEEN_SETTINGS_KEY, features.flatMap(featureKeys).filter((key) => !unseen.includes(key)));
  const settings = createSettings({ storage, features, log });
  settings.set('amoledTheme', true);
  const diagnostics = createDiagnostics();
  diagnostics.decide({ post: '1029384756', rule: 'Sponsored', signal: 'Sponsored label', layer: 'page' });
  diagnostics.decide({ post: 'pfbid0abc', rule: 'Suggested for you', detail: 'header text', layer: 'data' });
  diagnostics.decide({ post: null, rule: 'Reels', layer: 'page' });
  let copied = null;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { copied = text; } } });
  let shadow;
  const attach = HTMLElement.prototype.attachShadow;
  HTMLElement.prototype.attachShadow = function (init) {
    const found = attach.call(this, init);
    if (this.dataset.hushfacebookWeb === 'ui') shadow = found;
    return found;
  };
  const now = Date.now();
  const panel = mountPanel({
    settings, features, log, hider: createHider({ doc: document, log }), diagnostics, actions: null, unavailable: new Map([['hideFooterLinks', 'failed']]),
    environment: {
      version: __HFW_VERSION__, manager: 'Local fixture', managerVersion: '1', mode: 'page', pageAccess: 'page', storage,
      update: () => ({ state: 'current', update: null, checking: false, checkedAt: now, triedAt: now, nextAt: now + 86400000 }),
    },
  });
  HTMLElement.prototype.attachShadow = attach;
  panel.open(view);
  if (view === 'diagnostics') {
    await panel.copyReport();
    check(typeof copied === 'string' && copied.includes(__HFW_VERSION__), 'Copy report copied nothing');
  } else panel.toast('Saved.');
  await frame();
  const toast = shadow.querySelector('.toast');
  check(toast !== null, 'No notice showed');
  await Promise.all(toast.getAnimations().map((animation) => animation.finished));
  const main = shadow.querySelector('main');
  if (end) main.scrollTop = main.scrollHeight;
  await frame();

  // Every element with words of its own that shows, outside a disabled control.
  const faint = [];
  let read = 0;
  for (const el of shadow.querySelectorAll('*')) {
    const words = [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
    const box = el.getBoundingClientRect();
    if (!words || box.width <= 1 || box.height <= 1 || el.closest(':disabled') || getComputedStyle(el).visibility === 'hidden') continue;
    const style = getComputedStyle(el);
    const back = behind(el);
    const ink = over(rgba(style.color), back);
    const ratio = contrast(css(ink), css(back));
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    read++;
    if (ratio < (large ? 3 : 4.5)) faint.push(`"${el.textContent.trim().slice(0, 40)}" ${ratio.toFixed(2)}:1`);
  }
  check(faint.length === 0, `Words that read faint in ${theme}: ${faint.join('; ')}`);
  check(main.scrollWidth <= main.clientWidth + 1, `The ${view} page scrolls sideways`);
  check(toast.getBoundingClientRect().right <= window.innerWidth + 0.5, 'The notice runs off the screen');
  return { read, toast: toast.textContent, report: copied?.split('\n') ?? null };
}
