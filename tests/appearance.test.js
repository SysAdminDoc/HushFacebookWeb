// The Appearance switches, against the theme Facebook drew live on 2026-10-11: one class on
// <html> for light or dark mode, colors and fonts as CSS variables, emoji as <img> pictures
// named after their code points.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import forceDarkMode, { createDarkKeeper, DARK, LIGHT } from '../src/features/appearance/force-dark.js';
import amoledTheme, { AMOLED_VARS } from '../src/features/appearance/amoled.js';
import accentColor, {
  accentCss, ACCENTS, chosenColor, contrast, FILTERS_MARK, over, palette, parseHex, SURFACES, toHex, toHsl,
} from '../src/features/appearance/accent.js';
import systemFont, { fontCss, fontName, SYSTEM_STACK } from '../src/features/appearance/system-font.js';
import systemEmoji, { createEmojiSwapper, emojiText, ORIGINAL } from '../src/features/appearance/system-emoji.js';
import noTransitions, { ANIMATED, NO_TRANSITIONS_CSS } from '../src/features/appearance/no-transitions.js';

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

function page(html = '', htmlClass = `_9dls ${LIGHT}`) {
  const win = testWindow('https://www.facebook.com/');
  windows.push(win);
  win.document.documentElement.className = htmlClass;
  win.document.body.innerHTML = html;
  return win;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// The parts of a stylesheet's rule for one selector: { '--accent': '#7B3FE4', ... }.
function varsOf(css, selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `no rule for ${selector}`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+): ([^;]+?) !important;/g)].map((m) => [m[1], m[2]]));
}

test('force dark mode swaps the theme class, keeps it swapped and puts it back when off', async () => {
  const win = page();
  const root = win.document.documentElement;
  let on = true;
  const keeper = createDarkKeeper({ doc: win.document, enabled: () => on });
  keeper.start();
  assert.equal(root.className, `_9dls ${DARK}`);
  // Facebook switching itself back to light (its own menu, a theme refresh) is undone.
  root.classList.replace(DARK, LIGHT);
  await tick();
  assert.ok(root.classList.contains(DARK) && !root.classList.contains(LIGHT));
  on = false;
  keeper.apply();
  assert.equal(root.className, `_9dls ${LIGHT}`);
  keeper.stop();
});

test('force dark mode leaves a page that was already dark as it is when switched off', () => {
  const win = page('', `_9dls ${DARK}`);
  let on = true;
  const keeper = createDarkKeeper({ doc: win.document, enabled: () => on });
  keeper.start();
  assert.equal(keeper.state().swapped, false);
  on = false;
  keeper.apply();
  assert.equal(win.document.documentElement.className, `_9dls ${DARK}`, 'Facebook chose dark, so it stays dark');
  keeper.stop();
});

// Facebook writes its theme by removing the old class and adding the new one (live 2026-10-11,
// run 32). Picking Dark in its own menu while the script holds the page dark changes nothing on
// the page, so only the calls show it.
const facebookPicks = (root, theme) => {
  root.classList.remove(theme === DARK ? LIGHT : DARK);
  root.classList.add(theme);
};
// happy-dom runs classList methods on the list behind its Proxy, which knows its element.
const ownerOf = (list) => list[Object.getOwnPropertySymbols(list).find((symbol) => symbol.description === 'ownerElement')];
const watchingKeeper = (doc, enabled) => createDarkKeeper({ doc, enabled, isRootList: (list) => ownerOf(list) === doc.documentElement });

test("force dark mode keeps dark after it's switched off when Facebook picked dark meanwhile", async () => {
  const win = page();
  const root = win.document.documentElement;
  let on = true;
  const keeper = watchingKeeper(win.document, () => on);
  keeper.start();
  assert.equal(keeper.state().swapped, true);
  facebookPicks(root, DARK);
  await tick();
  assert.equal(keeper.state().swapped, false);
  on = false;
  keeper.apply();
  assert.equal(root.className, `_9dls ${DARK}`, "Facebook's new choice stays");
  keeper.stop();
});

