// Calm theme: a softer Facebook for long reading. Reviewed live on desktop 2026-11-04 (Home,
// groups, a profile, Marketplace and a post's comments, light and dark):
// - Light mode puts pure white cards on #F2F4F7 with near-black #080809 text, about 20:1, which
//   glares. Dark mode is the opposite problem: cards (#252728) barely stand off the page
//   (#1C1C1D) and the dividers (#65686C) are brighter than they need to be.
// - Post and comment text is 15px on 20px lines, tight for paragraphs.
// - Every color is a CSS variable on <html> and on popup layers, under .__fb-light-mode or
//   .__fb-dark-mode (579 each). Facebook sets some of them inline, so these need !important.
//
// Each palette in theme-palettes.js has a light and a dark side, and the side shown follows
// Facebook's own mode (or Force dark mode). Its accent goes through accent.js's palette(), so
// links, switches and focus rings get shades that read on this palette's surfaces. AMOLED black
// theme and Accent color come after this in the stylesheet, so with either on its surfaces or
// its color wins.
//
// Feed cards take their shadow from a generated class (0 1px 2px var(--shadow-2), not
// --shadow-base), so instead of an edge each dark side steps its cards a little further off the
// page than Facebook's 1.13:1.
//
// Post text is the div[dir=auto] with an inline text-align inside the post's message block, and
// a comment's is the same div inside its role=article. Live, the style reads "text-align: start;"
// on one post and "text-align:start" on the next. Centered text (posts on a colored background,
// sized to fit their box) is left alone.

import { whenBodyReady } from '../../core/env.js';
import { accentVars, block, DARK_SELECTOR, LIGHT_SELECTOR, palette, parseHex, themeSurfaces, writeFilters } from './accent.js';
import { chosenTheme, THEMES } from './theme-palettes.js';

const rgba = (hex, a) => `rgba(${parseHex(hex).join(', ')}, ${a})`;

export const THEME_FILTER_IDS = {
  light: { base: 'hfw-theme-base', lightLink: 'hfw-theme-link', darkLink: 'hfw-theme-link', darkDeemphasized: 'hfw-theme-link' },
  dark: { base: 'hfw-theme-base-dark', lightLink: 'hfw-theme-link-dark', darkLink: 'hfw-theme-link-dark', darkDeemphasized: 'hfw-theme-deemphasized-dark' },
};
export const THEME_FILTERS_MARK = 'data-hfw-theme-filters';

// Facebook's neutral variables for one side of a palette. The overlays and tints are the text
// color at Facebook's own opacities, so they take on the palette's warmth or coolness.
export function surfaceVars(c, dark) {
  const tint = (lightAlpha, darkAlpha) => rgba(c.text, dark ? darkAlpha : lightAlpha);
  return {
    '--web-wash': c.page, '--wash': dark ? c.page : c.line,
    '--surface-background': c.card, '--card-background': c.card, '--nav-bar-background': c.card, '--messenger-card-background': c.card,
    '--media-outer-border': c.card,
    '--card-background-flat': c.flat, '--comment-background': c.flat, '--attachment-footer-background': c.flat,
    '--chat-incoming-message-bubble-background-color': c.flat, '--messenger-reply-background': dark ? c.inputOff : c.flat,
    '--popover-background': c.popover, '--toast-background': c.popover,
    '--input-background': c.input, '--input-background-disabled': c.inputOff,
    '--text-input-bar-background': dark ? tint(0, 0.1) : c.flat, '--background-deemphasized': dark ? tint(0, 0.1) : c.page,
    '--secondary-button-background': tint(0.08, 0.1), '--disabled-button-background': tint(0.08, 0.1),
    '--secondary-button-pressed': tint(0.05, 0.2), '--hover-overlay': tint(0.05, 0.1), '--press-overlay': tint(0.1, 0.2),
    '--primary-text': c.text, '--primary-icon': c.text, '--secondary-button-text': c.text, '--toast-text': c.text, '--text-input-outside-label': c.text,
    '--secondary-text': c.muted, '--secondary-icon': c.muted, '--placeholder-text': c.muted, '--placeholder-icon': c.muted,
    '--section-header-text': c.muted, '--border-focused': c.muted,
    '--disabled-text': c.faint, '--disabled-icon': c.faint, '--disabled-button-text': c.faint,
    '--divider': c.line, '--comment-threading-lines': c.line, '--input-border-color': c.line, '--border-ui-emphasis': dark ? tint(0, 0.06) : c.line,
    '--scroll-thumb': rgba(c.muted, dark ? 0.4 : 0.5),
    '--nav-bar-background-gradient': `linear-gradient(to top, ${c.card}, ${rgba(c.card, 0)})`,
    '--nav-bar-background-gradient-wash': `linear-gradient(to top, ${c.page}, ${rgba(c.page, 0)})`,
    '--negative': c.red, '--positive': c.green,
  };
}

