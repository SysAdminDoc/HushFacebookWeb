// Calm theme: every palette reads on both sides, the stylesheet's order lets AMOLED black and
// Accent color win, the line spacing only reaches post and comment text, and Accent color works
// its shades out on the theme's surfaces.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { testWindow } from './helpers/dom.js';
import { features } from '../src/features/index.js';
import { renderFeatureCss } from '../src/core/style.js';
import accentColor, { accentCss, ACCENTS, contrast, FILTERS_MARK, over, palette, parseHex, themeSurfaces } from '../src/features/appearance/accent.js';
import calmTheme, { THEME_FILTERS_MARK, themeColors, themeCss } from '../src/features/appearance/theme.js';
import { chosenTheme, THEMES } from '../src/features/appearance/theme-palettes.js';

const LIGHT = ':root, .__fb-light-mode';
const DARK = '.__fb-dark-mode';
const getter = (values) => (key) => values[key];
const themeNamed = (value) => THEMES.find((theme) => theme.value === value);

const windows = [];
afterEach(async () => {
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

function page(html = '') {
  const win = testWindow('https://www.facebook.com/');
  windows.push(win);
  win.document.documentElement.className = '_9dls __fb-dark-mode';
  win.document.body.innerHTML = html;
  return win;
}

function varsOf(css, selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `no rule for ${selector}`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+): ([^;]+?) !important;/g)].map((m) => [m[1], m[2]]));
}

// A color from the stylesheet as #RRGGBB, an rgba() laid over what's under it.
function solid(value, under) {
  if (value.startsWith('#')) return value;
  const [r, g, b, a] = value.match(/[\d.]+/g).map(Number);
  return over([r, g, b], under, a);
}

test('every Calm theme palette reads on every surface, in light and dark', () => {
  // Known WCAG pairs, so the checks below measure what they should.
  assert.equal(contrast('#767676', '#FFFFFF').toFixed(2), '4.54');
  assert.equal(solid('rgba(0, 0, 0, 0.2)', '#FFFFFF'), '#CCCCCC');
  for (const theme of THEMES) {
    const css = themeCss(getter({ 'calmTheme.palette': theme.value }));
    for (const [side, selector] of [['light', LIGHT], ['dark', DARK]]) {
      const v = varsOf(css, selector);
      const card = v['--card-background'];
      const on = {
        page: v['--web-wash'], card, flat: v['--card-background-flat'], comment: v['--comment-background'], popover: v['--popover-background'],
        toast: v['--toast-background'], input: v['--input-background'], hovered: solid(v['--hover-overlay'], card),
        unread: solid(v['--new-notification-background'], card), button: solid(v['--secondary-button-background'], card),
      };
      const reads = (name, ratio, where) => {
        for (const surface of where) {
          const ratioThere = contrast(v[name], on[surface]);
          assert.ok(ratioThere >= ratio, `${theme.value} ${side}: ${name} ${v[name]} on ${surface} ${on[surface]} is ${ratioThere.toFixed(2)}`);
        }
      };
      const everywhere = Object.keys(on);
      reads('--primary-text', 6, everywhere);
      reads('--secondary-text', 4.5, everywhere);
      reads('--secondary-button-text', 4.5, ['button']);
      reads('--toast-text', 4.5, ['toast']);
      reads('--negative', 4.5, ['card', 'flat', 'popover']);
      reads('--positive', 4.5, ['card', 'flat', 'popover']);
      reads('--blue-link', 4.5, ['page', 'card', 'flat', 'popover', 'hovered', 'unread']);
      reads('--toast-text-link', 4.5, ['toast']);
      reads('--input-label-color-highlighted', 4.5, ['input']);
      reads('--focus-ring-blue', 3, ['card', 'flat']);
      for (const button of ['--primary-button-background', '--primary-button-pressed']) {
        assert.ok(contrast(v['--primary-button-text'], v[button]) >= 4.5, `${theme.value} ${side}: button text on ${button}`);
      }
      // Calm means less glare: the main text stays below Facebook's 20:1 and the dividers below
      // dark mode's bright #65686C.
      assert.ok(contrast(v['--primary-text'], card) < 17, `${theme.value} ${side} text is softer than Facebook's`);
      assert.ok(contrast(v['--divider'], card) < contrast('#65686C', '#252728'), `${theme.value} ${side} dividers are quieter`);
      // Cards stand further off the page than Facebook's dark mode, where they barely show.
      if (side === 'dark') assert.ok(contrast(card, on.page) > contrast('#252728', '#1C1C1D') + 0.005, `${theme.value} dark cards stand off the page`);
    }
  }
});

