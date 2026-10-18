// Accent color, as on Android. Facebook's blue is a set of CSS variables per theme (read live
// 2026-10-11, light and dark): --accent and the button, focus, progress and cursor colors are
// the blue itself, links and outlined buttons use a darker shade in light mode and a lighter
// one in dark mode, and selected rows use a pale tint. The script works out the same steps
// from your color and sets them for both themes. The Facebook logo, the Like reaction and the
// ring around unseen stories keep their own colors.
//
// Blue icons are tinted by CSS filter chains made for that one blue (--filter-accent and three
// more), so they'd stay blue. The script points them at small SVG filters of its own that
// fill an icon's shape with the exact color, whatever color the icon was drawn in.

import { whenBodyReady } from '../../core/env.js';

export const ACCENTS = [
  { value: 'purple', label: 'Purple', hex: '#7B3FE4' },
  { value: 'pink', label: 'Pink', hex: '#D6246E' },
  { value: 'red', label: 'Red', hex: '#D93025' },
  { value: 'orange', label: 'Orange', hex: '#E8590C' },
  { value: 'green', label: 'Green', hex: '#1E8E3E' },
  { value: 'teal', label: 'Teal', hex: '#00897B' },
  { value: 'graphite', label: 'Graphite', hex: '#5F6368' },
];

export function parseHex(value) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value ?? '').trim());
  if (!match) return null;
  const n = Number.parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHsl([r, g, b]) {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rr ? (gg - bb) / d + (gg < bb ? 6 : 0) : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
  return [h * 60, s * 100, l * 100];
}