test('force dark mode brings light back when Facebook went dark and then light again before the switch went off', async () => {
  const win = page();
  const root = win.document.documentElement;
  let on = true;
  const keeper = watchingKeeper(win.document, () => on);
  keeper.start();
  facebookPicks(root, DARK);
  await tick();
  facebookPicks(root, LIGHT);
  await tick();
  assert.ok(root.classList.contains(DARK), 'still held dark while the switch is on');
  assert.equal(keeper.state().swapped, true);
  on = false;
  keeper.apply();
  assert.equal(root.className, `_9dls ${LIGHT}`);
  keeper.stop();
});

test("force dark mode never takes its own swaps, or a popup layer's class, for Facebook's choice", async () => {
  const win = page(`<div class="${LIGHT}" id="layer"></div>`);
  const doc = win.document;
  let on = true;
  const keeper = watchingKeeper(doc, () => on);
  keeper.start();
  on = false;
  keeper.apply();
  on = true;
  keeper.apply();
  assert.equal(keeper.state().swapped, true, "the second swap is the script's too");
  doc.getElementById('layer').classList.add(DARK);
  await tick();
  assert.equal(keeper.state().swapped, true);
  on = false;
  keeper.apply();
  assert.equal(doc.documentElement.className, `_9dls ${LIGHT}`);
  keeper.stop();
});

test('force dark mode stops instead of fighting a page that keeps switching back', () => {
  const win = page();
  const root = win.document.documentElement;
  let time = 0;
  const warnings = [];
  const keeper = createDarkKeeper({ doc: win.document, enabled: () => true, now: () => time, log: { warn: (m) => warnings.push(m) } });
  for (let i = 0; i < 25; i += 1) {
    root.classList.replace(DARK, LIGHT);
    time += 10;
    keeper.apply();
  }
  assert.equal(keeper.state().gaveUp, true);
  assert.ok(root.classList.contains(LIGHT));
  assert.equal(warnings.length, 1);
  // Slow switching, once a minute, never trips it.
  const calm = page();
  const calmKeeper = createDarkKeeper({ doc: calm.document, enabled: () => true, now: () => time });
  for (let i = 0; i < 40; i += 1) {
    calm.document.documentElement.classList.replace(DARK, LIGHT);
    time += 60000;
    calmKeeper.apply();
  }
  assert.equal(calmKeeper.state().gaveUp, false);
  assert.ok(calm.document.documentElement.classList.contains(DARK));
});

test("force dark mode turns Facebook's popup layers dark too, and puts back only the ones it changed", async () => {
  // Live 2026-10-11: plain divs in the top bar and at the end of <body> hold the menus and keep
  // their own theme class.
  const win = page(`<div role="banner"><div class="${LIGHT}" id="bar-layer"><div role="dialog">menu</div></div></div>
    <div class="${DARK}" id="own-dark"></div><div><div class="${LIGHT}" id="body-layer"></div></div>`);
  const doc = win.document;
  let on = true;
  const keeper = createDarkKeeper({ doc, enabled: () => on });
  keeper.start();
  const theme = (id) => (doc.getElementById(id).classList.contains(DARK) ? 'dark' : 'light');
  assert.deepEqual(['bar-layer', 'body-layer', 'own-dark'].map(theme), ['dark', 'dark', 'dark']);
  assert.equal(keeper.state().layers, 2);
  // A layer drawn later, and one Facebook sets back to light.
  doc.body.insertAdjacentHTML('beforeend', `<div class="${LIGHT}" id="late-layer"></div>`);
  doc.getElementById('bar-layer').className = LIGHT;
  await tick();
  assert.deepEqual(['bar-layer', 'late-layer'].map(theme), ['dark', 'dark']);
  assert.equal(keeper.state().layers, 3);
  on = false;
  keeper.apply();
  assert.deepEqual(['bar-layer', 'body-layer', 'late-layer', 'own-dark'].map(theme), ['light', 'light', 'light', 'dark'],
    "Facebook's own dark layer stays dark");
  assert.equal(doc.documentElement.className, `_9dls ${LIGHT}`);
  keeper.stop();
});

