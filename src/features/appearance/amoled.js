// AMOLED black theme, as on Android: Facebook's dark mode with pure black where it's dark gray.
// Dark mode's surfaces are CSS variables under .__fb-dark-mode (read live 2026-10-11): the page
// behind everything is #1C1C1D, cards, the top bar and side columns #252728, comment bubbles
// and flat cards #333334, menus #3B3C3E, text boxes and toasts #242526. The page and cards go
// black, and what sits on them gets a near-black step so bubbles, menus and boxes still show
// their edges. Facebook also draws some parts dark inside a light page (the video player, for
// one), and those go black too. Light mode is left alone, so it needs Facebook's dark mode or
// Force dark mode.

export const BLACK = '#000000';
export const RAISED = '#121212';
export const POPOVER = '#1A1A1A';

export const AMOLED_VARS = {
  '--web-wash': BLACK,
  '--wash': BLACK,
  '--surface-background': BLACK,
  '--card-background': BLACK,
  '--nav-bar-background': BLACK,
  '--messenger-card-background': BLACK,
  '--card-background-flat': RAISED,
  '--comment-background': RAISED,
  '--input-background': RAISED,
  '--input-background-disabled': RAISED,
  '--messenger-reply-background': RAISED,
  '--toast-background': RAISED,
  '--popover-background': POPOVER,
};

export function amoledCss() {
  const lines = Object.entries(AMOLED_VARS).map(([name, value]) => `  ${name}: ${value} !important;`);
  return `.__fb-dark-mode {\n${lines.join('\n')}\n}`;
}

export default {
  id: 'amoledTheme',
  section: 'appearance',
  android: 'AMOLED black theme',
  title: 'AMOLED black theme',
  description: "Pure black in place of Facebook's dark gray. It changes dark mode only, so turn on Facebook's dark mode or Force dark mode with it.",
  default: false,
  css: amoledCss,
};