test('the Calm theme sets the same variables on both sides, dark after light, with its own colors', () => {
  const css = themeCss(getter({ 'calmTheme.palette': 'nord' }));
  assert.ok(css.indexOf(`${DARK} {`) > css.indexOf(`${LIGHT} {`), 'dark wins on <html> in dark mode');
  const light = varsOf(css, LIGHT);
  const dark = varsOf(css, DARK);
  // The light block also matches :root, so anything the dark one left out would show through.
  assert.deepEqual(Object.keys(dark).sort(), Object.keys(light).sort());
  const nord = themeNamed('nord');
  for (const [vars, colors] of [[light, nord.light], [dark, nord.dark]]) {
    assert.equal(vars['--web-wash'], colors.page);
    assert.equal(vars['--card-background'], colors.card);
    assert.equal(vars['--comment-background'], colors.flat);
    assert.equal(vars['--popover-background'], colors.popover);
    assert.equal(vars['--primary-text'], colors.text);
    assert.equal(vars['--secondary-text'], colors.muted);
    assert.equal(vars['--divider'], colors.line);
    assert.equal(vars['--accent'], colors.accent);
    // Facebook's own marks keep their colors, and so does the red count badge (white text needs it).
    for (const kept of ['--fb-logo', '--fb-wordmark', '--reaction-like', '--story-unseen', '--notification-badge']) assert.equal(vars[kept], undefined, kept);
  }
  assert.equal(light['--filter-accent'], 'url("#hfw-theme-base")');
  assert.equal(dark['--filter-accent'], 'url("#hfw-theme-link-dark")');
  assert.equal(dark['--filter-primary-accent'], 'url("#hfw-theme-base-dark")');
  assert.notEqual(light['--blue-link'], dark['--blue-link']);
  assert.equal(themeCss(getter({ 'calmTheme.palette': 'gone' })), themeCss(), 'an unknown palette is Soft');
  assert.equal(chosenTheme(getter({})).value, 'soft');
  assert.ok(themeCss().includes(`--card-background: ${themeNamed('soft').dark.card} !important;`));
});

test('more room between lines goes on post and comment text, not on centered or other text', () => {
  const win = page(`
    <div data-ad-rendering-role="story_message"><div dir="auto" style="text-align: start;" id="post">Post</div></div>
    <div data-ad-preview="message"><div dir="auto" style="text-align: start;" id="preview">Preview</div></div>
    <div data-ad-rendering-role="story_message"><div dir="auto" style="text-align:start" id="tight">Written without the space</div></div>
    <div role="article"><div dir="auto" style="text-align: start;" id="comment">Comment</div></div>
    <div data-ad-rendering-role="story_message"><div dir="auto" style="text-align: center;" id="colored">Big words</div></div>
    <div data-ad-rendering-role="story_message"><div dir="auto" id="plain">No inline style</div></div>
    <div role="navigation"><div dir="auto" style="text-align: start;" id="menu">Menu</div></div>`);
  const doc = win.document;
  const sheet = doc.createElement('style');
  doc.head.append(sheet);
  const height = (id) => win.getComputedStyle(doc.getElementById(id)).lineHeight;
  sheet.textContent = themeCss();
  for (const id of ['post', 'preview', 'tight', 'comment']) assert.equal(height(id), '1.5', id);
  for (const id of ['colored', 'plain', 'menu']) assert.notEqual(height(id), '1.5', id);
  sheet.textContent = themeCss(getter({ 'calmTheme.roomy': false }));
  assert.notEqual(height('post'), '1.5', 'switched off');
});

test('the Calm theme comes before AMOLED black and Accent color, so either wins over it', () => {
  const values = { calmTheme: true, amoledTheme: true, accentColor: true, 'accentColor.color': 'purple' };
  const css = renderFeatureCss(features, { get: getter(values), enabled: (id) => values[id] === true }, null);
  const at = (id) => css.indexOf(`/* ${id} */`);
  assert.ok(at('calmTheme') >= 0);
  assert.ok(at('calmTheme') < at('amoledTheme'));
  assert.ok(at('calmTheme') < at('accentColor'));
});