test("force dark mode leaves the light islands Facebook puts in its own dark areas", async () => {
  // Live 2026-10-12, Reels' library page with no script: a dark div around the tab list, the
  // selected tab white, and its word in a light div so it comes out dark.
  const chip = (id) => `<div class="${DARK}" id="${id}-area"><div role="tablist"><div role="tab">
    <div class="${LIGHT}" id="${id}"><div class="${LIGHT}" id="${id}-inner"><span>Saved</span></div></div></div></div></div>`;
  const win = page(`${chip('chip')}<div class="${LIGHT}" id="layer"><div class="${LIGHT}" id="in-layer"></div></div>`);
  const doc = win.document;
  let on = true;
  const keeper = createDarkKeeper({ doc, enabled: () => on });
  keeper.start();
  const theme = (id) => (doc.getElementById(id).classList.contains(DARK) ? 'dark' : 'light');
  assert.deepEqual(['chip', 'chip-inner', 'layer', 'in-layer'].map(theme), ['light', 'light', 'dark', 'dark']);
  // One drawn later, and one inside a layer the script darkened, which only follows the page.
  doc.body.insertAdjacentHTML('beforeend', chip('late'));
  doc.getElementById('layer').insertAdjacentHTML('beforeend', `<div class="${LIGHT}" id="in-layer-late"></div>`);
  await tick();
  assert.deepEqual(['late', 'late-inner', 'in-layer-late'].map(theme), ['light', 'light', 'dark']);
  on = false;
  keeper.apply();
  assert.deepEqual(['chip', 'chip-area', 'layer', 'in-layer'].map(theme), ['light', 'dark', 'light', 'light']);
  keeper.stop();
});

test('force dark mode stops swapping layers that keep coming back light', () => {
  const win = page(`<div class="${LIGHT}" id="layer"></div>`);
  let time = 0;
  const warnings = [];
  const keeper = createDarkKeeper({ doc: win.document, enabled: () => true, now: () => time, log: { warn: (m) => warnings.push(m) } });
  const layer = win.document.getElementById('layer');
  for (let i = 0; i < 250; i += 1) {
    layer.className = LIGHT;
    time += 5;
    keeper.apply();
  }
  assert.equal(keeper.state().gaveUp, true);
  assert.equal(warnings.length, 1);
});

test('force dark mode darkens a page full of layers without mistaking it for a fight', async () => {
  const many = Array.from({ length: 300 }, (_, i) => `<div class="${LIGHT}" id="l${i}"></div>`).join('');
  const win = page(many);
  const doc = win.document;
  const keeper = createDarkKeeper({ doc, enabled: () => true, log: { warn: () => assert.fail('gave up') } });
  keeper.start();
  assert.equal(doc.getElementsByClassName(LIGHT).length, 0);
  // Layers that arrive later, nested inside new content, are found from the change itself.
  doc.body.insertAdjacentHTML('beforeend', `<div><section>${many.replace(/id="l/g, 'id="m')}</section></div>`);
  await tick();
  assert.equal(doc.getElementsByClassName(LIGHT).length, 0);
  assert.deepEqual(keeper.state(), { swapped: true, gaveUp: false, layers: 600 });
  keeper.stop();
});

test('force dark mode follows the switch through settings', () => {
  const win = page();
  let on = true;
  const listeners = [];
  forceDarkMode.setup({ doc: win.document, enabled: () => on, settings: { subscribe: (fn) => listeners.push(fn) } });
  assert.ok(win.document.documentElement.classList.contains(DARK));
  on = false;
  for (const fn of listeners) fn({ keys: ['forceDarkMode'] });
  assert.ok(win.document.documentElement.classList.contains(LIGHT));
});