// Both sides' accent shades, worked out on this palette's surfaces.
export function themeColors(theme) {
  const surfaces = themeSurfaces(theme);
  return { light: palette(theme.light.accent, surfaces), dark: palette(theme.dark.accent, surfaces) };
}

export function themeFilterColors(colors) {
  return {
    [THEME_FILTER_IDS.light.base]: colors.light.base,
    [THEME_FILTER_IDS.light.lightLink]: colors.light.light.link,
    [THEME_FILTER_IDS.dark.base]: colors.dark.base,
    [THEME_FILTER_IDS.dark.darkLink]: colors.dark.dark.link,
    [THEME_FILTER_IDS.dark.darkDeemphasized]: colors.dark.dark.deemphasized,
  };
}

const TEXT = ':is([data-ad-rendering-role="story_message"], [data-ad-preview="message"], [role="article"]) div[dir="auto"][style*="text-align"]:not([style*="center"])';

export function themeCss(get = () => undefined) {
  const theme = chosenTheme(get);
  const colors = themeColors(theme);
  const light = accentVars(colors.light, THEME_FILTER_IDS.light);
  const dark = accentVars(colors.dark, THEME_FILTER_IDS.dark);
  const parts = [
    block(LIGHT_SELECTOR, {
      ...surfaceVars(theme.light, false), ...light.shared, ...light.light, '--new-notification-background': colors.light.light.highlight,
    }),
    block(DARK_SELECTOR, {
      ...surfaceVars(theme.dark, true), ...dark.shared, ...dark.dark, '--new-notification-background': colors.dark.alpha(0.12),
    }),
    'html { scrollbar-color: var(--scroll-thumb) var(--web-wash); }',
  ];
  if (get('calmTheme.roomy') !== false) parts.push(`${TEXT} { line-height: 1.5 !important; }`);
  return parts.join('\n');
}

export default {
  id: 'calmTheme',
  section: 'appearance',
  webOnly: true,
  title: 'Calm theme',
  description: "Softer colors that are easier on the eyes, in light and dark mode, and more room between the lines of posts and comments. Light or dark follows Facebook's own setting.",
  default: false,
  options: [
    { key: 'palette', type: 'select', label: 'Palette', default: THEMES[0].value, choices: THEMES.map(({ value, label }) => ({ value, label })) },
    { key: 'roomy', type: 'toggle', label: 'More room between lines', default: true },
  ],
  css: themeCss,

  setup({ doc, settings, enabled, log }) {
    if (!doc) return;
    const sync = () => {
      try {
        const existing = doc.querySelector(`svg[${THEME_FILTERS_MARK}]`);
        if (!enabled()) {
          existing?.remove();
          return;
        }
        writeFilters(doc, themeFilterColors(themeColors(chosenTheme(settings.get))), THEME_FILTERS_MARK);
      } catch (error) {
        log?.error("Calm theme: the icon colors couldn't be set", error);
      }
    };
    whenBodyReady(sync, doc);
    settings?.subscribe(() => whenBodyReady(sync, doc));
  },
};