test('Accent color works its shades out on the Calm theme surfaces when both are on', () => {
  // The surface each shade reads worst on: Soft's light card is darker than its white menus,
  // and a hovered dark row is lighter than its menus.
  assert.deepEqual(themeSurfaces(themeNamed('soft')), {
    white: '#FAFBFC', wash: '#ECEEF1', bubble: '#2B2F35', card: '#1F2227', box: '#2B2F35', raised: '#32353A',
  });
  for (const theme of THEMES) {
    for (const { value, hex } of ACCENTS) {
      const css = accentColor.css(getter({ calmTheme: true, 'calmTheme.palette': theme.value, 'accentColor.color': value, 'accentColor.custom': '' }));
      const light = varsOf(css, LIGHT);
      const dark = varsOf(css, DARK);
      const reads = (shade, surfaces, what) => {
        for (const surface of surfaces) assert.ok(contrast(shade, surface) >= 4.5, `${theme.value} ${hex} ${what} ${shade} on ${surface}`);
      };
      const { light: l, dark: d } = theme;
      reads(light['--blue-link'], [l.page, l.card, l.flat, l.popover, l.input], 'light link');
      reads(light['--toast-text-link'], [l.popover], 'light toast link');
      reads(dark['--blue-link'], [d.card, d.flat, d.popover, over(parseHex(d.text), d.card, 0.1)], 'dark link');
      reads(dark['--input-label-color-highlighted'], [d.input, d.popover], 'dark field label');
      reads(dark['--toast-text-link'], [d.popover], 'dark toast link');
    }
  }
  assert.equal(accentColor.css(getter({ 'accentColor.color': 'purple' })), accentCss('#7B3FE4'), "theme off: Facebook's surfaces, as before");
  assert.equal(accentColor.css(getter({ calmTheme: false, 'calmTheme.palette': 'paper', 'accentColor.color': 'purple' })), accentCss('#7B3FE4'));
});

test('Accent color icon filters follow the Calm theme surfaces too', () => {
  const win = page('<div id="app"></div>');
  const doc = win.document;
  const values = { calmTheme: true, 'calmTheme.palette': 'nord', 'accentColor.color': 'purple', 'accentColor.custom': '' };
  accentColor.setup({ doc, settings: { get: getter(values), subscribe() {} }, enabled: () => true });
  const flood = doc.querySelector(`svg[${FILTERS_MARK}] filter[id="hfw-accent-link-dark"] feFlood`).getAttribute('flood-color');
  assert.equal(flood, palette('#7B3FE4', themeSurfaces(themeNamed('nord'))).dark.link);
  assert.notEqual(flood, palette('#7B3FE4').dark.link, "Nord's lighter bubbles need a lighter link than Facebook's");
});

test('the Calm theme writes its own icon filters beside Accent color and removes them when off', () => {
  const win = page('<div id="app"></div>');
  const doc = win.document;
  const values = { 'calmTheme.palette': 'paper' };
  let on = true;
  const listeners = [];
  calmTheme.setup({ doc, settings: { get: getter(values), subscribe: (fn) => listeners.push(fn) }, enabled: () => on });
  accentColor.setup({ doc, settings: { get: getter({ 'accentColor.color': 'green' }), subscribe() {} }, enabled: () => true });
  const svg = () => doc.querySelector(`svg[${THEME_FILTERS_MARK}]`);
  const flood = (id) => svg().querySelector(`filter[id="${id}"] feFlood`)?.getAttribute('flood-color');
  const paper = themeColors(themeNamed('paper'));
  assert.equal(flood('hfw-theme-base'), '#B0532A');
  assert.equal(flood('hfw-theme-base-dark'), '#D9964A');
  assert.equal(flood('hfw-theme-link'), paper.light.light.link);
  assert.equal(flood('hfw-theme-link-dark'), paper.dark.dark.link);
  assert.equal(flood('hfw-theme-deemphasized-dark'), paper.dark.dark.deemphasized);
  // Every filter the stylesheet points at is there.
  for (const [, id] of themeCss(getter(values)).matchAll(/url\("#([\w-]+)"\)/g)) assert.ok(flood(id), id);
  values['calmTheme.palette'] = 'nord';
  for (const fn of listeners) fn({ keys: ['calmTheme.palette'] });
  assert.equal(flood('hfw-theme-base'), '#4C6A92');
  assert.equal(doc.querySelectorAll(`svg[${THEME_FILTERS_MARK}]`).length, 1, 'rewritten in place');
  on = false;
  for (const fn of listeners) fn({ keys: ['calmTheme'] });
  assert.equal(svg(), null);
  assert.equal(doc.querySelectorAll(`svg[${FILTERS_MARK}]`).length, 1, "Accent color's own filters stay");
});