test('AMOLED turns dark mode surfaces black and leaves light mode alone', () => {
  const css = amoledTheme.css;
  const vars = varsOf(typeof css === 'function' ? css() : css, '.__fb-dark-mode');
  for (const name of ['--web-wash', '--wash', '--card-background', '--surface-background', '--nav-bar-background']) assert.equal(vars[name], '#000000', name);
  // Bubbles, boxes and menus keep a visible step above the black.
  assert.equal(vars['--comment-background'], '#121212');
  assert.equal(vars['--popover-background'], '#1A1A1A');
  assert.deepEqual(vars, AMOLED_VARS);
  assert.ok(!(typeof css === 'function' ? css() : css).includes('__fb-light-mode'));
});

test('color math matches Facebook\'s own blue', () => {
  assert.deepEqual(parseHex('#0866FF'), [8, 102, 255]);
  assert.deepEqual(parseHex('0866ff'), [8, 102, 255]);
  for (const bad of ['', '#08F', 'blue', '#0866FG', '#0866FF;}', null]) assert.equal(parseHex(bad), null, String(bad));
  const [h, s, l] = toHsl([8, 102, 255]);
  assert.ok(Math.abs(h - 217.2) < 0.1 && Math.abs(s - 100) < 0.1 && Math.abs(l - 51.6) < 0.1);
  for (const { hex } of ACCENTS) assert.equal(toHex(toHsl(parseHex(hex))), hex, 'round trip');
  // Facebook's light link is a darker step and its dark link a lighter one.
  const blue = palette('#0866FF');
  assert.equal(toHsl(parseHex(blue.light.link))[2].toFixed(0), '41');
  // Lightness 68 in this hue is #5C9AFF, 4.0:1 on dark mode's #3A3B3C bubbles, so it goes on
  // to 72, near Facebook's own #5AA7FF.
  assert.equal(toHsl(parseHex(blue.dark.link))[2].toFixed(0), '72');
  assert.ok(contrast(blue.dark.link, '#3A3B3C') >= 4.5);
  assert.equal(blue.light.focus, '#0866FF', 'the focus ring stays the color itself when it reads');
  assert.equal(blue.onBase, '#FFFFFF');
  assert.equal(palette('#FFD54F').onBase, '#000000', 'dark text on a light color');
});

