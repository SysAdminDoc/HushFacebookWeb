// Use the system font, as on Android. Facebook picks its font through CSS variables (read live
// 2026-10-11): --font-family-segoe on Windows ("Segoe UI Historic", Segoe UI, Helvetica, Arial),
// --font-family-apple, --font-family-default and --font-family-system-fds. The script points
// all four at the computer's own interface font, or at a font you name, and sets it on <body>
// for text that only inherits. Code blocks keep their monospace font.

export const SYSTEM_STACK = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", "Helvetica Neue", Arial, sans-serif';
const FONT_VARS = ['--font-family-default', '--font-family-segoe', '--font-family-apple', '--font-family-system-fds'];

// A font name goes inside a CSS string, so only letters, digits, spaces and a few joining
// marks get through. Anything else (quotes, semicolons, braces) means the name is ignored.
export function fontName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  return /^[\p{L}\p{N}][\p{L}\p{N} ._&+-]{0,63}$/u.test(name) ? name : '';
}

export function fontStack(get) {
  const name = fontName(get('systemFont.font'));
  return name ? `"${name}", ${SYSTEM_STACK}` : SYSTEM_STACK;
}

export function fontCss(get) {
  const stack = fontStack(get);
  const vars = FONT_VARS.map((name) => `  ${name}: ${stack} !important;`).join('\n');
  return `:root, .__fb-light-mode, .__fb-dark-mode {\n${vars}\n}\nbody { font-family: ${stack} !important; }`;
}

export default {
  id: 'systemFont',
  section: 'appearance',
  android: 'Use the system font',
  title: 'Use the system font',
  description: "Draws Facebook's text in your computer's own interface font, or in a font you have installed.",
  default: false,
  options: [
    { key: 'font', type: 'text', lines: 1, label: 'Or a font you have installed, by name', default: '', maxLength: 64 },
  ],
  css: fontCss,
};
