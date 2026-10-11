// Use the phone's emoji, as on Android: your own system's emoji in place of Facebook's emoji
// pictures. Live 2026-10-11, Facebook draws an emoji in text as
// <img src=".../images/emoji.php/v9/t4/1/16/1faf6_1f3fb.png" alt="🫶🏻" width=16 height=16>
// inside a span, and the file name spells out the code points. The script keeps that <img>
// and only swaps its picture for a small SVG that draws the alt text with the system's emoji
// font, so Facebook's layout, the alt text and copy and paste stay as they were. The original
// address is kept on the image and goes back when the switch is off. Works in content mode.

export const EMOJI_IMG = 'img[src*="/images/emoji.php/"]';
export const ORIGINAL = 'data-hfw-emoji';
const EMOJI_FONTS = "'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji','Twemoji Mozilla',sans-serif";

// The emoji as text: the alt when it holds one, the file name's code points otherwise.
export function emojiText(img, src = img.getAttribute('src') ?? '') {
  const alt = img.getAttribute('alt') ?? '';
  if ([...alt].some((char) => char.codePointAt(0) > 0xff)) return alt;
  const match = /\/([0-9a-f]{2,6}(?:_[0-9a-f]{2,6})*)\.png(?:$|[?#])/i.exec(src);
  if (!match) return null;
  try {
    return String.fromCodePoint(...match[1].split('_').map((hex) => Number.parseInt(hex, 16)));
  } catch {
    return null;
  }
}

const escapeXml = (text) => text.replace(/[&<>"']/g, (char) => `&#${char.codePointAt(0)};`);

export function emojiPicture(text) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><text x="10" y="10.5" font-size="16" text-anchor="middle" dominant-baseline="central" font-family="${EMOJI_FONTS}">${escapeXml(text)}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function swapEmoji(img) {
  const src = img.getAttribute('src') ?? '';
  if (!src.includes('/images/emoji.php/')) return false;
  const text = emojiText(img, src);
  if (!text) return false;
  img.setAttribute(ORIGINAL, src);
  img.setAttribute('src', emojiPicture(text));
  return true;
}

export function restoreEmoji(img) {
  const original = img.getAttribute(ORIGINAL);
  img.removeAttribute(ORIGINAL);
  if (original) img.setAttribute('src', original);
}

export function createEmojiSwapper({ doc, enabled, log }) {
  let observer = null;
  let swapped = 0;

  const swapIn = (root) => {
    if (root.nodeType !== 1) return;
    if (root.matches(EMOJI_IMG) && swapEmoji(root)) swapped += 1;
    for (const img of root.querySelectorAll(EMOJI_IMG)) if (swapEmoji(img)) swapped += 1;
  };

  const onMutations = (records) => {
    try {
      for (const record of records) {
        // Facebook set a new emoji on an image the script had already swapped.
        if (record.type === 'attributes') swapIn(record.target);
        else for (const node of record.addedNodes) swapIn(node);
      }
    } catch (error) {
      log?.error('Use system emoji: swapping an emoji failed', error);
    }
  };

  function start() {
    if (observer) return;
    const root = doc.documentElement;
    if (!root) return;
    const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
    observer = new Observer(onMutations);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
    swapIn(root);
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    for (const img of doc.querySelectorAll(`img[${ORIGINAL}]`)) restoreEmoji(img);
  }

  return {
    apply: () => (enabled() ? start() : stop()),
    state: () => ({ running: Boolean(observer), swapped }),
  };
}

export default {
  id: 'systemEmoji',
  section: 'appearance',
  android: "Use the phone's emoji",
  title: "Use your computer's emoji",
  description: "Shows emoji in posts, comments and chats with your own system's emoji instead of Facebook's pictures of them.",
  default: false,

  setup({ doc, settings, enabled, log, diagnostics }) {
    if (!doc) return;
    const swapper = createEmojiSwapper({ doc, enabled, log });
    const apply = () => {
      if (doc.documentElement) swapper.apply();
    };
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', apply, { once: true });
    else apply();
    settings?.subscribe(apply);
    diagnostics?.add('Emoji swapped for your own', () => (enabled() ? String(swapper.state().swapped) : 'off'));
  },
};