test('accent text and focus shades read on the surfaces they sit on, for every preset and your own colors', () => {
  // Known WCAG pairs, so the checks below measure what they should.
  assert.equal(contrast('#FFFFFF', '#000000'), 21);
  assert.equal(contrast('#767676', '#FFFFFF').toFixed(2), '4.54');
  assert.equal(contrast('#FFFFFF', '#E8590C').toFixed(2), '3.58', 'white on the orange preset, which it used to get');
  assert.equal(over([0, 0, 0], '#FFFFFF', 0.2), '#CCCCCC');
  const amoled = ['#000000', '#121212', '#1A1A1A'];
  // #0014F0's outlined-button text reads on a dark card but not on the button's own tint.
  const customs = ['#999999', '#D1D100', '#FFD54F', '#00FFFF', '#FFFFFF', '#000000', '#202020', '#000080', '#FF00AA', '#0866FF', '#0014F0'];
  for (const hex of [...ACCENTS.map((accent) => accent.hex), ...customs]) {
    const rgb = parseHex(hex);
    const { base, onBase, light, dark } = palette(hex);
    const reads = (shade, surfaces, ratio, what) => {
      for (const surface of surfaces) {
        const ratioThere = contrast(shade, surface);
        assert.ok(ratioThere >= ratio, `${hex} ${what} ${shade} on ${surface} is ${ratioThere.toFixed(2)}`);
      }
    };
    reads(onBase, [base], 4.5, 'button text');
    reads(light.link, [SURFACES.white, SURFACES.wash, light.button, light.highlight, light.selected], 4.5, 'light link');
    reads(light.toastLink, [SURFACES.white], 4.5, 'light toast link');
    reads(light.focus, [SURFACES.white, SURFACES.wash], 3, 'light focus ring');
    reads(dark.link, [SURFACES.card, SURFACES.bubble, ...amoled], 4.5, 'dark link');
    reads(dark.label, [SURFACES.box, ...amoled], 4.5, 'dark field label');
    reads(dark.toastLink, [SURFACES.box, ...amoled], 4.5, 'dark toast link');
    reads(dark.deemphasized, [over(rgb, SURFACES.card, 0.2), over(rgb, '#000000', 0.2)], 4.5, 'dark outlined button');
    reads(dark.focus, [SURFACES.card, SURFACES.bubble, ...amoled], 3, 'dark focus ring');
    // The shades only get lighter or darker, so a colorful choice keeps its hue.
    const [hue, saturation] = toHsl(rgb);
    if (saturation < 20) continue;
    for (const shade of [light.link, light.focus, dark.link, dark.deemphasized]) {
      const [shadeHue, , lightness] = toHsl(parseHex(shade));
      if (lightness < 10 || lightness > 90) continue;
      assert.ok(Math.abs(((shadeHue - hue + 540) % 360) - 180) < 4, `${hex} keeps its hue in ${shade}`);
    }
  }
  // A pale yellow can't be a light-mode link at Facebook's step, so it gets a deep olive.
  const yellow = palette('#D1D100');
  assert.ok(contrast('#D1D100', SURFACES.white) < 2);
  assert.ok(toHsl(parseHex(yellow.light.link))[2] < 30);
  assert.notEqual(yellow.light.focus, yellow.base);
});

test('accent color sets both themes, the dark one after the light one', () => {
  const css = accentCss('#7B3FE4');
  const light = varsOf(css, ':root, .__fb-light-mode');
  const dark = varsOf(css, '.__fb-dark-mode');
  assert.ok(css.indexOf('.__fb-dark-mode {') > css.indexOf(':root, .__fb-light-mode {'), 'dark wins on <html> in dark mode');
  for (const vars of [light, dark]) {
    assert.equal(vars['--accent'], '#7B3FE4');
    assert.equal(vars['--primary-button-background'], '#7B3FE4');
    assert.equal(vars['--progress-ring-blue-background'], 'rgba(123, 63, 228, 0.2)');
    for (const kept of ['--fb-logo', '--fb-wordmark', '--reaction-like', '--story-unseen']) assert.equal(vars[kept], undefined, kept);
  }
  const colors = palette('#7B3FE4');
  assert.equal(light['--blue-link'], colors.light.link);
  assert.equal(dark['--blue-link'], colors.dark.link);
  assert.notEqual(light['--blue-link'], dark['--blue-link']);
  assert.equal(light['--filter-accent'], 'url("#hfw-accent-base")');
  assert.equal(dark['--filter-blue-link-icon'], 'url("#hfw-accent-link-dark")');
  const pale = palette('#D1D100');
  const paleLight = varsOf(accentCss('#D1D100'), ':root, .__fb-light-mode');
  const paleDark = varsOf(accentCss('#D1D100'), '.__fb-dark-mode');
  assert.equal(paleLight['--focus-ring-blue'], pale.light.focus, 'light mode rings use the shade that shows on white');
  assert.equal(paleDark['--focus-ring-blue'], pale.dark.focus);
  assert.equal(paleLight['--primary-button-text'], '#000000');
  assert.equal(accentCss('nonsense'), '');
});