export function toHex([h, s, l]) {
  const ss = s / 100;
  const ll = l / 100;
  const a = ss * Math.min(ll, 1 - ll);
  const channel = (n) => {
    const k = (n + h / 30) % 12;
    return ll - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return `#${[channel(0), channel(8), channel(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

// WCAG relative luminance.
function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// WCAG contrast of two #RRGGBB colors, from 1 to 21. Text needs 4.5, focus rings 3.
export function contrast(a, b) {
  const [x, y] = [luminance(parseHex(a)), luminance(parseHex(b))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
export const TEXT = 4.5;
export const INDICATOR = 3;

// What the shades sit on. Light mode: white cards, and #F0F2F5 for comment bubbles and the
// page behind the cards. Dark mode (read live, see amoled.js): comment bubbles #333334, the
// lightest place a link shows, cards #252728, text boxes and toasts #242526. AMOLED's
// surfaces are all darker, so a shade that reads in dark mode reads there too.
export const SURFACES = { white: '#FFFFFF', wash: '#F0F2F5', bubble: '#333334', card: '#252728', box: '#242526' };

// Your color laid over a surface at some opacity, as Facebook draws dark mode's tinted buttons.
export function over(rgb, surface, a) {
  const under = parseHex(surface);
  return `#${rgb.map((c, i) => Math.round(c * a + under[i] * (1 - a)).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

// Starts at Facebook's step and moves the lightness down (by -1) or up (by 1) until the shade
// reaches the ratio on every surface given, so the hue and saturation stay yours.
function readable([h, s], from, by, surfaces, ratio) {
  for (let l = from; l >= 0 && l <= 100; l += by) {
    const hex = toHex([h, s, l]);
    if (surfaces.every((surface) => contrast(hex, surface) >= ratio)) return hex;
  }
  return by < 0 ? '#000000' : '#FFFFFF';
}

// Facebook's steps for its own blue (#0866FF, lightness 52): links #0064D1 (41) in light mode
// and #5AA7FF (68) in dark mode, outlined buttons #DDEDFE (93), selected rows #EBF5FF (96).
// A color too light or too dark for a step gets the nearest shade that still reads. Button
// text is white or black, whichever stands out more on your color.
export function palette(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const hsl = toHsl(rgb);
  const l = hsl[2];
  const base = toHex(hsl);
  const at = (lightness) => toHex([hsl[0], hsl[1], lightness]);
  const darker = (from, surfaces, ratio = TEXT) => readable(hsl, from, -1, surfaces, ratio);
  const lighter = (from, surfaces, ratio = TEXT) => readable(hsl, from, 1, surfaces, ratio);
  const alpha = (a) => `rgba(${rgb.join(', ')}, ${a})`;
  const button = at(93);
  return {
    base,
    onBase: contrast(base, '#FFFFFF') >= contrast(base, '#000000') ? '#FFFFFF' : '#000000',
    alpha,
    light: {
      focus: darker(l, [SURFACES.white, SURFACES.wash], INDICATOR),
      link: darker(Math.min(l, 41), [SURFACES.white, SURFACES.wash, button]),
      toastLink: darker(Math.min(l, 49), [SURFACES.white]),
      pressed: at(Math.max(l, 73)), button, highlight: at(95), selected: at(96),
    },
    dark: {
      focus: lighter(Math.max(l, 55), [SURFACES.card, SURFACES.bubble], INDICATOR),
      label: lighter(Math.max(l, 61), [SURFACES.box]),
      toastLink: lighter(Math.max(l, 64), [SURFACES.box]),
      link: lighter(Math.max(l, 68), [SURFACES.card, SURFACES.bubble]),
      deemphasized: lighter(Math.max(l, 73), [over(rgb, SURFACES.card, 0.2)]),
    },
  };
}

// The color picked: your own when it's a valid #RRGGBB, the list's otherwise.
export function chosenColor(get) {
  const custom = String(get('accentColor.custom') ?? '').trim();
  if (parseHex(custom)) return custom.startsWith('#') ? custom : `#${custom}`;
  return (ACCENTS.find((accent) => accent.value === get('accentColor.color')) ?? ACCENTS[0]).hex;
}

export const FILTER_IDS = {
  base: 'hfw-accent-base', lightLink: 'hfw-accent-link', darkLink: 'hfw-accent-link-dark', darkDeemphasized: 'hfw-accent-deemphasized-dark',
};

export function filterColors(colors) {
  return {
    [FILTER_IDS.base]: colors.base,
    [FILTER_IDS.lightLink]: colors.light.link,
    [FILTER_IDS.darkLink]: colors.dark.link,
    [FILTER_IDS.darkDeemphasized]: colors.dark.deemphasized,
  };
}

const url = (id) => `url("#${id}")`;
const block = (selector, vars) => `${selector} {\n${Object.entries(vars).map(([name, value]) => `  ${name}: ${value} !important;`).join('\n')}\n}`;

export function accentCss(hex) {
  const colors = palette(hex);
  if (!colors) return '';
  const { base, onBase, alpha, light, dark } = colors;
  const shared = {
    '--accent': base, '--primary-button-background': base, '--primary-button-text': onBase, '--primary-button-icon': onBase,
    '--cursor': base, '--progress-ring-blue-foreground': base, '--progress-ring-blue-background': alpha(0.2),
    '--primary-deemphasized-button-pressed-overlay': alpha(0.15), '--filter-primary-accent': url(FILTER_IDS.base),
  };
  // Light first: Facebook's light rule also matches a bare :root, so the dark block has to
  // come after it to win on <html> in dark mode.
  return [
    block(':root, .__fb-light-mode', {
      ...shared,
      '--focus-ring-blue': light.focus, '--primary-button-pressed': light.pressed,
      '--blue-link': light.link, '--primary-deemphasized-button-text': light.link, '--primary-deemphasized-button-icon': light.link,
      '--toggle-active-icon': light.link, '--toggle-active-text': light.link, '--input-label-color-highlighted': light.link,
      '--toast-text-link': light.toastLink, '--primary-deemphasized-button-background': light.button,
      '--highlight-bg': light.highlight, '--toggle-active-background': light.selected, '--hosted-view-selected-state': light.selected,
      '--text-highlight': alpha(0.2),
      '--filter-accent': url(FILTER_IDS.base), '--filter-blue-link-icon': url(FILTER_IDS.lightLink),
      '--filter-primary-deemphasized-button-icon': url(FILTER_IDS.lightLink),
    }),
    block('.__fb-dark-mode', {
      ...shared,
      '--focus-ring-blue': dark.focus, '--toggle-active-background': dark.focus, '--primary-button-pressed': dark.deemphasized,
      '--blue-link': dark.link, '--primary-deemphasized-button-text': dark.deemphasized, '--primary-deemphasized-button-icon': dark.deemphasized,
      '--input-label-color-highlighted': dark.label, '--toast-text-link': dark.toastLink,
      '--primary-deemphasized-button-background': alpha(0.2), '--highlight-bg': alpha(0.31), '--text-highlight': alpha(0.45),
      '--hosted-view-selected-state': alpha(0.1),
      '--filter-accent': url(FILTER_IDS.darkLink), '--filter-blue-link-icon': url(FILTER_IDS.darkLink),
      '--filter-primary-deemphasized-button-icon': url(FILTER_IDS.darkDeemphasized),
    }),
  ].join('\n');
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export const FILTERS_MARK = 'data-hfw-accent-filters';

// One hidden <svg> with a filter per color. Each fills the icon's shape (its alpha) with the
// color, in sRGB so the result is the exact hex.
export function writeFilters(doc, colors) {
  let svg = doc.querySelector(`svg[${FILTERS_MARK}]`);
  if (!svg) {
    svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute(FILTERS_MARK, '');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none');
    (doc.body ?? doc.documentElement).append(svg);
  }
  const defs = doc.createElementNS(SVG_NS, 'defs');
  for (const [id, color] of Object.entries(colors)) {
    const filter = doc.createElementNS(SVG_NS, 'filter');
    filter.setAttribute('id', id);
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    const flood = doc.createElementNS(SVG_NS, 'feFlood');
    flood.setAttribute('flood-color', color);
    const composite = doc.createElementNS(SVG_NS, 'feComposite');
    composite.setAttribute('in2', 'SourceAlpha');
    composite.setAttribute('operator', 'in');
    filter.append(flood, composite);
    defs.append(filter);
  }
  svg.replaceChildren(defs);
  return svg;
}

export default {
  id: 'accentColor',
  section: 'appearance',
  android: 'Accent color',
  title: 'Accent color',
  description: "Your own color in place of Facebook's blue, for buttons, links, switches and highlights, in both light and dark mode.",
  default: false,
  options: [
    { key: 'color', type: 'select', label: 'Color', default: ACCENTS[0].value, choices: ACCENTS.map(({ value, label }) => ({ value, label })) },
    { key: 'custom', type: 'text', lines: 1, label: 'Or your own color, like #7B3FE4', default: '', maxLength: 7 },
  ],
  css: (get) => accentCss(chosenColor(get)),

  setup({ doc, settings, enabled, log }) {
    if (!doc) return;
    const sync = () => {
      try {
        const existing = doc.querySelector(`svg[${FILTERS_MARK}]`);
        if (!enabled()) {
          existing?.remove();
          return;
        }
        writeFilters(doc, filterColors(palette(chosenColor(settings.get))));
      } catch (error) {
        log?.error("Accent color: the icon colors couldn't be set", error);
      }
    };
    whenBodyReady(sync, doc);
    settings?.subscribe(() => whenBodyReady(sync, doc));
  },
};