test('accent color takes your own color only when it is a plain hex color', () => {
  const settings = { 'accentColor.color': 'teal', 'accentColor.custom': '' };
  const get = (key) => settings[key];
  assert.equal(chosenColor(get), '#00897B');
  settings['accentColor.custom'] = '#ff00aa';
  assert.equal(chosenColor(get), '#ff00aa');
  assert.ok(accentColor.css(get).includes('--accent: #FF00AA !important;'));
  settings['accentColor.custom'] = 'ff00aa';
  assert.equal(chosenColor(get), '#ff00aa');
  for (const bad of ['red; } body { display: none', '#ff00a', 'url(x)']) {
    settings['accentColor.custom'] = bad;
    assert.equal(chosenColor(get), '#00897B', bad);
    assert.ok(!accentColor.css(get).includes('display'), bad);
  }
  settings['accentColor.color'] = 'gone';
  settings['accentColor.custom'] = '';
  assert.equal(chosenColor(get), ACCENTS[0].hex, 'an unknown choice falls back to the first');
});

test('accent color writes icon filters of the exact color and removes them when off', () => {
  const win = page('<div id="app"></div>');
  const doc = win.document;
  const values = { 'accentColor.color': 'green', 'accentColor.custom': '' };
  let on = true;
  const listeners = [];
  const settings = { get: (key) => values[key], subscribe: (fn) => listeners.push(fn) };
  accentColor.setup({ doc, settings, enabled: () => on });
  const svg = doc.querySelector(`svg[${FILTERS_MARK}]`);
  assert.ok(svg);
  const flood = (id) => svg.querySelector(`filter[id="${id}"] feFlood`)?.getAttribute('flood-color');
  assert.equal(flood('hfw-accent-base'), '#1E8E3E');
  assert.equal(flood('hfw-accent-link-dark'), palette('#1E8E3E').dark.link);
  assert.equal(svg.querySelector('filter[id="hfw-accent-base"]').getAttribute('color-interpolation-filters'), 'sRGB');
  assert.equal(svg.querySelector('feComposite').getAttribute('operator'), 'in');
  values['accentColor.color'] = 'red';
  for (const fn of listeners) fn({ keys: ['accentColor.color'] });
  assert.equal(doc.querySelectorAll(`svg[${FILTERS_MARK}]`).length, 1, 'rewritten in place');
  assert.equal(flood('hfw-accent-base'), '#D93025');
  on = false;
  for (const fn of listeners) fn({ keys: ['accentColor'] });
  assert.equal(doc.querySelector(`svg[${FILTERS_MARK}]`), null);
});

test('system font points every Facebook font variable at the system stack', () => {
  const values = { 'systemFont.font': '' };
  const get = (key) => values[key];
  const vars = varsOf(fontCss(get), ':root, .__fb-light-mode, .__fb-dark-mode');
  assert.deepEqual(Object.keys(vars).sort(), ['--font-family-apple', '--font-family-default', '--font-family-segoe', '--font-family-system-fds']);
  for (const value of Object.values(vars)) assert.equal(value, SYSTEM_STACK);
  assert.ok(!fontCss(get).includes('--font-family-code'), 'code keeps its monospace font');
  values['systemFont.font'] = '  Atkinson   Hyperlegible ';
  assert.ok(systemFont.css(get).includes('"Atkinson Hyperlegible", system-ui'));
});

test('a font name that could break out of its CSS string is ignored', () => {
  assert.equal(fontName('Inter'), 'Inter');
  assert.equal(fontName('Noto Sans CJK JP'), 'Noto Sans CJK JP');
  assert.equal(fontName('Fira Code 6.2'), 'Fira Code 6.2');
  assert.equal(fontName(`Hiragino Kaku Gothic ${String.fromCodePoint(0x30d7, 0x30ed)}`), `Hiragino Kaku Gothic ${String.fromCodePoint(0x30d7, 0x30ed)}`);
  for (const bad of ['Inter"; } body { display: none', "Inter'", 'a;b', 'a{b', 'a\\b', '<x>', '-Inter', 'x'.repeat(65)]) {
    assert.equal(fontName(bad), '', bad);
  }
});

const SMILE = String.fromCodePoint(0x1f600);
const HANDS = String.fromCodePoint(0x1faf6, 0x1f3fb);
const emojiImg = (alt, name) => `<span><img height="16" width="16" alt="${alt}" src="https://static.xx.fbcdn.net/images/emoji.php/v9/t4/1/16/${name}.png"></span>`;

test('emoji text comes from the alt, or from the file name when the alt has none', () => {
  const win = page(`${emojiImg(SMILE, '1f600')}${emojiImg('', '1faf6_1f3fb')}${emojiImg(':)', '1f642')}`);
  const [a, b, c] = win.document.querySelectorAll('img');
  assert.equal(emojiText(a), SMILE);
  assert.equal(emojiText(b), HANDS);
  assert.equal(emojiText(c), String.fromCodePoint(0x1f642), 'plain-text alt falls back to the file name');
  // Live 2026-10-11: the snowflake's alt is U+2744 U+FE0F but its file is 2744.png. The alt
  // wins, since without U+FE0F the system may draw the plain text snowflake.
  const snow = page(emojiImg(String.fromCodePoint(0x2744, 0xfe0f), '2744')).document.querySelector('img');
  assert.equal(emojiText(snow), String.fromCodePoint(0x2744, 0xfe0f));
});

test('system emoji swaps emoji pictures, keeps the alt and layout, and puts them back', async () => {
  const win = page(`<p>Hi ${emojiImg(SMILE, '1f600')} there</p><img id="photo" src="https://scontent.xx.fbcdn.net/v/t39/1.jpg" alt="photo">`);
  const doc = win.document;
  let on = true;
  const swapper = createEmojiSwapper({ doc, enabled: () => on });
  swapper.apply();
  const img = doc.querySelector('p img');
  const original = 'https://static.xx.fbcdn.net/images/emoji.php/v9/t4/1/16/1f600.png';
  assert.ok(img.getAttribute('src').startsWith('data:image/svg+xml'));
  assert.ok(decodeURIComponent(img.getAttribute('src')).includes(`>${SMILE}</text>`));
  assert.equal(img.getAttribute(ORIGINAL), original);
  assert.equal(img.getAttribute('alt'), SMILE);
  assert.equal(img.getAttribute('width'), '16');
  assert.equal(doc.querySelector('#photo').getAttribute('src'), 'https://scontent.xx.fbcdn.net/v/t39/1.jpg', 'other images untouched');
  // A comment that loads later.
  doc.body.insertAdjacentHTML('beforeend', `<div>${emojiImg(HANDS, '1faf6_1f3fb')}</div>`);
  await tick();
  const later = doc.querySelector('div img');
  assert.equal(later.getAttribute(ORIGINAL), 'https://static.xx.fbcdn.net/images/emoji.php/v9/t4/1/16/1faf6_1f3fb.png');
  // Facebook reuses the image for another emoji.
  img.setAttribute('src', 'https://static.xx.fbcdn.net/images/emoji.php/v9/t4/1/16/1f642.png');
  img.setAttribute('alt', String.fromCodePoint(0x1f642));
  await tick();
  assert.ok(decodeURIComponent(img.getAttribute('src')).includes(`>${String.fromCodePoint(0x1f642)}</text>`));
  assert.equal(img.getAttribute(ORIGINAL), 'https://static.xx.fbcdn.net/images/emoji.php/v9/t4/1/16/1f642.png');
  assert.equal(swapper.state().swapped, 3);
  on = false;
  swapper.apply();
  assert.equal(img.getAttribute('src'), 'https://static.xx.fbcdn.net/images/emoji.php/v9/t4/1/16/1f642.png');
  assert.equal(later.getAttribute('src'), 'https://static.xx.fbcdn.net/images/emoji.php/v9/t4/1/16/1faf6_1f3fb.png');
  assert.equal(doc.querySelector(`[${ORIGINAL}]`), null);
  // Off means off: new emoji stay Facebook's.
  doc.body.insertAdjacentHTML('beforeend', `<section>${emojiImg(SMILE, '1f600')}</section>`);
  await tick();
  assert.ok(doc.querySelector('section img').getAttribute('src').includes('/images/emoji.php/'));
});

test('a swapped emoji image that Facebook reuses for a photo keeps the photo when the switch goes off', async () => {
  const win = page(`<p>${emojiImg(SMILE, '1f600')}</p>`);
  const doc = win.document;
  let on = true;
  const swapper = createEmojiSwapper({ doc, enabled: () => on });
  swapper.apply();
  const img = doc.querySelector('p img');
  assert.equal(img.hasAttribute(ORIGINAL), true);
  img.setAttribute('alt', 'photo');
  img.setAttribute('src', 'https://scontent.xx.fbcdn.net/v/t39/2.jpg');
  await tick();
  assert.equal(img.getAttribute('src'), 'https://scontent.xx.fbcdn.net/v/t39/2.jpg');
  assert.equal(img.hasAttribute(ORIGINAL), false);
  on = false;
  swapper.apply();
  assert.equal(img.getAttribute('src'), 'https://scontent.xx.fbcdn.net/v/t39/2.jpg');
});

test('an emoji the script can\'t read is left as Facebook drew it', () => {
  const win = page('<img alt="" src="https://static.xx.fbcdn.net/images/emoji.php/v9/t4/1/16/sprite.png">');
  const swapper = createEmojiSwapper({ doc: win.document, enabled: () => true });
  swapper.apply();
  assert.ok(win.document.querySelector('img').getAttribute('src').endsWith('/sprite.png'));
  assert.equal(win.document.querySelector(`[${ORIGINAL}]`), null);
});

test('system emoji runs from setup and reports a count', () => {
  const win = page(emojiImg(SMILE, '1f600'));
  const rows = new Map();
  systemEmoji.setup({ doc: win.document, enabled: () => true, settings: { subscribe() {} }, diagnostics: { add: (label, read) => rows.set(label, read) } });
  assert.equal(rows.get('Emoji swapped for your own')(), '1');
});

test('turning off transitions keeps progress spinners turning', () => {
  assert.equal(noTransitions.css, NO_TRANSITIONS_CSS);
  assert.match(NO_TRANSITIONS_CSS, /transition-duration: 0\.001ms !important/);
  assert.match(NO_TRANSITIONS_CSS, /animation-iteration-count: 1 !important/);
  // Near zero, not none, so transitionend still fires.
  assert.ok(!/duration: 0s/.test(NO_TRANSITIONS_CSS));
  const win = page('<div role="progressbar"><i class="spin"></i></div><div class="menu"><i class="fade"></i></div>');
  assert.ok(NO_TRANSITIONS_CSS.startsWith(`${ANIMATED}, ${ANIMATED}::before, ${ANIMATED}::after {`));
  const hit = (element) => element.matches(ANIMATED);
  assert.equal(hit(win.document.querySelector('.fade')), true);
  assert.equal(hit(win.document.querySelector('[role="progressbar"]')), false);
  // happy-dom ignores a descendant selector inside :not(), so what's inside the spinner is
  // checked by the selector's text here and by Chrome in the live run (inject.py appearance).
  assert.match(ANIMATED, /:not\(\[role="progressbar"\], \[role="progressbar"\] \*\)$/);
});

test('every Appearance switch is off by default and in the Appearance section', () => {
  for (const feature of [forceDarkMode, amoledTheme, accentColor, systemFont, systemEmoji, noTransitions]) {
    assert.equal(feature.default, false, feature.id);
    assert.equal(feature.section, 'appearance', feature.id);
    assert.ok(!feature.needsPage, `${feature.id} works in content mode`);
  }
});
